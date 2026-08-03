-- ============================================================================
-- 007_read_rpcs_rollback.sql ／ 007 を取り消す
-- ============================================================================
--
-- 【使うとき】
--   Step 3C をやり直したい／Step 3B-3b 完了時点（21表・RPCなし）へ戻したいとき。
--
-- 【実行方法】
--   Supabase ダッシュボード → SQL Editor → New query → 貼り付けて Run
--
-- 【消えるもの】
--   ・取得系RPC 13本（と、その実行権限）
--
-- 【消えないもの】
--   ・**全21表とそのデータ**（この工程は表を1つも触っていない）
--   ・Step 2 の handle_new_user / sync_profile_anonymous_flag
--   ・Step 3B-2a の draft_sessions_set_updated_at
--   → 関数を消すだけなので、データが失われることはない。
--
-- 【drop function の引数について】
--   Postgres は同じ名前で引数の違う関数を複数持てるため、
--   消すときは引数の型まで指定する必要がある。
--   if exists を付けてあるので、対象が無くてもエラーにならない。
--
-- ============================================================================


begin;

-- 誰でも呼べる4本
drop function if exists public.get_public_works(text, text, int, int);
drop function if exists public.get_work_detail(uuid);
drop function if exists public.get_work_quiz(uuid);
drop function if exists public.get_public_saves(uuid, int, int);

-- 本人だけの9本
drop function if exists public.get_my_works(int, int);
drop function if exists public.get_my_work(uuid);
drop function if exists public.get_my_prompts(int, int);
drop function if exists public.get_my_prompt(uuid);
drop function if exists public.get_my_answers(int, int);
drop function if exists public.get_my_answer(uuid);
drop function if exists public.get_my_likes(int, int);
drop function if exists public.get_my_saves(int, int);
drop function if exists public.get_my_reaction(uuid);

commit;


-- ============================================================================
-- 確認用（実行は任意）
-- ============================================================================
--
-- ① 13本が消えていること（0 行が返れば成功）
-- select proname from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname like 'get\_%';
--
-- ② 既存の関数3本が無事であること（3 行返る）
-- select proname from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and p.proname in ('handle_new_user','sync_profile_anonymous_flag',
--                      'draft_sessions_set_updated_at');
--
-- ③ 全21表が無事であること（21 が返る）
-- select count(*) from pg_tables where schemaname = 'public';
--
-- ④ マスタ行数が変わっていないこと（8 / 10 / 2 / 8 / 0）
-- select 'tag_pools' as t, count(*) from public.tag_pools
-- union all select 'card_slots',       count(*) from public.card_slots
-- union all select 'draft_modes',      count(*) from public.draft_modes
-- union all select 'draft_mode_slots', count(*) from public.draft_mode_slots
-- union all select 'tags',             count(*) from public.tags;
