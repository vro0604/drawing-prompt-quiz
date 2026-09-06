-- ============================================================================
-- carry_slots ／ 持ち出しの上限を「要素の個数」から「保存枠の数」へ直す
-- ============================================================================
--
-- 【何が違っていたか】
--   2026-09-05 の 20260905091000 は、保存上限 5／3 を
--   **要素1語ずつの行数**として実装していた（同ファイルの見出しコメントに
--   「行数（＝要素の個数）として実装している。単位が『組』だと決まったら…」と
--   書いてある）。
--
--   2026-09-05 のユーザー発言で単位が確定した。
--     「保存上限の単位は、個別の語数ではありません。
--       『1〜3要素をまとめた保存枠』の数です。」
--
--   したがって上限は次の意味になる。
--     ・自分のお題由来   … 最大 5 保存枠
--     ・他者のお題由来   … 最大 3 保存枠
--     ・1つの保存枠には、同じ元お題から選んだ 1〜3 要素が入る
--
-- 【表をどう分けたか】
--   保存枠                 public.saved_carry_slots      （新規）
--   保存枠内要素           public.saved_elements         （既存に枠IDを足す）
--   保存枠を使った派生お題 public.prompt_carry_slots     （新規）
--   派生お題へ入った要素   public.prompt_element_origins （既存に枠ID・要素IDを足す）
--
--   既存の表を作り直さず、列と表を足すだけにした。
--   **既に適用済みの migration を書き換えない**ため（適用履歴が食い違う）。
--
-- 【上限に達したらどうなるか】
--   保存しない。古い枠を勝手に消さない（原文「上限到達時は保存不可」
--   「破棄は利用者が行う」）。利用者が枠を捨てると空きができる。
--
-- 【この migration が変えないもの】
--   ・1回のお題へ持ち込める要素の数（1〜3個。D161）
--   ・セッション内の持ち出しはゲストも使えること（D166）
--   ・永続保存は登録者だけであること（D166）
--   ・フレーバーテキストが登録者限定であること（D164）
--
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 保存枠
-- ----------------------------------------------------------------------------
--
-- 1つの枠は「1回の持ち出し操作」に対応する。
-- 同じ元お題から選んだ1〜3要素が、1つの枠にまとまって入る。

create table if not exists public.saved_carry_slots (
  id bigint generated always as identity primary key,

  user_id uuid not null
    references public.profiles (id) on delete cascade on update restrict,

  -- session＝いまの流れの中だけ／self＝自分のお題から／others＝他者のお題から
  scope text not null
    constraint saved_carry_slots_scope_valid check (scope in ('session', 'self', 'others')),

  -- 出所が自分の制作・投稿か。上限の数え分けと、登録後の移し先の判断に使う
  source_is_own boolean not null,

  -- 元作品（他者作品から持ち出したとき）。作品が消えても枠は残す
  source_work_id uuid
    references public.works (id) on delete set null on update restrict,

  -- 元お題。自分のお題からでも他者作品からでも入る
  source_prompt_id uuid
    references public.prompts (id) on delete set null on update restrict,

  -- session の枠だけが持つ期限
  expires_at timestamptz,

  created_at timestamptz not null default now(),

  constraint saved_carry_slots_session_has_expiry
    check ((scope = 'session') = (expires_at is not null))
);

comment on table public.saved_carry_slots is
  '保存枠（2026-09-05 に単位が確定）。1枠に同じ元お題からの1〜3要素が入る。'
  '上限はこの枠の数で数える（自分のお題から5枠・他者のお題から3枠）。';
comment on column public.saved_carry_slots.scope is
  'session＝いまの流れの中だけ（ゲストも可・上限なし）、'
  'self＝自分のお題から永続（登録者・5枠）、others＝他者のお題から永続（登録者・3枠）。';

create index if not exists saved_carry_slots_user_idx
  on public.saved_carry_slots (user_id, created_at desc);

create index if not exists saved_carry_slots_expiry_idx
  on public.saved_carry_slots (expires_at) where scope = 'session';

alter table public.saved_carry_slots enable row level security;
revoke all on table public.saved_carry_slots from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 2. 保存枠内要素（既存の saved_elements を枠にぶら下げる）
-- ----------------------------------------------------------------------------

alter table public.saved_elements
  add column if not exists carry_slot_id bigint
    references public.saved_carry_slots (id) on delete cascade on update restrict;

alter table public.saved_elements
  add column if not exists position int;

comment on column public.saved_elements.carry_slot_id is
  'この要素が入っている保存枠。枠を捨てると要素も一緒に消える。';
comment on column public.saved_elements.position is
  '枠の中での並び（1〜3）。持ち出したときに選んだ順。';


-- --- 既存行を枠へ入れ直す ---------------------------------------------------
--
-- 同じ人・同じ区分・同じ元お題・同じ元作品のものを1つの枠にまとめる。
-- 4件以上ある場合は、3件ずつの枠に割る（1枠は最大3要素のため）。

do $$
declare
  g record;
  v_slot_id bigint;
  v_id      bigint;
  v_pos     int;
begin
  for g in
    select se.user_id, se.scope, se.source_is_own,
           se.source_work_id, se.source_prompt_id, se.expires_at,
           array_agg(se.id order by se.created_at, se.id) as ids
      from public.saved_elements se
     where se.carry_slot_id is null
     group by se.user_id, se.scope, se.source_is_own,
              se.source_work_id, se.source_prompt_id, se.expires_at
  loop
    v_pos := 0;
    v_slot_id := null;

    foreach v_id in array g.ids loop
      if v_pos = 0 or v_pos = 3 then
        insert into public.saved_carry_slots
          (user_id, scope, source_is_own, source_work_id, source_prompt_id, expires_at)
        values
          (g.user_id, g.scope, g.source_is_own, g.source_work_id, g.source_prompt_id,
           g.expires_at)
        returning id into v_slot_id;
        v_pos := 0;
      end if;

      v_pos := v_pos + 1;
      update public.saved_elements
         set carry_slot_id = v_slot_id, position = v_pos
       where id = v_id;
    end loop;
  end loop;
end $$;

-- 枠に入っていない要素はもう存在しない
alter table public.saved_elements
  alter column carry_slot_id set not null;

update public.saved_elements set position = 1 where position is null;

alter table public.saved_elements
  alter column position set not null;

do $$
begin
  -- 「同じ語は1人につき1つ」をやめる。**枠が単位になったため。**
  -- 別の作品から同じ語を持ち出したら、別の枠に別の出所として入る
  if exists (select 1 from pg_constraint
              where conrelid = 'public.saved_elements'::regclass
                and conname = 'saved_elements_unique') then
    alter table public.saved_elements drop constraint saved_elements_unique;
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.saved_elements'::regclass
                    and conname = 'saved_elements_slot_tag_unique') then
    alter table public.saved_elements
      add constraint saved_elements_slot_tag_unique unique (carry_slot_id, tag_id);
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.saved_elements'::regclass
                    and conname = 'saved_elements_position_range') then
    alter table public.saved_elements
      add constraint saved_elements_position_range check (position between 1 and 3);
  end if;
end $$;

create index if not exists saved_elements_slot_idx
  on public.saved_elements (carry_slot_id, position);


-- --- 1枠に4要素以上を入れさせない -------------------------------------------
--
-- 「1〜3要素をまとめた保存枠」を表の側でも守る。
-- RPC の中だけで数えると、別の入口が増えたときに漏れる。

create or replace function public.saved_elements_slot_size_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_count int;
begin
  select count(*) into v_count
    from public.saved_elements se
   where se.carry_slot_id = new.carry_slot_id;

  if v_count > 3 then
    raise exception
      'CARRY_SLOT_TOO_LARGE: 1つの保存枠に入れられるのは1〜3要素です（いま %要素）。',
      v_count;
  end if;

  return null;
end;
$fn$;

drop trigger if exists saved_elements_slot_size_guard_trigger on public.saved_elements;
create trigger saved_elements_slot_size_guard_trigger
  after insert or update of carry_slot_id on public.saved_elements
  for each row
  execute function public.saved_elements_slot_size_guard();

revoke all on function public.saved_elements_slot_size_guard()
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 3. 上限の値（単位が確定したので書き直す）
-- ----------------------------------------------------------------------------
--
-- 【is_provisional を false にした理由】
--   値も単位も、2026-09-05 のユーザー発言そのままになったため。
--     出所: 「自分のお題由来は最大5保存枠」「他者のお題由来は最大3保存枠」
--   session_ttl_hours だけは私が置いた値なので true のまま。

alter table public.carry_policy
  add column if not exists unit text not null default 'slot';

comment on column public.carry_policy.unit is
  '上限の数え方。slot＝保存枠の数（2026-09-05 にユーザーが確定）。'
  'element＝要素の個数（2026-09-05 の初回実装。誤りだった）。';

update public.carry_policy
   set value = 5, unit = 'slot', is_provisional = false,
       note = 'セッション外・自己お題の保存上限。単位は保存枠。出所: ユーザー発言「自分のお題由来は最大5保存枠」',
       updated_at = now()
 where policy_key = 'self_max';

update public.carry_policy
   set value = 3, unit = 'slot', is_provisional = false,
       note = 'セッション外・他者お題の保存上限。単位は保存枠。出所: ユーザー発言「他者のお題由来は最大3保存枠」',
       updated_at = now()
 where policy_key = 'others_max';

update public.carry_policy
   set unit = 'hour'
 where policy_key = 'session_ttl_hours';


-- ----------------------------------------------------------------------------
-- 4. 派生の記録（枠単位・要素単位の両方）
-- ----------------------------------------------------------------------------
--
-- 【なぜ2つ要るか】
--   1つの保存枠から一部だけ使うことがある（3要素の枠から1要素だけ持ち込む）。
--   枠だけを記録すると「どれを使ったか」が残らず、
--   要素だけを記録すると「どの枠から来たか」が残らない。

create table if not exists public.prompt_carry_slots (
  id bigint generated always as identity primary key,

  prompt_id uuid not null
    references public.prompts (id) on delete cascade on update restrict,

  -- 枠を捨てても派生の記録は残す
  carry_slot_id bigint
    references public.saved_carry_slots (id) on delete set null on update restrict,

  -- 枠が消えても出所をたどれるように、ここへ写しておく
  source_is_own boolean not null,
  source_work_id uuid
    references public.works (id) on delete set null on update restrict,
  source_prompt_id uuid
    references public.prompts (id) on delete set null on update restrict,

  -- その枠が何要素あって、そのうち何要素をこのお題へ入れたか
  slot_size int not null
    constraint prompt_carry_slots_size_range check (slot_size between 1 and 3),
  used_count int not null
    constraint prompt_carry_slots_used_range check (used_count between 1 and 3),

  created_at timestamptz not null default now(),

  constraint prompt_carry_slots_unique unique (prompt_id, carry_slot_id)
);

comment on table public.prompt_carry_slots is
  '保存枠を使用した派生お題。1つの枠から一部だけ使った場合も、'
  '枠の要素数と使った数の両方を残す。prompt_id を含むため公開しない。';

create index if not exists prompt_carry_slots_slot_idx
  on public.prompt_carry_slots (carry_slot_id);

alter table public.prompt_carry_slots enable row level security;
revoke all on table public.prompt_carry_slots from public, anon, authenticated;


alter table public.prompt_element_origins
  add column if not exists carry_slot_id bigint
    references public.saved_carry_slots (id) on delete set null on update restrict;

alter table public.prompt_element_origins
  add column if not exists saved_element_id bigint;

alter table public.prompt_element_origins
  add column if not exists source_is_own boolean;

comment on column public.prompt_element_origins.carry_slot_id is
  'どの保存枠から来た要素か。枠を捨てても行は残る（set null）。';
comment on column public.prompt_element_origins.saved_element_id is
  'どの保存枠内要素だったか。枠を捨てたあとの照合用に、参照ではなく値で持つ。';


-- ドラフトへ持ち込んだ要素にも、枠と要素の id を残す
alter table public.draft_session_carried
  add column if not exists carry_slot_id bigint
    references public.saved_carry_slots (id) on delete set null on update restrict;

alter table public.draft_session_carried
  add column if not exists saved_element_id bigint;

alter table public.draft_session_carried
  add column if not exists source_is_own boolean not null default true;


-- ----------------------------------------------------------------------------
-- 5. 一覧（枠と要素の両方を返す）
-- ----------------------------------------------------------------------------

create or replace function public.list_saved_elements()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  with mine as (
    select s.*
      from public.saved_carry_slots s
     where s.user_id = (select auth.uid())
       and (s.scope <> 'session' or s.expires_at > clock_timestamp())
  ),
  slot_items as (
    select se.carry_slot_id,
           jsonb_agg(
             jsonb_build_object(
               'id',             se.id,
               'tag_id',         se.tag_id,
               'tag_label',      tg.label,
               'category_key',   tg.pool_key,
               'category_label', tp.label,
               'category_kind',  coalesce(dc.kind, 'legacy'),
               'position',       se.position
             ) order by se.position
           ) as items,
           count(*) as n
      from public.saved_elements se
      join mine m on m.id = se.carry_slot_id
      join public.tags      tg on tg.id       = se.tag_id
      join public.tag_pools tp on tp.pool_key = tg.pool_key
      left join public.draw_categories dc on dc.pool_key = tg.pool_key
     group by se.carry_slot_id
  )
  select jsonb_build_object(
    'slots', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',              m.id,
          'scope',           m.scope,
          'source_is_own',   m.source_is_own,
          'source_work_id',  m.source_work_id,
          'has_source_work', m.source_work_id is not null,
          'expires_at',      m.expires_at,
          'created_at',      m.created_at,
          'element_count',   coalesce(si.n, 0),
          'elements',        coalesce(si.items, '[]'::jsonb)
        ) order by m.created_at desc
      )
      from mine m
      left join slot_items si on si.carry_slot_id = m.id
    ), '[]'::jsonb),

    -- 平らな要素の一覧。枠の情報を各行に写してある
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',              se.id,
          'carry_slot_id',   m.id,
          'position',        se.position,
          'tag_id',          se.tag_id,
          'tag_label',       tg.label,
          'category_key',    tg.pool_key,
          'category_label',  tp.label,
          'category_kind',   coalesce(dc.kind, 'legacy'),
          'scope',           m.scope,
          'source_is_own',   m.source_is_own,
          'source_work_id',  m.source_work_id,
          'has_source_work', m.source_work_id is not null,
          'expires_at',      m.expires_at,
          'created_at',      se.created_at
        ) order by m.created_at desc, se.position
      )
      from public.saved_elements se
      join mine m on m.id = se.carry_slot_id
      join public.tags      tg on tg.id       = se.tag_id
      join public.tag_pools tp on tp.pool_key = tg.pool_key
      left join public.draw_categories dc on dc.pool_key = tg.pool_key
    ), '[]'::jsonb),

    -- **上限と突き合わせる数はここ。保存枠の数を数える**
    'counts', jsonb_build_object(
      'session', (select count(*) from mine where scope = 'session'),
      'self',    (select count(*) from mine where scope = 'self'),
      'others',  (select count(*) from mine where scope = 'others')
    ),
    'element_counts', jsonb_build_object(
      'session', (select count(*) from public.saved_elements se
                   join mine m on m.id = se.carry_slot_id where m.scope = 'session'),
      'self',    (select count(*) from public.saved_elements se
                   join mine m on m.id = se.carry_slot_id where m.scope = 'self'),
      'others',  (select count(*) from public.saved_elements se
                   join mine m on m.id = se.carry_slot_id where m.scope = 'others')
    ),
    'limits', jsonb_build_object(
      'self',   (select value from public.carry_policy where policy_key = 'self_max'),
      'others', (select value from public.carry_policy where policy_key = 'others_max')
    ),
    'limit_unit', 'slot',
    'max_per_slot', 3,
    'can_persist', not coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
  );
$fn$;

comment on function public.list_saved_elements() is
  '自分の保存枠と、枠の中の要素。上限は保存枠の数で数える（2026-09-05 に確定）。'
  '元お題IDは返さない（D23）。期限切れのセッション枠は返さない。';


-- ----------------------------------------------------------------------------
-- 6. 保存（1回の操作で1つの保存枠を作る）
-- ----------------------------------------------------------------------------

create or replace function public.save_prompt_elements(
  p_source_kind text,
  p_source_id   uuid,
  p_tag_ids     bigint[],
  p_persist     boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid          uuid := (select auth.uid());
  v_is_anonymous boolean;
  v_prompt_id    uuid;
  v_work_id      uuid;
  v_owner        uuid;
  v_count        int;
  v_matched      int;
  v_scope        text;
  v_is_own       boolean;
  v_expires      timestamptz;
  v_limit        int;
  v_have         int;
  v_slot_id      bigint;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  v_is_anonymous := coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false);

  if p_tag_ids is null then
    raise exception 'BAD_ELEMENTS: 持ち出す要素が指定されていません。';
  end if;

  select count(*) into v_count
    from (select distinct unnest(p_tag_ids) as tag_id) x;

  if v_count <> coalesce(array_length(p_tag_ids, 1), 0) then
    raise exception 'DUPLICATE_ELEMENT: 同じ要素を2回指定することはできません。';
  end if;

  if v_count < 1 or v_count > 3 then
    raise exception
      'BAD_ELEMENT_COUNT: 1つの保存枠に入れられるのは1〜3個です（いま %個）。', v_count;
  end if;

  -- --- 出所を確かめ、自分のものかどうかを決める -----------------------------
  if p_source_kind = 'work' then
    select w.id, w.prompt_id, w.user_id into v_work_id, v_prompt_id, v_owner
      from public.works w
     where w.id = p_source_id
       and w.is_published
       and w.review_status = 'ok'
       and w.deleted_at is null
       and (
         w.user_id = v_uid
         or exists (select 1 from public.answers a
                     where a.work_id = w.id and a.user_id = v_uid)
       );

    if v_prompt_id is null then
      raise exception
        'SOURCE_NOT_AVAILABLE: その作品のお題はまだ開示されていません。'
        '先にクイズへ回答してください。';
    end if;

    v_is_own := (v_owner = v_uid);

  elsif p_source_kind = 'prompt' then
    select p.id into v_prompt_id
      from public.prompts p
     where p.id = p_source_id
       and p.created_by = v_uid;

    if v_prompt_id is null then
      raise exception 'SOURCE_NOT_FOUND: そのお題は見つかりません。';
    end if;

    v_work_id := null;
    v_is_own  := true;

  else
    raise exception 'BAD_SOURCE_KIND: 出所の種類 % は使えません。', p_source_kind;
  end if;

  -- --- 区分を決める ---------------------------------------------------------
  if v_is_anonymous or not coalesce(p_persist, true) then
    v_scope := 'session';
    v_expires := clock_timestamp() + make_interval(
      hours => (select cp.value from public.carry_policy cp
                 where cp.policy_key = 'session_ttl_hours'));
  elsif v_is_own then
    v_scope := 'self';
    v_expires := null;
  else
    v_scope := 'others';
    v_expires := null;
  end if;

  -- --- 指定された語が、本当にそのお題に入っているか -------------------------
  --
  -- **distinct で数える。**同じ語が1つのお題の2つの枠に入っていることが
  -- ありうる（例: 同じ状態カテゴリが2回出て、たまたま同じ語が選ばれる場合）。
  -- 素の count(*) だと、その語1つで2件と数えられて件数が食い違い、
  -- 正当な持ち出しが「お題に含まれない」として断られる。
  select count(distinct pc.tag_id) into v_matched
    from public.prompt_cards pc
   where pc.prompt_id = v_prompt_id
     and pc.tag_id = any(p_tag_ids);

  if v_matched <> v_count then
    raise exception
      'ELEMENT_NOT_IN_PROMPT: そのお題に含まれない要素が指定されています。';
  end if;

  -- --- 永続保存の上限（**保存枠の数**で数える）------------------------------
  if v_scope <> 'session' then
    select cp.value into v_limit
      from public.carry_policy cp
     where cp.policy_key = (case when v_scope = 'self' then 'self_max' else 'others_max' end);

    select count(*) into v_have
      from public.saved_carry_slots s
     where s.user_id = v_uid and s.scope = v_scope;

    if v_have + 1 > v_limit then
      raise exception
        'CARRY_LIMIT_REACHED: %持ち出して手元に残せるのは%枠までです'
        '（いま%枠。1枠に1〜3要素）。使わない枠を捨ててから保存してください。',
        (case when v_scope = 'self' then '自分のお題から'
              else '他の人のお題から' end),
        v_limit, v_have;
    end if;
  end if;

  -- --- 保存枠を1つ作り、選んだ要素をその中へ入れる --------------------------
  insert into public.saved_carry_slots
    (user_id, scope, source_is_own, source_work_id, source_prompt_id, expires_at)
  values
    (v_uid, v_scope, v_is_own, v_work_id, v_prompt_id, v_expires)
  returning id into v_slot_id;

  insert into public.saved_elements
    (user_id, tag_id, source_work_id, source_prompt_id, scope, source_is_own,
     expires_at, carry_slot_id, position)
  select v_uid, x.tag_id, v_work_id, v_prompt_id, v_scope, v_is_own,
         v_expires, v_slot_id,
         row_number() over (order by array_position(p_tag_ids, x.tag_id))
    from (select distinct pc.tag_id
            from public.prompt_cards pc
           where pc.prompt_id = v_prompt_id
             and pc.tag_id = any(p_tag_ids)) x;

  return public.list_saved_elements();
end;
$fn$;

comment on function public.save_prompt_elements(text, uuid, bigint[], boolean) is
  '同じ元お題から選んだ1〜3要素を、1つの保存枠へまとめて持ち出す。'
  '**自分のお題か他人のお題かは、呼び出し側の申告ではなく works.user_id と'
  'prompts.created_by を見てここで決める。**区分を引数で受け取らないので、'
  'RPC を直接叩いても他人のお題を自分の枠にはできない。'
  '上限は保存枠の数（自分5枠・他者3枠）。上限に達していたら保存しない。'
  'ゲスト（匿名JWT）は永続行を作らず session（流れの中だけ・上限なし）。';


-- ----------------------------------------------------------------------------
-- 7. 捨てる（枠ごと／要素1つ）
-- ----------------------------------------------------------------------------

create or replace function public.delete_saved_carry_slot(p_slot_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  delete from public.saved_carry_slots s
   where s.id = p_slot_id and s.user_id = v_uid;

  return public.list_saved_elements();
end;
$fn$;

comment on function public.delete_saved_carry_slot(bigint) is
  '保存枠を1つ捨てる（中の要素も一緒に消える）。これで上限に空きができる。';


create or replace function public.delete_saved_element(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid  uuid := (select auth.uid());
  v_slot bigint;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  delete from public.saved_elements se
   where se.id = p_id and se.user_id = v_uid
   returning se.carry_slot_id into v_slot;

  -- 枠が空になったら枠ごと消す。**空の枠が上限を占め続けないように**
  if v_slot is not null then
    delete from public.saved_carry_slots s
     where s.id = v_slot
       and s.user_id = v_uid
       and not exists (select 1 from public.saved_elements se
                        where se.carry_slot_id = s.id);
  end if;

  return public.list_saved_elements();
end;
$fn$;

comment on function public.delete_saved_element(bigint) is
  '保存枠の中の要素を1つ捨てる。枠が空になったら枠も消える。'
  '**枠が残っている限り上限の空きは増えない**（単位は枠のため）。';


-- ----------------------------------------------------------------------------
-- 8. 登録後に、セッションの枠を永続へ移す
-- ----------------------------------------------------------------------------

create or replace function public.promote_session_carry(p_slot_ids bigint[] default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid          uuid := (select auth.uid());
  v_is_anonymous boolean;
  v_self_limit   int;
  v_others_limit int;
  v_self_have    int;
  v_others_have  int;
  v_self_add     int;
  v_others_add   int;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  v_is_anonymous := coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false);
  if v_is_anonymous then
    raise exception
      'GUEST_CANNOT_PERSIST: 持ち出しを次のセッションへ残すにはアカウント登録が必要です。'
      'ゲストのままでも、いまの流れの中では使えます。';
  end if;

  select cp.value into v_self_limit   from public.carry_policy cp where cp.policy_key = 'self_max';
  select cp.value into v_others_limit from public.carry_policy cp where cp.policy_key = 'others_max';

  select count(*) into v_self_have
    from public.saved_carry_slots s where s.user_id = v_uid and s.scope = 'self';
  select count(*) into v_others_have
    from public.saved_carry_slots s where s.user_id = v_uid and s.scope = 'others';

  select count(*) filter (where s.source_is_own),
         count(*) filter (where not s.source_is_own)
    into v_self_add, v_others_add
    from public.saved_carry_slots s
   where s.user_id = v_uid
     and s.scope = 'session'
     and (p_slot_ids is null or s.id = any(p_slot_ids));

  if v_self_have + v_self_add > v_self_limit then
    raise exception
      'CARRY_LIMIT_REACHED: 自分のお題から手元に残せるのは%枠までです。', v_self_limit;
  end if;
  if v_others_have + v_others_add > v_others_limit then
    raise exception
      'CARRY_LIMIT_REACHED: 他の人のお題から手元に残せるのは%枠までです。', v_others_limit;
  end if;

  update public.saved_carry_slots s
     set scope      = case when s.source_is_own then 'self' else 'others' end,
         expires_at = null
   where s.user_id = v_uid
     and s.scope = 'session'
     and (p_slot_ids is null or s.id = any(p_slot_ids));

  update public.saved_elements se
     set scope      = s.scope,
         expires_at = null
    from public.saved_carry_slots s
   where s.id = se.carry_slot_id
     and se.user_id = v_uid
     and se.scope = 'session';

  return public.list_saved_elements();
end;
$fn$;

comment on function public.promote_session_carry(bigint[]) is
  'ゲストのときに作った保存枠を、登録後に永続へ移す。移す単位は保存枠。'
  '出所が自分なら self、他人なら others。上限（枠数）を超える移動は断る。';

-- 要素単位で移していた古い関数を落とす。**単位が変わったので残さない**
drop function if exists public.promote_session_elements(bigint[]);


-- ----------------------------------------------------------------------------
-- 9. 流れが終わったとき／期限切れの掃除（枠ごと消す）
-- ----------------------------------------------------------------------------

create or replace function public.end_session_carry(p_user_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_count int;
begin
  delete from public.saved_carry_slots s
   where s.user_id = p_user_id
     and s.scope = 'session';

  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

comment on function public.end_session_carry(uuid) is
  'セッション内の保存枠を終える。お題の確定・ドラフトの破棄で呼ぶ。永続の枠は消さない。';


create or replace function public.cleanup_expired_session_carry(p_limit int default 1000)
returns int
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_count int;
begin
  with target as (
    select s.id from public.saved_carry_slots s
     where s.scope = 'session'
       and s.expires_at <= clock_timestamp()
     limit greatest(1, coalesce(p_limit, 1000))
  )
  delete from public.saved_carry_slots s
   using target t where s.id = t.id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;


-- ----------------------------------------------------------------------------
-- 10. 出所の追跡（枠単位・要素単位）
-- ----------------------------------------------------------------------------
--
-- 自分のお題について、「どの保存枠から、どの要素が入ったか」を返す。
-- **お題の持ち主だけ。**他人には null。

create or replace function public.get_my_prompt_carry_origins(p_prompt_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_ok  boolean;
begin
  if v_uid is null then
    return null;
  end if;

  select true into v_ok
    from public.prompts p
   where p.id = p_prompt_id and p.created_by = v_uid;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'slots', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'carry_slot_id',   pcs.carry_slot_id,
          'slot_exists',     pcs.carry_slot_id is not null,
          'source_is_own',   pcs.source_is_own,
          'source_work_id',  pcs.source_work_id,
          'slot_size',       pcs.slot_size,
          'used_count',      pcs.used_count,
          'partial',         pcs.used_count < pcs.slot_size
        ) order by pcs.id
      )
      from public.prompt_carry_slots pcs
     where pcs.prompt_id = p_prompt_id
    ), '[]'::jsonb),
    'elements', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'tag_id',           peo.tag_id,
          'tag_label',        tg.label,
          'carry_slot_id',    peo.carry_slot_id,
          'saved_element_id', peo.saved_element_id,
          'source_is_own',    peo.source_is_own,
          'source_work_id',   peo.source_work_id
        ) order by peo.tag_id
      )
      from public.prompt_element_origins peo
      join public.tags tg on tg.id = peo.tag_id
     where peo.prompt_id = p_prompt_id
    ), '[]'::jsonb)
  );
end;
$fn$;

comment on function public.get_my_prompt_carry_origins(uuid) is
  '自分のお題に入った持ち出しの出所。保存枠単位と要素単位の両方を返す。'
  '他人・未サインインには null（D40）。';


-- ----------------------------------------------------------------------------
-- 11. 実行権限
-- ----------------------------------------------------------------------------

revoke all on function public.save_prompt_elements(text, uuid, bigint[], boolean)
  from public, anon, authenticated;
revoke all on function public.list_saved_elements()
  from public, anon, authenticated;
revoke all on function public.delete_saved_element(bigint)
  from public, anon, authenticated;
revoke all on function public.delete_saved_carry_slot(bigint)
  from public, anon, authenticated;
revoke all on function public.promote_session_carry(bigint[])
  from public, anon, authenticated;
revoke all on function public.get_my_prompt_carry_origins(uuid)
  from public, anon, authenticated;
revoke all on function public.end_session_carry(uuid)
  from public, anon, authenticated;
revoke all on function public.cleanup_expired_session_carry(int)
  from public, anon, authenticated;

grant execute on function public.save_prompt_elements(text, uuid, bigint[], boolean) to authenticated;
grant execute on function public.list_saved_elements() to authenticated;
grant execute on function public.delete_saved_element(bigint) to authenticated;
grant execute on function public.delete_saved_carry_slot(bigint) to authenticated;
grant execute on function public.promote_session_carry(bigint[]) to authenticated;
grant execute on function public.get_my_prompt_carry_origins(uuid) to authenticated;
grant execute on function public.cleanup_expired_session_carry(int) to service_role;
