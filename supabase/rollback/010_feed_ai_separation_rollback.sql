-- ============================================================================
-- 010_feed_ai_separation_rollback.sql ／ feed_ai_separation を取り消す
-- ============================================================================
--
-- 【使うとき】
--   Step 8（通常フィードと AI フィードの分離）をやり直したいとき。
--
-- 【実行方法】
--   Supabase ダッシュボード → SQL Editor → New query → 貼り付けて Run
--
-- 【消えるもの】
--   何も消えない。get_public_works の中身が 3C 当時の定義に戻るだけ。
--
-- 【戻したあとの挙動】
--   p_division is null が **全部門（AI を含む）** に戻る。
--   通常フィードに AI 作品が混ざるようになるので、
--   /works 画面はその状態のまま使わないこと。
--
-- ============================================================================


begin;

create or replace function public.get_public_works(
  p_division text default null,
  p_sort     text default 'new',
  p_limit    int  default 24,
  p_offset   int  default 0
)
returns table (
  id                  uuid,
  title               text,
  image_path          text,
  image_width         int,
  image_height        int,
  division            text,
  source_title        text,
  source_character    text,
  fanart_note         text,
  actual_time_seconds int,
  time_limit_seconds  int,
  mode_key            text,
  was_rerolled        boolean,
  likes_count         int,
  saves_count         int,
  answers_count       int,
  created_at          timestamptz,
  author_id           uuid,
  author_handle       text,
  author_display_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    w.id,
    w.title,
    w.image_path,
    w.image_width,
    w.image_height,
    w.division,
    w.source_title,
    w.source_character,
    w.fanart_note,
    w.actual_time_seconds,
    p.time_limit_seconds,
    p.mode_key,
    p.was_rerolled,
    w.likes_count,
    w.saves_count,
    w.answers_count,
    w.created_at,
    pr.id,
    pr.handle,
    pr.display_name
  from public.works w
  join public.prompts  p  on p.id  = w.prompt_id
  join public.profiles pr on pr.id = w.user_id
  where w.is_published
    and w.review_status = 'ok'
    and w.deleted_at is null
    and (p_division is null or w.division = p_division)
  order by
    case when p_sort = 'likes'   then w.likes_count   end desc nulls last,
    case when p_sort = 'answers' then w.answers_count end desc nulls last,
    w.created_at desc,
    w.id desc
  limit  least(greatest(coalesce(p_limit, 24), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.get_public_works(text, text, int, int) is
  '公開作品の一覧。prompt_id は返さない（D23）。';

revoke all on function public.get_public_works(text, text, int, int)
  from public, anon, authenticated;

grant execute on function public.get_public_works(text, text, int, int)
  to anon, authenticated;

commit;


-- ============================================================================
-- 確認用（実行は任意）
-- ============================================================================
--
-- ① 3C の定義に戻っていること（case 式が消えている）
-- select prosrc like '%p_division is null  then%' as ai_separation_still_there
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname='public' and p.proname='get_public_works';
--
-- ② anon から呼べること
-- select count(*) from public.get_public_works(null, 'new', 5, 0);
