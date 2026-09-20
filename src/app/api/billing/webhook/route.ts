import { NextResponse } from "next/server";
import { STRIPE_WEBHOOK_SECRET, hasStripeWebhookSecret, stripeSecretMode } from "@/lib/env";
import {
  callApplyRefundResult,
  callCompleteCheckout,
  callExpireCheckout,
  callMarkDispute,
  claimWebhookEvent,
  finishWebhookEvent,
} from "@/features/billing/rpc";
import {
  applySupportDispute,
  applySupportRefund,
  completeSupportCheckout,
  expireSupportCheckout,
} from "@/features/billing/support-rpc";
import {
  parseStripeEvent,
  retrievePaymentIntentMetadata,
  verifyStripeSignature,
  type StripeEvent,
} from "@/features/billing/stripe";
import { STRIPE_API_VERSION } from "@/features/billing/types";

/**
 * /api/billing/webhook ／ Stripe からの知らせを受け取る唯一の場所。
 *
 * 【なぜここが権限を決める唯一の場所か】
 *   利用者のブラウザが成功画面へ戻ってきても、それは「戻ってきた」以上の
 *   意味を持たない。URL は手で打てるし、戻らずに閉じることもある。
 *   **お金が動いたことを言えるのは Stripe だけ**なので、
 *   Founder 権を付けるのはこの経路だけにする。
 *
 * 【値の流れ】
 *   Stripe が POST する
 *     → 本文を**文字のまま**読む（JSON として読むのは署名を確かめたあと）
 *     → Stripe-Signature ヘッダーと STRIPE_WEBHOOK_SECRET で本物か確かめる
 *     → 知らせの ID を DB へ入れる。すでにあれば、それは2回目なので何もしない
 *     → 種類ごとに DB の関数を1つ呼ぶ（確定・失効・返金・申し立て）
 *     → 処理し終えたことを記録して 200 を返す
 *
 * 【なぜ本文を先に JSON として読まないか】
 *   署名は**送られてきた文字列そのもの**に対して計算されている。
 *   読み直すと空白や並び順が変わり、必ず一致しなくなる（Stripe の注意書き）。
 *
 * 【失敗したときに何を返すか】
 *   ・署名が合わない …… 400。**再送されても意味が無い**
 *   ・鍵が無い ……… 503。設定が済むまで受け取れない
 *   ・DB が失敗 …… 500。Stripe は指数的に間隔を空けて3日間まで再送する
 *   200 を返すのは、処理し終えたときと、こちらが扱わない種類のときだけ。
 *
 * 【途中で落ちた知らせ】
 *   知らせの ID は「受け取った」時点で入れ、「処理し終えた」時刻は別に持つ。
 *   途中で落ちると処理済みの時刻が空のまま残るので、再送が来たときに
 *   **もう一度処理する**（2回処理しても結果が変わらないように、
 *   DB 側の関数はどれも2回目を弾くか、同じ答えを返す形にしてある）。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 扱う知らせ。**これ以外は 200 を返して何もしない** */
const HANDLED = new Set([
  "checkout.session.completed",
  "checkout.session.expired",
  "refund.created",
  "refund.updated",
  "refund.failed",
  "charge.dispute.created",
  "charge.dispute.closed",
]);

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

/** 知らせが指している対象の ID（記録用） */
function objectId(event: StripeEvent): string | null {
  return str(event.object.id);
}

/* ---------------------------------------------------------------------------
 * 種類ごとの処理
 * ------------------------------------------------------------------------- */

async function handleCheckoutCompleted(event: StripeEvent): Promise<string> {
  const session = event.object;
  const sessionId = str(session.id);
  if (!sessionId) return "決済ページの ID がありません";

  const paymentStatus = str(session.payment_status);

  // **払い終えていない知らせでは権限を付けない。**
  // 断るのではなく、何もせずに受け取り切る（再送させても結果は変わらない）
  if (paymentStatus !== "paid") {
    return `まだ支払いが確定していません（${paymentStatus ?? "不明"}）`;
  }

  const metadata = (session.metadata ?? {}) as Record<string, unknown>;

  if (metadata.kind === "support") {
    await completeSupportCheckout({
      sessionId,
      supportId: str(metadata.support_payment_id),
      mode: str(session.mode),
      paymentStatus,
      amount: num(session.amount_total),
      currency: str(session.currency),
      paymentIntentId: str(session.payment_intent),
    });
    return "support recorded";
  }

  const result = await callCompleteCheckout({
    sessionId,
    // client_reference_id と metadata の両方に入れてある。片方が欠けても拾える
    purchaseId: str(metadata.purchase_id) ?? str(session.client_reference_id),
    offerCode: str(metadata.offer_code),
    mode: str(session.mode),
    paymentStatus,
    amountTotal: num(session.amount_total),
    currency: str(session.currency),
    paymentIntentId: str(session.payment_intent),
  });

  return `${result.result} #${result.founder_number}`;
}

async function handleCheckoutExpired(event: StripeEvent): Promise<string> {
  const sessionId = str(event.object.id);
  if (!sessionId) return "決済ページの ID がありません";

  const metadata = (event.object.metadata ?? {}) as Record<string, unknown>;
  if (metadata.kind === "support") {
    await expireSupportCheckout(sessionId);
    return "support expired";
  }

  const out = await callExpireCheckout(sessionId);
  return out.result;
}

/**
 * 返金の3つ（作られた・変わった・失敗した）をまとめて扱う。
 *
 * Stripe の返金の状態は pending / requires_action / succeeded / failed /
 * canceled の5つ。**どれをどう扱うかは DB 側の1本にまとめてある**ので、
 * ここは状態をそのまま渡すだけにする。
 */
async function handleRefund(event: StripeEvent): Promise<string> {
  const refund = event.object;
  const paymentIntentId = str(refund.payment_intent);
  if (!paymentIntentId) return "返金に支払いの ID が付いていません";

  // refund.failed は、対象の状態が追いついていないことがある。
  // 種類そのものが「失敗」なので、そちらを優先する
  const status =
    event.type === "refund.failed" ? "failed" : (str(refund.status) ?? "pending");

  const supportHandled = await applySupportRefund({
    paymentIntentId,
    refundId: str(refund.id),
    amount: num(refund.amount),
    status,
  });
  if (supportHandled) return `support ${status}`;

  const out = await callApplyRefundResult({
    paymentIntentId,
    refundId: str(refund.id),
    refundStatus: status,
  });

  if (out.result === "unknown_payment") {
    const metadata = await retrievePaymentIntentMetadata(paymentIntentId);
    if (metadata.kind === "support") {
      // Checkout 完了イベントより先に届いた。処理済みにせず Stripe に再送させる。
      throw new Error("SUPPORT_COMPLETION_PENDING");
    }
  }

  return `${status} → ${out.result}`;
}

async function handleDispute(event: StripeEvent): Promise<string> {
  const dispute = event.object;
  const paymentIntentId = str(dispute.payment_intent);
  if (!paymentIntentId) return "申し立てに支払いの ID が付いていません";

  const status = str(dispute.status);
  if (!status) return "申し立ての状態がありません";

  const supportHandled = await applySupportDispute({ paymentIntentId, status });
  if (supportHandled) return `support ${status}`;

  const out = await callMarkDispute({ paymentIntentId, disputeStatus: status });
  if (out.result === "unknown_payment") {
    const metadata = await retrievePaymentIntentMetadata(paymentIntentId);
    if (metadata.kind === "support") throw new Error("SUPPORT_COMPLETION_PENDING");
  }
  return `${status} → ${out.result}`;
}

async function dispatch(event: StripeEvent): Promise<string> {
  switch (event.type) {
    case "checkout.session.completed":
      return handleCheckoutCompleted(event);
    case "checkout.session.expired":
      return handleCheckoutExpired(event);
    case "refund.created":
    case "refund.updated":
    case "refund.failed":
      return handleRefund(event);
    case "charge.dispute.created":
    case "charge.dispute.closed":
      return handleDispute(event);
    default:
      return "扱わない種類";
  }
}

/* ---------------------------------------------------------------------------
 * 受け口
 * ------------------------------------------------------------------------- */

export async function POST(request: Request) {
  if (!hasStripeWebhookSecret()) {
    // **素通しにしない。**鍵が無いなら受け取らない
    return NextResponse.json(
      { ok: false, error: "STRIPE_WEBHOOK_SECRET が未設定です" },
      { status: 503 },
    );
  }

  // **ここで文字のまま読む。**JSON にしない
  let payload: string;
  try {
    payload = await request.text();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  try {
    verifyStripeSignature({
      payload,
      header: request.headers.get("stripe-signature"),
      secret: STRIPE_WEBHOOK_SECRET,
    });
  } catch (e) {
    // 何が違うかは返さない。**再送されても通らない**ので 400
    const code = e instanceof Error ? e.message.split(":")[0] : "SIGNATURE_INVALID";
    return NextResponse.json({ ok: false, error: code }, { status: 400 });
  }

  let event: StripeEvent;
  try {
    event = parseStripeEvent(payload);
  } catch {
    return NextResponse.json({ ok: false, error: "EVENT_MALFORMED" }, { status: 400 });
  }

  const mode = stripeSecretMode();
  if (mode === null) {
    return NextResponse.json({ ok: false, error: "STRIPE_KEY_MODE_UNKNOWN" }, { status: 503 });
  }
  if (event.livemode !== (mode === "live")) {
    return NextResponse.json({ ok: false, error: "STRIPE_MODE_MISMATCH" }, { status: 400 });
  }

  if (!HANDLED.has(event.type)) {
    // 購読していないはずの種類。記録も残さずに受け取り切る
    return NextResponse.json({ ok: true, skipped: event.type });
  }

  // 【版がずれていたら、記録に残して先へ進む】
  //   受け口は STRIPE_API_VERSION で登録する決まりだが、Stripe 側の画面から
  //   変えられる。**ここで断ると、払い終えた人が Founder 権をもらえないまま
  //   止まる。**こちらが読む項目（売り方・支払い状態・金額・通貨・metadata）は
  //   版をまたいで名前が変わっていないので、処理は続ける。
  //   ずれたという事実は billing_webhook_events.api_version に残るので、
  //   あとから1件ずつ突き合わせられる。
  if (event.apiVersion !== null && event.apiVersion !== STRIPE_API_VERSION) {
    console.warn(
      `[billing] 受け口の API の版がずれています: 届いた ${event.apiVersion} / ` +
        `想定 ${STRIPE_API_VERSION}。Stripe の受け口の設定を確かめてください。`,
    );
  }

  try {
    const claim = await claimWebhookEvent({
      eventId: event.id,
      eventType: event.type,
      objectId: objectId(event),
      livemode: event.livemode,
      createdAt: event.created ? new Date(event.created * 1000) : null,
      apiVersion: event.apiVersion,
    });

    // 2回目でも、**前回が処理し終えていなければもう一度やる**
    if (!claim.claimed && claim.processed_at !== null) {
      return NextResponse.json({ ok: true, duplicate: true });
    }

    const note = await dispatch(event);
    await finishWebhookEvent(event.id);

    return NextResponse.json({ ok: true, note });
  } catch (e) {
    // 500 を返すと Stripe が間隔を空けて再送する。**握りつぶさない**
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[billing/webhook] ${event.type} ${event.id}: ${message}`);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
