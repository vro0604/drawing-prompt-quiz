/**
 * 同じ人の購入の要求が重なったときの扱い。**サーバー専用だが、外部を呼ばない純粋な判定。**
 *
 * 【何が起きるか】
 *   同じ人が2つのタブから同時に購入を押すと、2つの要求が同じ Idempotency-Key
 *   （`customer-<人>` / `checkout-<購入>`）で Stripe を呼ぶ。Stripe は後から来たほうを
 *   「前の要求がまだ処理中」として断る。購入の行は DB が1つに抑えるので二重購入にはならず、
 *   少し待ってからもう一度押せば、先の要求が作った決済ページがそのまま返る。
 *
 * 【Stripe が返す形（2026-09-17 にテストモードで実測）】
 *   ・処理中の重なり … HTTP 409 / code = idempotency_key_in_use
 *     「There is currently another in-progress request using this Idempotent Key …」
 *   ・同じ鍵で中身が違う … HTTP 400 / type = idempotency_error（code なし）
 *     「Keys for idempotent requests can only be used with the same parameters …」
 *     決済ページの失効時刻（expires_at）は呼んだ秒で決まるので、重なった2つ目がこちらになることがある。
 *     これも先の要求が終われば、次の押下で同じ決済ページが返る。
 *
 * 【利用者へ出さないもの】
 *   Stripe の英語のエラー文そのもの。**画面にも API の本文にも載せない。**
 *   元の情報はサーバーの記録（console）にだけ残す。
 */

/** 利用者へ出す文。英語も内部の合図も含めない */
export const CHECKOUT_BUSY_MESSAGE = "処理が重なりました。少し待ってから、もう一度お試しください。";

/** API の本文に載せる合図（Stripe の合図とは別の、こちらの名前） */
export const CHECKOUT_BUSY_CODE = "CHECKOUT_BUSY";

/** Stripe の Idempotency-Key が重なったことを表す合図 */
const CONFLICT_CODES = new Set(["idempotency_key_in_use", "idempotency_error"]);

/**
 * Stripe から返った「要求が重なった」失敗か。
 *
 * stripe.ts の StripeError（name・status・stripeCode を持つ）だけを対象にする。
 * DB の失敗や、ほかの Stripe の失敗（カードの拒否など）は false。
 */
export function isStripeRequestConflict(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { name?: unknown; status?: unknown; stripeCode?: unknown };
  if (err.name !== "StripeError") return false;
  if (typeof err.stripeCode !== "string" || !CONFLICT_CODES.has(err.stripeCode)) return false;
  return err.status === 409 || err.status === 400;
}
