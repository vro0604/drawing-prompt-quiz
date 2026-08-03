"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ensureUserId } from "@/features/auth/session";
import { callSubmitAnswer } from "@/features/quiz/rpc";
import type { AnswerSelection } from "@/features/quiz/types";
import { callPublishWork, callUnpublishWork } from "@/features/work/rpc";

/**
 * 作品ページのボタンから呼ばれる Server Action。
 *
 * 公開／下書きの切り替えだけを行う。どちらも update_work を呼ぶ。
 *
 * **本人確認はここでしない。** update_work が
 * 「その作品の user_id は auth.uid() と一致するか」を見るので、
 * 他人の作品IDを送っても「見つかりません」で終わる（D40）。
 */

/** FormData から必ず文字列を取り出す（無ければ空文字） */
function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
}

/** 失敗したら理由を URL に載せて作品ページへ戻る */
function backWithError(workId: string, e: unknown): never {
  const message = e instanceof Error ? e.message : String(e);
  redirect(`/works/${workId}?error=${encodeURIComponent(message)}`);
}

export async function publishWorkAction(form: FormData): Promise<void> {
  const workId = str(form, "workId");

  try {
    await callPublishWork(workId);
  } catch (e) {
    backWithError(workId, e);
  }

  revalidatePath(`/works/${workId}`);
  redirect(`/works/${workId}`);
}

export async function unpublishWorkAction(form: FormData): Promise<void> {
  const workId = str(form, "workId");

  try {
    await callUnpublishWork(workId);
  } catch (e) {
    backWithError(workId, e);
  }

  revalidatePath(`/works/${workId}`);
  redirect(`/works/${workId}`);
}

/**
 * クイズの回答を送る。
 *
 * 【フォームの読み取り】
 *   出題側は問ごとに name="q_{question_id}"、value=tag_id のラジオを出す。
 *   ここではその接頭辞が付いた項目を拾って並べ直すだけ。
 *
 *   答えていない問はそもそも送られてこないので、数が足りなければ
 *   DB 側が INCOMPLETE_ANSWER で断る。ここでは数を数えない
 *   （何問あるべきかを知っているのは DB だけなので、二重管理にしない）。
 *
 * 【匿名サインインのタイミング】
 *   ページを開いただけでは発行しない（spec 11-1）。
 *   「回答する」を押した瞬間＝最初の書き込みで初めて発行する。
 *   ゲストのまま回答できるのは仕様どおり（spec 10 の権限表）。
 *
 * 【正しさの判定はここでしない】
 *   自作への回答か、2回目か、選択肢にある答えかは、すべて
 *   submit_answer が見る。ここを通り抜けても DB 側で必ず止まる。
 */
export async function submitAnswerAction(form: FormData): Promise<void> {
  const workId = str(form, "workId");
  const selections: AnswerSelection[] = [];

  for (const [key, value] of form.entries()) {
    if (!key.startsWith("q_")) continue;

    const questionId = Number.parseInt(key.slice(2), 10);
    const tagId = Number.parseInt(typeof value === "string" ? value : "", 10);

    if (Number.isFinite(questionId) && Number.isFinite(tagId)) {
      selections.push({ question_id: questionId, tag_id: tagId });
    }
  }

  try {
    // ここが「最初の書き込み」。必要ならこの瞬間にゲストが発行される
    await ensureUserId();
    await callSubmitAnswer(workId, selections);
  } catch (e) {
    backWithError(workId, e);
  }

  revalidatePath(`/works/${workId}`);
  redirect(`/works/${workId}`);
}
