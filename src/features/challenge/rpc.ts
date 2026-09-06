import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readableRpcError } from "@/features/draft/rpc";
import type { ActiveChallenge } from "@/features/challenge/types";

/**
 * いま進行中の制作挑戦を読む／時間を延ばす。サーバー専用。
 *
 * 【未サインインには DB へ問い合わせない】
 *   get_active_challenge は authenticated だけが呼べる。
 *   anon のまま呼ぶと permission denied で 500 になる（D90 と同じ形）。
 *   ここで null を返して、帯そのものを出さない。
 */

export async function fetchActiveChallenge(): Promise<ActiveChallenge | null> {
  const supabase = await createSupabaseServerClient();

  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return null;

  const { data, error } = await supabase.rpc("get_active_challenge");

  if (error) throw new Error(readableRpcError(error.message));
  return (data as ActiveChallenge | null) ?? null;
}

/**
 * いまの挑戦の時間を延ばす。
 *
 * **どの挑戦かを画面から渡さない。**渡すと、他人の ID を送られたときの
 * 判定を1か所増やすことになる。DB 側が「その人のいまの挑戦」を自分で決める。
 */
export async function callRenewCurrentChallenge(): Promise<ActiveChallenge | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("renew_current_challenge");

  if (error) throw new Error(readableRpcError(error.message));
  return (data as ActiveChallenge | null) ?? null;
}
