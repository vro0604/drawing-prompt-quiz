"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ensureUserId } from "@/features/auth/session";
import {
  callDeleteSavedCarrySlot,
  callPromoteSessionCarry,
} from "@/features/carry/rpc";
import { pickSubDirective } from "@/features/modifier/types";
import { writeSubDirective } from "@/features/modifier/rpc";
import {
  isShapeAssistKey,
  pickRandomShapeAssist,
} from "@/features/shape-assist/types";
import {
  callAbandonDraft,
  callCompleteDraft,
  callRerollDraft,
  callPickCard,
  callRedoSlot,
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
 *   候補数と引き直し上限**まで比べる。
 *   マスタが途中で変わっていれば、同じモード名でも中身は別物なので
 *   合流させない。出題数はお題の語数で決まるので、比べる対象ではない（D165）。
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
      current.max_rerolls === mode.max_rerolls;

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

  // 持ち出す要素（D161）。数の上限も、本人の手持ちかどうかも start_draft が見る。
  // **ここで数を切らない。**切ると「3個までです」を2か所で管理することになる。
  const carriedElementIds = form
    .getAll("carriedElementId")
    .map((v) => Number.parseInt(typeof v === "string" ? v : "", 10))
    .filter((n) => Number.isFinite(n));

  // 形状アシスト（D191）。**お題ではない。**
  //
  //   なし     … 何も渡さない（null）
  //   ランダム … ここで1つに決めて渡す。決めた結果はドラフトの行に残るので、
  //              引き直しても、読み込み直しても同じものが残る
  //   自分で選ぶ … 選ばれた候補をそのまま渡す
  //
  // 「自分で選ぶ」以外のときに候補の値が混ざっていても無視する。
  // 押していない選択肢が効いてしまうと、画面と結果が食い違う。
  const shapeAssistMode = str(form, "shapeAssistMode");
  const pickedShapeAssist = str(form, "shapeAssistKey");
  const shapeAssistKey =
    shapeAssistMode === "random"
      ? pickRandomShapeAssist()
      : shapeAssistMode === "pick" && isShapeAssistKey(pickedShapeAssist)
        ? pickedShapeAssist
        : null;

  try {
    // ここが「最初の書き込み」。必要ならこの瞬間に匿名ユーザーが発行される
    await ensureUserId();
    await callStartDraft(
      modeKey,
      timeLimitSeconds,
      carriedElementIds,
      shapeAssistKey,
    );
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

/**
 * カードを1枚引く（2026-09-08）。
 *
 * 引いた瞬間に仮採用になり、次のカテゴリへ自動で進む。**確認は挟まない。**
 * 引き直したあとの「残りから1枚選ぶ」も、同じ入口を通る。
 *
 * 二度押されても壊れない。すでに決まっているカテゴリなら、DB が
 * いまの状態をそのまま返すので、2回目は何も起きない。
 */
export async function pickCardAction(form: FormData): Promise<void> {
  const sessionId = str(form, "sessionId");
  const cardSlotKey = str(form, "cardSlotKey");
  const candidateIndex = Number.parseInt(str(form, "candidateIndex"), 10);

  try {
    if (!Number.isFinite(candidateIndex)) {
      throw new Error("カードの番号が読み取れませんでした。");
    }
    await callPickCard(sessionId, cardSlotKey, candidateIndex);
  } catch (e) {
    backWithError(e);
  }

  revalidatePath(PAGE);
  redirect(PAGE);
}

/**
 * カテゴリを引き直す（2026-09-08）。**取り消せない。**
 *
 * ここへ来る前に、取り消せないことを伝える画面を通っている
 * （/play?redo=<カテゴリ>）。この処理は確認しない。捨てる。
 *
 * 【戻るボタンで送り直されても、2枚目は捨てられない】
 *   引き直しを使ったかどうかは DB の枠に記録されている。
 *   2回目は REDO_ALREADY_USED で断られる。
 *
 * 捨てた直後の画面にだけ退場の動きを出すため、戻り先に印を付ける。
 * 印は見た目のためだけのもので、状態は持たない。
 */
export async function redoSlotAction(form: FormData): Promise<void> {
  const sessionId = str(form, "sessionId");
  const cardSlotKey = str(form, "cardSlotKey");

  try {
    await callRedoSlot(sessionId, cardSlotKey);
  } catch (e) {
    backWithError(e);
  }

  revalidatePath(PAGE);
  redirect(`${PAGE}?discarded=${encodeURIComponent(cardSlotKey)}`);
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

/**
 * ゲストのときに作った保存枠を、登録後に手元へ残す（D166）。
 *
 * 原文「登録後は使用分を保存可能」。**移す先は出所で決まる。**
 * 自分のお題からのものは「自分のお題から」、他の人のお題からのものは
 * 「他の人のお題から」に入る。どちらも上限（保存枠の数）があるので、
 * 超えるときは DB が断る（画面では数えない）。
 */
export async function promoteSessionCarryAction(): Promise<void> {
  try {
    await callPromoteSessionCarry(null);
  } catch (e) {
    backWithError(e);
  }

  revalidatePath(PAGE);
  redirect(PAGE);
}

/**
 * 手元の保存枠を1つ捨てる。
 *
 * 原文「破棄は利用者が行う」「上限到達時は保存不可」。
 * **古い枠を勝手に押し出さない**ので、上限に達したら
 * 利用者が枠を捨てるまで新しく保存できない。その捨てる操作がここ。
 *
 * 上限を数える単位は保存枠なので、**空きが増えるのは枠ごと捨てたときだけ。**
 * 他人の枠は消せない（判定は DB 側）。
 */
export async function deleteSavedCarrySlotAction(form: FormData): Promise<void> {
  const id = Number.parseInt(str(form, "carrySlotId"), 10);

  try {
    if (!Number.isFinite(id)) throw new Error("捨てる保存枠が選ばれていません。");
    await callDeleteSavedCarrySlot(id);
  } catch (e) {
    backWithError(e);
  }

  revalidatePath(PAGE);
  redirect(PAGE);
}
