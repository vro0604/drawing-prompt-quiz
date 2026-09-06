-- ============================================================================
-- draft_expiry_guards ／ ドラフト中の時間切れを操作の入口で止める
-- ============================================================================
--
-- 20260905090000 でドラフトにも期限が入った。期限そのものは入れたが、
-- **入れただけでは何も止まらない。**猶予を使い切ったあとでもカードはめくれるし、
-- お題も確定できてしまう。ここで3つの入口に検査を足す。
--
--   reveal_card    … めくる
--   reroll_draft   … 引き直す
--   complete_draft … お題を確定する
--
-- 検査は assert_draft_not_expired 1本を呼ぶだけで、判定は書き写さない。
--
-- 【complete_draft がもう1つやること】
--   ドラフトの開始時刻・期限・更新回数を、確定したお題へそのまま引き継ぐ。
--   ここが「ドラフトから確定お題へ時計を渡す」唯一の場所。
--   引き継がないと、確定の瞬間に期限が作り直されて時間が増える。
--
-- ============================================================================


create or replace function public.reveal_card(
  p_session_id      uuid,
  p_card_slot_key   text,
  p_candidate_index int
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid       uuid := (select auth.uid());
  v_session   record;
  v_slot_order int;
  v_updated   int;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select ds.id, ds.status, ds.current_generation, ds.current_slot_order
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

  -- 猶予を使い切っていたら、掃除を待たずにここで止める（D163）
  perform public.assert_draft_not_expired(p_session_id);

  select dc.slot_order into v_slot_order
    from public.draft_candidates dc
   where dc.session_id = p_session_id
     and dc.generation = v_session.current_generation
     and dc.card_slot_key = p_card_slot_key
   limit 1;

  if v_slot_order is null then
    raise exception 'SLOT_NOT_FOUND: 枠 % はこのドラフトにありません。', p_card_slot_key;
  end if;

  if v_slot_order <> v_session.current_slot_order then
    raise exception 'WRONG_SLOT_ORDER: いまめくれるのは %番目の枠です。',
      v_session.current_slot_order;
  end if;

  if exists (
    select 1 from public.draft_candidates dc
     where dc.session_id = p_session_id
       and dc.generation = v_session.current_generation
       and dc.card_slot_key = p_card_slot_key
       and dc.is_chosen
  ) then
    raise exception 'ALREADY_CHOSEN: その枠はもう決まっています。';
  end if;

  update public.draft_candidates dc
     set revealed_at = clock_timestamp(),
         is_chosen   = true
   where dc.session_id = p_session_id
     and dc.generation = v_session.current_generation
     and dc.card_slot_key = p_card_slot_key
     and dc.candidate_index = p_candidate_index;

  get diagnostics v_updated = row_count;

  if v_updated <> 1 then
    raise exception 'CANDIDATE_NOT_FOUND: %番のカードはありません。', p_candidate_index;
  end if;

  update public.draft_sessions ds
     set current_slot_order = ds.current_slot_order + 1
   where ds.id = p_session_id;

  return public.draft_state_json(p_session_id);
end;
$fn$;

comment on function public.reveal_card(uuid, text, int) is
  'カードを1枚めくって確定する。猶予を使い切ったドラフトでは断る（D163）。';


create or replace function public.reroll_draft(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid     uuid := (select auth.uid());
  v_session record;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select ds.id, ds.status, ds.mode_key, ds.candidate_count,
         ds.max_rerolls, ds.reroll_count, ds.current_generation
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

  if v_session.reroll_count >= v_session.max_rerolls then
    raise exception 'NO_REROLL_LEFT: 引き直せる回数が残っていません。';
  end if;

  update public.draft_sessions ds
     set reroll_count       = ds.reroll_count + 1,
         current_generation = ds.current_generation + 1,
         current_slot_order = 1
   where ds.id = p_session_id;

  perform public.draft_generate_candidates(
    p_session_id,
    v_session.current_generation + 1,
    v_session.mode_key,
    v_session.candidate_count);

  return public.draft_state_json(p_session_id);
end;
$fn$;

comment on function public.reroll_draft(uuid) is
  '全部引き直す。引き直しても開始時刻は変わらない（時計は戻らない。D163）。';


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

  -- --- 1. お題 --------------------------------------------------------------
  --
  -- 【時計を引き継ぐ】
  --   started_at   ドラフトを始めた時刻。ここが総経過時間の起点
  --   deadline_at  ドラフト中に進んだ（更新もされうる）期限をそのまま
  --   renew_count  ドラフト中に延ばした回数も持ち越す
  --
  --   引き継がずに空で入れると、prompts の INSERT トリガーが
  --   「いま ＋ T」で期限を作り直し、**カードをめくっていた時間が消える。**
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

  -- --- 2. 答えのカード ------------------------------------------------------
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

  -- --- 2-b. 派生関係（D161）--------------------------------------------------
  if v_carried > 0 then
    insert into public.prompt_element_origins
      (prompt_id, tag_id, source_prompt_id, source_work_id)
    select v_prompt_id, c.tag_id, c.source_prompt_id, c.source_work_id
      from public.draft_session_carried c
     where c.session_id = p_session_id
    on conflict (prompt_id, tag_id) do nothing;
  end if;

  -- --- 3〜5. 出題と4択を作る ------------------------------------------------
  perform public.build_quiz_for_prompt(v_prompt_id, v_session.quiz_question_count);

  -- --- 6. ドラフトを完了にする ----------------------------------------------
  update public.draft_sessions ds
     set status       = 'completed',
         completed_at = clock_timestamp()
   where ds.id = p_session_id;

  return jsonb_build_object(
    'prompt_id',      v_prompt_id,
    'mode_key',       v_session.mode_key,
    'card_count',     v_slot_count,
    'question_count', v_session.quiz_question_count
  );
end;
$fn$;

comment on function public.complete_draft(uuid) is
  'お題とクイズを確定生成する。ドラフトの開始時刻・期限・更新回数をそのまま引き継ぐ（D163）。'
  '猶予を使い切ったドラフトでは断る。持ち出しの派生関係も記録する（D161）。';

revoke all on function public.complete_draft(uuid) from public, anon, authenticated;
grant execute on function public.complete_draft(uuid) to authenticated;
