-- ============================================================================
-- 016_profile_public_rpcs_rollback.sql ／ profile_public_rpcs を取り消す
-- ============================================================================
--
-- 【使うとき】
--   Step 14（公開プロフィール・公開設定・お気に入り一覧）をやり直したいとき。
--
-- 【実行方法】
--   Supabase ダッシュボード → SQL Editor → New query → 貼り付けて Run
--
-- 【消えるもの】
--   ・update_my_visibility / get_public_profile / get_user_works
--     get_saved_works / get_public_answers（5本）
--
-- 【消えないもの】
--   ・**すべてのデータ**。追加した5本はどれも読むだけ、または
--     profiles の show_* 3列を更新するだけで、行を消さない
--   ・saves / likes / answers / works の中身
--   ・全21表とその構造
--
-- ============================================================================
-- 【重要】update_my_profile は自動では戻さない
-- ============================================================================
--
--   Step 14 で足したのは「予約語の検査」1ブロックだけ。消すと
--   admin / official のような ID を取れる状態に戻る。
--
--   それを承知で戻したい場合だけ、下の「予約語の検査を外す」を
--   **意図して** 実行すること。
--
--   なお、この工程より前に取られた予約語の ID があっても、
--   検査は「自分がいま持っている ID なら通す」ので、あとから
--   保存できなくなることはない。
--
-- ============================================================================


begin;

drop function if exists public.update_my_visibility(boolean, boolean, boolean);
drop function if exists public.get_public_profile(text);
drop function if exists public.get_user_works(uuid, text, text, int, int);
drop function if exists public.get_saved_works(uuid, int, int);
drop function if exists public.get_public_answers(uuid, int, int);

commit;


-- ============================================================================
-- 予約語の検査を外す（実行は任意。**意図して**流すこと）
-- ============================================================================
--
-- Step 6 本体の定義（20260803051911_profile_rpc.sql）をそのまま貼り直す。
-- ファイルが手元にあるので、ここには重複して置かない。
--
--   supabase/migrations/20260803051911_profile_rpc.sql
--   の create function 〜 grant execute までを SQL Editor で実行する
--   （create function を create or replace function に読み替える）。


-- ============================================================================
-- 確認用（実行は任意）
-- ============================================================================
--
-- ① 5本が消えていること（0 行）
-- select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname='public'
--    and p.proname in ('update_my_visibility','get_public_profile',
--                      'get_user_works','get_saved_works','get_public_answers');
--
-- ② お気に入りが無事であること
-- select count(*) from public.saves;
--
-- ③ 公開設定が無事であること
-- select count(*) from public.profiles where show_saved_works;
