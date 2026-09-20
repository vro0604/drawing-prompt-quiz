/** 自由額支援の金額と流入元。ブラウザとサーバーで同じ定義を使う。 */
export const SUPPORT_MIN_YEN = 500;
export const SUPPORT_DEFAULT_YEN = 1000;
export const SUPPORT_MAX_YEN = 100000;

export const SUPPORT_SOURCES = [
  "footer",
  "account",
  "founder",
  "founder_soldout",
  "support_page",
  "campaign",
  "direct",
] as const;

export type SupportSource = (typeof SUPPORT_SOURCES)[number];

export function normalizeSupportSource(value: unknown): SupportSource {
  return typeof value === "string" &&
    SUPPORT_SOURCES.includes(value as SupportSource)
    ? (value as SupportSource)
    : "direct";
}

/** Number() の暗黙の変換で空文字や指数表記を通さない。 */
export function parseSupportAmount(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value);
  if (!/^[0-9]{1,6}$/.test(raw)) return null;
  const amount = Number(raw);
  return Number.isSafeInteger(amount) &&
    amount >= SUPPORT_MIN_YEN && amount <= SUPPORT_MAX_YEN
    ? amount
    : null;
}
