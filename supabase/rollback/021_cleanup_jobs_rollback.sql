-- ============================================================================
-- 021_cleanup_jobs_rollback.sql ／ 掃除の関数を取り消す
-- ============================================================================
--
-- 【流す前に】
--   これを流すと掃除が止まる。**データは1件も消えないが、減らなくなる。**
--
--   止まって困るのは次の2つ。どちらも「消し残し」なので、
--   放っておくと個人情報が残り続ける。
--
--     ・auth.users を消せていない退会（account_deletions）
--     ・Storage から消せていない画像（storage_cleanup_queue）
--
--   止めるなら、代わりの手段を用意してから止めること。
--   残り件数は次で見られる（この関数も消えるので、先に控えること）。
--
--     select public.cleanup_status();
--
-- 【実行方法】
--   Supabase ダッシュボード → SQL Editor → New query → 貼り付けて Run
--
-- 【消えないもの】
--   ・すべてのデータ。この操作は関数だけを消す
--   ・掃除待ちの列そのもの（storage_cleanup_queue / account_deletions）
--
-- ============================================================================

drop function if exists public.cleanup_orphan_prompts(int);
drop function if exists public.cleanup_stale_drafts(int);
drop function if exists public.cleanup_expired_agreements(int);
drop function if exists public.enqueue_orphan_work_images(int);
drop function if exists public.list_pending_storage_objects(int);
drop function if exists public.mark_storage_object_done(bigint);
drop function if exists public.mark_storage_object_failed(bigint, text);
drop function if exists public.list_pending_account_deletions(int);
drop function if exists public.finish_account_deletion(uuid);
drop function if exists public.fail_account_deletion(uuid, text);
drop function if exists public.list_stale_guests(int);
drop function if exists public.cleanup_status();


-- ============================================================================
-- 確認用（実行は任意）
-- ============================================================================
--
-- ① 関数が消えたか（0件になる）
-- select proname from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and proname in ('cleanup_orphan_prompts','cleanup_stale_drafts',
--                    'cleanup_expired_agreements','enqueue_orphan_work_images',
--                    'list_pending_storage_objects','mark_storage_object_done',
--                    'mark_storage_object_failed','list_pending_account_deletions',
--                    'finish_account_deletion','fail_account_deletion',
--                    'list_stale_guests','cleanup_status');
--
-- ② 片づいていない後始末（止める前に必ず見る）
-- select count(*) as 退会待ち from public.account_deletions;
-- select count(*) as 画像待ち from public.storage_cleanup_queue where deleted_at is null;
