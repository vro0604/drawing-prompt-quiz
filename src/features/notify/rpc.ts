import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readableRpcError } from "@/features/draft/rpc";
import type { AppNotification } from "@/features/notify/types";

/**
 * 知らせを読む・確認する・プッシュの宛先を出し入れする。サーバー専用。
 *
 * 【読めなかったときに画面を止めない】
 *   知らせは補助なので、取れなければ空で返す。
 *   ここで例外を投げると、知らせの仕組みが壊れた日にサイト全体が開かなくなる。
 */

export async function fetchMyNotifications(limit = 20): Promise<AppNotification[]> {
  const supabase = await createSupabaseServerClient();

  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return [];

  const { data, error } = await supabase.rpc("get_my_notifications", { p_limit: limit });
  if (error) return [];

  return (data as AppNotification[] | null) ?? [];
}

export async function callAcknowledgeNotification(id: number): Promise<AppNotification[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("acknowledge_notification", { p_id: id });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as AppNotification[] | null) ?? [];
}

export async function callSavePushSubscription(input: {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
}): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("save_push_subscription", {
    p_endpoint: input.endpoint,
    p_p256dh: input.p256dh,
    p_auth: input.auth,
    p_user_agent: input.userAgent,
  });

  if (error) throw new Error(readableRpcError(error.message));
}

export async function callDeletePushSubscription(endpoint: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("delete_push_subscription", { p_endpoint: endpoint });

  if (error) throw new Error(readableRpcError(error.message));
}
