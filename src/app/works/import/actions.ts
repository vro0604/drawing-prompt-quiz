"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/features/auth/session";
import { readImageInfo } from "@/features/work/image";
import { callCreateArtFirstWork } from "@/features/artfirst/rpc";
import { callSetCompleteness, removeWorkImage, uploadWorkImage } from "@/features/work/rpc";
import { DEFAULT_COMPLETENESS, MAX_IMAGE_BYTES, type Division } from "@/features/work/types";

/**
 * 持ち込み投稿の Server Action。
 *
 * 【/works/new との違いは2つだけ】
 *   1. お題のIDを受け取らない。代わりに作者が選んだ語のIDを受け取る
 *   2. 呼ぶ受け口が create_art_first_work（お題を作ってから作品を作る）
 *
 * 順番は同じ。**アップロード → 受け口 → 失敗したら画像を消す（R10）。**
 * 画像の置き場所に作品IDが入る規約（spec 8-6）も同じなので、
 * 作品IDをここで決めてから上げる。
 *
 * 【正しさの判定をしない】
 *   語が何件か・有効な語か・分類の上限を超えていないか・登録済みか・
 *   画像の置き場所が本人の領域かは、すべて DB 側が持っている。
 *   ここでの早い確認は、無駄なアップロードを避けるためだけのもの。
 */

const PAGE = "/works/import";

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

function orNull(value: string): string | null {
  return value === "" ? null : value;
}

/** 投稿画面へ戻る。理由は URL に載せる */
function backWithError(message: string): never {
  redirect(`${PAGE}?${new URLSearchParams({ error: message }).toString()}`);
}

/**
 * "12,44,90" を数のならびに直す。
 *
 * **並びを保つ。**この順がそのままお題の並び（slot_order）になる。
 * 数でないものが混ざっていたら、その時点で捨てずに空にする。
 * 一部だけ通すと、作者が選んだものと違うお題ができる。
 */
function parseTagIds(raw: string): number[] {
  if (raw === "") return [];
  const parts = raw.split(",").map((s) => Number.parseInt(s.trim(), 10));
  return parts.some((n) => !Number.isFinite(n)) ? [] : parts;
}

export async function createArtFirstWorkAction(form: FormData): Promise<void> {
  const division = str(form, "division") as Division;
  const isPublished = str(form, "saveAs") !== "draft";
  const tagIds = parseTagIds(str(form, "tagIds"));

  // --- 1. 誰が投稿しようとしているか -----------------------------------------
  const user = await getCurrentUser();

  if (!user) {
    redirect("/account?error=" + encodeURIComponent("作品の投稿にはサインインが必要です。"));
  }
  if (user.is_anonymous) {
    redirect(
      "/account?error=" +
        encodeURIComponent("作品の投稿にはアカウント登録が必要です。"),
    );
  }

  // 【1-b は無くなった】規約への同意は登録のときに済ませる（P5）。
  //   works の門番が未同意の INSERT を断るので、受け口の守りは変わらない。

  // --- 2. 語が選ばれているか ---------------------------------------------------
  //
  // 件数の上下限は DB が持っている。ここで見るのは「1件も無い」だけ。
  // 数を書き写すと、DB 側の範囲を変えたときにここだけ古くなる。
  if (tagIds.length === 0) {
    backWithError("この絵で試したい項目を選んでください。");
  }

  // --- 3. 画像を読む -----------------------------------------------------------
  const file = form.get("image");

  if (!(file instanceof File) || file.size === 0) {
    backWithError("画像を選んでください。");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    backWithError(
      `画像は5MBまでです（選ばれたファイルは ${(file.size / 1024 / 1024).toFixed(1)}MB）。`,
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const info = readImageInfo(bytes);

  if (!info) {
    backWithError("この画像は扱えません。JPEG / PNG / WebP を選んでください。");
  }

  // --- 4. 置き場所を決めてアップロードする -------------------------------------
  const workId = crypto.randomUUID();
  const imagePath = `${user.id}/${workId}.${info.ext}`;

  try {
    await uploadWorkImage(imagePath, bytes, info);
  } catch (e) {
    backWithError(e instanceof Error ? e.message : String(e));
  }

  // --- 5. お題と作品を1回で作る。失敗したら画像を消す（R10）--------------------
  try {
    await callCreateArtFirstWork({
      workId,
      tagIds,
      title: str(form, "title"),
      imagePath,
      imageWidth: info.width,
      imageHeight: info.height,
      division,
      sourceTitle: orNull(str(form, "sourceTitle")),
      sourceCharacter: orNull(str(form, "sourceCharacter")),
      fanartNote: orNull(str(form, "fanartNote")),
      isPublished,
    });
  } catch (e) {
    await removeWorkImage(imagePath);
    backWithError(e instanceof Error ? e.message : String(e));
  }

  // --- 6. 完成度を入れる（D135）------------------------------------------------
  //
  // **失敗しても投稿は取り消さない。**作品はもう存在する。
  // 既定の「仕上げ」のまま残るほうが害が小さい（/works/new と同じ扱い）。
  const completeness = str(form, "completeness");

  if (completeness !== "" && completeness !== DEFAULT_COMPLETENESS) {
    try {
      await callSetCompleteness(workId, completeness);
    } catch {
      // 握りつぶす。利用者に見せる失敗ではない（D89）
    }
  }

  revalidatePath("/works");
  redirect(`/works/${workId}`);
}
