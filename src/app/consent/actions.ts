"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { callAgree, fetchConsentStatus } from "@/features/consent/rpc";

/**
 * 同意を記録して、元居た場所へ戻す（P5）。
 *
 * 【版を画面から受け取る理由】
 *   利用者が読んだのは、画面を開いた瞬間に有効だった版。
 *   その版を送り返してもらい、**DB がいまの版と突き合わせる。**
 *   読んでいる最中に改定されたら VERSION_MISMATCH で断られ、
 *   新しい本文が出た画面をもう一度読むことになる。
 */
export async function agreeAction(form: FormData): Promise<void> {
  const terms = String(form.get("termsVersion") ?? "");
  const privacy = String(form.get("privacyVersion") ?? "");
  const back = String(form.get("back") ?? "/");

  if (!terms || !privacy) {
    redirect("/consent?error=" + encodeURIComponent("版が分かりませんでした。読み込み直してください。"));
  }

  try {
    await callAgree(terms, privacy);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    redirect("/consent?error=" + encodeURIComponent(message));
  }

  // 同意の状態は全ページの入口が読むので、まとめて作り直させる
  revalidatePath("/", "layout");

  // **戻り先はサイト内だけ。**画面から来た値をそのまま redirect に渡さない
  redirect(back.startsWith("/") && !back.startsWith("//") ? back : "/");
}

/** いま止まっているかを、画面から確かめるための読み取り */
export async function currentConsent() {
  return fetchConsentStatus();
}
