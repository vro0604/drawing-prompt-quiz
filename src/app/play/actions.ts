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
  fetchCurrentDraft,
  fetchDraftModes,
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

/** 進行中のドラフトがあるときの案内。従来と同じ文言を1か所にまとめる */
const IN_PROGRESS =
  "DRAFT_IN_PROGRESS: 進行中のドラフトがあります。" +
  "続けるか、破棄してから新しく始めてください。";

/**
 * いま進行中のドラフトが「これから始めようとした条件と同じか」を見る。
 *
 * 【なぜ条件まで見るか】
 *   無条件で合流させると、**お手軽で始めたつもりが標準の途中に戻される。**
 *   利用者は自分が何を選んだか分からなくなる。
 *   同じ条件のときだけ「さっき押したやつだ」と言い切れる。
 *
 * 【何を比べるか】
 *   モードと制限時間に加えて、**そのモードがいま持っている
 *   候補数・引き直し上限・出題数**まで比べる。
 *   マスタが途中で変わっていれば、同じモード名でも中身は別物なので
 *   合流させない。
 *
 * 読み取りに失敗したら null を返す。合流の判断ができないので、
 * 呼び出し側は元のエラーをそのまま出す（勝手に成功にしない）。
 */
async function sameConditionDraft(
  modeKey: string,
  timeLimitSeconds: number | null,
): Promise<{ matched: boolean } | null> {
  try {
    const current = await fetchCurrentDraft();
    if (!current || current.status !== "in_progress") return null;

    const modes = await fetchDraftModes();
    const mode = modes.find((m) => m.mode_key === modeKey);

    const matched =
      current.mode_key === modeKey &&
      (current.time_limit_seconds ?? null) === timeLimitSeconds &&
      mode !== undefined &&
      current.candidate_count === mode.candidate_count &&
      current.max_rerolls === mode.max_rerolls &&
      current.quiz_question_count === mode.quiz_question_count;

    return { matched };
  } catch {
    return null;
  }
}

/**
 * ドラフトを始める。
 *
 * 【二重送信への備え】
 *   ボタンは押した瞬間に塞がる（SubmitButton）。それでも
 *   Enter とクリックが同時に走る、通信が遅れて2本届く、といったことは起きる。
 *
 *   start_draft は「進行中があるか」を見てから入れるので、
 *   同時に2本来ると両方が検査を通り抜けることがある。そのときは
 *   部分ユニーク索引（user_id / status='in_progress'）が2本目を弾く。
 *   **行は増えない。**ただし2本目には素の一意制約違反が返る。
 *
 *   ここでは、失敗したあとに**いま進行中のドラフトを読み直して**、
 *   始めようとした条件と同じなら、そのまま先へ進める（＝1件に合流）。
 *   条件が違えば、従来どおりの案内を出す。
 *
 *   エラーの文面では判定しない。文面は環境によって差し替わる（D82）ため、
 *   **いまの状態を見て決める。**
 */
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
    const existing = await sameConditionDraft(modeKey, timeLimitSeconds);

    // 進行中が無い／読めない → 失敗の原因は別にある。そのまま出す
    if (existing === null) backWithError(e);

    // 条件が違う → 従来の案内。勝手に別のドラフトへ連れて行かない
    if (!existing.matched) backWithError(new Error(IN_PROGRESS));

    // 条件が同じ → さっきの1件へ合流する（下の redirect へ落ちる）
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
