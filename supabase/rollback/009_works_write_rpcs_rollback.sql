-- ============================================================================
-- 009_works_write_rpcs_rollback.sql ／ works_write_rpcs を取り消す
-- ============================================================================
--
-- 【使うとき】
--   Step 7（作品投稿）をやり直したいとき。
--
-- 【実行方法】
--   Supabase ダッシュボード → SQL Editor → New query → 貼り付けて Run
--   （取り消しは CLI では流さない。db push は「前へ進む」ためのものなので、
--     戻す操作は意図を持って手で行う）
--
-- 【消えるもの】
--   ・create_work / update_work の2本
--   ・storage.objects に張った works 用ポリシー4本
--
-- 【消えないもの】
--   ・全21表とその構造・データ
--   ・**投稿済みの作品（works の行）**
--   ・**Storage バケット works と、その中の画像**
--   ・001〜008 で作った関数・ポリシー・権限
--
-- ============================================================================
-- 【バケットと画像をこのファイルで消さない理由】
-- ============================================================================
--
--   バケットを消すと中の画像が消える。画像が消えると works.image_path が
--   指す先が無くなり、投稿済みの作品が壊れる。
--
--   「関数をやり直したいだけ」で作品が壊れるのは割に合わないので、
--   バケットの削除はこのファイルに含めない。
--   本当に消すときは、先に作品が0件であることを確かめてから
--   ダッシュボードの Storage 画面で手で消す。
--
--     select count(*) from public.works;   -- 0 であることを確認
--
--   なお、ポリシー4本を消すとバケットは
--   「公開読み取りはできるが、誰もアップロードできない」状態になる。
--   これは安全側の状態で、既存の画像は配信され続ける。
--
-- ============================================================================


begin;

-- --- 1. 書き込みRPC 2本 -----------------------------------------------------

drop function if exists public.update_work(uuid, text, text, text, text, int, boolean);
drop function if exists public.create_work(uuid, uuid, text, text, int, int, text,
                                           text, text, text, int, boolean);


-- --- 2. storage.objects のポリシー4本 ---------------------------------------

drop policy if exists works_objects_read_public on storage.objects;
drop policy if exists works_objects_insert_own  on storage.objects;
drop policy if exists works_objects_update_own  on storage.objects;
drop policy if exists works_objects_delete_own  on storage.objects;

commit;


-- ============================================================================
-- 確認用（実行は任意）
-- ============================================================================
--
-- ① 書き込みRPCが消えていること（0 行が返れば成功）
-- select proname from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname in ('create_work','update_work');
--
-- ② works 用ポリシーが消えていること（0 行）
-- select policyname from pg_policies
--  where schemaname = 'storage' and tablename = 'objects'
--    and policyname like 'works\_objects\_%';
--
-- ③ 投稿済みの作品が無事であること
-- select count(*) from public.works;
--
-- ④ バケットが残っていること（1 行）
-- select id, public, file_size_limit, allowed_mime_types from storage.buckets
--  where id = 'works';
