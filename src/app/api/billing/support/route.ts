import { NextResponse } from "next/server";
import { getCurrentUser } from "@/features/auth/session";
import { attachSupportCheckout, startSupportPayment } from "@/features/billing/support-rpc";
import { normalizeSupportSource, parseSupportAmount } from "@/features/billing/support";
import { createSupportCheckoutSession, expireCheckoutSession } from "@/features/billing/stripe";
import { billingConfigError, siteUrl } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store, private, max-age=0", Vary: "Cookie" };

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: HEADERS });
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const host = request.headers.get("host") ?? new URL(request.url).host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** 金額・流入元以外を受け取らない。ログインは不要。 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "この操作は受け付けられません。" }, 403);
  if (billingConfigError()) {
    return json({ error: "ただいま支援のお支払いを受け付けられません。" }, 503);
  }
  if (Number(request.headers.get("content-length") ?? 0) > 2048) {
    return json({ error: "送信された内容が大きすぎます。" }, 413);
  }

  let body: { amount?: unknown; source?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "金額を読み取れませんでした。" }, 400);
  }
  const amount = parseSupportAmount(body?.amount);
  if (amount === null) {
    return json({ error: "500円から100,000円まで、1円単位の金額を入力してください。" }, 400);
  }
  const source = normalizeSupportSource(body?.source);

  try {
    const user = await getCurrentUser();
    // 匿名 Auth セッションは登録アカウントへのログインとして扱わない。
    const profileId = user && !user.is_anonymous ? user.id : null;
    const payment = await startSupportPayment({
      profileId,
      amount,
      source,
    });
    // 画面の値ではなく、DB が返した値を Stripe に渡す。
    const session = await createSupportCheckoutSession({
      supportId: payment.id,
      amount: payment.amount,
      source: payment.source,
      profileId,
      successUrl: siteUrl("/support/thanks?session_id={CHECKOUT_SESSION_ID}"),
      cancelUrl: siteUrl(`/support?canceled=1&source=${source}`),
    });
    try {
      await attachSupportCheckout(payment.id, session.id);
    } catch (error) {
      await expireCheckoutSession(session.id).catch(() => undefined);
      throw error;
    }
    if (!session.url) {
      await expireCheckoutSession(session.id).catch(() => undefined);
      return json({ error: "決済ページを開けませんでした。" }, 502);
    }
    return json({ url: session.url });
  } catch (error) {
    // DB や Stripe の詳細をブラウザへ渡さない。識別子・秘密鍵を含み得る。
    console.error("[billing/support] Checkout の作成に失敗:", error);
    return json({ error: "決済ページを用意できませんでした。しばらくしてからお試しください。" }, 503);
  }
}
