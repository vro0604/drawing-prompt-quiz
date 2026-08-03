-- ============================================================================
-- 017_step15_rollback.sql ／ step15 を取り消す
-- ============================================================================
--
-- 【使うとき】
--   Step 15（旧IDの保護・通報・削除）をやり直したいとき。
--
-- 【実行方法】
--   Supabase ダッシュボード → SQL Editor → New query → 貼り付けて Run
--
-- 【消えるもの】
--   ・get_handle_redirect / create_report / delete_work /
--     mark_work_image_deleted（4本）
--
-- 【消えないもの】
--   ・**すべてのデータ**。作品も通報も1行も消さない
--   ・handle_history 表と、その中身
--   ・profiles.handle_updated_at / works.image_deleted_at の2列
--   ・update_my_profile（下記のとおり自動では戻さない）
--
-- ============================================================================
-- 【重要】表と列は残す
-- ============================================================================
--
--   works.image_deleted_at を消すと、**どの画像をすでに消したかが失われる**。
--   Step 16 の掃除が「まだ消えていない」と判断して、消えているファイルを
--   もう一度消しにいく。実害は小さいが、消し残しの調査ができなくなる。
--
--   handle_history を消すと、手放した ID が誰でも取れる状態に戻る。
--   外部に貼られたリンクが別人に届く（P5 そのもの）。
--
--   profiles.handle_updated_at を消すと、30日制限の基準が失われる。
--
--   どれも「残っていても害が無く、消すと情報が失われる」ものなので、
--   取り消しの既定では触らない。それでも消したい場合は、
--   いちばん下の「表と列も消す」を **意図して** 実行すること。
--
-- ============================================================================
-- 【重要】update_my_profile は自動では戻さない
-- ============================================================================
--
--   Step 15 で足したのは「他人の旧ID を断る」「30日に1回」の2つの検査と、
--   控えの書き込みだけ。消すと P5 が未解決の状態に戻る。
--
--   戻したい場合は Step 14 の定義
--   （supabase/migrations/20260803210859_profile_public_rpcs.sql の
--     update_my_profile）を create or replace として貼り直す。
--
-- ============================================================================


begin;

drop function if exists public.get_handle_redirect(text);
drop function if exists public.create_report(uuid, text, text);
drop function if exists public.delete_work(uuid);
drop function if exists public.mark_work_image_deleted(uuid);

commit;


-- ============================================================================
-- 表と列も消す（実行は任意。**意図して**流すこと）
-- ============================================================================
--
-- 上の理由を読んだうえで消す場合だけ。
--
-- begin;
-- drop table if exists public.handle_history;
-- alter table public.profiles drop column if exists handle_updated_at;
-- alter table public.works    drop column if exists image_deleted_at;
-- commit;


-- ============================================================================
-- 削除した作品を戻す（実行は任意。**意図して**流すこと）
-- ============================================================================
--
-- delete_work は行を消さないので、deleted_at を外せば戻せる。
-- ただし画像がすでに Storage から消えていると、画像だけが欠けた
-- 作品になる。image_deleted_at が null の作品だけが安全に戻せる。
--
-- 【先に確認する】
-- select id, title, deleted_at, image_deleted_at
--   from public.works where deleted_at is not null;
--
-- 【戻す】（画像が残っているものだけ）
-- begin;
-- update public.works
--    set deleted_at = null
--  where id = 'ここに作品ID'
--    and image_deleted_at is null;
-- commit;
--
-- 公開に戻すかどうかは本人の操作（update_work）に任せる。
-- 削除時に is_published = false にしてあるので、勝手には公開されない。


-- ============================================================================
-- 確認用（実行は任意）
-- ============================================================================
--
-- ① 4本が消えていること（0 行）
-- select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname='public'
--    and p.proname in ('get_handle_redirect','create_report',
--                      'delete_work','mark_work_image_deleted');
--
-- ② 作品と通報が無事であること
-- select count(*) from public.works;
-- select count(*) from public.reports;
--
-- ③ 旧IDの控えが無事であること
-- select count(*) from public.handle_history;
