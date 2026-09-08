"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/features/admin/auth";
import {
  adminError,
  callAdminHideWork,
  callAdminResolveReport,
} from "@/features/admin/rpc";

/**
 * 管理の Server Action。
 *
 * 【毎回 requireAdmin を通す】
 *   画面側（layout と page）でも判定しているが、ここでもやる。
 *   Server Action は画面を通らずに直接叩けるため
 *   （Next.js 16 同梱文書 server-actions.md
 *    「Render-time gating ... is not a security boundary」）。
 *
 * 【失敗を成功に見せない】
 *   失敗したら必ず ?error= を付けて同じ画面へ戻る。
 *   握りつぶして「完了しました」を出す経路を1つも作らない。
 *   合図（WORK_ALREADY_HIDDEN など）は落とさずに画面まで運ぶ。
 *
 * 【成功も画面に出す】
 *   ?done= を付けて戻る。押したのに何も変わらないと、
 *   もう一度押される（_pending.tsx が書いている二重送信の話と同じ）。
 */

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
}

/** 失敗したら合図つきで同じ画面へ戻る */
function back(reportId: string, e: unknown): never {
  const err = adminError(e);
  const text = err.code ? `[${err.code}] ${err.message}` : err.message;
  redirect(`/admin/reports/${reportId}?error=${encodeURIComponent(text)}`);
}

function done(reportId: string, message: string): never {
  revalidatePath(`/admin/reports/${reportId}`);
  revalidatePath("/admin/reports");
  redirect(`/admin/reports/${reportId}?done=${encodeURIComponent(message)}`);
}

/**
 * 作品を運営の判断で非表示にする。
 *
 * **通報の状態は変えない。**下げることと、通報を閉じることは別の判断
 * （問題投稿だったが通報の理由は的外れ、ということがある）。
 * 続けて閉じたければ、同じ画面でもう1回押す。
 */
export async function hideWorkAction(form: FormData): Promise<void> {
  const reportId = str(form, "reportId");
  const workId = str(form, "workId");
  const reason = str(form, "reason").trim();
  const confirmed = str(form, "confirm") === "yes";

  try {
    const adminUserId = await requireAdmin();

    // 確認の印はブラウザ側の required だけに頼らない。
    // JavaScript を切っても HTML の required は効くが、
    // **フォームを通さずに送れる**ので、ここでも見る。
    if (!confirmed) {
      throw new Error(
        "CONFIRM_REQUIRED: 確認の欄にチェックを入れてから実行してください。",
      );
    }
    if (reason === "") {
      throw new Error("REASON_REQUIRED: 理由を書いてください。");
    }

    await callAdminHideWork({ adminUserId, workId, reason });
  } catch (e) {
    back(reportId, e);
  }

  done(reportId, "作品を非表示にしました。通報はまだ開いています。");
}

/** 通報を閉じる中身。resolution は呼ぶ側が固定する（フォームから受け取らない） */
async function closeReport(
  form: FormData,
  resolution: "resolved" | "rejected",
  message: string,
): Promise<void> {
  const reportId = str(form, "reportId");
  const reason = str(form, "reason").trim();

  try {
    const adminUserId = await requireAdmin();

    if (reason === "") {
      throw new Error("REASON_REQUIRED: 理由を書いてください。");
    }

    await callAdminResolveReport({
      adminUserId,
      reportId: Number.parseInt(reportId, 10),
      resolution,
      reason,
    });
  } catch (e) {
    back(reportId, e);
  }

  done(reportId, message);
}

/** 対応した（作品を下げた・作者へ連絡した など） */
export async function resolveReportAction(form: FormData): Promise<void> {
  await closeReport(form, "resolved", "通報を対応済みにしました。");
}

/** 却下した（通報に理由が無かった） */
export async function rejectReportAction(form: FormData): Promise<void> {
  await closeReport(form, "rejected", "通報を却下しました。作品は変えていません。");
}
