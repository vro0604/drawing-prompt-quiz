-- ============================================================================
-- 012_quiz_choice_dedupe_rollback.sql ／ quiz_choice_dedupe を取り消す
-- ============================================================================
--
-- 【使うとき】
--   選択肢の重複禁止をやり直したいとき。
--
-- 【実行方法】
--   Supabase ダッシュボード → SQL Editor → New query → 貼り付けて Run
--
-- 【消えるもの】
--   ・quiz_choice_dedupe_cutoff（診断 A23 が使う境目）
--
-- 【消えないもの】
--   ・**すでに作られたお題・クイズ・選択肢**（1行も触らない）
--   ・全21表とその構造
--
-- ============================================================================
-- 【重要】戻すと不具合も戻る
-- ============================================================================
--
--   complete_draft が draft_rpcs 当時の定義に戻り、**同じタグが複数の問に
--   出るようになる**。そのタグは全問で不正解だと確定するため、
--   4択が実質3択になる。
--
--   戻したあとに作られたお題は、その状態のまま残る（作り直さない方針のため）。
--   一時的な切り分け以外では戻さないこと。
--
--   なお診断 A23 は quiz_choice_dedupe_cutoff が無いと実行できなくなる。
--   db:verify のその項目はクエリ失敗として表示される。
--
-- ============================================================================


begin;

-- --- 1. complete_draft を draft_rpcs 当時の定義へ戻す ------------------------

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
  v_bad          int;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select ds.id, ds.status, ds.mode_key, ds.reroll_count,
         ds.current_generation, ds.time_limit_seconds, ds.quiz_question_count
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

  select count(*) into v_slot_count
    from public.draft_mode_slots dms
   where dms.mode_key = v_session.mode_key;

  select count(*) into v_chosen_count
    from public.draft_candidates dc
   where dc.session_id = p_session_id
     and dc.generation = v_session.current_generation
     and dc.is_chosen;

  if v_chosen_count <> v_slot_count then
    raise exception 'DRAFT_INCOMPLETE: まだ決まっていない枠があります（%/%）。',
      v_chosen_count, v_slot_count;
  end if;

  insert into public.prompts
    (draft_session_id, created_by, mode_key, time_limit_seconds,
     was_rerolled, reroll_count, status)
  values
    (p_session_id, v_uid, v_session.mode_key, v_session.time_limit_seconds,
     v_session.reroll_count > 0, v_session.reroll_count, 'active')
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

  insert into public.quiz_questions (prompt_id, card_slot_key, position)
  select v_prompt_id, x.card_slot_key, x.rn - 1
    from (
      select cs.card_slot_key,
             row_number() over (order by cs.quiz_priority) as rn
        from public.draft_mode_slots dms
        join public.card_slots cs on cs.card_slot_key = dms.card_slot_key
       where dms.mode_key = v_session.mode_key
         and cs.is_quiz_eligible
    ) x
   where x.rn <= v_session.quiz_question_count;

  get diagnostics v_inserted = row_count;
  if v_inserted <> v_session.quiz_question_count then
    raise exception
      'QUESTION_COUNT_MISMATCH: 出題できる枠が %個しかありません（必要 %個）。',
      v_inserted, v_session.quiz_question_count;
  end if;

  -- 【注意】ここが重複を生む版。問ごとに独立してハズレを引いている。
  insert into public.quiz_choices (question_id, tag_id, position, is_correct)
  with q as (
    select qq.id as question_id,
           cs.pool_key,
           pc.tag_id as correct_tag_id
      from public.quiz_questions qq
      join public.card_slots   cs on cs.card_slot_key = qq.card_slot_key
      join public.prompt_cards pc on pc.prompt_id     = qq.prompt_id
                                 and pc.card_slot_key = qq.card_slot_key
     where qq.prompt_id = v_prompt_id
  ),
  used as (
    select pc.tag_id from public.prompt_cards pc where pc.prompt_id = v_prompt_id
  ),
  distractor_lots as (
    select q.question_id, t.id as tag_id, random() as lot
      from q
      join public.tags t on t.pool_key = q.pool_key and t.is_active
     where t.id not in (select u.tag_id from used u)
  ),
  distractors as (
    select dl.question_id, dl.tag_id, false as is_correct,
           row_number() over (partition by dl.question_id order by dl.lot) as rn
      from distractor_lots dl
  ),
  picked as (
    select d.question_id, d.tag_id, d.is_correct
      from distractors d
     where d.rn <= 3
    union all
    select q.question_id, q.correct_tag_id, true from q
  ),
  shuffle_lots as (
    select p.question_id, p.tag_id, p.is_correct, random() as lot from picked p
  )
  select sl.question_id,
         sl.tag_id,
         (row_number() over (partition by sl.question_id order by sl.lot))::int - 1,
         sl.is_correct
    from shuffle_lots sl;

  get diagnostics v_inserted = row_count;
  if v_inserted <> v_session.quiz_question_count * 4 then
    raise exception
      'CHOICE_COUNT_MISMATCH: 選択肢が %件です（必要 %件）。同じプールのタグが不足しています。',
      v_inserted, v_session.quiz_question_count * 4;
  end if;

  select count(*) into v_bad
    from public.quiz_questions qq
   where qq.prompt_id = v_prompt_id
     and (
       (select count(*) from public.quiz_choices qc
         where qc.question_id = qq.id) <> 4
       or
       (select count(*) from public.quiz_choices qc
         where qc.question_id = qq.id and qc.is_correct) <> 1
     );

  if v_bad > 0 then
    raise exception 'QUIZ_BROKEN: 選択肢または正解の数が正しくない問が%件あります。', v_bad;
  end if;

  update public.draft_sessions ds
     set status       = 'completed',
         completed_at = clock_timestamp()
   where ds.id = p_session_id;

  return jsonb_build_object(
    'prompt_id',  v_prompt_id,
    'mode_key',   v_session.mode_key,
    'card_count', v_slot_count,
    'question_count', v_session.quiz_question_count
  );
end;
$fn$;

revoke all on function public.complete_draft(uuid) from public, anon, authenticated;
grant execute on function public.complete_draft(uuid) to authenticated;


-- --- 2. 境目の関数 ----------------------------------------------------------

drop function if exists public.quiz_choice_dedupe_cutoff();

commit;


-- ============================================================================
-- 確認用（実行は任意）
-- ============================================================================
--
-- ① 重複禁止が外れていること（0 行が返れば戻っている）
-- select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname='public' and p.proname='complete_draft'
--    and p.prosrc like '%QUIZ_CHOICES_DUPLICATE%';
--
-- ② 既存のクイズが無事であること
-- select count(*) from public.quiz_questions;
-- select count(*) from public.quiz_choices;
