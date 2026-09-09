"use server";

import { redirect } from "next/navigation";
import { getCurrentUser } from "@/features/auth/session";
import { billingError, callSetMyFounderVisibility } from "@/features/billing/rpc";
import { callAgreeToDocuments } from "@/features/account/rpc";

/**
 * /founder の「名前を出す・出さない」を切り替える。
 *
 * 【誰の設定かを受け取らない】
 *   フォームから来るのは「出すか／出さないか」の1つだけ。
 *   **誰の設定かは DB が auth.uid() から決める**ので、
 *   他人の番号や購入の ID を送っても、その人の設定は動かない。
 *
 * 【画面で隠すことを守りにしない】
 *   ボタンを出さなければ押せない、ではなく、ここでも必ず認可を確かめる。
 *   Server Action は画面を通らずに直接叩ける
 *   （node_modules/next/dist/docs/01-app/02-guides/server-actions.md）。
 *
 * 【結果の伝え方】
 *   既存の /account と同じで、済んだら元の画面へ戻す。
 *   失敗したときだけ、URL に短い合図を付けて画面側で日本語を出す。
 */

const PAGE = "/founder";

export async function setFounderVisibilityAction(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user || user.is_anonymous) {
    redirect(`${PAGE}?error=${encodeURIComponent("この操作にはログインが必要です。")}`);
  }

  const wantsPublic = formData.get("public") === "1";

  try {
    await callSetMyFounderVisibility(wantsPublic);
  } catch (e) {
    redirect(`${PAGE}?error=${encodeURIComponent(billingError(e).message)}`);
  }

  redirect(`${PAGE}?notice=${encodeURIComponent(
    wantsPublic
      ? "Founder 一覧とプロフィールに、表示名を出すようにしました。"
      : "Founder 一覧では匿名希望として表示し、プロフィールには出さないようにしました。",
  )}`);
}

/**
 * 購入の前に、いま有効な規約とポリシーへ同意する（規約 13-6）。
 *
 * 【なぜ購入の画面で取るか】
 *   投稿の画面と同じ考え方。**同意を求める場所と、同意が要る操作を離さない。**
 *   離すと「どこかで同意したはず」の状態ができて、
 *   お金を受け取ったあとで「同意していない」と言われる形になる。
 *
 * 【版はフォームから来るが、信用していない】
 *   agree_to_documents が「いま有効な版か」をもう一度確かめ、
 *   違えば VERSION_MISMATCH で断る。**古い版に同意させられない。**
 *   誰が同意したかはフォームから来ない（auth.uid() が決める）。
 */
export async function agreeToBillingDocumentsAction(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user || user.is_anonymous) {
    redirect(`${PAGE}?error=${encodeURIComponent("この操作にはログインが必要です。")}`);
  }

  const terms = String(formData.get("termsVersion") ?? "");
  const privacy = String(formData.get("privacyVersion") ?? "");

  if (formData.get("accept") !== "1") {
    redirect(`${PAGE}?error=${encodeURIComponent("同意のチェックを入れてください。")}`);
  }

  try {
    await callAgreeToDocuments(terms, privacy);
  } catch (e) {
    const message = e instanceof Error ? e.message : "同意を記録できませんでした。";
    redirect(`${PAGE}?error=${encodeURIComponent(message)}`);
  }

  redirect(`${PAGE}?notice=${encodeURIComponent("同意を記録しました。購入へお進みいただけます。")}`);
}
