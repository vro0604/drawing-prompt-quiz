-- ============================================================================
-- time_overrun_renewal ／ 制作時間のオーバー更新制（D163）
-- ============================================================================
--
-- 【何が変わるか】
--   いままで、お題を引いてから何日経っても作品を投稿できた。
--   create_work は「お題が active か」しか見ておらず、時間を1か所も見ていない。
--   掃除は「持ち主が消えたお題」しか消さないので、持ち主のいるお題は残り続ける。
--
--   これからは、有限の制限時間を選んだお題に期限が入る。
--   期限が近づくと更新でき、更新すれば何度でも続けられる。
--   更新しないまま猶予を使い切ったときだけ、その挑戦は失敗になる。
--
-- 【測る対象】
--   描き手が制作挑戦を始めてから（＝ドラフト開始）、作品を投稿し終えるまで。
--   **鑑賞者のクイズ回答には時間制限を付けない。**この移行で回答側の表・関数に
--   時間の列は1つも足していない。
--
-- 【規則】元の制限時間を T とする（D163）。
--
--   初期の期限          挑戦の開始時刻 ＋ T（20260905090000 で「確定時刻」から改めた）
--   更新できる時点      いまの期限までの残りが 0.25T になったとき
--   更新一回の時間      更新した時刻 ＋ 0.75T（残り時間は繰り越さない）
--   0秒後の最終猶予     いまの期限から 0.5T
--   更新回数            無制限
--   失敗                猶予を使い切るまで更新しなかったとき
--
--   0.25 / 0.75 / 0.5 は**初期値が承認済み**で、変更を許容する設定値。
--   コードのあちこちに散らさず time_policy 表の3行にまとめる。
--
-- 【無制限は別扱い】
--   time_limit_seconds が null のお題には T が無い。
--   オーバー更新・猶予・時間切れの失敗を**適用しない。**
--   「T を 0 とみなす」ような暗黙の処理はしない。分岐を明示的に書く。
--
-- 【作品データは消さない】
--   失敗は prompts の状態が変わるだけ。works にも Storage にも触れない。
--
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 3つの係数（D163。初期値が承認済み）
-- ----------------------------------------------------------------------------

create table if not exists public.time_policy (
  policy_key text primary key
    constraint time_policy_key_format check (policy_key ~ '^[a-z][a-z0-9_]{1,49}$'),
  ratio numeric not null
    constraint time_policy_ratio_range check (ratio > 0 and ratio <= 10),

  -- **false = ユーザー承認済みの初期値。**draw_config の確率とは扱いが違う
  is_provisional boolean not null default false,

  note text not null
    constraint time_policy_note_length check (char_length(note) between 1 and 300),

  updated_at timestamptz not null default now()
);

comment on table public.time_policy is
  'オーバー更新制の3係数（D163）。初期値はユーザー承認済みで、変更を許容する設定値。'
  'draw_config（値そのものが未確定）とは扱いが違う。混同しない。';

insert into public.time_policy (policy_key, ratio, is_provisional, note) values
  ('renew_threshold_ratio', 0.25, false,
   '更新できるようになる時点。残り時間が元の制限時間 T の 0.25 倍になったとき'),
  ('renew_grant_ratio', 0.75, false,
   '更新一回で得る時間。更新した時刻から 0.75T。残り時間は繰り越さない'),
  ('grace_ratio', 0.50, false,
   '期限を過ぎたあとの最終猶予。いまの期限から 0.5T')
on conflict (policy_key) do nothing;

alter table public.time_policy enable row level security;
revoke all on table public.time_policy from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 2. お題に期限の列を足す
-- ----------------------------------------------------------------------------

alter table public.prompts
  add column if not exists deadline_at timestamptz;

alter table public.prompts
  add column if not exists renew_count int not null default 0;

alter table public.prompts
  add column if not exists last_renewed_at timestamptz;

alter table public.prompts
  add column if not exists failed_at timestamptz;

comment on column public.prompts.deadline_at is
  'いまの期限（D163）。null は「期限なし」＝無制限を選んだお題。'
  '更新のたびに 更新時刻 + 0.75T へ置き換わる。';
comment on column public.prompts.renew_count is
  'オーバー更新を行った回数。上限は無い（D163）。記録用。';
comment on column public.prompts.failed_at is
  '猶予を使い切って挑戦失敗になった時刻。作品データには一切触れない。';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.prompts'::regclass
       and conname = 'prompts_renew_count_positive'
  ) then
    alter table public.prompts
      add constraint prompts_renew_count_positive check (renew_count >= 0);
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- 3. 状態に 'failed' を足す
-- ----------------------------------------------------------------------------
--
-- 既存の2つの CHECK を張り直す。**行は1つも変えない。**
-- 既存の active / submitted / abandoned は、新しい CHECK でもそのまま通る。

alter table public.prompts drop constraint if exists prompts_status_valid;
alter table public.prompts
  add constraint prompts_status_valid check (
    status in ('active', 'submitted', 'abandoned', 'failed')
  );

alter table public.prompts drop constraint if exists prompts_status_timestamps;
alter table public.prompts
  add constraint prompts_status_timestamps check (
    (status = 'active'    and submitted_at is null and abandoned_at is null
                          and failed_at is null)
    or
    (status = 'submitted' and submitted_at is not null and abandoned_at is null
                          and failed_at is null)
    or
    (status = 'abandoned' and abandoned_at is not null and submitted_at is null
                          and failed_at is null)
    or
    (status = 'failed'    and failed_at is not null and submitted_at is null
                          and abandoned_at is null)
  );

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.prompts'::regclass
       and conname = 'prompts_failed_after_created'
  ) then
    alter table public.prompts
      add constraint prompts_failed_after_created
      check (failed_at is null or failed_at >= created_at);
  end if;
end $$;

-- 期限切れを探す索引。active で期限を持つ行だけを見る
create index if not exists prompts_deadline_idx
  on public.prompts (deadline_at)
  where status = 'active' and deadline_at is not null;


-- ----------------------------------------------------------------------------
-- 4. 既存のお題への遡及は、ここでは行わない
-- ----------------------------------------------------------------------------
--
-- 【2026-09-05 に外した】
--   もとはここに、まだ active の古いお題へ
--     deadline_at = created_at + T
--   を書き込む UPDATE が1本あった。**外した。**
--
--   列を足すこと（新しい挑戦に期限が付く）と、
--   既に進行中の挑戦へ後から期限を入れて投稿できなくすること は別の判断で、
--   後者は承認を受けていない。標準の `npm run db:deploy` で自動的に走る形に
--   しておくと、承認の無い状態変更が deploy のついでに起きる。
--
--   遡及したいときは、次の2本を手で実行する。どちらも migration ではない。
--     supabase/manual/20260905_inspect_prompt_deadlines.sql   … 数えるだけ（読み取り専用）
--     supabase/manual/20260905_backfill_prompt_deadlines.sql  … 実際に入れる
--
--   遡及しない場合、古いお題は deadline_at が null のままになる。
--   prompt_timer_json は「期限を持たない挑戦」として扱い、
--   投稿の検査（第8節）も素通りさせる。**時間切れにはならない。**

-- ----------------------------------------------------------------------------
-- 5. 期限の状態を1か所で計算する
-- ----------------------------------------------------------------------------
--
-- 画面・投稿・更新・掃除の4か所が同じ判定を使う。
-- 判定を4回書くと、どれか1つを直し忘れたときに気づけない。
--
-- 返す内容:
--   is_unlimited        無制限か（T が無いか）
--   deadline_at         いまの期限
--   seconds_left        期限までの残り秒（過ぎていれば負）
--   overrun_seconds     0秒を過ぎてからの経過秒（過ぎていなければ0）
--   can_renew           いま更新できるか
--   renew_opens_at      更新できるようになる時刻
--   grace_ends_at       猶予が終わる時刻（これを過ぎたら失敗）
--   is_expired          猶予まで使い切ったか
--   renew_count         更新した回数

create or replace function public.prompt_timer_json(p_prompt_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_p         record;
  v_now       timestamptz := clock_timestamp();
  v_threshold numeric;
  v_grace     numeric;
  v_t         numeric;
  v_open      timestamptz;
  v_grace_end timestamptz;
begin
  select p.id, p.status, p.time_limit_seconds, p.deadline_at,
         p.renew_count, p.last_renewed_at, p.created_at, p.failed_at
    into v_p
    from public.prompts p
   where p.id = p_prompt_id;

  if not found then
    return null;
  end if;

  -- 無制限は明示的に分ける（D163）。T が無いので更新も猶予も失敗も無い
  if v_p.time_limit_seconds is null or v_p.deadline_at is null then
    return jsonb_build_object(
      'status',          v_p.status,
      'is_unlimited',    v_p.time_limit_seconds is null,
      'has_deadline',    false,
      'deadline_at',     null,
      'seconds_left',    null,
      'overrun_seconds', 0,
      'can_renew',       false,
      'renew_opens_at',  null,
      'grace_ends_at',   null,
      'is_expired',      false,
      'renew_count',     v_p.renew_count,
      'time_limit_seconds', v_p.time_limit_seconds
    );
  end if;

  select tp.ratio into v_threshold
    from public.time_policy tp where tp.policy_key = 'renew_threshold_ratio';
  select tp.ratio into v_grace
    from public.time_policy tp where tp.policy_key = 'grace_ratio';

  v_t         := v_p.time_limit_seconds;
  v_open      := v_p.deadline_at - make_interval(secs => (v_t * v_threshold)::double precision);
  v_grace_end := v_p.deadline_at + make_interval(secs => (v_t * v_grace)::double precision);

  return jsonb_build_object(
    'status',          v_p.status,
    'is_unlimited',    false,
    'has_deadline',    true,
    'deadline_at',     v_p.deadline_at,
    'seconds_left',    floor(extract(epoch from (v_p.deadline_at - v_now)))::bigint,
    'overrun_seconds',
      greatest(0, floor(extract(epoch from (v_now - v_p.deadline_at))))::bigint,
    -- 更新できるのは「更新可能化から猶予の終わりまで」。
    -- 期限を過ぎていても、猶予の中なら更新できる（D163）
    'can_renew',       v_p.status = 'active' and v_now >= v_open and v_now <= v_grace_end,
    'renew_opens_at',  v_open,
    'grace_ends_at',   v_grace_end,
    'is_expired',      v_now > v_grace_end,
    'renew_count',     v_p.renew_count,
    'time_limit_seconds', v_p.time_limit_seconds
  );
end;
$fn$;

comment on function public.prompt_timer_json(uuid) is
  '期限の状態を1か所で計算する（D163）。画面・投稿・更新・掃除がこれを使う。'
  '内部専用。外向きの入口は get_prompt_timer。';

revoke all on function public.prompt_timer_json(uuid)
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 6. 本人がタイマーを読む／更新する
-- ----------------------------------------------------------------------------

create or replace function public.get_prompt_timer(p_prompt_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    return null;
  end if;

  -- 他人のお題には null（存在するかも教えない。D40）
  if not exists (
    select 1 from public.prompts p
     where p.id = p_prompt_id and p.created_by = v_uid
  ) then
    return null;
  end if;

  return public.prompt_timer_json(p_prompt_id);
end;
$fn$;

comment on function public.get_prompt_timer(uuid) is
  '自分のお題の期限の状態を返す。他人のお題と存在しないIDには null（D40）。';


create or replace function public.renew_prompt_deadline(p_prompt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid    uuid := (select auth.uid());
  v_p      record;
  v_timer  jsonb;
  v_grant  numeric;
  v_now    timestamptz := clock_timestamp();
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  -- 【二重更新と競合を止める】
  --   for update で行を押さえてから判定する。押さえないと、
  --   2つの更新が同時に「まだ更新できる」を通り抜けて、
  --   2回ぶんの時間が入る。
  select p.id, p.status, p.time_limit_seconds, p.deadline_at, p.renew_count
    into v_p
    from public.prompts p
   where p.id = p_prompt_id
     and p.created_by = v_uid
   for update;

  if not found then
    raise exception 'PROMPT_NOT_FOUND: そのお題は見つかりません。';
  end if;

  if v_p.status <> 'active' then
    raise exception
      'PROMPT_NOT_ACTIVE: そのお題はもう更新できません（状態: %）。', v_p.status;
  end if;

  -- 無制限には更新を適用しない（D163）
  if v_p.time_limit_seconds is null or v_p.deadline_at is null then
    raise exception
      'UNLIMITED_NO_RENEW: 制作時間が無制限のお題に、時間の更新はありません。';
  end if;

  v_timer := public.prompt_timer_json(p_prompt_id);

  if (v_timer ->> 'is_expired')::boolean then
    raise exception
      'RENEW_TOO_LATE: 猶予が終わっています。この挑戦は続けられません。';
  end if;

  if not (v_timer ->> 'can_renew')::boolean then
    raise exception
      'RENEW_TOO_EARLY: まだ更新できません。残りが元の制限時間の1/4になってからです。';
  end if;

  select tp.ratio into v_grant
    from public.time_policy tp where tp.policy_key = 'renew_grant_ratio';

  -- 更新後の期限は「更新した時刻 ＋ 0.75T」。
  -- **更新前に残っていた時間は繰り越さない**（D163）
  update public.prompts p
     set deadline_at     = v_now + make_interval(
                             secs => (p.time_limit_seconds * v_grant)::double precision),
         renew_count     = p.renew_count + 1,
         last_renewed_at = v_now
   where p.id = p_prompt_id;

  return public.prompt_timer_json(p_prompt_id);
end;
$fn$;

comment on function public.renew_prompt_deadline(uuid) is
  'オーバー更新（D163）。更新後の期限は 更新時刻 + 0.75T。残り時間は繰り越さない。'
  '無制限には適用しない。行を for update で押さえてから判定するので二重更新にならない。';


-- ----------------------------------------------------------------------------
-- 7. 猶予を使い切ったお題を失敗にする（掃除）
-- ----------------------------------------------------------------------------
--
-- **作品データには触れない**（D163）。prompts の status を変えるだけ。
-- 既に作品がある（submitted）お題は対象外。

create or replace function public.expire_overdue_prompts(p_limit int default 500)
returns int
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_grace numeric;
  v_count int;
begin
  select tp.ratio into v_grace
    from public.time_policy tp where tp.policy_key = 'grace_ratio';

  with target as (
    select p.id
      from public.prompts p
     where p.status = 'active'
       and p.time_limit_seconds is not null
       and p.deadline_at is not null
       and clock_timestamp() >
           p.deadline_at + make_interval(
             secs => (p.time_limit_seconds * v_grace)::double precision)
     order by p.deadline_at
     limit greatest(1, coalesce(p_limit, 500))
  )
  update public.prompts p
     set status    = 'failed',
         failed_at = greatest(clock_timestamp(), p.created_at)
    from target t
   where p.id = t.id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

comment on function public.expire_overdue_prompts(int) is
  '猶予を使い切った制作挑戦を失敗にする（D163）。作品画像・作品行には触れない。'
  '無制限のお題は対象外。';

revoke all on function public.expire_overdue_prompts(int)
  from public, anon, authenticated;
grant execute on function public.expire_overdue_prompts(int) to service_role;


-- ----------------------------------------------------------------------------
-- 8. 投稿を受け付ける側で期限を守る
-- ----------------------------------------------------------------------------
--
-- 【なぜ create_work の中ではなくトリガーなのか】
--   works へ行が入る経路が将来増えても、必ずここを通るため。
--   画面の表示だけで守ると、フォームを直接叩かれたときに素通りする。
--
-- 【猶予の中は通す】
--   期限を過ぎていても、猶予を使い切るまでは挑戦が続いている（D163）。
--   止めるのは猶予も使い切ったときだけ。
--
-- 【無制限は素通り】
--   deadline_at が null の行は判定に入らない。

create or replace function public.works_guard_prompt_deadline()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_p     record;
  v_grace numeric;
begin
  select p.id, p.time_limit_seconds, p.deadline_at, p.status
    into v_p
    from public.prompts p
   where p.id = new.prompt_id;

  if not found then
    return new;   -- 存在しないお題は create_work 側が先に断る
  end if;

  if v_p.status = 'failed' then
    raise exception
      'PROMPT_EXPIRED: この挑戦は時間切れで終了しています。'
      '新しいお題を引いてください。';
  end if;

  -- 無制限、または期限を持たない古いお題は素通り
  if v_p.time_limit_seconds is null or v_p.deadline_at is null then
    return new;
  end if;

  select tp.ratio into v_grace
    from public.time_policy tp where tp.policy_key = 'grace_ratio';

  if clock_timestamp() >
     v_p.deadline_at + make_interval(
       secs => (v_p.time_limit_seconds * v_grace)::double precision) then
    -- **ここで status を 'failed' に書き換えない。**
    --   例外を投げるとこのトランザクション全体が巻き戻るので、
    --   同じトランザクションで書いた更新も一緒に消える。
    --   「書いたつもりで消えている」がいちばん見つけにくい。
    --
    --   状態を 'failed' にするのは expire_overdue_prompts（掃除）の役目。
    --   掃除が回るまでの間も、投稿はこの検査で必ず止まる。
    --   画面は status ではなく prompt_timer_json の is_expired を見るので、
    --   掃除を待たずに「終了しました」と出せる。
    raise exception
      'PROMPT_EXPIRED: 制作時間の猶予を過ぎました。'
      '時間を更新しないまま猶予を使い切ったため、この挑戦は失敗です。'
      '作品の画像やこれまでの記録は消えません。';
  end if;

  return new;
end;
$fn$;

comment on function public.works_guard_prompt_deadline() is
  '投稿の受け口で制作時間の猶予を守る（D163）。猶予の中は通す。無制限は素通り。'
  '作品データは消さない。';

drop trigger if exists works_guard_prompt_deadline_trigger on public.works;
create trigger works_guard_prompt_deadline_trigger
  before insert on public.works
  for each row
  execute function public.works_guard_prompt_deadline();

revoke all on function public.works_guard_prompt_deadline()
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 9. お題を確定するときに期限を入れる
-- ----------------------------------------------------------------------------
--
-- complete_draft の中に書かず、prompts への INSERT トリガーにする。
-- お題が作られる経路が増えても、必ず期限が入る。

create or replace function public.prompts_set_initial_deadline()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  -- 無制限（T が無い）には期限を入れない。明示的な分岐（D163）
  if new.time_limit_seconds is null then
    new.deadline_at := null;
    return new;
  end if;

  if new.deadline_at is null then
    new.deadline_at := coalesce(new.created_at, clock_timestamp())
                       + make_interval(secs => new.time_limit_seconds);
  end if;

  return new;
end;
$fn$;

comment on function public.prompts_set_initial_deadline() is
  '初期の期限＝お題の確定時刻 ＋ T（D163）。無制限には入れない。';

drop trigger if exists prompts_set_initial_deadline_trigger on public.prompts;
create trigger prompts_set_initial_deadline_trigger
  before insert on public.prompts
  for each row
  execute function public.prompts_set_initial_deadline();

revoke all on function public.prompts_set_initial_deadline()
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 10. 実行権限
-- ----------------------------------------------------------------------------

revoke all on function public.get_prompt_timer(uuid)
  from public, anon, authenticated;
revoke all on function public.renew_prompt_deadline(uuid)
  from public, anon, authenticated;

grant execute on function public.get_prompt_timer(uuid) to authenticated;
grant execute on function public.renew_prompt_deadline(uuid) to authenticated;


-- prompts に足した4列（deadline_at / renew_count / last_renewed_at / failed_at）は
-- 誰にも列権限を配らない。列を足しただけでは権限は付かないので、ここでは何もしない。
-- 期限は get_prompt_timer から読む。表を直接読ませる必要が無い。
