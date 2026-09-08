import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readableRpcError } from "@/features/draft/rpc";
import type { ArtFirstVocabulary } from "@/features/artfirst/types";
import type { Division, WorkWriteResult } from "@/features/work/types";

/**
 * 持ち込みの DB 呼び出し。サーバー専用。
 *
 * 【2本しかない】
 *   選べる語を読む1本と、投稿する1本。投稿より後ろ（出題・回答・採点・集計・
 *   開示）は既存の関数がそのまま動くので、ここには何も無い。
 */

/**
 * 選べる語の一覧。
 *
 * **語そのものは誰でも読めるもの**（tags の id / pool_key / label）だが、
 * 分類との対応は tags からは辿れないので、DB 側で結んで返してもらう。
 * 未サインインでは呼べない（authenticated にだけ EXECUTE がある）。
 */
export async function fetchArtFirstVocabulary(): Promise<ArtFirstVocabulary> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_art_first_vocabulary");

  if (error) throw new Error(readableRpcError(error.message));
  return data as ArtFirstVocabulary;
}

/** create_art_first_work に渡す一式 */
export type CreateArtFirstWorkInput = {
  workId: string;
  /** 作者が選んだ語。3〜6件。**この並びがそのままお題の並びになる** */
  tagIds: number[];
  title: string;
  imagePath: string;
  imageWidth: number;
  imageHeight: number;
  division: Division;
  sourceTitle: string | null;
  sourceCharacter: string | null;
  fanartNote: string | null;
  isPublished: boolean;
};

/**
 * 持ち込みの作品を投稿する。
 *
 * **お題相当の行・答えのカード・出題・作品が、この1回で全部できる。**
 * 途中で失敗すれば1つも残らない（DB 側が1つのトランザクションで通す）。
 * 語の検査も投稿の検査も DB 側にあり、ここでは並べ替えるだけ。
 */
export async function callCreateArtFirstWork(
  input: CreateArtFirstWorkInput,
): Promise<WorkWriteResult & { question_count: number }> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_art_first_work", {
    p_work_id: input.workId,
    p_tag_ids: input.tagIds,
    p_title: input.title,
    p_image_path: input.imagePath,
    p_image_width: input.imageWidth,
    p_image_height: input.imageHeight,
    p_division: input.division,
    p_source_title: input.sourceTitle,
    p_source_character: input.sourceCharacter,
    p_fanart_note: input.fanartNote,
    p_actual_time_seconds: null,
    p_is_published: input.isPublished,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return data as WorkWriteResult & { question_count: number };
}
