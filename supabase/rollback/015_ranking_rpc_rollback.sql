-- ============================================================================
-- 015_ranking_rpc_rollback.sql ／ ranking_rpc を取り消す
-- ============================================================================
--
-- 【使うとき】
--   Step 13（ランキング）をやり直したいとき。
--
-- 【実行方法】
--   Supabase ダッシュボード → SQL Editor → New query → 貼り付けて Run
--
-- 【消えるもの】
--   ・get_rankings（1本だけ）
--
-- 【消えないもの】
--   ・**すべてのデータ**。この関数は読むだけで、何も書いていない
--   ・works / likes / work_slot_stats の値
--   ・ほかの関数・トリガー・ポリシー・全21表
--
-- 順位を保存する表は作っていないので、消すものが1本しか無い。
-- 実行しても、ランキングのページが 500 になる以外の影響は出ない。
--
-- ============================================================================


begin;

drop function if exists public.get_rankings(text, text, text, int, int);

commit;


-- ============================================================================
-- 確認用（実行は任意）
-- ============================================================================
--
-- ① 関数が消えていること（0 行）
-- select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname='public' and p.proname = 'get_rankings';
--
-- ② いいねが無事であること
-- select count(*) from public.likes;
--
-- ③ 集計が無事であること
-- select count(*) from public.work_slot_stats;
