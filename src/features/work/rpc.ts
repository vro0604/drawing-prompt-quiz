import { SUPABASE_URL } from "@/lib/env";
import { isUuid } from "@/lib/uuid";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readableRpcError } from "@/features/draft/rpc";
import {
  WORKS_BUCKET,
  type Division,
  type MyWork,
  type MyWorkResult,
  type ProductionTime,
  type PublicWorkListItem,
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
 * 公開作品の一覧。誰でも（未サインインでも）呼べる。
 *
 * **division に null を渡すと AI 部門は返らない**（通常フィード）。
 * AI を見せる画面では 'ai' を明示する。この分岐は SQL 側にあり、
 * 画面で取ったあとに捨てる形にはしていない。捨てると1ページの件数が
 * ばらつき、ページ送りの位置もずれるため。
 */
export async function fetchPublicWorks(params: {
  division: string | null;
  sort: string;
  limit: number;
  offset: number;
  completeness?: string | null;
  /**
   * 自分が回答済みの作品を外すか（D169 の11）。
   *
   * **見ているのは回答の行だけ。**作品を開いただけでは外れない。
   * 誰なのか分からない状態（サインインも匿名の発行もされていない）では
   * 判定できないので、DB 側が絞り込まずに全件を返す。
   */
  unansweredOnly?: boolean;
}): Promise<PublicWorkListItem[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_public_works", {
    p_division: params.division,
    p_sort: params.sort,
    p_limit: params.limit,
    p_offset: params.offset,
    p_completeness: params.completeness ?? null,
    p_unanswered_only: params.unansweredOnly ?? false,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return (data ?? []) as PublicWorkListItem[];
}

/**
 * 公開作品1件。公開条件を満たさなければ null。
 *
 * 【non-null が返る条件】is_published かつ review_status='ok' かつ 未削除。
 * 非公開・他人の下書き・削除済みはすべて null になる（get_work_detail 側の where）。
 * 「権限がありません」ではなく null なのは、その作品の存在自体を
 * 教えないため（D40）。
 */
export async function fetchWorkDetail(workId: string): Promise<WorkDetail | null> {
  // 形が違うIDは DB へ渡さない。渡すと 500 になる（本来は 404）
  if (!isUuid(workId)) return null;

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
  if (!isUuid(workId)) return null;

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

/**
 * 完成度を設定する（D135）。
 *
 * **create_work には足さなかった。**引数を1つ増やすと 12引数版と 13引数版が
 * 並び、既存の呼び出しがどちらにも当てはまって Postgres が断る。
 * 12引数版を drop して本体を書き写すと、D27 の6検査が二重になって
 * **片方だけ直る事故**が起きる。だから作ったあとで、これを呼ぶ。
 *
 * 失敗しても作品は既定の 'finished' で残る。落書きが仕上げとして
 * 並ぶだけなので、**壊れかたが軽い。**
 */
export async function callSetCompleteness(
  workId: string,
  completeness: string,
): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("update_work_completeness", {
    p_work_id: workId,
    p_completeness: completeness,
  });

  if (error) throw new Error(readableRpcError(error.message));
}

/**
 * 自分の作品の結果。他人の作品・未サインインなら null。
 *
 * **null と「まだ誰も答えていない」は違う。**前者は見る権利が無い、
 * 後者は answers_count が 0。画面はこの2つを別に扱う。
 */
export async function fetchMyWorkResult(workId: string): Promise<MyWorkResult | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_my_work_result", {
    p_work_id: workId,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as MyWorkResult | null) ?? null;
}

/**
 * 自分の作品の結果を**開く。**返るものは上の fetchMyWorkResult と同じ。
 *
 * 違いは1つだけで、こちらは「最後に結果を開いた時刻」を記録する（D192）。
 * 記録すると、その時刻より前に来ていた回答は未確認でなくなり、
 * 知らせから消える。
 *
 * 【なぜ読むほうと分けるか】
 *   作品ページは、結果を閉じた状態でも開かれる。そこで記録すると、
 *   中身を見ていないのに確認したことになる。
 *   出所: ユーザー指示（2026-09-10）「単に通知一覧を開いただけでは
 *   確認済みにしない。作者本人が対象作品の結果を実際に開いた時点、
 *   すなわち既存の result=open の結果表示が成立した時点で
 *   『最後に結果を確認した時刻』を更新する。」
 *
 * 【見る権利の判定はここに無い】
 *   他人の作品を渡しても、DB 側が1行も更新せず null を返す。
 */
export async function openMyWorkResult(workId: string): Promise<MyWorkResult | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("open_my_work_result", {
    p_work_id: workId,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as MyWorkResult | null) ?? null;
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
 * いいねを付ける／外す。押すたびに入れ替わる。
 *
 * **登録ユーザーだけ**（D7 / spec 10）。ゲストが呼ぶと DB 側が断る。
 * 判定は偽造できない JWT だけを見ているので、ここで確かめる必要はない
 * （画面は、押す前に案内を出し分けるためだけに状態を見る）。
 */
export async function callToggleLike(
  workId: string,
): Promise<{ work_id: string; liked: boolean; likes_count: number }> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("toggle_like", { p_work_id: workId });

  if (error) throw new Error(readableRpcError(error.message));
  return data as { work_id: string; liked: boolean; likes_count: number };
}

/** 保存を付ける／外す。条件は toggle_like と同じ */
export async function callToggleSave(
  workId: string,
): Promise<{ work_id: string; saved: boolean; saves_count: number }> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("toggle_save", { p_work_id: workId });

  if (error) throw new Error(readableRpcError(error.message));
  return data as { work_id: string; saved: boolean; saves_count: number };
}

/** delete_work の戻り値。image_path は「これから消すべきファイル」 */
export type DeleteWorkResult = {
  work_id: string;
  image_path: string;
  deleted_at: string;
  /** すでに削除済みだった（今回の操作では何も変えていない） */
  already: boolean;
};

/**
 * 作品を削除する。**行は消さない**（論理削除）。
 *
 * DB がやるのは `is_published = false` と `deleted_at` を立てることだけで、
 * 画像ファイルには触れない。消すべきパスを受け取って、**そのあとに**
 * アプリ側が Storage から消す。
 *
 * 順序が逆だと、画像が消えたのに作品が公開されたままの時間が生まれる。
 * 画像の削除に失敗しても作品は削除済みのままで、公開へは戻らない
 * （update_work が deleted_at を見て断る）。
 */
export async function callDeleteWork(workId: string): Promise<DeleteWorkResult> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_work", { p_work_id: workId });

  if (error) throw new Error(readableRpcError(error.message));
  return data as DeleteWorkResult;
}

/**
 * 画像を Storage から消せたことを記録する。
 *
 * **失敗しても呼び出し側で握りつぶす。** 印が付かなくても作品は
 * 削除済みのままで、残るのは容量の問題だけ。Step 16 の掃除が
 * 「deleted_at はあるが image_deleted_at が無い」作品を拾って再試行する。
 */
export async function callMarkWorkImageDeleted(workId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("mark_work_image_deleted", {
    p_work_id: workId,
  });

  if (error) throw new Error(readableRpcError(error.message));
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
 * 置いた画像を消す。作品の作成に失敗したときの後始末（R10）と、
 * 作品の削除（Step 15）の両方で使う。
 *
 * **例外を投げず、消せたかどうかを返す。** 呼ばれるのは既に別の失敗を
 * 処理している最中か、DB 側の削除が済んだあとなので、掃除の失敗で
 * 元の処理を巻き戻したくない。
 *
 * **返り値は必ず見ること。** 消せていないのに「消した」と記録すると、
 * Step 16 の掃除が対象から外してしまい、消し残しが永久に残る。
 */
export async function removeWorkImage(path: string): Promise<boolean> {
  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.storage.from(WORKS_BUCKET).remove([path]);
    return !error;
  } catch {
    // 後始末の失敗は握りつぶす（上記の理由）
    return false;
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

/**
 * 制作時間の計測値を読む（2026-09-09）。
 *
 * 投稿画面がこれを表示するだけで、利用者は入力しない。
 * 読めなかったときは null を返す（画面は「読めませんでした」と出す）。
 */
export async function fetchProductionTime(promptId: string): Promise<ProductionTime | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_production_time", {
    p_prompt_id: promptId,
  });

  if (error) return null;
  return (data as ProductionTime | null) ?? null;
}
