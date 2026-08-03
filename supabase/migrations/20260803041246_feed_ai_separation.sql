-- ============================================================================
-- feed_ai_separation ／ Step 8: 通常フィードと AI フィードを分ける
-- ============================================================================
--
-- 【このファイルがやること】
--   get_public_works の絞り込みだけを差し替える（create or replace）。
--
-- 【このファイルがやらないこと】
--   ・表・列・制約・権限・データに一切触れない
--   ・関数の引数・返り値・並び順・件数制限を変えない
--   ・ほかの12本の取得系RPCに触れない
--
-- 【実行方法】
--   npm run db:deploy
--
-- 【取り消し】
--   supabase/rollback/010_feed_ai_separation_rollback.sql
--   （3C 当時の定義へ戻すだけ。表もデータも動かない）
--
--
-- 【なぜ差し替えが要るか】
--
--   spec 13 の Step 8 は「**AI作品が通常フィードに出ない**」を終了条件に
--   している。ところが 3C の get_public_works は
--
--     p_division is null → **全部門**（AI を含む）
--
--   になっていて、通常フィードをこの関数だけでは表現できなかった。
--
--   画面側で AI を除くこともできない。1ページ24件を取ってから AI を捨てると
--   ページごとの件数がばらつき、ページ送りの位置もずれる。
--   **絞り込みは件数を数える前に済んでいる必要がある**ので、SQL 側で行う。
--
--
-- 【p_division の意味（ここで変わる）】
--
--   null        通常フィード。**AI を除く**（original + fanart）  ← 既定
--   'original'  オリジナルだけ
--   'fanart'    ファンアートだけ
--   'ai'        AI だけ
--   'all'       すべて（運営・診断用。画面からは使わない）
--
--   null の意味が「全部門」から「AI以外」に変わる。これは仕様に合わせた
--   修正であって、機能追加ではない。null が全部門を指していた 3C の状態は
--   Step 8 の終了条件を満たせないため、そちらが誤りだった。
--
--   これまで null を使っていた呼び出し元は db:verify の実地確認1件だけで、
--   そこは「anon が呼べること」しか見ていないため影響しない。
--
--
-- 【AI を分ける理由（spec 7-3）】
--
--   生成AIの作品を通常の一覧に混ぜない。手で描いた作品と同じ列に並べると、
--   見る側が区別できないまま比較することになる。
--   締め出すのではなく、**別の場所を用意する**という扱い。
--
-- ============================================================================


-- ----------------------------------------------------------------------------
-- get_public_works ／ 公開作品の一覧
-- ----------------------------------------------------------------------------
--
-- 【変更点は where の1か所だけ】
--   3C の
--     and (p_division is null or w.division = p_division)
--   を case 式に置き換えた。ほかの行は 3C のまま。
--
-- 【security definer の3つの決まりは 3C から変えていない】
--   1. set search_path = ''  … 偽テーブルを読まされないため
--   2. 返す列を1つずつ書く   … 列が増えても勝手に外へ出ないため
--   3. prompt_id を返さない  … 作品からお題へ辿らせないため（D23）
--
-- 【create or replace について】
--   引数と返り値が 3C と完全に同じなので置き換えられる。
--   関数の中身だけが変わり、**権限（GRANT）はそのまま引き継がれる**。
--   それでも念のため、末尾で権限をかけ直す。

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
    p.time_limit_seconds,   -- お題の制限時間。時間別ランキングの分類基準（D25）
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
    -- ここだけが 3C からの変更点。
    -- 知らない値が来たら「その部門だけ」に落ちるので、0件になって終わる
    -- （エラーにはしない。一覧が壊れるより空のほうが害が小さい）。
    and case
          when p_division is null  then w.division <> 'ai'
          when p_division = 'all'  then true
          else w.division = p_division
        end
  order by
    case when p_sort = 'likes'   then w.likes_count   end desc nulls last,
    case when p_sort = 'answers' then w.answers_count end desc nulls last,
    w.created_at desc,
    w.id desc
  limit  least(greatest(coalesce(p_limit, 24), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.get_public_works(text, text, int, int) is
  '公開作品の一覧。prompt_id は返さない（D23）。'
  'p_division: null=通常（AI以外）／original／fanart／ai／all。';


-- ----------------------------------------------------------------------------
-- 権限をかけ直す
-- ----------------------------------------------------------------------------
--
-- create or replace は権限を引き継ぐので、本来これは不要。
-- それでも書くのは、将来この関数を drop → create で作り直したときに
-- 「権限を付け忘れて公開一覧が見えなくなる」ことを防ぐため。
-- 何度実行しても同じ結果になる。

revoke all on function public.get_public_works(text, text, int, int)
  from public, anon, authenticated;

grant execute on function public.get_public_works(text, text, int, int)
  to anon, authenticated;
