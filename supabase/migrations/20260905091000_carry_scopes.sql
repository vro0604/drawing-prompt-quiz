-- ============================================================================
-- carry_scopes ／ 持ち出しを3区分に分ける（2026-09-05 の定義更新）
-- ============================================================================
--
-- 【いままでの作り（2026-09-04 の実装）】
--   持ち出しは1種類しかなく、**登録者だけ**が使えた（D164）。
--   ゲストは保存もできず、使うこともできなかった。
--
-- 【これからの3区分】
--
--   ① サイト内セッション内（scope = 'session'）
--        誰が使えるか   ゲストも登録者も
--        どこから       自分のお題からでも、回答した他者作品からでも
--        いつまで       いま進めている流れが終わるまで。
--                       お題を確定した時点、ドラフトを捨てた時点で消える。
--                       放置されたぶんは掃除が期限で消す。
--        保存上限       置かない（1回のお題へ持ち込めるのは従来どおり1〜3個）
--
--   ② セッション外・自己お題（scope = 'self'）
--        誰が使えるか   登録者だけ
--        どこから       自分が制作・投稿したクイズ記録のお題
--        いつまで       利用者が捨てるまで（別のセッションでも使える）
--        保存上限       5
--
--   ③ セッション外・他者お題（scope = 'others'）
--        誰が使えるか   保持は登録者だけ。ゲストは①として一時利用のみ
--        どこから       他者の投稿や、共有されたクイズ記録
--        いつまで       利用者が捨てるまで
--        保存上限       3
--
-- 【上限の単位について（未決定）】
--   5 と 3 が「要素の個数」なのか「保存した組の数」なのかは、
--   リポジトリ内の決定記録にも仕様書にも書かれていない（2026-09-05 時点で検索した）。
--   **ここでは行数（＝要素の個数）として実装している。**
--   単位が「組」だと決まったら、count(*) を count(distinct saved_group_id) に
--   変えることになる。承認が要る。
--
-- 【一時利用と永続保存を分けている場所】
--   区分は scope 列1つで表す。ゲストは 'session' 以外を作れない
--   （関数の中で JWT の is_anonymous を見て断る）。
--   **ゲストを許可するために、永続保存まで開けていない。**
--
-- 【フレーバーテキストは変えていない】
--   登録者限定のまま（D164）。この移行はフレーバーの表にも関数にも触れない。
--
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 区分の列
-- ----------------------------------------------------------------------------

alter table public.saved_elements
  add column if not exists scope text not null default 'self';

alter table public.saved_elements
  add column if not exists source_is_own boolean not null default true;

alter table public.saved_elements
  add column if not exists expires_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.saved_elements'::regclass
       and conname = 'saved_elements_scope_valid'
  ) then
    alter table public.saved_elements
      add constraint saved_elements_scope_valid
      check (scope in ('session', 'self', 'others'));
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.saved_elements'::regclass
       and conname = 'saved_elements_session_has_expiry'
  ) then
    -- セッション内の持ち出しには必ず期限が要る。
    -- 期限の無い 'session' 行は、掃除が拾えず永久に残る
    alter table public.saved_elements
      add constraint saved_elements_session_has_expiry
      check ((scope = 'session') = (expires_at is not null));
  end if;
end $$;

-- 既存行は「自分のお題から保存した永続の持ち出し」として扱う。
-- 2026-09-04 の実装では他者作品からの保存も同じ表に入るので、
-- 出所の作品が自分のものでない行は 'others' へ寄せる
update public.saved_elements se
   set scope = 'others',
       source_is_own = false
 where se.source_work_id is not null
   and exists (select 1 from public.works w
                where w.id = se.source_work_id
                  and w.user_id <> se.user_id);

comment on column public.saved_elements.scope is
  '持ち出しの区分（2026-09-05）。session＝いまの流れの中だけ（ゲスト可）、'
  'self＝自分のお題から永続（登録者・上限5）、others＝他者のお題から永続（登録者・上限3）。';
comment on column public.saved_elements.source_is_own is
  '出所が自分の制作・投稿かどうか。ゲストが登録したあと、'
  'session の行を self と others のどちらへ移すかの判断に使う。';
comment on column public.saved_elements.expires_at is
  'session の行だけが持つ期限。掃除が過ぎた行を消す。'
  '**24時間という値は私が置いた暫定値で、承認を受けていない。**';

create index if not exists saved_elements_expiry_idx
  on public.saved_elements (expires_at) where scope = 'session';


-- ----------------------------------------------------------------------------
-- 2. 上限（承認待ちの値。1か所にまとめる）
-- ----------------------------------------------------------------------------
--
-- time_policy と同じ形にする。**is_provisional = true** は
-- 「ユーザーの承認をまだ受けていない」という意味。

create table if not exists public.carry_policy (
  policy_key text primary key
    constraint carry_policy_key_format check (policy_key ~ '^[a-z][a-z0-9_]{1,49}$'),
  value int not null
    constraint carry_policy_value_range check (value >= 0 and value <= 1000),
  is_provisional boolean not null default true,
  note text not null
    constraint carry_policy_note_length check (char_length(note) between 1 and 300),
  updated_at timestamptz not null default now()
);

comment on table public.carry_policy is
  '持ち出しの上限（2026-09-05 の3区分）。is_provisional = true は未承認の値。'
  '「5」「3」は原文にある数だが、単位（要素か組か）は記録に無いため未決定。';

insert into public.carry_policy (policy_key, value, is_provisional, note) values
  ('self_max', 5, true,
   'セッション外・自己お題の保存上限。原文の「保存上限5」。単位は要素数として実装（未決定）'),
  ('others_max', 3, true,
   'セッション外・他者お題の保存上限。原文の「保存上限3程度」。単位は要素数として実装（未決定）'),
  ('session_ttl_hours', 24, true,
   'セッション内の持ち出しが残る時間。放置された行を掃除が消すまで。私が置いた暫定値')
on conflict (policy_key) do nothing;

alter table public.carry_policy enable row level security;
revoke all on table public.carry_policy from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 3. 一覧（区分と上限を一緒に返す）
-- ----------------------------------------------------------------------------

create or replace function public.list_saved_elements()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',              se.id,
          'tag_id',          se.tag_id,
          'tag_label',       tg.label,
          'category_key',    tg.pool_key,
          'category_label',  tp.label,
          'category_kind',   coalesce(dc.kind, 'legacy'),
          'scope',           se.scope,
          'source_is_own',   se.source_is_own,
          'source_work_id',  se.source_work_id,
          'has_source_work', se.source_work_id is not null,
          'expires_at',      se.expires_at,
          'created_at',      se.created_at
        )
        order by se.created_at desc
      )
      from public.saved_elements se
      join public.tags      tg on tg.id       = se.tag_id
      join public.tag_pools tp on tp.pool_key = tg.pool_key
      left join public.draw_categories dc on dc.pool_key = tg.pool_key
      where se.user_id = (select auth.uid())
        and (se.scope <> 'session' or se.expires_at > clock_timestamp())
    ), '[]'::jsonb),
    'counts', jsonb_build_object(
      'session', (select count(*) from public.saved_elements se
                   where se.user_id = (select auth.uid()) and se.scope = 'session'
                     and se.expires_at > clock_timestamp()),
      'self',    (select count(*) from public.saved_elements se
                   where se.user_id = (select auth.uid()) and se.scope = 'self'),
      'others',  (select count(*) from public.saved_elements se
                   where se.user_id = (select auth.uid()) and se.scope = 'others')
    ),
    'limits', jsonb_build_object(
      'self',   (select value from public.carry_policy where policy_key = 'self_max'),
      'others', (select value from public.carry_policy where policy_key = 'others_max')
    ),
    'can_persist', not coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
  );
$fn$;

comment on function public.list_saved_elements() is
  '自分が持ち出した要素の一覧と、区分ごとの件数・上限（2026-09-05）。'
  '元お題IDは返さない（D23）。期限切れのセッション行は返さない。';


-- ----------------------------------------------------------------------------
-- 4. 保存（3区分に振り分ける）
-- ----------------------------------------------------------------------------
--
-- 【p_persist】
--   true  … 永続保存を望む（登録者のみ。区分は出所で self / others に決まる）
--   false … いまの流れの中だけ（ゲストも可）
--   ゲストが true を渡しても 'session' になる。**断らずに一時利用へ落とす。**
--   断ると「回答したのに何も持ち帰れない」画面になり、
--   原文の「ゲストは一時利用可能」を満たせない。

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
      'BAD_ELEMENT_COUNT: 一度に持ち出せるのは1〜3個です（いま %個）。', v_count;
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
  select count(*) into v_matched
    from public.prompt_cards pc
   where pc.prompt_id = v_prompt_id
     and pc.tag_id = any(p_tag_ids);

  if v_matched <> v_count then
    raise exception
      'ELEMENT_NOT_IN_PROMPT: そのお題に含まれない要素が指定されています。';
  end if;

  -- --- 永続保存の上限 -------------------------------------------------------
  --
  -- **上限に達していたら保存しない。**古いものを勝手に押し出さない
  -- （原文「上限到達時は保存不可」「破棄は利用者が行う」）。
  if v_scope <> 'session' then
    select cp.value into v_limit
      from public.carry_policy cp
     where cp.policy_key = (case when v_scope = 'self' then 'self_max' else 'others_max' end);

    select count(*) into v_have
      from public.saved_elements se
     where se.user_id = v_uid and se.scope = v_scope;

    -- すでに持っている語は増えないので、新しく増える数だけを数える
    select v_have + count(*) into v_have
      from public.prompt_cards pc
     where pc.prompt_id = v_prompt_id
       and pc.tag_id = any(p_tag_ids)
       and not exists (select 1 from public.saved_elements se
                        where se.user_id = v_uid and se.tag_id = pc.tag_id);

    if v_have > v_limit then
      raise exception
        'CARRY_LIMIT_REACHED: %持ち出して手元に残せるのは%個までです。'
        '使わないものを捨ててから保存してください。',
        (case when v_scope = 'self' then '自分のお題から'
              else '他の人のお題から' end),
        v_limit;
    end if;
  end if;

  -- --- 保存する -------------------------------------------------------------
  insert into public.saved_elements
    (user_id, tag_id, source_work_id, source_prompt_id, scope, source_is_own, expires_at)
  select v_uid, pc.tag_id, v_work_id, v_prompt_id, v_scope, v_is_own, v_expires
    from public.prompt_cards pc
   where pc.prompt_id = v_prompt_id
     and pc.tag_id = any(p_tag_ids)
  on conflict (user_id, tag_id) do nothing;

  return public.list_saved_elements();
end;
$fn$;

comment on function public.save_prompt_elements(text, uuid, bigint[], boolean) is
  'お題の要素を1〜3個持ち出す（2026-09-05 の3区分）。'
  'ゲストは session（流れの中だけ）。登録者は出所に応じて self / others へ永続保存。'
  '上限に達していたら保存しない。';

-- 引数が1本増えたので、古い3引数版を落とす。
-- 残すと「上限を見ない保存」の入口が生き続ける
drop function if exists public.save_prompt_elements(text, uuid, bigint[]);


-- ----------------------------------------------------------------------------
-- 5. ゲストが登録したあと、使った分を永続へ移す
-- ----------------------------------------------------------------------------
--
-- 原文「登録後は使用分を保存可能」。
-- session の行を、出所に応じて self / others へ移す。上限は同じように見る。

create or replace function public.promote_session_elements(p_ids bigint[] default null)
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
    from public.saved_elements se where se.user_id = v_uid and se.scope = 'self';
  select count(*) into v_others_have
    from public.saved_elements se where se.user_id = v_uid and se.scope = 'others';

  select count(*) filter (where se.source_is_own),
         count(*) filter (where not se.source_is_own)
    into v_self_add, v_others_add
    from public.saved_elements se
   where se.user_id = v_uid
     and se.scope = 'session'
     and (p_ids is null or se.id = any(p_ids));

  if v_self_have + v_self_add > v_self_limit then
    raise exception
      'CARRY_LIMIT_REACHED: 自分のお題から持ち出して手元に残せるのは%個までです。',
      v_self_limit;
  end if;
  if v_others_have + v_others_add > v_others_limit then
    raise exception
      'CARRY_LIMIT_REACHED: 他の人のお題から持ち出して手元に残せるのは%個までです。',
      v_others_limit;
  end if;

  update public.saved_elements se
     set scope      = case when se.source_is_own then 'self' else 'others' end,
         expires_at = null
   where se.user_id = v_uid
     and se.scope = 'session'
     and (p_ids is null or se.id = any(p_ids));

  return public.list_saved_elements();
end;
$fn$;

comment on function public.promote_session_elements(bigint[]) is
  'ゲストのときに持ち出した要素を、登録後に永続保存へ移す（2026-09-05）。'
  '出所が自分なら self、他人なら others。上限を超える移動は断る。';

revoke all on function public.promote_session_elements(bigint[])
  from public, anon, authenticated;
grant execute on function public.promote_session_elements(bigint[]) to authenticated;


-- ----------------------------------------------------------------------------
-- 6. 流れが終わったら、セッション内の持ち出しを終える
-- ----------------------------------------------------------------------------
--
-- お題を確定した時点と、ドラフトを捨てた時点。
-- **永続の行（self / others）には触れない。**

create or replace function public.end_session_carry(p_user_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_count int;
begin
  delete from public.saved_elements se
   where se.user_id = p_user_id
     and se.scope = 'session';

  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

comment on function public.end_session_carry(uuid) is
  'セッション内の持ち出しを終える。お題の確定・ドラフトの破棄で呼ぶ。永続の行は消さない。';

revoke all on function public.end_session_carry(uuid)
  from public, anon, authenticated;


create or replace function public.abandon_draft(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid     uuid := (select auth.uid());
  v_updated int;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  update public.draft_sessions ds
     set status       = 'abandoned',
         abandoned_at = clock_timestamp()
   where ds.id = p_session_id
     and ds.user_id = v_uid
     and ds.status = 'in_progress';

  get diagnostics v_updated = row_count;

  if v_updated <> 1 then
    raise exception 'DRAFT_NOT_FOUND: 破棄できる進行中のドラフトがありません。';
  end if;

  -- 流れが終わったので、セッション内の持ち出しも終わる
  perform public.end_session_carry(v_uid);

  return jsonb_build_object('session_id', p_session_id, 'status', 'abandoned');
end;
$fn$;


-- ----------------------------------------------------------------------------
-- 7. ゲストも持ち出しを使える（start_draft の判定を差し替える）
-- ----------------------------------------------------------------------------
--
-- 2026-09-04 の start_draft は、持ち出しを渡してきた相手がゲストなら断っていた。
-- 3区分ではゲストも session の持ち出しを使える。断るのをやめ、
-- **代わりに「その行が本人のもので、期限内か」を見る。**

create or replace function public.start_draft(
  p_mode_key            text,
  p_time_limit_seconds  int      default null,
  p_carried_element_ids bigint[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid          uuid := (select auth.uid());
  v_session_id   uuid;
  v_mode         record;
  v_carried      int := 0;
  v_found        int;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select dm.mode_key, dm.candidate_count, dm.max_rerolls,
         dm.quiz_question_count, dm.uses_two_stage
    into v_mode
    from public.draft_modes dm
   where dm.mode_key = p_mode_key
     and dm.is_active;

  if not found then
    raise exception 'MODE_NOT_FOUND: モード % は使えません。', p_mode_key;
  end if;

  if p_time_limit_seconds is not null
     and (p_time_limit_seconds < 60 or p_time_limit_seconds > 600000) then
    raise exception 'BAD_TIME_LIMIT: 制限時間は60〜600000秒の範囲で指定してください。';
  end if;

  if p_carried_element_ids is not null
     and array_length(p_carried_element_ids, 1) > 0 then

    if not v_mode.uses_two_stage then
      raise exception
        'MODE_NO_CARRY: このモードでは要素を持ち出せません。';
    end if;

    v_carried := array_length(p_carried_element_ids, 1);
    if v_carried > 3 then
      raise exception
        'BAD_ELEMENT_COUNT: 1つのお題へ持ち込めるのは1〜3個です（いま %個）。', v_carried;
    end if;

    -- 本人の行で、セッション内のものは期限内であること
    select count(*) into v_found
      from public.saved_elements se
     where se.user_id = v_uid
       and se.id = any(p_carried_element_ids)
       and (se.scope <> 'session' or se.expires_at > clock_timestamp());

    if v_found <> v_carried then
      raise exception
        'ELEMENT_NOT_FOUND: 選んだ要素が見つかりません。'
        'セッション内の持ち出しは、時間が経つと使えなくなります。';
    end if;
  end if;

  if exists (
    select 1 from public.draft_sessions ds
     where ds.user_id = v_uid and ds.status = 'in_progress'
  ) then
    raise exception
      'DRAFT_IN_PROGRESS: 進行中のドラフトがあります。'
      '続けるか、破棄してから新しく始めてください。';
  end if;

  insert into public.draft_sessions
    (user_id, mode_key, candidate_count, max_rerolls,
     quiz_question_count, time_limit_seconds)
  values
    (v_uid, v_mode.mode_key, v_mode.candidate_count, v_mode.max_rerolls,
     v_mode.quiz_question_count, p_time_limit_seconds)
  returning id into v_session_id;

  if v_carried > 0 then
    insert into public.draft_session_carried
      (session_id, position, tag_id, source_work_id, source_prompt_id)
    select v_session_id,
           row_number() over (order by se.created_at, se.id),
           se.tag_id, se.source_work_id, se.source_prompt_id
      from public.saved_elements se
     where se.user_id = v_uid
       and se.id = any(p_carried_element_ids);
  end if;

  perform public.draft_generate_candidates(
    v_session_id, 1, v_mode.mode_key, v_mode.candidate_count);

  return public.draft_state_json(v_session_id);
end;
$fn$;

comment on function public.start_draft(text, int, bigint[]) is
  'ドラフトを始める。持ち出しを1〜3個渡せる（D161）。'
  'セッション内の持ち出しはゲストも使える（2026-09-05 の3区分）。'
  '始めた瞬間が制作挑戦の開始時刻になる（D163）。';

revoke all on function public.start_draft(text, int, bigint[])
  from public, anon, authenticated;
grant execute on function public.start_draft(text, int, bigint[]) to authenticated;


-- ----------------------------------------------------------------------------
-- 8. お題の確定でも、セッション内の持ち出しを終える
-- ----------------------------------------------------------------------------
--
-- complete_draft の最後に1行足すだけ。ほかの手順は 20260905090500 のまま。

create or replace function public.complete_draft(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid          uuid := (select auth.uid());
  v_session      record;
  v_slot_count   int;
  v_chosen_count int;
  v_prompt_id    uuid;
  v_inserted     int;
  v_carried      int;
  v_two_stage    boolean;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select ds.id, ds.status, ds.mode_key, ds.reroll_count,
         ds.current_generation, ds.time_limit_seconds, ds.quiz_question_count,
         ds.started_at, ds.deadline_at, ds.renew_count, ds.last_renewed_at
    into v_session
    from public.draft_sessions ds
   where ds.id = p_session_id
     and ds.user_id = v_uid;

  if not found then
    raise exception 'DRAFT_NOT_FOUND: そのドラフトは見つかりません。';
  end if;

  if v_session.status <> 'in_progress' then
    raise exception 'DRAFT_NOT_IN_PROGRESS: そのドラフトは終了しています。';
  end if;

  perform public.assert_draft_not_expired(p_session_id);

  select dm.uses_two_stage into v_two_stage
    from public.draft_modes dm where dm.mode_key = v_session.mode_key;

  if v_two_stage then
    select count(*) into v_slot_count
      from public.draft_session_slots s
     where s.session_id = p_session_id
       and s.generation = v_session.current_generation;
  else
    select count(*) into v_slot_count
      from public.draft_mode_slots dms
     where dms.mode_key = v_session.mode_key;
  end if;

  select count(*) into v_chosen_count
    from public.draft_candidates dc
   where dc.session_id = p_session_id
     and dc.generation = v_session.current_generation
     and dc.is_chosen;

  if v_chosen_count <> v_slot_count then
    raise exception 'DRAFT_INCOMPLETE: まだ決まっていない枠があります（%/%）。',
      v_chosen_count, v_slot_count;
  end if;

  select count(*) into v_carried
    from public.draft_session_carried c where c.session_id = p_session_id;

  insert into public.prompts
    (draft_session_id, created_by, mode_key, time_limit_seconds,
     was_rerolled, reroll_count, status, origin,
     started_at, deadline_at, renew_count, last_renewed_at)
  values
    (p_session_id, v_uid, v_session.mode_key, v_session.time_limit_seconds,
     v_session.reroll_count > 0, v_session.reroll_count, 'active',
     case when v_carried > 0 then 'saved' else 'draft' end,
     v_session.started_at, v_session.deadline_at,
     v_session.renew_count, v_session.last_renewed_at)
  returning id into v_prompt_id;

  insert into public.prompt_cards (prompt_id, card_slot_key, slot_order, tag_id)
  select v_prompt_id, dc.card_slot_key, dc.slot_order, dc.tag_id
    from public.draft_candidates dc
   where dc.session_id = p_session_id
     and dc.generation = v_session.current_generation
     and dc.is_chosen;

  get diagnostics v_inserted = row_count;
  if v_inserted <> v_slot_count then
    raise exception 'CARD_COUNT_MISMATCH: 答えのカードが %件です（必要 %件）。',
      v_inserted, v_slot_count;
  end if;

  if v_carried > 0 then
    insert into public.prompt_element_origins
      (prompt_id, tag_id, source_prompt_id, source_work_id)
    select v_prompt_id, c.tag_id, c.source_prompt_id, c.source_work_id
      from public.draft_session_carried c
     where c.session_id = p_session_id
    on conflict (prompt_id, tag_id) do nothing;
  end if;

  perform public.build_quiz_for_prompt(v_prompt_id, v_session.quiz_question_count);

  update public.draft_sessions ds
     set status       = 'completed',
         completed_at = clock_timestamp()
   where ds.id = p_session_id;

  -- 流れがここで終わる。セッション内の持ち出しは保持を終える（2026-09-05）
  perform public.end_session_carry(v_uid);

  return jsonb_build_object(
    'prompt_id',      v_prompt_id,
    'mode_key',       v_session.mode_key,
    'card_count',     v_slot_count,
    'question_count', v_session.quiz_question_count
  );
end;
$fn$;

revoke all on function public.complete_draft(uuid) from public, anon, authenticated;
grant execute on function public.complete_draft(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- 9. 期限切れのセッション持ち出しを掃除する
-- ----------------------------------------------------------------------------

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
    select se.id from public.saved_elements se
     where se.scope = 'session'
       and se.expires_at <= clock_timestamp()
     limit greatest(1, coalesce(p_limit, 1000))
  )
  delete from public.saved_elements se
   using target t where se.id = t.id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

comment on function public.cleanup_expired_session_carry(int) is
  '期限を過ぎたセッション内の持ち出しを消す。永続の行には触れない。';

revoke all on function public.cleanup_expired_session_carry(int)
  from public, anon, authenticated;
grant execute on function public.cleanup_expired_session_carry(int) to service_role;


-- ----------------------------------------------------------------------------
-- 10. 実行権限
-- ----------------------------------------------------------------------------

revoke all on function public.save_prompt_elements(text, uuid, bigint[], boolean)
  from public, anon, authenticated;
revoke all on function public.list_saved_elements()
  from public, anon, authenticated;

grant execute on function public.save_prompt_elements(text, uuid, bigint[], boolean) to authenticated;
grant execute on function public.list_saved_elements() to authenticated;
