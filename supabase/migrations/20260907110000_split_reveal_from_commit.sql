-- ============================================================================
-- 20260907110000 ／ めくることと決めることを分ける（D170 の最後の1手）
-- ============================================================================
--
-- 出所: ユーザー指示「旧フロント＋新DBの不整合時間をどう避けるか決めてから
-- 作業してください」（2026-09-07）。
--
-- 【このファイルだけ、当てる順番が違う】
--   ほかの3本（090000 / 093000 / 094000）は、いま動いている画面のままでも
--   問題なく当てられる。新しい表と新しい関数が増えるだけで、
--   いまの画面が呼んでいる関数の振る舞いは1つも変わらないため。
--
--   このファイルだけが、いまの画面が呼んでいる `reveal_card` の
--   振る舞いを変える。**めくっても決まらなくなる。**
--   いまの画面は「めくった＝決まった」前提で作られているので、
--   これを先に当てると、画面が入れ替わるまでのあいだ枠が進まなくなる。
--
--   だから当てる順番はこうする。
--
--     1. 090000 / 093000 / 094000 を当てる  … いまの画面はそのまま動く
--     2. 新しい画面を本番へ出す              … 新しい画面もそのまま動く
--                                              （このときはまだ「めくる＝決まる」）
--     3. このファイルを当てる                … ここで初めて2段になる
--
--   1 と 2 のあいだ、2 と 3 のあいだ、どちらも壊れない。
--   **止まる時間が1秒も生まれない。**
--
-- 【当てたあとに何が変わるか】
--   カードの状態が3つになる。
--
--     hidden           revealed_at が null
--     revealed_pending revealed_at が入っていて、is_chosen が false
--     chosen           is_chosen が true
--
--   めくっても枠は進まない。進むのは choose_card だけ。
--   読み込み直しても、めくった状態のまま復元される。
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
  v_uid        uuid := (select auth.uid());
  v_session    record;
  v_slot_order int;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select ds.id, ds.status, ds.current_generation, ds.current_slot_order
    into v_session
    from public.draft_sessions ds
   where ds.id = p_session_id and ds.user_id = v_uid;

  if not found then
    raise exception 'DRAFT_NOT_FOUND: そのドラフトは見つかりません。';
  end if;

  if v_session.status <> 'in_progress' then
    raise exception 'DRAFT_NOT_IN_PROGRESS: そのドラフトは終了しています。';
  end if;

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

  -- **二度めくっても同じカードのまま。**時刻は最初の1回だけ書く。
  -- 二重送信でも別の候補に変わらない。
  update public.draft_candidates dc
     set revealed_at = coalesce(dc.revealed_at, clock_timestamp())
   where dc.session_id = p_session_id
     and dc.generation = v_session.current_generation
     and dc.card_slot_key = p_card_slot_key
     and dc.candidate_index = p_candidate_index;

  if not found then
    raise exception 'CANDIDATE_NOT_FOUND: %番のカードはありません。', p_candidate_index;
  end if;

  return public.draft_state_json(p_session_id);
end;
$fn$;


comment on function public.reveal_card(uuid, text, int) is
  'カードをめくる（D170）。**決定はしない。**枠も進まない。二度押しても同じカード。';
