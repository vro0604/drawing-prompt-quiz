import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  FOUNDER_OFFER_CODE,
  isBillingNotInstalled,
  type FounderBadge,
  type FounderOfferStatus,
  type FounderRow,
  type EntitlementKey,
} from "./types";

/**
 * 課金の RPC の呼び出し。**サーバー専用。**
 *
 * 【呼び分けは2つだけ】
 *   1. 見るもの（残り枠・一覧・自分の番号・公開設定の切り替え）
 *      … いつもの利用者の鍵で呼ぶ。DB 側で auth.uid() が効く。
 *   2. 動かすもの（枠を押さえる・決済ページを結び付ける・確定・返金・失効）
 *      … 秘密鍵で呼ぶ。これらは service_role にしか実行権限が無い。
 *
 *   **1 と 2 を混ぜないこと。**混ぜると「利用者の鍵で権限を付ける」経路が
 *   できてしまい、DB 側の遮断が意味を失う。
 *
 * 【2 を呼ぶ前に、必ず本人であることを確かめる】
 *   この層は認可しない。呼ぶ側（Route Handler）が
 *   getCurrentUser() を通してから、その id を渡す。
 *   管理 v0（src/features/admin/rpc.ts）と同じ考え方。
 *
 * 【Client Component から import しないこと】
 *   秘密鍵に触る。import してよいのは Server Component / Server Action /
 *   Route Handler だけ。
 */

const NO_KEY =
  "BILLING_KEY_MISSING: SUPABASE_SECRET_KEY が設定されていないため、購入を扱えません。";

function admin() {
  const client = createSupabaseAdminClient();
  if (!client) throw new Error(NO_KEY);
  return client;
}

function fail(message: string): never {
  throw new Error(message);
}

/* ---------------------------------------------------------------------------
 * 合図を、利用者に通じる日本語にする
 * ------------------------------------------------------------------------- */

export type BillingErrorKind =
  | "sign_in_required"
  | "terms_not_agreed"
  | "not_eligible"
  | "already_owned"
  | "sold_out"
  | "closed"
  | "not_found"
  | "config"
  | "mismatch"
  | "unknown";

export type BillingError = {
  kind: BillingErrorKind;
  /** DB や Stripe が投げた合図（SOLD_OUT など）。分からなければ空 */
  code: string;
  /** 画面に出す日本語 */
  message: string;
};

const KINDS: { code: string; kind: BillingErrorKind; message: string }[] = [
  {
    code: "SIGN_IN_REQUIRED",
    kind: "sign_in_required",
    message: "ご購入にはログインが必要です。",
  },
  {
    // 規約 13-6。**お金を受け取ったあとで同意を求める形にしない**
    code: "TERMS_NOT_AGREED",
    kind: "terms_not_agreed",
    message:
      "ご購入の前に、利用規約とプライバシーポリシーへの同意が必要です。" +
      "購入の画面に戻って、同意のチェックを入れてください。",
  },
  {
    code: "ACCOUNT_NOT_ELIGIBLE",
    kind: "not_eligible",
    message:
      "このアカウントではご購入いただけません。" +
      "ゲストのままの場合は、メールアドレスを登録してからお試しください。",
  },
  {
    code: "ALREADY_OWNED",
    kind: "already_owned",
    message: "すでにご購入いただいています。",
  },
  {
    code: "SOLD_OUT",
    kind: "sold_out",
    message: "申し訳ありません。販売枠が埋まりました。",
  },
  {
    code: "OFFER_CLOSED",
    kind: "closed",
    message: "ただいま販売しておりません。",
  },
  {
    code: "OFFER_NOT_FOUND",
    kind: "not_found",
    message: "その商品は見つかりませんでした。",
  },
  {
    code: "PROFILE_NOT_FOUND",
    kind: "not_found",
    message: "アカウントの情報を読めませんでした。",
  },
  {
    code: "NOT_A_FOUNDER",
    kind: "not_found",
    message: "公開設定を変えられる購入がありません。",
  },
  {
    code: "BILLING_KEY_MISSING",
    kind: "config",
    message: "決済の設定が完了していないため、いまはご購入いただけません。",
  },
  {
    code: "STRIPE_NOT_CONFIGURED",
    kind: "config",
    message: "決済の設定が完了していないため、いまはご購入いただけません。",
  },
  {
    code: "PURCHASE_NOT_RESERVED",
    kind: "mismatch",
    message: "お手続きの状態が変わっています。画面を読み込み直してください。",
  },
  {
    code: "permission denied",
    kind: "config",
    message:
      "データベースがこの操作を断りました。課金の関数は service_role だけが" +
      "呼べます。秘密鍵の設定を確かめてください。",
  },
];

export function billingError(e: unknown): BillingError {
  const raw = e instanceof Error ? e.message : String(e);

  for (const k of KINDS) {
    if (raw.includes(k.code)) return { kind: k.kind, code: k.code, message: k.message };
  }

  // 分からないものは握りつぶさない。**そのまま出す。**
  // 「成功したように見える」状態を作らないことのほうが大事。
  return { kind: "unknown", code: "", message: `想定外の失敗です: ${raw}` };
}

/* ---------------------------------------------------------------------------
 * 見る（利用者の鍵）
 * ------------------------------------------------------------------------- */

/** 残り枠と、いまの人の購入状態。ログインしていなければ mine は null */
export async function fetchFounderOfferStatus(
  offerCode: string = FOUNDER_OFFER_CODE,
): Promise<FounderOfferStatus | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_founder_offer_status", {
    p_offer_code: offerCode,
  });

  // 課金の migration がまだ無い DB では「商品が無い」として扱い、画面の準備中へ回す
  if (isBillingNotInstalled(error)) return null;
  if (error) fail(error.message);
  return (data as FounderOfferStatus | null) ?? null;
}

/** Founder 一覧。番号順 */
export async function fetchFounderList(
  offerCode: string = FOUNDER_OFFER_CODE,
): Promise<FounderRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_founders", { p_offer_code: offerCode });

  // 課金の migration がまだ無い DB では、誰も買っていない一覧として出す
  if (isBillingNotInstalled(error)) return [];
  if (error) fail(error.message);
  return (data as FounderRow[] | null) ?? [];
}

/** その人のプロフィールに出す番号。出さない設定なら null */
export async function fetchFounderBadge(profileId: string): Promise<FounderBadge | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_founder_badge", {
    p_profile_id: profileId,
  });

  // **プロフィールの表示のために、ページ全体を落とさない。**
  // 番号が読めなかったら、バッジを出さないだけにする
  if (error) return null;
  return (data as FounderBadge | null) ?? null;
}

/** いま生きている自分の権限の鍵 */
export async function fetchMyEntitlements(): Promise<EntitlementKey[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_my_entitlements");

  if (error) return [];
  return (data as EntitlementKey[] | null) ?? [];
}

/** 名前を出すかどうかを切り替える。宛先は auth.uid() だけ（他人を指せない） */
export async function callSetMyFounderVisibility(
  isPublic: boolean,
): Promise<{ founder_number: number; founder_public: boolean }> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_my_founder_visibility", {
    p_public: isPublic,
  });

  if (error) fail(error.message);
  return data as { founder_number: number; founder_public: boolean };
}

/* ---------------------------------------------------------------------------
 * 動かす（秘密鍵）
 * ------------------------------------------------------------------------- */

export type ReserveResult = {
  result: "reserved" | "already_reserved";
  purchase_id: string;
  offer_code: string;
  offer_name?: string;
  amount: number;
  currency: string;
  checkout_session_id?: string | null;
  checkout_expires_at?: string | null;
};

/** 決済ページを作る前に、販売枠を1つ押さえる */
export async function callReserveSlot(input: {
  profileId: string;
  offerCode?: string;
}): Promise<ReserveResult> {
  const { data, error } = await admin().rpc("billing_reserve_slot", {
    p_profile_id: input.profileId,
    p_offer_code: input.offerCode ?? FOUNDER_OFFER_CODE,
  });

  if (error) fail(error.message);
  return data as ReserveResult;
}

export type CustomerLink = {
  billing_customer_id: string;
  stripe_customer_id: string;
};

/** すでに結び付いている Stripe 顧客。無ければ null */
export async function fetchBillingCustomer(profileId: string): Promise<CustomerLink | null> {
  const { data, error } = await admin().rpc("billing_get_customer", {
    p_profile_id: profileId,
  });

  if (error) fail(error.message);
  return (data as CustomerLink | null) ?? null;
}

export async function callUpsertBillingCustomer(input: {
  profileId: string;
  stripeCustomerId: string;
}): Promise<CustomerLink> {
  const { data, error } = await admin().rpc("billing_upsert_customer", {
    p_profile_id: input.profileId,
    p_stripe_customer_id: input.stripeCustomerId,
  });

  if (error) fail(error.message);
  return data as CustomerLink;
}

/** 作った決済ページを、予約中の購入へ結び付ける */
export async function callAttachCheckout(input: {
  purchaseId: string;
  billingCustomerId: string;
  sessionId: string;
  expiresAt: Date | null;
}): Promise<void> {
  const { error } = await admin().rpc("billing_attach_checkout", {
    p_purchase_id: input.purchaseId,
    p_billing_customer_id: input.billingCustomerId,
    p_session_id: input.sessionId,
    p_expires_at: input.expiresAt ? input.expiresAt.toISOString() : null,
  });

  if (error) fail(error.message);
}

export type CompleteResult = {
  result: "granted" | "already_granted";
  purchase_id: string;
  founder_number: number;
  profile_id?: string | null;
};

/** 決済の確定。**6つの突き合わせは DB の中で行う** */
export async function callCompleteCheckout(input: {
  sessionId: string;
  purchaseId: string | null;
  offerCode: string | null;
  mode: string | null;
  paymentStatus: string | null;
  amountTotal: number | null;
  currency: string | null;
  paymentIntentId: string | null;
}): Promise<CompleteResult> {
  const { data, error } = await admin().rpc("billing_complete_checkout", {
    p_session_id: input.sessionId,
    p_purchase_id: input.purchaseId,
    p_offer_code: input.offerCode,
    p_mode: input.mode,
    p_payment_status: input.paymentStatus,
    p_amount_total: input.amountTotal,
    p_currency: input.currency,
    p_payment_intent_id: input.paymentIntentId,
  });

  if (error) fail(error.message);
  return data as CompleteResult;
}

export async function callExpireCheckout(sessionId: string): Promise<{ result: string }> {
  const { data, error } = await admin().rpc("billing_expire_checkout", {
    p_session_id: sessionId,
  });

  if (error) fail(error.message);
  return data as { result: string };
}

export async function callMarkRefundPending(input: {
  paymentIntentId: string;
  refundId: string | null;
}): Promise<{ result: string }> {
  const { data, error } = await admin().rpc("billing_mark_refund_pending", {
    p_payment_intent_id: input.paymentIntentId,
    p_refund_id: input.refundId,
  });

  if (error) fail(error.message);
  return data as { result: string };
}

export async function callApplyRefundResult(input: {
  paymentIntentId: string;
  refundId: string | null;
  refundStatus: string;
}): Promise<{ result: string }> {
  const { data, error } = await admin().rpc("billing_apply_refund_result", {
    p_payment_intent_id: input.paymentIntentId,
    p_refund_id: input.refundId,
    p_refund_status: input.refundStatus,
  });

  if (error) fail(error.message);
  return data as { result: string };
}

export async function callMarkDispute(input: {
  paymentIntentId: string;
  disputeStatus: string;
}): Promise<{ result: string }> {
  const { data, error } = await admin().rpc("billing_mark_dispute", {
    p_payment_intent_id: input.paymentIntentId,
    p_dispute_status: input.disputeStatus,
  });

  if (error) fail(error.message);
  return data as { result: string };
}

/* ---------------------------------------------------------------------------
 * 受け取った知らせの重複防止
 * ------------------------------------------------------------------------- */

/** 初めて受け取った知らせなら claimed が true。2回目以降は false */
export async function claimWebhookEvent(input: {
  eventId: string;
  eventType: string;
  objectId: string | null;
  livemode: boolean;
  createdAt: Date | null;
  /** Stripe が使った API の版。**残しておかないと、ずれても気づけない。** */
  apiVersion: string | null;
}): Promise<{ claimed: boolean; processed_at: string | null }> {
  const { data, error } = await admin().rpc("billing_claim_webhook_event", {
    p_event_id: input.eventId,
    p_event_type: input.eventType,
    p_object_id: input.objectId,
    p_livemode: input.livemode,
    p_created_at: input.createdAt ? input.createdAt.toISOString() : null,
    p_api_version: input.apiVersion,
  });

  if (error) fail(error.message);
  return data as { claimed: boolean; processed_at: string | null };
}

export async function finishWebhookEvent(eventId: string): Promise<void> {
  const { error } = await admin().rpc("billing_finish_webhook_event", {
    p_event_id: eventId,
  });

  if (error) fail(error.message);
}

/* ---------------------------------------------------------------------------
 * 運営が行う救済
 * ------------------------------------------------------------------------- */

/**
 * 購入を別のアカウントへ結び直す。**譲渡ではない。**
 *
 * 使うのは、本人だと確かめられたうえでの事故の救済だけ
 * （メールアドレスの変更、ログインの事故、アカウントの移行）。
 * 呼ぶ前に必ず requireAdmin() を通すこと（src/features/admin/auth.ts）。
 * 理由は必須で、既存の監査記録（admin_audit_log）に残る。
 *
 * v0 では画面を作っていない。運営がこの関数を直接呼ぶ。
 */
export async function callReassignPurchase(input: {
  adminUserId: string;
  purchaseId: string;
  newProfileId: string;
  reason: string;
}): Promise<{
  purchase_id: string;
  founder_number: number | null;
  from_profile: string | null;
  to_profile: string;
}> {
  const { data, error } = await admin().rpc("billing_reassign_purchase", {
    p_admin_user_id: input.adminUserId,
    p_purchase_id: input.purchaseId,
    p_new_profile_id: input.newProfileId,
    p_reason: input.reason,
  });

  if (error) fail(error.message);
  return data as {
    purchase_id: string;
    founder_number: number | null;
    from_profile: string | null;
    to_profile: string;
  };
}
