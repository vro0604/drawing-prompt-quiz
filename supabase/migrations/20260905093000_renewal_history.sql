-- ============================================================================
-- renewal_history ／ 更新と超過の履歴を1件ずつ残す
-- ============================================================================
--
-- 【なぜ回数だけでは足りないか】
--   prompts.renew_count と last_renewed_at は「何回・最後にいつ」しか持たない。
--   「何回目のときに、どれだけ超過していたか」は残らない。
--   要件は**過去の超過・更新履歴を保持する**なので、1件ずつ書く。
--
-- 【何を書くか】
--   ・どの挑戦か（ドラフトか確定お題か、そのID）
--   ・押した時刻
--   ・押す前の期限と、押したあとの期限
--   ・押した時点の総経過秒
--   ・押した時点の超過秒（期限内に押したなら0）
--
-- 【誰も直接読めない】
--   表には権限を配らない。読むのは本人向けの RPC を通してだけ。
--
-- ============================================================================

create table if not exists public.challenge_renewals (
  id bigint generated always as identity primary key,

  user_id uuid not null
    references public.profiles (id) on delete cascade on update restrict,

  -- 'draft' … カードをめくっている最中 ／ 'prompt' … お題が決まったあと
  kind text not null
    constraint challenge_renewals_kind_valid check (kind in ('draft', 'prompt')),

  -- 挑戦の ID。ドラフトと確定お題で参照先が違うので、外部キーは張らない
  -- （張ると2列に分かれ、どちらかが必ず null の形になる）
  challenge_id uuid not null,

  renewed_at timestamptz not null default now(),

  deadline_before timestamptz not null,
  deadline_after  timestamptz not null,

  elapsed_seconds bigint not null
    constraint challenge_renewals_elapsed_positive check (elapsed_seconds >= 0),

  -- 押した時点で期限を過ぎていた秒数。期限内なら0
  overrun_seconds bigint not null default 0
    constraint challenge_renewals_overrun_positive check (overrun_seconds >= 0),

  -- 何回目の更新か（1から数える）
  renew_index int not null
    constraint challenge_renewals_index_positive check (renew_index >= 1)
);

comment on table public.challenge_renewals is
  '制作時間を延ばした履歴（2026-09-05）。回数だけでなく、'
  'そのときの総経過と超過も1件ずつ残す。権限は配らない。';

create index if not exists challenge_renewals_user_idx
  on public.challenge_renewals (user_id, renewed_at desc);

create index if not exists challenge_renewals_challenge_idx
  on public.challenge_renewals (challenge_id, renew_index);

alter table public.challenge_renewals enable row level security;
revoke all on table public.challenge_renewals from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 履歴を書く（内部専用）
-- ----------------------------------------------------------------------------

create or replace function public.record_renewal(
  p_user_id  uuid,
  p_kind     text,
  p_id       uuid,
  p_before   timestamptz,
  p_after    timestamptz,
  p_started  timestamptz,
  p_index    int
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_now timestamptz := clock_timestamp();
begin
  insert into public.challenge_renewals
    (user_id, kind, challenge_id, renewed_at,
     deadline_before, deadline_after, elapsed_seconds, overrun_seconds, renew_index)
  values
    (p_user_id, p_kind, p_id, v_now,
     p_before, p_after,
     greatest(0, floor(extract(epoch from (v_now - p_started))))::bigint,
     greatest(0, floor(extract(epoch from (v_now - p_before))))::bigint,
     p_index);
end;
$fn$;

comment on function public.record_renewal(uuid, text, uuid, timestamptz, timestamptz, timestamptz, int) is
  '更新の履歴を1件書く。内部専用。更新の関数からだけ呼ぶ。';

revoke all on function public.record_renewal(uuid, text, uuid, timestamptz, timestamptz, timestamptz, int)
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 確定お題の更新に履歴を足す
-- ----------------------------------------------------------------------------

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
  v_after  timestamptz;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select p.id, p.status, p.time_limit_seconds, p.deadline_at, p.renew_count, p.started_at
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

  v_after := v_now + make_interval(
    secs => (v_p.time_limit_seconds * v_grant)::double precision);

  update public.prompts p
     set deadline_at     = v_after,
         renew_count     = p.renew_count + 1,
         last_renewed_at = v_now
   where p.id = p_prompt_id;

  perform public.record_renewal(
    v_uid, 'prompt', p_prompt_id,
    v_p.deadline_at, v_after, v_p.started_at, v_p.renew_count + 1);

  return public.prompt_timer_json(p_prompt_id);
end;
$fn$;

comment on function public.renew_prompt_deadline(uuid) is
  'オーバー更新（D163）。更新後の期限は 更新時刻 + 0.75T。残り時間は繰り越さない。'
  '無制限には適用しない。更新のたびに履歴を1件残す。';

revoke all on function public.renew_prompt_deadline(uuid)
  from public, anon, authenticated;
grant execute on function public.renew_prompt_deadline(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- ドラフト中の更新に履歴を足す
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
  v_after timestamptz;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select ds.id, ds.status, ds.time_limit_seconds, ds.deadline_at,
         ds.renew_count, ds.started_at
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

  v_after := v_now + make_interval(
    secs => (v_s.time_limit_seconds * v_grant)::double precision);

  update public.draft_sessions ds
     set deadline_at     = v_after,
         renew_count     = ds.renew_count + 1,
         last_renewed_at = v_now
   where ds.id = p_session_id;

  perform public.record_renewal(
    v_uid, 'draft', p_session_id,
    v_s.deadline_at, v_after, v_s.started_at, v_s.renew_count + 1);

  return public.draft_timer_json(p_session_id);
end;
$fn$;

comment on function public.renew_draft_deadline(uuid) is
  'ドラフト中のオーバー更新（D163）。規則は確定お題と同じ。'
  '総経過時間は減らない。更新のたびに履歴を1件残す。';

revoke all on function public.renew_draft_deadline(uuid)
  from public, anon, authenticated;
grant execute on function public.renew_draft_deadline(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- 本人が自分の履歴を読む
-- ----------------------------------------------------------------------------
--
-- お題の語は1つも返さない。時刻と秒数だけ。

create or replace function public.get_my_renewals(p_limit int default 50)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'kind',            r.kind,
        'renewed_at',      r.renewed_at,
        'deadline_before', r.deadline_before,
        'deadline_after',  r.deadline_after,
        'elapsed_seconds', r.elapsed_seconds,
        'overrun_seconds', r.overrun_seconds,
        'renew_index',     r.renew_index
      )
      order by r.renewed_at desc
    ),
    '[]'::jsonb
  )
  from (
    select * from public.challenge_renewals c
     where c.user_id = (select auth.uid())
     order by c.renewed_at desc
     limit greatest(1, least(coalesce(p_limit, 50), 200))
  ) r;
$fn$;

comment on function public.get_my_renewals(int) is
  '自分が時間を延ばした履歴（2026-09-05）。お題の語は返さない。';

revoke all on function public.get_my_renewals(int)
  from public, anon, authenticated;
grant execute on function public.get_my_renewals(int) to authenticated;
