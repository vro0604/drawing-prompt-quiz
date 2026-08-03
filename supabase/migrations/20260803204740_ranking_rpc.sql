-- ============================================================================
-- ranking_rpc ／ Step 13: ランキング（3種 × 2系統）
-- ============================================================================
--
-- 【このファイルがやること】
--   取得系RPC get_rankings を1本追加する。それだけ。
--
-- 【このファイルがやらないこと】
--   ・表・列・制約・データに一切触れない（読むだけ）
--   ・既存の関数を書き換えない
--   ・順位を保存する表を作らない（毎回その場で数える）
--
-- 【実行方法】
--   npm run db:deploy
--
-- 【取り消し】
--   supabase/rollback/015_ranking_rpc_rollback.sql
--   （追加した関数を1本消すだけ。表もデータも動かない）
--
--
-- ============================================================================
-- なぜ works.likes_count をそのまま順位に使わないか
-- ============================================================================
--
--   自分の作品にいいねを押すことは禁じていない（D56）。回答と違って
--   統計を歪めないからで、その判断は変えない。
--
--   ところが**順位付けに使うと話が変わる**。自作へのいいねが数えられると、
--   投稿者は誰でも自分の作品を1票ぶん押し上げられる。作品数が多いほど
--   有利になり、順位が「反応の量」ではなく「投稿者本人の操作」を映す。
--
--   そこで順位には likes 表を直接数え直した値を使う。
--
--     ranking_likes_count = count(*) from likes
--                           where work_id = w.id
--                             and user_id <> w.user_id      ← 作者本人を除く
--
--   works.likes_count は**表示用の総数**として今までどおり返す。
--   作者本人の1票が見える数から消えると、押した本人が「反映されていない」と
--   受け取るため。**見せる数と順位の数は役割が違う**ので分けて持つ。
--
--   likes 表を毎回数えるのは、キャッシュ列と違ってずれようがないから。
--   ランキングは1ページ20件・上位だけなので、この数え方で足りる。
--
--   なお likes に行を作れるのは登録ユーザーだけ（D7 / spec 10）。
--   「人気は登録ユーザーのいいねのみで集計する」（spec 10）は、
--   ここで絞っているのではなく、そもそもゲストが押せないことで成り立つ。
--
--
-- ============================================================================
-- 時間区分の決めかた
-- ============================================================================
--
--   分類の基準は **prompts.time_limit_seconds**（お題を引いた時点で確定する
--   制限時間）であって、works.actual_time_seconds ではない（D25）。
--   実績時間は自己申告なので、順位の土俵を決める基準には使えない。
--
--     short      1〜900秒       15分以内
--     medium     901〜3599秒    16〜59分
--     long       3600秒以上     60分以上
--     unlimited  null           無制限
--
--   区分そのものは公開情報（get_public_works も time_limit_seconds を返す）。
--   ただしこの関数が返すのは区分の文字だけにする。**prompts 表に結合するのは
--   関数の中だけ**で、お題のIDも中身も外へは出ない（D23）。
--
--
-- ============================================================================
-- 伝達率の出しかた
-- ============================================================================
--
--   accuracy = 全枠の corrects 合計 ÷ 全枠の attempts 合計
--
--   work_slot_stats（枠ごとの挑戦数と正解数）を足し上げる。これは
--   answers.correct_count の合計 ÷ answer_items の件数と同じ値になる。
--   同じ値なら、回答のたびにトリガーが更新している集計表を読むほうが軽い。
--   両者が一致することは診断 A21 と A24 が見張っている。
--
--   対象は **answers_count >= 5 の作品だけ**（R6）。ブラウザのデータを消せば
--   新しいゲストになれる以上、回答の一意性は保証できない。1人しか答えて
--   いない作品が「100%」で1位に出るのを防ぐための下限。
--
--
-- ============================================================================
-- 同点のときの順序
-- ============================================================================
--
--   並び順が決まりきっていないと、同じ条件で開くたびに順位が入れ替わる。
--   ページ送りでも、1ページ目に出た作品が2ページ目にもう一度出たり、
--   逆にどのページにも出なかったりする。最後に必ず id を入れて、
--   **一意に決まるところまで** 並べ切る。
--
--     人気・時間別  ranking_likes_count desc → created_at desc → id desc
--     伝達率        accuracy desc → answers_count desc
--                   → ranking_likes_count desc → created_at desc → id desc
--
-- ============================================================================


-- ----------------------------------------------------------------------------
-- get_rankings ／ ランキング（誰でも呼べる）
-- ----------------------------------------------------------------------------
--
-- 【security definer の3つの決まり（3C から共通）】
--   1. set search_path = ''  … 偽テーブルを読まされないため
--   2. 返す列を1つずつ書く   … 列が増えても勝手に外へ出ないため
--   3. お題のIDを返さない    … 作品からお題へ辿らせないため（D23）
--
-- 【引数】
--   p_type       popular（人気）／ accuracy（伝達率）／ duration（時間別）
--                知らない値は popular として扱う
--   p_feed       normal（AI以外）／ ai。知らない値は normal として扱う
--   p_time_limit duration のときだけ使う。short / medium / long / unlimited。
--                null なら区分で絞らない。知らない値は0件になる
--   p_limit      1〜50 に丸める
--   p_offset     0未満は0に丸める
--
-- 【知らない値でエラーにしない理由】
--   一覧が壊れて開かなくなるより、既定に落ちるか空で返るほうが害が小さい
--   （get_public_works の p_division と同じ考え方）。

create function public.get_rankings(
  p_type       text default 'popular',
  p_feed       text default 'normal',
  p_time_limit text default null,
  p_limit      int  default 20,
  p_offset     int  default 0
)
returns table (
  rank                int,
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
  time_limit_bucket   text,
  likes_count         int,
  ranking_likes_count int,
  saves_count         int,
  answers_count       int,
  accuracy            numeric,
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
  with base as (
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
      -- お題の制限時間は区分の文字にしてから返す。秒数もお題のIDも出さない
      case
        when p.time_limit_seconds is null then 'unlimited'
        when p.time_limit_seconds <= 900  then 'short'
        when p.time_limit_seconds <= 3599 then 'medium'
        else 'long'
      end as time_limit_bucket,
      w.likes_count,
      -- 順位に使う票数。作者本人が押したぶんを除く（上の説明のとおり）
      (select count(*)
         from public.likes l
        where l.work_id = w.id
          and l.user_id <> w.user_id)::int as ranking_likes_count,
      w.saves_count,
      w.answers_count,
      -- 伝達率。回答が5人に満たない作品は出さない（R6）
      case when w.answers_count >= 5 then (
        select sum(st.corrects)::numeric / nullif(sum(st.attempts), 0)
          from public.work_slot_stats st
         where st.work_id = w.id
      ) end as accuracy,
      w.created_at,
      pr.id           as author_id,
      pr.handle       as author_handle,
      pr.display_name as author_display_name
    from public.works w
      join public.prompts  p  on p.id  = w.prompt_id
      join public.profiles pr on pr.id = w.user_id
    -- 公開されているものだけ。get_public_works と同じ3条件。
    -- ここを緩めると、下書きや削除済みの作品の存在がランキング経由で漏れる
    where w.is_published
      and w.review_status = 'ok'
      and w.deleted_at is null
      and case
            when p_feed = 'ai' then w.division =  'ai'
            else                    w.division <> 'ai'
          end
  )
  select
    -- 順位は絞り込みのあとに振る。where は window 関数より先に効くので、
    -- 2ページ目でも通し番号（21位から）になる
    (row_number() over (
       order by
         case when p_type = 'accuracy' then b.accuracy      end desc nulls last,
         case when p_type = 'accuracy' then b.answers_count end desc nulls last,
         b.ranking_likes_count desc,
         b.created_at          desc,
         b.id                  desc
     ))::int,
    b.id,
    b.title,
    b.image_path,
    b.image_width,
    b.image_height,
    b.division,
    b.source_title,
    b.source_character,
    b.fanart_note,
    b.actual_time_seconds,
    b.time_limit_bucket,
    b.likes_count,
    b.ranking_likes_count,
    b.saves_count,
    b.answers_count,
    b.accuracy,
    b.created_at,
    b.author_id,
    b.author_handle,
    b.author_display_name
  from base b
  where case
          when p_type = 'accuracy' then b.accuracy is not null
          when p_type = 'duration' then
            (p_time_limit is null or b.time_limit_bucket = p_time_limit)
          else true
        end
  order by 1
  limit  least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.get_rankings(text, text, text, int, int) is
  'ランキング。p_type: popular/accuracy/duration、p_feed: normal/ai。'
  '順位には作者本人のいいねを除いた ranking_likes_count を使う。'
  '伝達率は answers_count>=5 のみ。お題のIDと正解は返さない（D23）。';


-- ----------------------------------------------------------------------------
-- 実行権限
-- ----------------------------------------------------------------------------
--
-- ランキングの閲覧に登録も匿名サインインも要らない（spec 10 の権限表）。
-- 見るだけでゲストを作らせないため、anon にも与える。

revoke all on function public.get_rankings(text, text, text, int, int)
  from public, anon, authenticated;

grant execute on function public.get_rankings(text, text, text, int, int)
  to anon, authenticated;
