"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
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
