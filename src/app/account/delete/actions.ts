"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  callStartAccountDeletion,
  finishAccountDeletion,
} from "@/features/account/rpc";

/**
 * 退会の Server Action。
 *
 * 【順番】
 *   1. start_account_deletion（DB。1つの取引で全部終わる）
 *   2. Storage の画像を消す
 *   3. auth.users を消す
 *   4. サインアウトする
 *
 * 【なぜこの順番か】
 *   2 と 3 は取引の外なので、途中で失敗しても巻き戻らない。
 *   だから **危ないほうから閉じる**。
 *
 *   1 が終わった時点で、その人はもう何も書き込めず（門番）、
 *   作品も公開されていない。2 や 3 が失敗しても、
 *   残るのは画像ファイルと auth.users のメールだけで、
 *   どちらも掃除の対象として記録に残っている。
 *
 *   逆順にすると「ログインできないのに作品が公開されたまま」になる。
 *
 * 【失敗しても画面はエラーにしない】
 *   1 が通っていれば退会そのものは成立している。
 *   ここで「失敗しました」と出すと、もう戻れないのに
 *   もう一度押させることになる。何がどこまで進んだかを結果画面で伝える。
 */

export async function deleteAccountAction(form: FormData): Promise<void> {
  const confirm = String(form.get("confirm") ?? "").trim();

  // --- 1. DB 側をすべて片づける ----------------------------------------------
  //
  // 合言葉が違えば CONFIRM_MISMATCH で戻る。**判定は DB が持つ。**
  // 画面側だけで見ていると、POST を直接作れば飛ばせてしまう。
  let started: Awaited<ReturnType<typeof callStartAccountDeletion>>;

  try {
    started = await callStartAccountDeletion(confirm);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    redirect(`/account/delete?error=${encodeURIComponent(readable(message))}`);
  }

  // --- 2 と 3. Storage と auth.users ------------------------------------------
  const outcome = await finishAccountDeletion(started.userId, started.objects);

  // --- 4. サインアウト（指定13）----------------------------------------------
  //
  // auth.users を消せていれば、そのセッションはもう無効。
  // 消せていなくても、手元の Cookie は落としておく。
  // ここで失敗しても退会は成立しているので、握りつぶす。
  try {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
  } catch {
    // Server Action からは Cookie を消せないことがある。proxy 側で切れる。
  }

  const params = new URLSearchParams({
    storageDeleted: String(outcome.storageDeleted),
    storageFailed: String(outcome.storageFailed),
    authDeleted: outcome.authDeleted ? "1" : "0",
    noKey: outcome.authSkippedNoKey ? "1" : "0",
  });

  redirect(`/account/deleted?${params.toString()}`);
}

/** RPC のエラー名を画面の言葉にする */
function readable(message: string): string {
  if (message.includes("CONFIRM_MISMATCH")) {
    return "入力が一致しません。画面に表示されている言葉をそのまま入力してください。";
  }
  if (message.includes("ANONYMOUS_NOT_ALLOWED")) {
    return "ゲストのままでは退会の手続きはできません。ゲストの記録は使われなくなると自動で消えます。";
  }
  if (message.includes("ALREADY_PENDING")) {
    return "このアカウントはすでに退会の処理に入っています。";
  }
  if (message.includes("NOT_SIGNED_IN")) {
    return "サインインし直してから、もう一度お試しください。";
  }
  return message;
}
