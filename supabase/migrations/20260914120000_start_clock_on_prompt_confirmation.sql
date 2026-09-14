-- 制作時間はカードを選んでいる間には使わず、お題の確定時から数える。
-- 放置によるドラフトの自動破棄は last_activity_at を起点に引き続き有効。

create or replace function public.draft_sessions_set_initial_deadline()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.started_at is null then
    new.started_at := coalesce(new.created_at, clock_timestamp());
  end if;

  -- 制作時間はまだ始まらない。選んだ長さだけ確定時まで保持する。
  new.deadline_at := null;
  return new;
end;
$fn$;

comment on function public.draft_sessions_set_initial_deadline() is
  'ドラフト作成時には制作期限を作らない。時計はお題の確定時に始める。';
comment on column public.draft_sessions.started_at is
  'ドラフトを作った時刻。制作時間の開始時刻ではない。';
comment on column public.draft_sessions.deadline_at is
  'ドラフト中は期限を持たない。既存ドラフトも2026-09-14の移行時に空にする。';

-- 既に進行中のドラフトも選択にかかった時間を課さない。
-- 設定移行を「利用者の操作」と誤認して放置時刻を進めない。
alter table public.draft_sessions disable trigger draft_sessions_touch_activity_trigger;
update public.draft_sessions
   set deadline_at = null,
       renew_count = 0,
       last_renewed_at = null
 where status = 'in_progress'
   and (deadline_at is not null or renew_count <> 0 or last_renewed_at is not null);
alter table public.draft_sessions enable trigger draft_sessions_touch_activity_trigger;

-- complete_draft はドラフトの開始時刻・期限を INSERT に渡してくる。
-- BEFORE INSERT で確定時刻に置き換えると、確定と計時開始が同じDB操作になる。
-- 持ち込みのお題（draft_session_id が無い）は従来の時刻を維持する。
create or replace function public.prompts_set_initial_deadline()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.draft_session_id is not null then
    new.started_at := clock_timestamp();
    -- created_at の既定値 now() はトランザクション開始時刻。
    -- 確定操作が1秒以上続いても started_at <= created_at + 1秒 を守る。
    new.created_at := new.started_at;
    new.deadline_at := case
      when new.time_limit_seconds is null then null
      else new.started_at + make_interval(secs => new.time_limit_seconds)
    end;
    new.renew_count := 0;
    new.last_renewed_at := null;
    return new;
  end if;

  if new.started_at is null then
    new.started_at := coalesce(new.created_at, clock_timestamp());
  end if;
  if new.time_limit_seconds is null then
    new.deadline_at := null;
  elsif new.deadline_at is null then
    new.deadline_at := new.started_at
                       + make_interval(secs => new.time_limit_seconds);
  end if;
  return new;
end;
$fn$;

comment on function public.prompts_set_initial_deadline() is
  'ドラフトから確定したお題は、そのINSERT時刻から制作時間を数える。持ち込みは従来どおり。';
comment on column public.prompts.started_at is
  '制作時間の開始時刻。ドラフト由来のお題では確定時刻。UPDATEでは変えられない。';

-- ドラフトは制作時間をまだ使っていないため、全ページの時計に返さない。
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

  select p.id into v_id
    from public.prompts p
   where p.created_by = v_uid
     and p.status = 'active'
   order by p.started_at desc
   limit 1;

  if v_id is not null then
    v_timer := public.prompt_timer_json(v_id);
    if not (v_timer ->> 'is_discarded')::boolean then
      return v_timer
        || jsonb_build_object(
             'kind',        'prompt',
             'id',          v_id,
             'href',        '/prompt/' || v_id::text,
             'is_finished', false,
             'work_id',     null);
    end if;
  end if;

  -- 新しいお題を選んでいる間、直前に投稿したお題の「終了」帯を残さない。
  if exists (
    select 1 from public.draft_sessions ds
     where ds.user_id = v_uid and ds.status = 'in_progress'
  ) then
    return null;
  end if;

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
  '確定済みのお題の時計だけ返す。ドラフト中はカウントダウンを表示しない。';

-- ドラフト中に延長は要らない。直接RPCで呼ぶ経路も閉じる。
revoke execute on function public.renew_draft_deadline(uuid) from authenticated;

create or replace function public.renew_current_challenge()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_id  uuid;
  v_r   jsonb;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select p.id into v_id
    from public.prompts p
   where p.created_by = v_uid and p.status = 'active'
   order by p.started_at desc
   limit 1;

  if v_id is null then
    raise exception 'NO_ACTIVE_CHALLENGE: いま進行中の制作挑戦がありません。';
  end if;

  v_r := public.renew_prompt_deadline(v_id);
  return public.get_active_challenge()
    || jsonb_build_object(
         'renewed',         true,
         'granted_seconds', v_r -> 'granted_seconds',
         'deadline_before', v_r -> 'deadline_before',
         'deadline_after',  v_r -> 'deadline_after');
end;
$fn$;

comment on function public.renew_current_challenge() is
  '確定済みのお題の制作時間だけ延長する。ドラフト中にはまだ制作時間が無い。';
