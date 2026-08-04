-- ============================================================================
-- 020_account_deletion_and_terms_rollback.sql ／ 退会・規約を取り消す
-- ============================================================================
--
-- ============================================================================
-- 【警告】流す前に必ず読むこと
-- ============================================================================
--
--   このファイルは**守りを外す**。とくに次の2つは戻すと危ない。
--
--   ① 書き込みの門番（8つのトリガー）
--      外すと、**退会処理中の人がまた投稿できるようになる。**
--      すでに退会した人が古い JWT を持っていれば、その人も書ける。
--
--   ② 規約への同意の要求
--      外すと、同意していない人でも投稿できるようになる。
--
--   **works.user_id を not null に戻すのは、原則としてできない。**
--   すでに退会した人がいれば、その作品の user_id は null になっている。
--   戻すには、その作品を消すか、誰かに付け替えるしかない。
--   消すと、**その作品に答えた他人の記録まで道連れになる**（cascade）。
--
--   だから第4節は既定で実行しない形にしてある。
--
-- ============================================================================
--
-- 【使うとき】
--   退会の仕組みそのものが誤りだったと判断したとき。
--
-- 【実行方法】
--   Supabase ダッシュボード → SQL Editor → New query → 貼り付けて Run
--
-- 【消えないもの】
--   ・すべての作品・回答・お題・通報・タグ
--   ・すでに退会した人の profiles（もう消えている）
--   ・すでに null になった works.user_id（戻せない）
--
-- ============================================================================


-- --- 1. 門番を外す --------------------------------------------------------------
--
-- **ここが守りの本体。**外すと退会処理中でも書けるようになる。

drop trigger if exists guard_account_active on public.answers;
drop trigger if exists guard_account_active on public.likes;
drop trigger if exists guard_account_active on public.saves;
drop trigger if exists guard_account_active on public.reports;
drop trigger if exists guard_account_active on public.draft_sessions;
drop trigger if exists guard_account_active on public.prompts;
drop trigger if exists guard_works          on public.works;
drop trigger if exists guard_profiles       on public.profiles;

drop function if exists public.app_guard_account_active();
drop function if exists public.app_guard_works();
drop function if exists public.app_guard_profiles();


-- --- 2. RPC を消す --------------------------------------------------------------

drop function if exists public.start_account_deletion(text);
drop function if exists public.agree_to_documents(text, text);
drop function if exists public.get_account_state();
drop function if exists public.get_current_documents();
drop function if exists public.app_handle_hash(text);


-- --- 3. Storage のポリシーを戻す -------------------------------------------------
--
-- 退会処理中かどうかを見ない、元の3本に戻す。

drop policy if exists works_objects_insert_own on storage.objects;
create policy works_objects_insert_own
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'works'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  );

drop policy if exists works_objects_update_own on storage.objects;
create policy works_objects_update_own
  on storage.objects for update to authenticated
  using (
    bucket_id = 'works'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  )
  with check (
    bucket_id = 'works'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists works_objects_delete_own on storage.objects;
create policy works_objects_delete_own
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'works'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );


-- --- 4. works を元に戻す（**既定では実行しない**）--------------------------------
--
-- コメントを外す前に、次を実行して0件であることを確かめること。
-- 1件でもあれば、戻すにはその作品を消すしかない。
--
--   select count(*) from public.works where user_id is null;
--
-- 0件でなければ**触らないこと。**

-- alter table public.works drop constraint if exists works_owner_or_deleted;
--
-- alter table public.works drop constraint if exists works_user_id_fkey;
-- alter table public.works
--   add constraint works_user_id_fkey
--     foreign key (user_id) references public.profiles (id)
--     on delete restrict on update restrict;
--
-- alter table public.works alter column user_id      set not null;
-- alter table public.works alter column title        set not null;
-- alter table public.works alter column image_path   set not null;
-- alter table public.works alter column image_width  set not null;
-- alter table public.works alter column image_height set not null;
--
-- alter table public.works drop constraint if exists works_fanart_requires_source;
-- alter table public.works
--   add constraint works_fanart_requires_source
--     check (division <> 'fanart' or source_title is not null);


-- --- 5. 表を消す（**既定では実行しない**）----------------------------------------
--
-- terms_agreements には同意の記録が入っている。**法的な記録なので、
-- 消してよいかを確かめてから外すこと。**
--
-- account_deletions と storage_cleanup_queue には、まだ片づいていない
-- 後始末が入っていることがある。消すと**消し残しが永久に残る。**
--
-- 先に次を実行し、0件であることを確かめること。
--
--   select count(*) from public.account_deletions;
--   select count(*) from public.storage_cleanup_queue where deleted_at is null;

-- drop table if exists public.terms_agreements;
-- drop table if exists public.terms_versions;
-- drop table if exists public.privacy_versions;
-- drop table if exists public.account_deletions;
-- drop table if exists public.storage_cleanup_queue;
-- drop table if exists public.handle_reservations;
-- drop table if exists public.app_secrets;


-- --- 6. profiles の列を消す（**既定では実行しない**）-----------------------------
--
-- account_status を消すと、退会処理中の人が区別できなくなる。
-- 第1節で門番を外したあとなら意味は無いが、記録としては残しておきたい。

-- alter table public.profiles drop column if exists account_status;
-- alter table public.profiles drop column if exists deletion_requested_at;


-- ============================================================================
-- 確認用（実行は任意）
-- ============================================================================
--
-- ① 門番が消えたか（0件になる）
-- select tgname, tgrelid::regclass::text from pg_trigger
--  where not tgisinternal
--    and tgname in ('guard_account_active','guard_works','guard_profiles');
--
-- ② 持ち主のいない作品（第4節を触る前に必ず見る）
-- select count(*) from public.works where user_id is null;
--
-- ③ 片づいていない後始末
-- select count(*) as 退会待ち from public.account_deletions;
-- select count(*) as 画像待ち from public.storage_cleanup_queue where deleted_at is null;
