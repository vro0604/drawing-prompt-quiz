"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/features/auth/session";
import { readImageInfo } from "@/features/work/image";
import {
  callCreateWork,
  callSetCompleteness,
  removeWorkImage,
  uploadWorkImage,
} from "@/features/work/rpc";
import {
  DEFAULT_COMPLETENESS,
  MAX_IMAGE_BYTES,
  type Division,
} from "@/features/work/types";
import { callAgreeToDocuments } from "@/features/account/rpc";

/**
 * 作品投稿の Server Action。
 *
 * 【この関数がやること】
 *   1. 画像を読み、種類と大きさを実物から数える
 *   2. Storage へ置く
 *   3. create_work を呼ぶ
 *   4. 失敗したら、置いた画像を消す（R10）
 *
 * 【この関数がやらないこと】
 *   **正しさの判定をしない。** 投稿者が登録済みか、お題の持ち主か、
 *   そのお題が使えるか、image_path が本人の領域かは、すべて
 *   create_work（D27 の6検査）と Storage のポリシーが持っている。
 *
 *   ここでの早めの確認は「無駄なアップロードを避ける」ためのもので、
 *   守りではない。Server Action は誰でも叩ける入口なので、
 *   ここを通り抜けても DB 側で必ず止まる。
 *
 * 【順番が大事：アップロード → INSERT（R10）】
 *   image_path は NOT NULL なので、行を作る前に置き場所が決まっている
 *   必要がある。そのため作品IDを先に決めてしまい、
 *     {user_id}/{work_id}.{ext} へ置く → create_work に同じIDを渡す
 *   という順にする。INSERT に失敗したら置いた画像を消して孤児を残さない。
 */

const PAGE = "/works/new";

/** FormData から必ず文字列を取り出す（無ければ空文字） */
function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

/** 空文字を null にする。DB 側は「未入力 = null」で受け取る */
function orNull(value: string): string | null {
  return value === "" ? null : value;
}

/** 投稿画面へ戻る。理由は URL に載せる（お題IDも保つ） */
function backWithError(promptId: string, message: string): never {
  const params = new URLSearchParams({ promptId, error: message });
  redirect(`${PAGE}?${params.toString()}`);
}

export async function createWorkAction(form: FormData): Promise<void> {
  const promptId = str(form, "promptId");
  const division = str(form, "division") as Division;

  // 「下書きとして保存」ボタンだけ value を持たせてある。
  // 押されなかったボタンの値は送られてこないので、無ければ公開。
  const isPublished = str(form, "saveAs") !== "draft";

  // --- 1. 誰が投稿しようとしているか -----------------------------------------
  //
  // ここで弾くのは、5MB の画像を上げてから DB に断られるのを避けるため。
  // 本当の判定は create_work の検査1（JWT の is_anonymous）。
  const user = await getCurrentUser();

  if (!user) {
    redirect("/account?error=" + encodeURIComponent("作品の投稿にはサインインが必要です。"));
  }
  if (user.is_anonymous) {
    redirect(
      "/account?error=" +
        encodeURIComponent(
          "作品の投稿にはアカウント登録が必要です。いまのゲストのまま登録すれば、引いたお題はそのまま引き継がれます。",
        ),
    );
  }

  // --- 1-b. 規約への同意 ------------------------------------------------------
  //
  // **画像を上げる前に済ませる。**あとにすると、同意で失敗したときに
  // 置いた画像を消す手間が増える。
  //
  // ここで通しても守りにはならない。works の門番が未同意の INSERT を
  // TERMS_NOT_AGREED で断るので、この画面を通らない投稿も止まる。
  if (str(form, "agreeDocs") === "on") {
    try {
      await callAgreeToDocuments(str(form, "termsVersion"), str(form, "privacyVersion"));
    } catch (e) {
      backWithError(promptId, e instanceof Error ? e.message : String(e));
    }
  }

  // --- 2. 画像を読む ----------------------------------------------------------
  const file = form.get("image");

  if (!(file instanceof File) || file.size === 0) {
    backWithError(promptId, "画像を選んでください。");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    backWithError(
      promptId,
      `画像は5MBまでです（選ばれたファイルは ${(file.size / 1024 / 1024).toFixed(1)}MB）。`,
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const info = readImageInfo(bytes);

  if (!info) {
    backWithError(promptId, "この画像は扱えません。JPEG / PNG / WebP を選んでください。");
  }

  // --- 3. 置き場所を決めてアップロードする ------------------------------------
  //
  // 作品IDをここで決めるのは、image_path にそのIDが入るため
  // （spec 8-6 のパス規約。create_work の検査6が完全一致を求める）。
  const workId = crypto.randomUUID();
  const imagePath = `${user.id}/${workId}.${info.ext}`;

  try {
    await uploadWorkImage(imagePath, bytes, info);
  } catch (e) {
    backWithError(promptId, e instanceof Error ? e.message : String(e));
  }

  // --- 4. 作品を作る。失敗したら画像を消す（R10）------------------------------
  try {
    await callCreateWork({
      workId,
      promptId,
      title: str(form, "title"),
      imagePath,
      imageWidth: info.width,
      imageHeight: info.height,
      division,
      sourceTitle: orNull(str(form, "sourceTitle")),
      sourceCharacter: orNull(str(form, "sourceCharacter")),
      fanartNote: orNull(str(form, "fanartNote")),
      actualTimeSeconds: parseSeconds(str(form, "actualTimeSeconds")),
      isPublished,
    });
  } catch (e) {
    await removeWorkImage(imagePath);
    backWithError(promptId, e instanceof Error ? e.message : String(e));
  }

  // --- 5. 完成度を入れる（D135）----------------------------------------------
  //
  // **失敗しても投稿は取り消さない。**
  // create_work は通っていて、作品はもう存在する。ここで巻き戻すと、
  // 画像も作品も消えて「投稿できなかった」ことになる。
  // 完成度が既定の「仕上げ」のまま残るほうが、はるかに害が小さい。
  // あとから作品ページで直せる（update_work_completeness）。
  const completeness = str(form, "completeness");

  if (completeness !== "" && completeness !== DEFAULT_COMPLETENESS) {
    try {
      await callSetCompleteness(workId, completeness);
    } catch {
      // 握りつぶす。利用者に見せる失敗ではない（D89）
    }
  }

  // redirect() は例外を投げて処理を打ち切るので try の外で呼ぶ。
  // try の中だと catch が拾ってしまい、移動が「失敗」に見える。
  revalidatePath(`/prompt/${promptId}`);
  redirect(`/works/${workId}`);
}

/** 実制作時間の入力を秒に直す。空・数字以外は「申告しない」扱い */
function parseSeconds(raw: string): number | null {
  if (raw === "") return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
