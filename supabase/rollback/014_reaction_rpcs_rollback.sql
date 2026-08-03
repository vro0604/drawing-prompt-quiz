-- ============================================================================
-- 014_reaction_rpcs_rollback.sql ／ reaction_rpcs を取り消す
-- ============================================================================
--
-- 【使うとき】
--   Step 12（いいね・保存）をやり直したいとき。
--
-- 【実行方法】
--   Supabase ダッシュボード → SQL Editor → New query → 貼り付けて Run
--
-- 【消えるもの】
--   ・toggle_like / toggle_save
--   ・カウンタを同期するトリガー2本と、その関数2本
--
-- 【消えないもの】
--   ・**すでに押されたいいね・保存**（likes / saves は1行も触らない）
--   ・**works.likes_count / saves_count の値**
--   ・全21表とその構造
--
-- ============================================================================
-- 【重要】カウンタは 0 に戻さない
-- ============================================================================
--
--   トリガーを消しても、これまでに加算された数はそのまま残る。
--   0 に戻すと「いいねはあるのに件数が0」というずれた状態になり、
--   診断 A11 が鳴り続ける。
--
--   トリガーを作り直したあとに数え直したい場合は、
--   下の「数え直し」を **意図して** 実行すること。
--   これはデータの書き換えにあたるので、このファイルでは自動実行しない。
--
-- ============================================================================


begin;

-- --- 1. トリガー（先に外す。関数を消す前）-----------------------------------

drop trigger if exists likes_after_change_counts on public.likes;
drop trigger if exists saves_after_change_counts on public.saves;


-- --- 2. 関数 -----------------------------------------------------------------

drop function if exists public.toggle_like(uuid);
drop function if exists public.toggle_save(uuid);
drop function if exists public.likes_after_change_counts();
drop function if exists public.saves_after_change_counts();

commit;


-- ============================================================================
-- 数え直し（実行は任意。**意図して**流すこと）
-- ============================================================================
--
-- 【先に確認する】ずれている行が無ければ、下の更新は流さなくてよい。
--
-- select w.id, w.likes_count, w.saves_count,
--        (select count(*) from public.likes l where l.work_id = w.id) as actual_likes,
--        (select count(*) from public.saves s where s.work_id = w.id) as actual_saves
--   from public.works w
--  where w.likes_count <> (select count(*) from public.likes l where l.work_id = w.id)
--     or w.saves_count <> (select count(*) from public.saves s where s.work_id = w.id);
--
--
-- 【揃え直す】
--
-- begin;
-- update public.works w
--    set likes_count = (select count(*) from public.likes l where l.work_id = w.id),
--        saves_count = (select count(*) from public.saves s where s.work_id = w.id);
-- commit;


-- ============================================================================
-- 確認用（実行は任意）
-- ============================================================================
--
-- ① 関数が消えていること（0 行）
-- select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname='public'
--    and p.proname in ('toggle_like','toggle_save',
--                      'likes_after_change_counts','saves_after_change_counts');
--
-- ② トリガーが消えていること（0 行）
-- select tgname from pg_trigger
--  where not tgisinternal and tgname like '%after_change_counts';
--
-- ③ いいね・保存が無事であること
-- select count(*) from public.likes;
-- select count(*) from public.saves;
