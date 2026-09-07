"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  callAbandonPrompt,
  callRenewPromptDeadline,
  callRevealPromptCandidates,
} from "@/features/draft/rpc";
import { callSavePromptElements } from "@/features/carry/rpc";

/**
 * 確定したお題の画面のボタン。
 *
 * 【どちらも本人確認をここでしない】
 *   renew_prompt_deadline も save_prompt_elements も
 *   「そのお題の created_by は auth.uid() と一致するか」を見る。
 *   他人のお題IDを送っても「見つかりません」で終わる（D40）。
 */

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
}

function backWithError(promptId: string, e: unknown): never {
  const message = e instanceof Error ? e.message : String(e);
  redirect(`/prompt/${promptId}?error=${encodeURIComponent(message)}`);
}

/**
 * 制作時間を更新する（オーバー更新。D163）。
 *
 * 【二重に押されたときに何が起きるか】
 *   押した瞬間にボタンは塞がるが、通信が2本届くことはある。
 *   そのとき DB 側は行を押さえてから判定するので、
 *   **2本目は「まだ更新できません」で断られる。**時間は1回ぶんしか増えない。
 *
 * 【失敗の理由が3通りある】
 *   早すぎる／猶予を過ぎた／無制限のお題。文言は DB 側が作る。
 *   ここで作り直すと、分岐が2か所に散る。
 */
export async function renewDeadlineAction(form: FormData): Promise<void> {
  const promptId = str(form, "promptId");

  try {
    await callRenewPromptDeadline(promptId);
  } catch (e) {
    backWithError(promptId, e);
  }

  revalidatePath(`/prompt/${promptId}`);
  redirect(
    `/prompt/${promptId}?notice=${encodeURIComponent("制作時間を延ばしました。")}`,
  );
}

/**
 * 自分のお題から要素を持ち出す（D161）。
 *
 * 他人の作品から持ち出す経路（/works/[id]）と入口が違うだけで、
 * 保存されるものは同じ。出所として、このお題のIDが記録される。
 */
export async function carryFromPromptAction(form: FormData): Promise<void> {
  const promptId = str(form, "promptId");

  const tagIds = form
    .getAll("tagId")
    .map((v) => Number.parseInt(typeof v === "string" ? v : "", 10))
    .filter((n) => Number.isFinite(n));

  if (tagIds.length === 0) {
    backWithError(promptId, new Error("持ち出す要素を選んでください。"));
  }

  try {
    await callSavePromptElements("prompt", promptId, tagIds);
  } catch (e) {
    backWithError(promptId, e);
  }

  revalidatePath(`/prompt/${promptId}`);
  revalidatePath("/play");
  redirect(
    `/prompt/${promptId}?notice=${encodeURIComponent(
      `${tagIds.length}個を持ち出しました。次にお題を引くとき、この要素から始められます。`,
    )}`,
  );
}

/**
 * 引かなかったカードを開く（spec 4-4 の「他の候補を見る」／D171）。
 *
 * 【本人確認をここでしない】
 *   reveal_prompt_candidates が created_by = auth.uid() を見る。
 *   他人のお題IDを送っても「そのお題は見つかりません」で終わる（D40）。
 *   画面側でボタンを隠しているのは見やすさのためで、**錠は DB 側にある。**
 *
 * 二度押されても、開いた時刻と理由は最初の1回ぶんしか記録されない。
 */
export async function revealPromptCandidatesAction(form: FormData): Promise<void> {
  const promptId = str(form, "promptId");

  try {
    await callRevealPromptCandidates(promptId);
  } catch (e) {
    backWithError(promptId, e);
  }

  revalidatePath(`/prompt/${promptId}`);
  redirect(
    `/prompt/${promptId}?notice=${encodeURIComponent(
      "引かなかったカードを開きました。この表示は元に戻せません。",
    )}`,
  );
}

/**
 * このお題は描かない（spec 4-4 の「チャレンジ放棄」／D171）。
 *
 * 押すとお題が放棄になり、そのお題では作品を投稿できなくなる。
 * 引き換えに、引かなかったカードが開く。
 *
 * **投稿済みのお題は放棄できない。**その判定も DB 側にある。
 */
export async function abandonPromptAction(form: FormData): Promise<void> {
  const promptId = str(form, "promptId");

  try {
    await callAbandonPrompt(promptId);
  } catch (e) {
    backWithError(promptId, e);
  }

  revalidatePath(`/prompt/${promptId}`);
  revalidatePath("/play");
  redirect(
    `/prompt/${promptId}?notice=${encodeURIComponent(
      "このお題をやめました。引かなかったカードを開いています。",
    )}`,
  );
}
