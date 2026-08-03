"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ensureUserId } from "@/features/auth/session";
import {
  callAbandonDraft,
  callCompleteDraft,
  callRerollDraft,
  callRevealCard,
  callStartDraft,
} from "@/features/draft/rpc";

/**
 * /play のボタンから呼ばれる Server Action。
 *
 * 【Server Action は「サーバー上の関数」ではなく「誰でも叩ける入口」】
 *   ブラウザには関数の中身ではなく呼び出し用のIDだけが渡り、押すと
 *   このページ宛に POST が飛ぶ。POST は誰でも作れるので、
 *   フォームに何が入っていても壊れないように書く必要がある。
 *
 *   ただし**本人確認と正しさの判定はすべて DB 側の RPC が持っている**。
 *   ここで session_id を差し替えられても、RPC が
 *   「その行の user_id は auth.uid() と一致するか」を見るので他人のドラフトは動かせない。
 *   このファイルがやるのは、入力を型に直すことと、失敗を画面に出すことだけ。
 *
 * 【匿名サインインのタイミング】
 *   ページを開いただけでは発行しない（spec 11-1）。
 *   「ドラフトを始める」を押した瞬間＝最初の書き込みで初めて発行する。
 */

const PAGE = "/play";

/** 失敗したら理由を URL に載せて /play へ戻る */
function backWithError(e: unknown): never {
  const message = e instanceof Error ? e.message : String(e);
  redirect(`${PAGE}?error=${encodeURIComponent(message)}`);
}

/** FormData から必ず文字列を取り出す（無ければ空文字） */
function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
}

export async function startDraftAction(form: FormData): Promise<void> {
  const modeKey = str(form, "modeKey");
  const rawLimit = str(form, "timeLimitSeconds");

  // 空文字 = 無制限。数字以外が来たら無制限として扱う（RPC 側でも範囲を見る）
  const parsed = Number.parseInt(rawLimit, 10);
  const timeLimitSeconds = Number.isFinite(parsed) ? parsed : null;

  try {
    // ここが「最初の書き込み」。必要ならこの瞬間に匿名ユーザーが発行される
    await ensureUserId();
    await callStartDraft(modeKey, timeLimitSeconds);
  } catch (e) {
    backWithError(e);
  }

  revalidatePath(PAGE);
  redirect(PAGE);
}

export async function revealCardAction(form: FormData): Promise<void> {
  const sessionId = str(form, "sessionId");
  const cardSlotKey = str(form, "cardSlotKey");
  const candidateIndex = Number.parseInt(str(form, "candidateIndex"), 10);

  try {
    if (!Number.isFinite(candidateIndex)) {
      throw new Error("カードの番号が読み取れませんでした。");
    }
    await callRevealCard(sessionId, cardSlotKey, candidateIndex);
  } catch (e) {
    backWithError(e);
  }

  revalidatePath(PAGE);
  redirect(PAGE);
}

export async function rerollDraftAction(form: FormData): Promise<void> {
  const sessionId = str(form, "sessionId");

  try {
    await callRerollDraft(sessionId);
  } catch (e) {
    backWithError(e);
  }

  revalidatePath(PAGE);
  redirect(PAGE);
}

/**
 * お題を確定する。成功したら確定お題のページへ移動する。
 *
 * redirect() は内部で例外を投げて処理を打ち切るため、try の外で呼ぶ。
 * try の中に置くと catch が拾ってしまい、移動が「失敗」に見える。
 */
export async function completeDraftAction(form: FormData): Promise<void> {
  const sessionId = str(form, "sessionId");
  let promptId: string;

  try {
    const result = await callCompleteDraft(sessionId);
    promptId = result.prompt_id;
  } catch (e) {
    backWithError(e);
  }

  revalidatePath(PAGE);
  redirect(`/prompt/${promptId}`);
}

export async function abandonDraftAction(form: FormData): Promise<void> {
  const sessionId = str(form, "sessionId");

  try {
    await callAbandonDraft(sessionId);
  } catch (e) {
    backWithError(e);
  }

  revalidatePath(PAGE);
  redirect(PAGE);
}
