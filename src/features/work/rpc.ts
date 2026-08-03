import { SUPABASE_URL } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readableRpcError } from "@/features/draft/rpc";
import {
  WORKS_BUCKET,
  type Division,
  type MyWork,
  type WorkDetail,
  type WorkWriteResult,
} from "@/features/work/types";
import type { ImageInfo } from "@/features/work/image";

/**
 * 作品まわりの DB / Storage 呼び出し。サーバー専用。
 *
 * works には誰も直接触れない（テーブル権限が無い）。
 * 読むのも書くのも、ここに並ぶ RPC を通したときだけ（D20 / D35）。
 *
 * エラー文の整形（'CODE: 日本語' から日本語だけ取り出す）は
 * ドラフト側と同じ readableRpcError を使い回す。
 */

/**
 * 公開作品1件。公開条件を満たさなければ null。
 *
 * 【non-null が返る条件】is_published かつ review_status='ok' かつ 未削除。
 * 非公開・他人の下書き・削除済みはすべて null になる（get_work_detail 側の where）。
 * 「権限がありません」ではなく null なのは、その作品の存在自体を
 * 教えないため（D40）。
 */
export async function fetchWorkDetail(workId: string): Promise<WorkDetail | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_work_detail", { p_work_id: workId });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as WorkDetail | null) ?? null;
}

/**
 * 自分の作品1件。**下書き・審査中・削除済みも返る唯一の経路**。
 *
 * 他人の作品IDを渡すと null。存在しないIDと区別がつかない。
 * 未サインイン（anon）はそもそもこの関数を呼べない（permission denied）ので、
 * 呼ぶ前にサインイン済みか確かめること。
 */
export async function fetchMyWork(workId: string): Promise<MyWork | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_my_work", { p_work_id: workId });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as MyWork | null) ?? null;
}

/** create_work に渡す一式 */
export type CreateWorkInput = {
  workId: string;
  promptId: string;
  title: string;
  imagePath: string;
  imageWidth: number;
  imageHeight: number;
  division: Division;
  sourceTitle: string | null;
  sourceCharacter: string | null;
  fanartNote: string | null;
  actualTimeSeconds: number | null;
  isPublished: boolean;
};

/**
 * 作品を作る。D27 の6検査は**すべて DB 側**にある。
 * ここでやるのは引数を並べ替えることだけで、正しさの判定はしない。
 */
export async function callCreateWork(input: CreateWorkInput): Promise<WorkWriteResult> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_work", {
    p_work_id: input.workId,
    p_prompt_id: input.promptId,
    p_title: input.title,
    p_image_path: input.imagePath,
    p_image_width: input.imageWidth,
    p_image_height: input.imageHeight,
    p_division: input.division,
    p_source_title: input.sourceTitle,
    p_source_character: input.sourceCharacter,
    p_fanart_note: input.fanartNote,
    p_actual_time_seconds: input.actualTimeSeconds,
    p_is_published: input.isPublished,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return data as WorkWriteResult;
}

/** 下書きを公開する（update_work のうち、画面から使うのはこれだけ） */
export async function callPublishWork(workId: string): Promise<WorkWriteResult> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_work", {
    p_work_id: workId,
    p_is_published: true,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return data as WorkWriteResult;
}

/** 公開済みの作品を下書きへ戻す */
export async function callUnpublishWork(workId: string): Promise<WorkWriteResult> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_work", {
    p_work_id: workId,
    p_is_published: false,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return data as WorkWriteResult;
}

/**
 * 画像を Storage へ置く。パスは spec 8-6 の {user_id}/{work_id}.{ext}。
 *
 * **upsert は使わない。** 同じパスに既に何かあるなら、それは
 * 作品IDの衝突か作り直しなので、黙って上書きせず失敗させる。
 */
export async function uploadWorkImage(
  path: string,
  bytes: Uint8Array,
  info: ImageInfo,
): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.storage
    .from(WORKS_BUCKET)
    .upload(path, bytes, { contentType: info.mime, upsert: false });

  if (error) throw new Error(`画像をアップロードできませんでした: ${error.message}`);
}

/**
 * 置いた画像を消す。作品の作成に失敗したときの後始末（R10）。
 *
 * **ここでは例外を投げない。** 呼ばれるのは既に別の失敗を処理している
 * 最中なので、掃除の失敗で元の原因を隠してしまわないようにする。
 * 消し損ねると孤児ファイルが残るが、それは容量の問題であって
 * 利用者に見える不具合ではない。
 */
export async function removeWorkImage(path: string): Promise<void> {
  try {
    const supabase = await createSupabaseServerClient();
    await supabase.storage.from(WORKS_BUCKET).remove([path]);
  } catch {
    // 後始末の失敗は握りつぶす（上記の理由）
  }
}

/**
 * 画像の公開URL。バケットが public なので署名は要らない。
 *
 * クライアントを作らずに組み立てているのは、この関数を
 * Server Component の描画中に何度も呼ぶため（毎回 Cookie を読む必要がない）。
 */
export function workImageUrl(imagePath: string): string {
  return `${SUPABASE_URL}/storage/v1/object/public/${WORKS_BUCKET}/${imagePath}`;
}
