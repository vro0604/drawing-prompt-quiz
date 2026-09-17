import { NextResponse } from "next/server";
import { getCurrentUser } from "@/features/auth/session";
import { billingConfigError, siteUrl } from "@/lib/env";
import {
  billingError,
  callAttachCheckout,
  callExpireCheckout,
  callReserveSlot,
  callUpsertBillingCustomer,
  fetchBillingCustomer,
  type ReserveResult,
} from "@/features/billing/rpc";
import {
  createCheckoutSession,
  createStripeCustomer,
  expireCheckoutSession,
  retrieveCheckoutSession,
} from "@/features/billing/stripe";
import {
  CHECKOUT_EXPIRES_IN_SECONDS,
  FOUNDER_OFFER_CODE,
} from "@/features/billing/types";
import {
  CHECKOUT_BUSY_CODE,
  CHECKOUT_BUSY_MESSAGE,
  isStripeRequestConflict,
} from "@/features/billing/conflict";

/**
 * /api/billing/checkout ／ 決済ページを1つ用意して、その入口を返す。
 *
 * 【何が起きるか（値の流れ）】
 *   ブラウザが POST する
 *     → ここが getCurrentUser() で「誰か」を決める（**ブラウザは名乗れない**）
 *     → DB の billing_reserve_slot が販売枠を1つ押さえる（purchase_id が出る）
 *     → その人の Stripe 顧客を確かめ、無ければ作る
 *     → Stripe に決済ページを作る（金額は DB の商品定義から）
 *     → 作れた決済ページの ID を DB の予約へ結び付ける
 *     → 決済ページの URL だけをブラウザへ返す
 *
 * 【ブラウザから受け取るもの】
 *   **何も無い。**金額も商品も人も、すべてこちら側で決める。
 *   本文を読まないので、値段を書き換えて送るという操作が成立しない。
 *
 * 【記録できなかった決済ページは渡さない】
 *   Stripe に決済ページを作れても、その ID を DB へ書けなかったら、
 *   払われたときに突き合わせる相手が無い。**その場合は URL を返さず、
 *   作った決済ページを失効させてから失敗を返す。**
 *
 * 【押さえたまま止まっている予約の扱い】
 *   前回の決済ページが Stripe 側で失効していても、知らせが届かなければ
 *   予約は押さえられたままになる。ここでは**その決済ページを Stripe に
 *   問い合わせて**、失効していれば枠を戻してから押さえ直す。
 *   DB の時計では戻さない（戻す根拠は必ず Stripe 側の状態）。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_HEADERS = {
  "Cache-Control": "no-store, private, max-age=0, must-revalidate",
  Vary: "Cookie",
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

/** 別のサイトの画面から呼ばせない（/api/push と同じ判定） */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;

  const host = request.headers.get("host");
  try {
    const from = new URL(origin).host;
    if (host && from === host) return true;
    return from === new URL(request.url).host;
  } catch {
    return false;
  }
}

/**
 * 前回の決済ページが Stripe 側でもう終わっていないかを見る。
 *
 * 返り値
 *   "open"    … まだ開いている。その URL をそのまま使える
 *   "gone"    … 失効か取り消し。枠を戻して押さえ直してよい
 *   "unknown" … Stripe に聞けなかった。**触らない**（安全側）
 */
async function inspectPreviousCheckout(
  sessionId: string,
): Promise<{ state: "open"; url: string } | { state: "gone" } | { state: "unknown" }> {
  try {
    const session = await retrieveCheckoutSession(sessionId);

    if (session.status === "open" && session.url) {
      return { state: "open", url: session.url };
    }
    if (session.status === "expired") return { state: "gone" };

    // complete（払い終えている）はここで触らない。知らせの側が確定させる
    return { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return json({ error: "この操作は受け付けられません。" }, 403);
  }

  // 設定が足りないなら、**素通しにせず入口を閉じる**
  const configError = billingConfigError();
  if (configError) {
    return json(
      { error: "ただいま購入手続きを受け付けられません。しばらくしてからお試しください。" },
      503,
    );
  }

  // ここが「誰か」を決める唯一の場所。ブラウザは名乗れない
  const user = await getCurrentUser();
  if (!user) {
    return json({ error: "ご購入にはログインが必要です。", need_sign_in: true }, 401);
  }
  if (user.is_anonymous) {
    return json(
      {
        error:
          "ゲストのままではご購入いただけません。メールアドレスを登録してからお試しください。",
        need_sign_in: true,
      },
      403,
    );
  }

  try {
    let reserved: ReserveResult = await callReserveSlot({ profileId: user.id });

    // 前回の決済ページが残っているなら、それを使えるか確かめる
    if (reserved.result === "already_reserved" && reserved.checkout_session_id) {
      const previous = await inspectPreviousCheckout(reserved.checkout_session_id);

      if (previous.state === "open") {
        return json({ url: previous.url, reused: true });
      }
      if (previous.state === "gone") {
        await callExpireCheckout(reserved.checkout_session_id);
        // 枠が戻ったので押さえ直す。**やり直すのはここ1回だけ**
        reserved = await callReserveSlot({ profileId: user.id });
      } else {
        return json(
          {
            error:
              "前回のお支払い手続きの状態を確認できませんでした。" +
              "少し時間をおいてからもう一度お試しください。",
          },
          503,
        );
      }
    }

    // Stripe の顧客を用意する
    let customer = await fetchBillingCustomer(user.id);
    if (!customer) {
      const stripeCustomerId = await createStripeCustomer({
        profileId: user.id,
        email: user.email ?? null,
      });
      customer = await callUpsertBillingCustomer({
        profileId: user.id,
        stripeCustomerId,
      });
    }

    // 決済ページを作る。**金額は DB の商品定義から来た値だけ**
    const session = await createCheckoutSession({
      purchaseId: reserved.purchase_id,
      profileId: user.id,
      offerCode: reserved.offer_code ?? FOUNDER_OFFER_CODE,
      productName: reserved.offer_name ?? "Founding Creator",
      amount: reserved.amount,
      currency: reserved.currency,
      customerId: customer.stripe_customer_id,
      successUrl: siteUrl("/founder?paid=1"),
      cancelUrl: siteUrl("/founder?canceled=1"),
      expiresInSeconds: CHECKOUT_EXPIRES_IN_SECONDS,
    });

    // **書けなければ渡さない。**書けた決済ページだけが利用者へ届く
    try {
      await callAttachCheckout({
        purchaseId: reserved.purchase_id,
        billingCustomerId: customer.billing_customer_id,
        sessionId: session.id,
        expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : null,
      });
    } catch (e) {
      // 開いたままにしない。失効させられなくても、URL は返さない
      await expireCheckoutSession(session.id).catch(() => undefined);
      throw e;
    }

    if (!session.url) {
      await expireCheckoutSession(session.id).catch(() => undefined);
      return json({ error: "決済ページを開けませんでした。もう一度お試しください。" }, 502);
    }

    return json({ url: session.url, reused: false });
  } catch (e) {
    // 【同じ人の要求が重なった】（2つのタブから同時に押したなど）
    //   Stripe の英語のエラー文は利用者へ出さない。元の情報はサーバーの記録にだけ残す。
    //   購入の行は DB が1つに抑えているので、もう一度押せば同じ決済ページが返る。
    if (isStripeRequestConflict(e)) {
      const s = e as { status: number; stripeCode: string; message: string };
      console.warn(
        `[billing/checkout] 要求が重なりました（Stripe ${s.status} ${s.stripeCode}）: ${s.message}`,
      );
      return json({ error: CHECKOUT_BUSY_MESSAGE, code: CHECKOUT_BUSY_CODE, retry: true }, 409);
    }

    const err = billingError(e);

    const status =
      err.kind === "sign_in_required"
        ? 401
        : err.kind === "terms_not_agreed"
          ? 403
          : err.kind === "not_eligible"
            ? 403
            : err.kind === "sold_out"
              ? 409
              : err.kind === "already_owned"
                ? 409
                : err.kind === "closed"
                  ? 409
                  : err.kind === "config"
                    ? 503
                    : 500;

    return json({ error: err.message, code: err.code }, status);
  }
}
