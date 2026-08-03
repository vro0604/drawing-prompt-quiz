/**
 * ランキングまわりの型。
 *
 * DB の get_rankings が返す行をそのまま写す。
 * ここも Supabase CLI の型生成を入れていないので手で書いている
 * （features/work/types.ts と同じ事情）。
 *
 * **お題のIDも制限時間の秒数も現れない。** DB 側が返さないので
 * （D23）、ここに書きようがない。区分の文字だけが来る。
 */

/** ランキングの種類。get_rankings の p_type と同じ値 */
export type RankingType = "popular" | "accuracy" | "duration";

/** 部門。get_rankings の p_feed と同じ値 */
export type RankingFeed = "normal" | "ai";

/** 制限時間の区分。get_rankings の p_time_limit と同じ値 */
export type TimeBucket = "short" | "medium" | "long" | "unlimited";

export const RANKING_TYPES: {
  value: RankingType;
  label: string;
  note: string;
}[] = [
  {
    value: "popular",
    label: "人気",
    note: "いいねが多い順。作者本人のいいねは順位に数えません。",
  },
  {
    value: "accuracy",
    label: "伝達率",
    note: "見た人がお題を当てられた割合の高い順。回答が5人以上の作品だけが並びます。",
  },
  {
    value: "duration",
    label: "時間別",
    note: "お題を引いたときの制限時間で分け、その中の人気順に並べます。",
  },
];

export const RANKING_FEEDS: { value: RankingFeed; label: string }[] = [
  { value: "normal", label: "通常（AI以外）" },
  { value: "ai", label: "AI生成" },
];

/**
 * 時間区分。境目は DB 側（get_rankings）と同じ。
 *
 * 分類の基準は**お題の制限時間**であって、投稿時に自己申告する
 * 実制作時間ではない（D25）。申告は表示のための補助情報で、
 * 順位の土俵を決めるのに使うと申告しだいで区分を選べてしまう。
 */
export const TIME_BUCKETS: { value: TimeBucket; label: string }[] = [
  { value: "short", label: "15分以内" },
  { value: "medium", label: "16〜59分" },
  { value: "long", label: "60分以上" },
  { value: "unlimited", label: "無制限" },
];

/** 1ページの件数。get_rankings の上限は50 */
export const RANKING_PAGE_SIZE = 20;

/** ランキングの1件（get_rankings が返す行） */
export type RankingItem = {
  rank: number;
  id: string;
  title: string;
  image_path: string;
  image_width: number;
  image_height: number;
  division: string;
  source_title: string | null;
  source_character: string | null;
  fanart_note: string | null;
  actual_time_seconds: number | null;
  time_limit_bucket: TimeBucket;
  /** 表示用の総数。作者本人のいいねも含む */
  likes_count: number;
  /** 順位に使う票数。作者本人のいいねを除いた数 */
  ranking_likes_count: number;
  saves_count: number;
  answers_count: number;
  /**
   * 伝達率（0〜1）。回答が5人に満たない作品は null。
   *
   * DB の型は numeric。PostgREST が文字列で返すことがあるので、
   * 表示に使うときは accuracyPercent() を通す。
   */
  accuracy: number | string | null;
  created_at: string;
  author_id: string;
  author_handle: string | null;
  author_display_name: string;
};

/** 区分キーから表示名を引く。未知の値はそのまま返す */
export function timeBucketLabel(bucket: string): string {
  return TIME_BUCKETS.find((b) => b.value === bucket)?.label ?? bucket;
}

/** 種類キーから定義を引く。未知の値は人気に落とす（DB 側と同じ扱い） */
export function resolveRankingType(raw: string | undefined) {
  return RANKING_TYPES.find((t) => t.value === raw) ?? RANKING_TYPES[0];
}

/** 部門キーから定義を引く。未知の値は通常に落とす（DB 側と同じ扱い） */
export function resolveRankingFeed(raw: string | undefined) {
  return RANKING_FEEDS.find((f) => f.value === raw) ?? RANKING_FEEDS[0];
}

/** 時間区分キーから定義を引く。未知の値は15分以内に落とす */
export function resolveTimeBucket(raw: string | undefined) {
  return TIME_BUCKETS.find((b) => b.value === raw) ?? TIME_BUCKETS[0];
}

/**
 * 伝達率を百分率にする。null は「まだ出せない」。
 *
 * 0% と「まだ分からない」は意味が違うので、null をそのまま通す
 * （features/work/types.ts の slotAccuracy と同じ考え方）。
 */
export function accuracyPercent(accuracy: number | string | null): number | null {
  if (accuracy === null) return null;
  const value = typeof accuracy === "string" ? Number.parseFloat(accuracy) : accuracy;
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}
