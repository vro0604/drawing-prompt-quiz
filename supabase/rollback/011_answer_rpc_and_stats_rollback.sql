-- ============================================================================
-- 011_answer_rpc_and_stats_rollback.sql ／ answer_rpc_and_stats を取り消す
-- ============================================================================
--
-- 【使うとき】
--   Step 10 / 11（クイズの回答と集計）をやり直したいとき。
--
-- 【実行方法】
--   Supabase ダッシュボード → SQL Editor → New query → 貼り付けて Run
--
-- 【消えるもの】
--   ・submit_answer
--   ・集計トリガー2本と、その関数2本
--
-- 【消えないもの】
--   ・全21表とその構造
--   ・**すでに入っている回答（answers / answer_items）**
--   ・**すでに動いた集計の値**（works.answers_count / 集計3表）
--
-- ============================================================================
-- 【重要】集計の値は戻さない
-- ============================================================================
--
--   トリガーを消しても、これまでに加算された数はそのまま残る。
--   0 に戻すと「回答はあるのに件数が0」というずれた状態になり、
--   診断 A8 / A11 / A20 / A21 が鳴り続ける。
--
--   トリガーを作り直したあとに数え直したい場合は、
--   下の「数え直し」を **意図して** 実行すること。
--   これはデータの書き換えにあたるので、このファイルでは自動実行しない。
--
-- ============================================================================


begin;

-- --- 1. トリガー（先に外す。関数を消す前）-----------------------------------

drop trigger if exists answer_items_after_insert_stats on public.answer_items;
drop trigger if exists answers_after_insert_stats      on public.answers;


-- --- 2. 関数 -----------------------------------------------------------------

drop function if exists public.submit_answer(uuid, jsonb);
drop function if exists public.answer_items_after_insert_stats();
drop function if exists public.answers_after_insert_stats();

commit;


-- ============================================================================
-- 数え直し（実行は任意。**意図して**流すこと）
-- ============================================================================
--
-- トリガーを作り直したあと、集計が正本（answers / answer_items）と
-- 合っているかを確かめ、合っていなければ揃え直す。
--
-- 【先に確認する】ずれている行が無ければ、下の更新は流さなくてよい。
--
-- select w.id, w.answers_count,
--        (select count(*) from public.answers a where a.work_id = w.id) as actual
--   from public.works w
--  where w.answers_count <> (select count(*) from public.answers a where a.work_id = w.id);
--
--
-- 【揃え直す】
--
-- begin;
--
-- update public.works w
--    set answers_count = (select count(*) from public.answers a where a.work_id = w.id);
--
-- delete from public.work_slot_stats;
-- insert into public.work_slot_stats (work_id, card_slot_key, attempts, corrects, updated_at)
-- select a.work_id, ai.card_slot_key, count(*),
--        count(*) filter (where ai.is_correct), now()
--   from public.answer_items ai
--   join public.answers a on a.id = ai.answer_id
--  group by a.work_id, ai.card_slot_key;
--
-- delete from public.user_stats;
-- insert into public.user_stats (user_id, total_answers, total_items, total_correct_items, updated_at)
-- select a.user_id,
--        count(distinct a.id),
--        count(ai.id),
--        count(*) filter (where ai.is_correct),
--        now()
--   from public.answers a
--   left join public.answer_items ai on ai.answer_id = a.id
--  where a.user_id is not null
--  group by a.user_id;
--
-- delete from public.user_slot_stats;
-- insert into public.user_slot_stats (user_id, card_slot_key, attempts, corrects, updated_at)
-- select a.user_id, ai.card_slot_key, count(*),
--        count(*) filter (where ai.is_correct), now()
--   from public.answer_items ai
--   join public.answers a on a.id = ai.answer_id
--  where a.user_id is not null
--  group by a.user_id, ai.card_slot_key;
--
-- commit;


-- ============================================================================
-- 確認用（実行は任意）
-- ============================================================================
--
-- ① 関数が消えていること（0 行）
-- select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname='public'
--    and p.proname in ('submit_answer','answers_after_insert_stats',
--                      'answer_items_after_insert_stats');
--
-- ② トリガーが消えていること（0 行）
-- select tgname from pg_trigger
--  where not tgisinternal and tgname like '%after_insert_stats';
--
-- ③ 回答が無事であること
-- select count(*) from public.answers;
-- select count(*) from public.answer_items;
