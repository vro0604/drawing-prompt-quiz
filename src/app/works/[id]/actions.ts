"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { ensureUserId } from "@/features/auth/session";
import { callSubmitAnswer } from "@/features/quiz/rpc";
import type { AnswerSelection } from "@/features/quiz/types";
import { callCreateReport } from "@/features/report/rpc";
import { captchaRequired, verifyCaptcha } from "@/features/report/captcha";
import {
  callDeleteWork,
  callMarkWorkImageDeleted,
  callPublishWork,
  callToggleLike,
  callToggleSave,
  callUnpublishWork,
  removeWorkImage,
} from "@/features/work/rpc";

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
 * いいね・保存を付ける／外す。
 *
 * 【回答と違って、ここでは匿名サインインをしない】
 *   いいねと保存は登録ユーザー限定（D7 / spec 10）。
 *   ここで ensureUserId を呼ぶと、押せもしないゲストを1人作ってしまう。
 *   閲覧しただけの人でユーザーを増やさない方針（spec 11-1）にも反する。
 *
 * 【判定は DB 側】
 *   ゲストかどうかは toggle_like / toggle_save が JWT で見る。
 *   ここを通り抜けても必ず止まる。
 */
async function toggleReaction(
  form: FormData,
  run: (workId: string) => Promise<unknown>,
): Promise<void> {
  const workId = str(form, "workId");

  try {
    await run(workId);
  } catch (e) {
    backWithError(workId, e);
  }

  revalidatePath(`/works/${workId}`);
  // 一覧にも件数が出ているので、そちらも描き直させる
  revalidatePath("/works");
  redirect(`/works/${workId}`);
}

export async function toggleLikeAction(form: FormData): Promise<void> {
  await toggleReaction(form, callToggleLike);
}

export async function toggleSaveAction(form: FormData): Promise<void> {
  await toggleReaction(form, callToggleSave);
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

/**
 * 作品を削除する。**取り返しがつきにくい操作**なので、確認画面から呼ぶ。
 *
 * 【誤操作を防ぐ】
 *   確認画面で作品タイトルの再入力を求め、一致しないときは何もしない。
 *   照合をここで行うのは、DB に渡す前に止めるため（DB 側は
 *   「本人か」しか見ない。タイトルは画面の都合であって、
 *   データの正しさの条件ではない）。
 *
 * 【順序】
 *   1. delete_work … 公開から外し、deleted_at を立てる（DB）
 *   2. Storage から画像を消す
 *   3. mark_work_image_deleted … 消せたことを記録する
 *
 *   2 と 3 が失敗しても作品は削除済みのままで、公開へは戻らない
 *   （update_work が deleted_at を見て断る）。残るのは容量の問題だけで、
 *   Step 16 の掃除が「deleted_at はあるが image_deleted_at が無い」
 *   作品を拾って再試行する。
 *
 *   だから 2 と 3 の失敗はここで握りつぶす。ここで例外にすると、
 *   **削除は成功しているのに画面には失敗と出る**という、
 *   いちばん誤解を生む結果になる。
 */
export async function deleteWorkAction(form: FormData): Promise<void> {
  const workId = str(form, "workId");
  const typedTitle = str(form, "confirmTitle").trim();
  const actualTitle = str(form, "expectedTitle").trim();

  if (typedTitle === "" || typedTitle !== actualTitle) {
    redirect(
      `/works/${workId}/delete?error=${encodeURIComponent(
        "作品タイトルが一致しません。削除していません。",
      )}`,
    );
  }

  let imagePath: string | null = null;

  try {
    const result = await callDeleteWork(workId);
    imagePath = result.image_path;
  } catch (e) {
    redirect(
      `/works/${workId}/delete?error=${encodeURIComponent(
        e instanceof Error ? e.message : String(e),
      )}`,
    );
  }

  // ここから先の失敗は握りつぶす（上記の理由）。
  //
  // **消せたときだけ印を付ける。** 消せていないのに記録すると、
  // Step 16 の掃除がその作品を対象から外し、消し残しが永久に残る。
  if (imagePath) {
    try {
      const removed = await removeWorkImage(imagePath);
      if (removed) await callMarkWorkImageDeleted(workId);
    } catch {
      // 消し残しは Step 16 の掃除が拾う
    }
  }

  revalidatePath("/works");
  revalidatePath("/rankings");
  revalidatePath(`/works/${workId}`);
  redirect("/works?notice=" + encodeURIComponent("作品を削除しました。"));
}

/**
 * 作品を通報する。
 *
 * **ゲストも送れる**（spec 8-4）。通報は「見つけた人が知らせる」行為で、
 * 登録を求めると、いちばん多くの作品を見ている層からの報告が届かなくなる。
 *
 * 未サインインの場合はここでゲストが発行される（ensureUserId）。
 * create_report は anon から呼べないため、この一手が要る。
 */
export async function createReportAction(form: FormData): Promise<void> {
  const workId = str(form, "workId");
  const reason = str(form, "reason");
  const detail = str(form, "detail").trim();

  // --- CAPTCHA（P6）-----------------------------------------------------
  //
  // 秘密鍵が設定されているときだけ検証する。設定されていなければ素通し
  // （開発中に手が止まらないようにするため）。**公開前に必ず設定する。**
  //
  // 検証に行けなかった場合も通さない。「確かめられなかったから通す」に
  // すると、検証先を落とすだけで CAPTCHA を無効化できてしまう。
  if (captchaRequired()) {
    const token = str(form, "cf-turnstile-response");
    const headerList = await headers();
    const ip =
      headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      headerList.get("x-real-ip") ??
      undefined;

    if (!(await verifyCaptcha(token, ip))) {
      redirect(
        `/works/${workId}/report?error=${encodeURIComponent(
          "確認に失敗しました。画面を読み込み直して、もう一度お試しください。",
        )}`,
      );
    }
  }

  try {
    await ensureUserId();
    await callCreateReport({
      workId,
      reason,
      detail: detail === "" ? null : detail,
    });
  } catch (e) {
    redirect(
      `/works/${workId}/report?error=${encodeURIComponent(
        e instanceof Error ? e.message : String(e),
      )}`,
    );
  }

  redirect(
    `/works/${workId}?notice=${encodeURIComponent(
      "報告を受け付けました。ご協力ありがとうございます。",
    )}`,
  );
}
