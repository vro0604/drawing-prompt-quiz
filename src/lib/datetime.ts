/**
 * 日時の表示。
 *
 * 【なぜ1か所にまとめるか】
 *   `new Date(x).toLocaleString("ja-JP")` とだけ書くと、**動いている場所の
 *   時間帯**で表示される。手元の端末は日本時間だが、公開先のサーバーは UTC で
 *   動いているので、同じコードが手元では 23:42、本番では 14:42 と出る。
 *   9時間ずれた投稿日が出ていても、手元では正しく見えるので気づけない。
 *
 *   時間帯を書き忘れられない形にするために、関数を通す。
 *
 * 【なぜ日本時間に固定するのか】
 *   このサービスは日本語だけで、対象も日本国内（spec 1）。
 *   見る人の端末に合わせるなら、サーバーで文字にせず、
 *   ブラウザ側で組み立てる作りに変える必要がある。いまはその作りではない。
 *   固定するなら、どこで動かしても同じ時刻が出る。
 */

/** 表示に使う時間帯。ここを変えると全画面の日時が変わる */
export const DISPLAY_TIME_ZONE = "Asia/Tokyo";

/** 2026年9月5日 のような日付 */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";

  return d.toLocaleDateString("ja-JP", {
    timeZone: DISPLAY_TIME_ZONE,
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** 2026年9月5日 23:42 のような日時 */
export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";

  return d.toLocaleString("ja-JP", {
    timeZone: DISPLAY_TIME_ZONE,
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 9月5日 23:42 のような、年を省いた日時 */
export function formatShortDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";

  return d.toLocaleString("ja-JP", {
    timeZone: DISPLAY_TIME_ZONE,
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
