-- ============================================================================
-- challenge_clock ／ 制作挑戦の時計を「開始の受理」から一本で通す（D163 の修正）
-- ============================================================================
--
-- 【いままでの作り（2026-09-04 の実装）】
--   期限は prompts に INSERT が入った瞬間、つまり **complete_draft でお題が
--   確定した瞬間**に「確定時刻 ＋ T」で作られていた。
--   ドラフトを始めてからカードをめくり終えるまでの時間は、どこにも記録が無く、
--   期限にも入っていなかった。伏せカードを何時間眺めても損をしない。
--
-- 【これからの作り】
--   時計はドラフトを始める操作をサーバーが受理した時刻から動く。
--     ・draft_sessions.started_at   … 挑戦の開始時刻。ここが唯一の起点
--     ・draft_sessions.deadline_at  … ドラフト中も期限が進む
--     ・complete_draft が started_at / deadline_at / renew_count を
--       そのまま prompts へ引き継ぐ。**確定で時計は取り直されない。**
--
--   引き継ぎを壊せないように、started_at は UPDATE で書き換えられない
--   （トリガーで拒否する）。
--
-- 【総経過時間と残り時間は別物】
--   総経過      … いま − started_at。更新しても猶予に入っても減らない
--   残り        … deadline_at − いま。更新すると 0.75T へ入れ替わる
--   この2つを1つの列にまとめない。まとめると更新のたびに経過が消える。
--
-- 【無制限（T が null）】
--   期限・猶予・更新・時間切れの失敗を、いっさい適用しない。
--   経過時間だけを数える。分岐は has_deadline / is_unlimited で明示する。
--
-- 【終了の記録】
--   投稿・失敗のときに elapsed_seconds を書き込む。
--   投稿後は時計を止めて、その値を「かかった時間」として出す。
--
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 開始時刻の列
-- ----------------------------------------------------------------------------
--
-- 既存行の started_at は created_at を写す。
-- **これは記録であって、期限を作る処理ではない。**
-- 既存のお題へ期限を入れる処理は、この migration には無い
-- （supabase/manual/ に分けてある。標準の deploy では走らない）。

alter table public.draft_sessions
  add column if not exists started_at timestamptz;

update public.draft_sessions ds
   set started_at = ds.created_at
 where ds.started_at is null;

alter table public.draft_sessions
  alter column started_at set default now();

alter table public.draft_sessions
  alter column started_at set not null;

alter table public.draft_sessions
  add column if not exists deadline_at timestamptz;

alter table public.draft_sessions
  add column if not exists renew_count int not null default 0;

alter table public.draft_sessions
  add column if not exists last_renewed_at timestamptz;

alter table public.draft_sessions
  add column if not exists failed_at timestamptz;

comment on column public.draft_sessions.started_at is
  '制作挑戦の開始時刻。start_draft をサーバーが受理した瞬間。'
  'ここが総経過時間の起点で、確定お題へそのまま引き継がれる。UPDATE で変えられない。';
comment on column public.draft_sessions.deadline_at is
  'ドラフト中の期限。null は無制限。complete_draft が prompts へ引き継ぐ。';


alter table public.prompts
  add column if not exists started_at timestamptz;

-- least() を挟むのは、お題の作成時刻より後の開始時刻を作らないため。
-- 通常はドラフトのほうが先だが、試験データや手で入れた行では逆転しうる。
update public.prompts p
   set started_at = least(
         coalesce(
           (select ds.started_at from public.draft_sessions ds
             where ds.id = p.draft_session_id),
           p.created_at),
         p.created_at)
 where p.started_at is null;

alter table public.prompts
  alter column started_at set default now();

alter table public.prompts
  alter column started_at set not null;

alter table public.prompts
  add column if not exists elapsed_seconds bigint;

comment on column public.prompts.started_at is
  '制作挑戦の開始時刻（ドラフトを始めた瞬間）。お題の確定時刻ではない。'
  '総経過時間はここから数える。UPDATE で変えられない。';
comment on column public.prompts.elapsed_seconds is
  '挑戦が終わったときの総経過秒（投稿または失敗）。started_at からの実測。';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.prompts'::regclass
       and conname = 'prompts_started_before_created'
  ) then
    alter table public.prompts
      add constraint prompts_started_before_created
      check (started_at <= created_at + interval '1 second');
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- 2. 開始時刻は書き換えられない
-- ----------------------------------------------------------------------------
--
-- 「途中で時間をリセットできないようにする」を、画面ではなく DB で守る。
-- 更新（オーバー更新）は deadline_at を動かすもので、started_at は動かない。

create or replace function public.guard_started_at_immutable()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.started_at is distinct from old.started_at then
    raise exception
      'STARTED_AT_IMMUTABLE: 制作挑戦の開始時刻は変更できません。';
  end if;
  return new;
end;
$fn$;

comment on function public.guard_started_at_immutable() is
  '開始時刻の書き換えを止める。時計のリセットを DB 側で不可能にする。';

drop trigger if exists draft_sessions_started_at_immutable on public.draft_sessions;
create trigger draft_sessions_started_at_immutable
  before update on public.draft_sessions
  for each row
  execute function public.guard_started_at_immutable();

drop trigger if exists prompts_started_at_immutable on public.prompts;
create trigger prompts_started_at_immutable
  before update on public.prompts
  for each row
  execute function public.guard_started_at_immutable();

revoke all on function public.guard_started_at_immutable()
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 3. ドラフトにも 'failed' を足す
-- ----------------------------------------------------------------------------
--
-- 猶予まで使い切ったドラフトは、お題を確定できない。
-- 状態を1つ足して、掃除がそこへ落とす。**候補も履歴も消さない。**

alter table public.draft_sessions drop constraint if exists draft_sessions_status_valid;
alter table public.draft_sessions
  add constraint draft_sessions_status_valid check (
    status in ('in_progress', 'completed', 'abandoned', 'failed')
  );

alter table public.draft_sessions drop constraint if exists draft_sessions_status_timestamps;
alter table public.draft_sessions
  add constraint draft_sessions_status_timestamps check (
    (status = 'in_progress' and completed_at is null     and abandoned_at is null
                            and failed_at is null)
    or
    (status = 'completed'   and completed_at is not null and abandoned_at is null
                            and failed_at is null)
    or
    (status = 'abandoned'   and abandoned_at is not null and completed_at is null
                            and failed_at is null)
    or
    (status = 'failed'      and failed_at is not null    and completed_at is null
                            and abandoned_at is null)
  );

-- 1人1つの制限は in_progress にだけ効く。failed は新しく引ける
-- （既存の部分UNIQUE索引が status = 'in_progress' 限定なので、そのままでよい）

create index if not exists draft_sessions_deadline_idx
  on public.draft_sessions (deadline_at)
  where status = 'in_progress' and deadline_at is not null;


-- ----------------------------------------------------------------------------
-- 4. 期限の判定を1本にする
-- ----------------------------------------------------------------------------
--
-- ドラフトと確定お題で、同じ規則を2回書かない。
-- prompt_timer_json も draft_timer_json も、この1本を呼ぶ。
--
-- 【返す値】
--   elapsed_seconds  開始からの総経過秒（更新しても減らない）
--   seconds_left     期限までの残り秒（過ぎていれば負）
--   overrun_seconds  期限を過ぎてからの秒（過ぎていなければ0）
--   grace_left_seconds 猶予が終わるまでの秒（期限内なら猶予はまだ始まっていない）

create or replace function public.timer_core_json(
  p_status       text,
  p_time_limit   int,
  p_started_at   timestamptz,
  p_deadline_at  timestamptz,
  p_renew_count  int,
  p_finished_at  timestamptz,
  p_elapsed      bigint
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_now       timestamptz := clock_timestamp();
  v_threshold numeric;
  v_grace     numeric;
  v_t         numeric;
  v_open      timestamptz;
  v_grace_end timestamptz;
  v_elapsed   bigint;
begin
  -- 終わっている挑戦は時計を止める。止めた時点の経過を出す
  if p_finished_at is not null then
    v_elapsed := coalesce(
      p_elapsed,
      floor(extract(epoch from (p_finished_at - p_started_at)))::bigint);
  else
    v_elapsed := greatest(0, floor(extract(epoch from (v_now - p_started_at))))::bigint;
  end if;

  -- 無制限、または期限を持たない古い挑戦
  if p_time_limit is null or p_deadline_at is null then
    return jsonb_build_object(
      'status',             p_status,
      'is_unlimited',       p_time_limit is null,
      'has_deadline',       false,
      'started_at',         p_started_at,
      'elapsed_seconds',    v_elapsed,
      'deadline_at',        null,
      'seconds_left',       null,
      'overrun_seconds',    0,
      'grace_left_seconds', null,
      'can_renew',          false,
      'renew_opens_at',     null,
      'grace_ends_at',      null,
      'is_expired',         false,
      'renew_count',        coalesce(p_renew_count, 0),
      'time_limit_seconds', p_time_limit,
      'finished_at',        p_finished_at,
      'server_now',         v_now
    );
  end if;

  select tp.ratio into v_threshold
    from public.time_policy tp where tp.policy_key = 'renew_threshold_ratio';
  select tp.ratio into v_grace
    from public.time_policy tp where tp.policy_key = 'grace_ratio';

  v_t         := p_time_limit;
  v_open      := p_deadline_at - make_interval(secs => (v_t * v_threshold)::double precision);
  v_grace_end := p_deadline_at + make_interval(secs => (v_t * v_grace)::double precision);

  return jsonb_build_object(
    'status',             p_status,
    'is_unlimited',       false,
    'has_deadline',       true,
    'started_at',         p_started_at,
    'elapsed_seconds',    v_elapsed,
    'deadline_at',        p_deadline_at,
    'seconds_left',       floor(extract(epoch from (p_deadline_at - v_now)))::bigint,
    'overrun_seconds',
      greatest(0, floor(extract(epoch from (v_now - p_deadline_at))))::bigint,
    'grace_left_seconds', floor(extract(epoch from (v_grace_end - v_now)))::bigint,
    -- 更新できるのは「更新可能化から猶予の終わりまで」。
    -- 期限を過ぎていても、猶予の中なら更新できる（D163）
    'can_renew',
      p_finished_at is null and p_status in ('active', 'in_progress')
      and v_now >= v_open and v_now <= v_grace_end,
    'renew_opens_at',     v_open,
    'grace_ends_at',      v_grace_end,
    'is_expired',         v_now > v_grace_end,
    'renew_count',        coalesce(p_renew_count, 0),
    'time_limit_seconds', p_time_limit,
    'finished_at',        p_finished_at,
    'server_now',         v_now
  );
end;
$fn$;

comment on function public.timer_core_json(text, int, timestamptz, timestamptz, int, timestamptz, bigint) is
  '制作挑戦の時間の状態を1か所で計算する（D163）。ドラフトと確定お題が同じ規則を使う。'
  '総経過は開始時刻から、残りは期限から。2つを混ぜない。内部専用。';

revoke all on function public.timer_core_json(text, int, timestamptz, timestamptz, int, timestamptz, bigint)
  from public, anon, authenticated;


-- prompt_timer_json を、この1本を呼ぶ形に置き換える。
-- **返り値のキーは減らさない。**既存の画面と試験がそのまま動く。
create or replace function public.prompt_timer_json(p_prompt_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_p record;
begin
  select p.id, p.status, p.time_limit_seconds, p.deadline_at, p.started_at,
         p.renew_count, p.last_renewed_at, p.created_at, p.failed_at,
         p.submitted_at, p.abandoned_at, p.elapsed_seconds
    into v_p
    from public.prompts p
   where p.id = p_prompt_id;

  if not found then
    return null;
  end if;

  return public.timer_core_json(
    v_p.status,
    v_p.time_limit_seconds,
    v_p.started_at,
    v_p.deadline_at,
    v_p.renew_count,
    coalesce(v_p.submitted_at, v_p.failed_at, v_p.abandoned_at),
    v_p.elapsed_seconds);
end;
$fn$;


create or replace function public.draft_timer_json(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_s record;
begin
  select ds.id, ds.status, ds.time_limit_seconds, ds.deadline_at, ds.started_at,
         ds.renew_count, ds.completed_at, ds.abandoned_at, ds.failed_at
    into v_s
    from public.draft_sessions ds
   where ds.id = p_session_id;

  if not found then
    return null;
  end if;

  return public.timer_core_json(
    v_s.status,
    v_s.time_limit_seconds,
    v_s.started_at,
    v_s.deadline_at,
    v_s.renew_count,
    coalesce(v_s.completed_at, v_s.abandoned_at, v_s.failed_at),
    null);
end;
$fn$;

comment on function public.draft_timer_json(uuid) is
  'ドラフト中の時間の状態（D163）。お題の確定前から時計は動いている。内部専用。';

revoke all on function public.draft_timer_json(uuid)
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 5. ドラフトを始めた瞬間に期限を入れる
-- ----------------------------------------------------------------------------

create or replace function public.draft_sessions_set_initial_deadline()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.started_at is null then
    new.started_at := coalesce(new.created_at, clock_timestamp());
  end if;

  -- 無制限には期限を入れない（D163）。明示的な分岐
  if new.time_limit_seconds is null then
    new.deadline_at := null;
    return new;
  end if;

  if new.deadline_at is null then
    new.deadline_at := new.started_at
                       + make_interval(secs => new.time_limit_seconds);
  end if;

  return new;
end;
$fn$;

comment on function public.draft_sessions_set_initial_deadline() is
  '挑戦開始の期限＝開始時刻 ＋ T（D163）。無制限には入れない。';

drop trigger if exists draft_sessions_set_initial_deadline_trigger on public.draft_sessions;
create trigger draft_sessions_set_initial_deadline_trigger
  before insert on public.draft_sessions
  for each row
  execute function public.draft_sessions_set_initial_deadline();

revoke all on function public.draft_sessions_set_initial_deadline()
  from public, anon, authenticated;


-- 確定お題の初期期限は「開始時刻 ＋ T」。
-- complete_draft が deadline_at を明示的に渡してくる場合はそれを尊重する
-- （＝ドラフト中に更新した期限がそのまま続く）。
create or replace function public.prompts_set_initial_deadline()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.started_at is null then
    new.started_at := coalesce(new.created_at, clock_timestamp());
  end if;

  if new.time_limit_seconds is null then
    new.deadline_at := null;
    return new;
  end if;

  if new.deadline_at is null then
    new.deadline_at := new.started_at
                       + make_interval(secs => new.time_limit_seconds);
  end if;

  return new;
end;
$fn$;

comment on function public.prompts_set_initial_deadline() is
  '初期の期限＝挑戦の開始時刻 ＋ T（D163）。'
  'complete_draft が引き継いだ期限を渡してきたときは、それを残す。無制限には入れない。';


-- ----------------------------------------------------------------------------
-- 6. 終わった挑戦の経過時間を記録する
-- ----------------------------------------------------------------------------
--
-- 投稿（submitted）と失敗（failed）と放棄（abandoned）のときに、
-- そこまでの総経過秒を書き込む。**あとから数え直せなくならないように**残す。

create or replace function public.prompts_record_elapsed()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.status = old.status then
    return new;
  end if;

  if new.status in ('submitted', 'failed', 'abandoned')
     and new.elapsed_seconds is null then
    new.elapsed_seconds := greatest(0, floor(extract(epoch from (
      coalesce(new.submitted_at, new.failed_at, new.abandoned_at, clock_timestamp())
      - new.started_at))))::bigint;
  end if;

  return new;
end;
$fn$;

comment on function public.prompts_record_elapsed() is
  '挑戦が終わった時点の総経過秒を残す。投稿後の時計はここで止まる。';

drop trigger if exists prompts_record_elapsed_trigger on public.prompts;
create trigger prompts_record_elapsed_trigger
  before update on public.prompts
  for each row
  execute function public.prompts_record_elapsed();

revoke all on function public.prompts_record_elapsed()
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 7. ドラフト中の更新と、ドラフトの時間切れ
-- ----------------------------------------------------------------------------

create or replace function public.renew_draft_deadline(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_s     record;
  v_timer jsonb;
  v_grant numeric;
  v_now   timestamptz := clock_timestamp();
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select ds.id, ds.status, ds.time_limit_seconds, ds.deadline_at
    into v_s
    from public.draft_sessions ds
   where ds.id = p_session_id
     and ds.user_id = v_uid
   for update;

  if not found then
    raise exception 'DRAFT_NOT_FOUND: そのドラフトは見つかりません。';
  end if;

  if v_s.status <> 'in_progress' then
    raise exception
      'DRAFT_NOT_IN_PROGRESS: そのドラフトはもう更新できません（状態: %）。', v_s.status;
  end if;

  if v_s.time_limit_seconds is null or v_s.deadline_at is null then
    raise exception
      'UNLIMITED_NO_RENEW: 制作時間が無制限の挑戦に、時間の更新はありません。';
  end if;

  v_timer := public.draft_timer_json(p_session_id);

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

  update public.draft_sessions ds
     set deadline_at     = v_now + make_interval(
                             secs => (ds.time_limit_seconds * v_grant)::double precision),
         renew_count     = ds.renew_count + 1,
         last_renewed_at = v_now
   where ds.id = p_session_id;

  return public.draft_timer_json(p_session_id);
end;
$fn$;

comment on function public.renew_draft_deadline(uuid) is
  'ドラフト中のオーバー更新（D163）。規則は確定お題と同じ。総経過時間は減らない。';

revoke all on function public.renew_draft_deadline(uuid)
  from public, anon, authenticated;
grant execute on function public.renew_draft_deadline(uuid) to authenticated;


create or replace function public.expire_overdue_drafts(p_limit int default 500)
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
    select ds.id
      from public.draft_sessions ds
     where ds.status = 'in_progress'
       and ds.time_limit_seconds is not null
       and ds.deadline_at is not null
       and clock_timestamp() >
           ds.deadline_at + make_interval(
             secs => (ds.time_limit_seconds * v_grace)::double precision)
     order by ds.deadline_at
     limit greatest(1, coalesce(p_limit, 500))
  )
  update public.draft_sessions ds
     set status    = 'failed',
         failed_at = greatest(clock_timestamp(), ds.created_at)
    from target t
   where ds.id = t.id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

comment on function public.expire_overdue_drafts(int) is
  '猶予を使い切ったドラフトを失敗にする（D163）。候補も履歴も消さない。無制限は対象外。';

revoke all on function public.expire_overdue_drafts(int)
  from public, anon, authenticated;
grant execute on function public.expire_overdue_drafts(int) to service_role;


-- ----------------------------------------------------------------------------
-- 8. ドラフトの操作を、猶予の終わりで止める
-- ----------------------------------------------------------------------------
--
-- 掃除が回る前でも、その場の計算で止める。
-- 「画面には終了と出ているのに、めくれてしまう」を作らない。

create or replace function public.assert_draft_not_expired(p_session_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_timer jsonb;
begin
  v_timer := public.draft_timer_json(p_session_id);
  if v_timer is null then
    return;
  end if;

  if (v_timer ->> 'is_expired')::boolean then
    raise exception
      'DRAFT_EXPIRED: 制作時間の猶予を過ぎました。'
      '時間を更新しないまま猶予を使い切ったため、この挑戦は終了です。'
      '新しいお題を引いてください。';
  end if;
end;
$fn$;

comment on function public.assert_draft_not_expired(uuid) is
  'ドラフトの猶予が終わっていたら例外にする。めくる・引き直す・確定するの入口で使う。';

revoke all on function public.assert_draft_not_expired(uuid)
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 9. いま進行中の制作挑戦を1件返す（全ページ共通の帯が読む）
-- ----------------------------------------------------------------------------
--
-- 【返さないもの】
--   お題の語、カードの中身、他人の挑戦。**正解は1文字も返さない。**
--   返すのは時刻と秒数と、戻り先の URL だけ。
--
-- 【どれを返すか】
--   1. 進行中のドラフトがあれば、それ
--   2. 無ければ、いちばん新しい active のお題
--   3. どちらも無ければ、直近に終わった挑戦（時計は止まっている）
--
--   3 を返すのは「投稿し終えた直後に、かかった時間を出す」ため。
--   何分ぶん出すかは p_finished_window_seconds で決める
--   （既定 1800 秒。**この数は私が置いた暫定値で、承認を受けていない。**）

create or replace function public.get_active_challenge(
  p_finished_window_seconds int default 1800
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_id    uuid;
  v_timer jsonb;
  v_work  uuid;
  v_win   int := greatest(0, coalesce(p_finished_window_seconds, 1800));
begin
  if v_uid is null then
    return null;
  end if;

  -- 1. 進行中のドラフト
  select ds.id into v_id
    from public.draft_sessions ds
   where ds.user_id = v_uid
     and ds.status = 'in_progress'
   order by ds.started_at desc
   limit 1;

  if v_id is not null then
    v_timer := public.draft_timer_json(v_id);
    return v_timer
      || jsonb_build_object(
           'kind',        'draft',
           'id',          v_id,
           'href',        '/play',
           'is_finished', false,
           'work_id',     null);
  end if;

  -- 2. 進行中の確定お題
  select p.id into v_id
    from public.prompts p
   where p.created_by = v_uid
     and p.status = 'active'
   order by p.started_at desc
   limit 1;

  if v_id is not null then
    v_timer := public.prompt_timer_json(v_id);
    return v_timer
      || jsonb_build_object(
           'kind',        'prompt',
           'id',          v_id,
           'href',        '/prompt/' || v_id::text,
           'is_finished', false,
           'work_id',     null);
  end if;

  -- 3. 直近に終わった挑戦
  select p.id into v_id
    from public.prompts p
   where p.created_by = v_uid
     and p.status in ('submitted', 'failed')
     and coalesce(p.submitted_at, p.failed_at)
         > clock_timestamp() - make_interval(secs => v_win)
   order by coalesce(p.submitted_at, p.failed_at) desc
   limit 1;

  if v_id is null then
    return null;
  end if;

  select w.id into v_work from public.works w where w.prompt_id = v_id;

  v_timer := public.prompt_timer_json(v_id);
  return v_timer
    || jsonb_build_object(
         'kind',        'prompt',
         'id',          v_id,
         'href',        case when v_work is null then '/prompt/' || v_id::text
                             else '/works/' || v_work::text end,
         'is_finished', true,
         'work_id',     v_work);
end;
$fn$;

comment on function public.get_active_challenge(int) is
  'いまの制作挑戦の時間の状態を1件返す（全ページ共通の帯が読む）。'
  'お題の語も他人の挑戦も返さない。未サインインには null。';

revoke all on function public.get_active_challenge(int)
  from public, anon, authenticated;
grant execute on function public.get_active_challenge(int) to authenticated;


-- ----------------------------------------------------------------------------
-- 10. 帯から押す「制作時間を延ばす」
-- ----------------------------------------------------------------------------
--
-- どのページからでも押せる必要がある。帯は挑戦の ID を持たなくてよい
-- （持たせると、他人の ID を送られたときの判定が1か所増える）。

create or replace function public.renew_current_challenge()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_id  uuid;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select ds.id into v_id
    from public.draft_sessions ds
   where ds.user_id = v_uid and ds.status = 'in_progress'
   order by ds.started_at desc
   limit 1;

  if v_id is not null then
    perform public.renew_draft_deadline(v_id);
    return public.get_active_challenge();
  end if;

  select p.id into v_id
    from public.prompts p
   where p.created_by = v_uid and p.status = 'active'
   order by p.started_at desc
   limit 1;

  if v_id is null then
    raise exception 'NO_ACTIVE_CHALLENGE: いま進行中の制作挑戦がありません。';
  end if;

  perform public.renew_prompt_deadline(v_id);
  return public.get_active_challenge();
end;
$fn$;

comment on function public.renew_current_challenge() is
  'いまの制作挑戦の時間を延ばす（D163）。ドラフト中でも確定後でも同じ入口。';

revoke all on function public.renew_current_challenge()
  from public, anon, authenticated;
grant execute on function public.renew_current_challenge() to authenticated;


-- ----------------------------------------------------------------------------
-- 11. 掃除の窓に「猶予を使い切ったドラフト」を足す
-- ----------------------------------------------------------------------------

create or replace function public.cleanup_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'orphan_prompts', (select count(*) from public.prompts p
                        where p.created_by is null
                          and p.status in ('active', 'abandoned')
                          and not exists (select 1 from public.works w
                                           where w.prompt_id = p.id)),
    'overdue_prompts', (
      select count(*) from public.prompts p
       where p.status = 'active'
         and p.time_limit_seconds is not null
         and p.deadline_at is not null
         and clock_timestamp() > p.deadline_at + make_interval(
               secs => (p.time_limit_seconds
                        * (select tp.ratio from public.time_policy tp
                            where tp.policy_key = 'grace_ratio'))::double precision)),
    'overdue_drafts', (
      select count(*) from public.draft_sessions s
       where s.status = 'in_progress'
         and s.time_limit_seconds is not null
         and s.deadline_at is not null
         and clock_timestamp() > s.deadline_at + make_interval(
               secs => (s.time_limit_seconds
                        * (select tp.ratio from public.time_policy tp
                            where tp.policy_key = 'grace_ratio'))::double precision)),
    'stale_drafts', (select count(*) from public.draft_sessions s
                      where (s.status = 'in_progress'
                             and s.updated_at < now() - interval '30 days')
                         or (s.status in ('abandoned', 'failed')
                             and coalesce(s.abandoned_at, s.failed_at)
                                 < now() - interval '30 days')),
    'expired_agreements', (select count(*) from public.terms_agreements a
                            where a.retain_until < now()),
    'pending_images', (select count(*) from public.storage_cleanup_queue q
                        where q.deleted_at is null),
    'pending_account_deletions', (select count(*) from public.account_deletions),
    'stale_guests', (select count(*) from public.profiles p
                      where p.is_anonymous and p.account_status = 'active'
                        and p.created_at < now() - interval '30 days'
                        and not exists (select 1 from public.draft_sessions s
                                         where s.user_id = p.id
                                           and s.updated_at > now() - interval '30 days')
                        and not exists (select 1 from public.works w
                                         where w.user_id = p.id)),
    'works_missing_image_cleanup', (select count(*) from public.works w
                                     where w.deleted_at is not null
                                       and w.image_path is not null
                                       and w.image_deleted_at is null)
  )
$$;

comment on function public.cleanup_status() is
  '掃除の残り件数。減っていることを確かめるための窓。'
  '2026-09-05 に overdue_drafts（猶予を使い切ったドラフト）を足した。';

revoke all on function public.cleanup_status() from public, anon, authenticated;
grant execute on function public.cleanup_status() to service_role;
