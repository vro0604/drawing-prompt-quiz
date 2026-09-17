import { STRIPE_SECRET_KEY, hasStripeSecretKey } from "@/lib/env";
import { STRIPE_API_VERSION } from "./types";
import { buildCheckoutSessionForm, toStripeForm, type FormShape } from "./signature";

// 署名の確かめ方と、送る文字列の組み立ては signature.ts にある
// （外部を呼ばないので、単体で試せるように分けてある）。ここから通して出す。
export {
  SIGNATURE_TOLERANCE_SECONDS,
  parseStripeEvent,
  toStripeForm,
  verifyStripeSignature,
} from "./signature";
export type { StripeEvent } from "./signature";

/**
 * Stripe の呼び出しと、Stripe から来た知らせの確かめ方。**サーバー専用。**
 *
 * 【なぜ公式のライブラリを入れないか】
 *   使うのは4つの呼び出しだけ（顧客を作る／決済ページを作る・読む・失効させる）。
 *   どれも「決まった形の文字列を POST して JSON を受け取る」だけで、
 *   ブラウザのプッシュ通知を自前で書いたのと同じ理由でここも自前にした
 *   （src/features/notify/push.ts）。**依存を1つ増やすと、
 *   その更新と脆弱性の面倒を見続けることになる。**
 *
 *   署名の確かめ方は Stripe が公開している手順（2026-09-09 に取得）に従う。
 *   手順そのものは signature.ts の verifyStripeSignature に書いた。
 *
 * 【Client Component から import しないこと】
 *   秘密鍵に触る。import してよいのは Route Handler と Server Action だけ。
 */

const API_BASE = "https://api.stripe.com/v1";

/** 呼び出しが返ってこないまま画面を待たせない */
const TIMEOUT_MS = 20_000;

/** Stripe が返した失敗を、合図つきの1文にする */
export class StripeError extends Error {
  readonly status: number;
  readonly stripeCode: string;

  constructor(status: number, stripeCode: string, message: string) {
    super(`STRIPE_ERROR: ${message}`);
    this.name = "StripeError";
    this.status = status;
    this.stripeCode = stripeCode;
  }
}

/**
 * Stripe を1回呼ぶ。
 *
 * 【Idempotency-Key】
 *   同じ鍵で2回呼ぶと、Stripe は**1回目とまったく同じ返事**をよこす。
 *   購入ボタンを連打されても決済ページが増えないのは、これが効くため。
 *   鍵は購入の ID から作る（購入が違えば鍵も違う）。
 */
async function callStripe(
  path: string,
  init: { method: "GET" | "POST"; form?: FormShape; idempotencyKey?: string },
): Promise<Record<string, unknown>> {
  if (!hasStripeSecretKey()) {
    throw new Error("STRIPE_NOT_CONFIGURED: STRIPE_SECRET_KEY が設定されていません。");
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
    // **口座の既定の版に任せない。**Stripe の画面から既定を変えられても、
    // ここから出る呼び出しはいつも同じ版で解釈される。
    "Stripe-Version": STRIPE_API_VERSION,
  };

  let body: string | undefined;
  if (init.method === "POST") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = toStripeForm(init.form ?? {}).toString();
  }
  if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;

  const res = await fetch(`${API_BASE}${path}`, {
    method: init.method,
    headers,
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (!res.ok) {
    const err = (json.error ?? {}) as { code?: string; message?: string; type?: string };
    throw new StripeError(
      res.status,
      err.code ?? err.type ?? "unknown",
      err.message ?? `Stripe が ${res.status} を返しました`,
    );
  }

  return json;
}

/* ---------------------------------------------------------------------------
 * 顧客
 * ------------------------------------------------------------------------- */

export async function createStripeCustomer(input: {
  profileId: string;
  email: string | null;
}): Promise<string> {
  const json = await callStripe("/customers", {
    method: "POST",
    // **同じ人を2回作らない。**profile_id を鍵にする
    idempotencyKey: `customer-${input.profileId}`,
    form: {
      email: input.email ?? undefined,
      metadata: { profile_id: input.profileId },
    },
  });

  const id = json.id;
  if (typeof id !== "string") {
    throw new Error("STRIPE_ERROR: 顧客の ID が返りませんでした。");
  }
  return id;
}

/* ---------------------------------------------------------------------------
 * 決済ページ
 * ------------------------------------------------------------------------- */

export type CheckoutSession = {
  id: string;
  url: string | null;
  status: string | null;
  payment_status: string | null;
  mode: string | null;
  amount_total: number | null;
  currency: string | null;
  expires_at: number | null;
  client_reference_id: string | null;
  payment_intent: string | null;
  metadata: Record<string, string> | null;
};

function asSession(json: Record<string, unknown>): CheckoutSession {
  return {
    id: String(json.id ?? ""),
    url: typeof json.url === "string" ? json.url : null,
    status: typeof json.status === "string" ? json.status : null,
    payment_status: typeof json.payment_status === "string" ? json.payment_status : null,
    mode: typeof json.mode === "string" ? json.mode : null,
    amount_total: typeof json.amount_total === "number" ? json.amount_total : null,
    currency: typeof json.currency === "string" ? json.currency : null,
    expires_at: typeof json.expires_at === "number" ? json.expires_at : null,
    client_reference_id:
      typeof json.client_reference_id === "string" ? json.client_reference_id : null,
    // 展開していないので、支払いの ID は文字列で返る
    payment_intent: typeof json.payment_intent === "string" ? json.payment_intent : null,
    metadata:
      json.metadata && typeof json.metadata === "object"
        ? (json.metadata as Record<string, string>)
        : null,
  };
}

/**
 * 決済ページを1つ作る。
 *
 * 【値段をここで決めない】
 *   金額も通貨も商品名も、呼ぶ側が DB の商品定義から読んだ値を渡す。
 *   **ブラウザから来た値をここへ流さないこと。**
 *
 * 【失効までの時間】
 *   Stripe は「作成から30分〜24時間」しか受け付けない（公式仕様）。
 *   Founder は枠を押さえたまま待たせるので、いちばん短い30分にする。
 */
export async function createCheckoutSession(input: {
  purchaseId: string;
  profileId: string;
  offerCode: string;
  productName: string;
  amount: number;
  currency: string;
  customerId: string;
  successUrl: string;
  cancelUrl: string;
  expiresInSeconds: number;
}): Promise<CheckoutSession> {
  const json = await callStripe("/checkout/sessions", {
    method: "POST",
    // **連打しても増えない。**同じ購入なら同じ決済ページが返る
    idempotencyKey: `checkout-${input.purchaseId}`,
    form: buildCheckoutSessionForm(input, Math.floor(Date.now() / 1000)),
  });
  return asSession(json);
}

export async function retrieveCheckoutSession(id: string): Promise<CheckoutSession> {
  return asSession(await callStripe(`/checkout/sessions/${encodeURIComponent(id)}`, {
    method: "GET",
  }));
}

/**
 * 決済ページをこちらから失効させる。
 *
 * 決済ページを作ったあとに手元の記録が残せなかったときに使う。
 * **記録できていないページを開いたままにしない。**
 */
export async function expireCheckoutSession(id: string): Promise<void> {
  await callStripe(`/checkout/sessions/${encodeURIComponent(id)}/expire`, {
    method: "POST",
  });
}

