"use server";

import { redirect } from "next/navigation";
import { ensureUserId } from "@/features/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * /health/auth のボタンから呼ばれる Server Action。
 *
 * ファイル先頭の "use server" で、この中の関数はサーバーでのみ実行される。
 * ブラウザからは「この関数を呼んでください」という POST が飛ぶだけで、
 * 中身のコードはブラウザに送られない。
 *
 * サインインは Cookie の書き込みを伴うため、Server Component ではなく
 * ここ（Server Action）から呼ぶ必要がある。
 */

const PAGE = "/health/auth";

/** 「書き込みが発生した」ことにして、必要なら匿名ユーザーを発行する */
export async function ensureGuestAction(): Promise<void> {
  let message: string | null = null;

  try {
    await ensureUserId();
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }

  // 失敗の理由を画面に出すため、URL に載せて戻る。
  // 成功時に redirect するのは、前回の ?error= を URL から消すため。
  // redirect() は内部で例外を投げて処理を打ち切るので、try の外で呼ぶ。
  redirect(message ? `${PAGE}?error=${encodeURIComponent(message)}` : PAGE);
}

/**
 * サインアウト。
 *
 * 注意: 匿名ユーザーがサインアウトすると、その uid には二度と戻れない。
 * 紐づく記録（回答履歴など）は本人から見えなくなる。
 * このページは動作確認用なので置いているが、本番の画面では
 * 匿名ユーザーにサインアウトを見せない。
 */
export async function signOutAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect(PAGE);
}
