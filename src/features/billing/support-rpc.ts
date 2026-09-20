import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { SupportSource } from "./support";

/** すべて service_role 専用。呼び出し元で本人確認と署名確認を済ませる。 */
function admin() {
  const client = createSupabaseAdminClient();
  if (!client) throw new Error("SUPPORT_KEY_MISSING");
  return client;
}

export async function startSupportPayment(input: {
  profileId: string | null;
  amount: number;
  source: SupportSource;
}): Promise<{ id: string; amount: number; source: SupportSource }> {
  const { data, error } = await admin().rpc("billing_support_start", {
    p_profile_id: input.profileId,
    p_amount: input.amount,
    p_source: input.source,
  });
  if (error) throw new Error(error.message);
  return data as { id: string; amount: number; source: SupportSource };
}

export async function attachSupportCheckout(id: string, sessionId: string): Promise<void> {
  const { error } = await admin().rpc("billing_support_attach", {
    p_id: id,
    p_session_id: sessionId,
  });
  if (error) throw new Error(error.message);
}

export async function completeSupportCheckout(input: {
  sessionId: string;
  supportId: string | null;
  mode: string | null;
  paymentStatus: string | null;
  amount: number | null;
  currency: string | null;
  paymentIntentId: string | null;
}): Promise<void> {
  const { error } = await admin().rpc("billing_support_complete", {
    p_session_id: input.sessionId,
    p_support_id: input.supportId,
    p_mode: input.mode,
    p_payment_status: input.paymentStatus,
    p_amount: input.amount,
    p_currency: input.currency,
    p_payment_intent_id: input.paymentIntentId,
  });
  if (error) throw new Error(error.message);
}

export async function expireSupportCheckout(sessionId: string): Promise<void> {
  const { error } = await admin().rpc("billing_support_expire", { p_session_id: sessionId });
  if (error) throw new Error(error.message);
}

export async function applySupportRefund(input: {
  paymentIntentId: string;
  refundId: string | null;
  amount: number | null;
  status: string;
}): Promise<boolean> {
  const { data, error } = await admin().rpc("billing_support_refund", {
    p_payment_intent_id: input.paymentIntentId,
    p_refund_id: input.refundId,
    p_amount: input.amount,
    p_status: input.status,
  });
  if (error) throw new Error(error.message);
  return (data as { handled: boolean }).handled;
}

export async function applySupportDispute(input: {
  paymentIntentId: string;
  status: string;
}): Promise<boolean> {
  const { data, error } = await admin().rpc("billing_support_dispute", {
    p_payment_intent_id: input.paymentIntentId,
    p_status: input.status,
  });
  if (error) throw new Error(error.message);
  return (data as { handled: boolean }).handled;
}

export async function fetchSupportPaymentStatus(sessionId: string): Promise<string | null> {
  const { data, error } = await admin().rpc("billing_support_status", {
    p_session_id: sessionId,
  });
  if (error) throw new Error(error.message);
  return (data as string | null) ?? null;
}

export async function fetchBillingRevenueSummary(): Promise<Record<string, unknown>> {
  const { data, error } = await admin().rpc("billing_revenue_summary");
  if (error) throw new Error(error.message);
  return data as Record<string, unknown>;
}
