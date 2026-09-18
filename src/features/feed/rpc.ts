import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readableRpcError } from "@/features/draft/rpc";
import type { FeedWorkItem } from "@/features/feed/types";

/**
 * 作品一覧まわりの DB 呼び出し。サーバー専用。
 *
 * **既存の fetchPublicWorks は消していない。** 呼ぶ先が
 * get_public_works から get_feed_works に変わっただけで、
 * 旧い関数も旧い入口も残っている（本番でDBを先に更新するため）。
 */

/**
 * 一覧の1ページ。未サインインでも呼べる。
 *
 * 【「興味なし」は DB 側で外れる】
 *   取ってから画面で捨てると、1ページの件数がばらつく。
 *   部門・完成度・未回答のみと同じ理由で、数える前に外す。
 */
export async function fetchFeedWorks(params: {
  division: string | null;
  sort: string;
  limit: number;
  offset: number;
  completeness?: string | null;
  unansweredOnly?: boolean;
}): Promise<FeedWorkItem[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_feed_works", {
    p_division: params.division,
    p_sort: params.sort,
    p_limit: params.limit,
    p_offset: params.offset,
    p_completeness: params.completeness ?? null,
    p_unanswered_only: params.unansweredOnly ?? false,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return (data ?? []) as FeedWorkItem[];
}

/**
 * 公開作品が何件あるか。
 *
 * **絞り込みの結果として0件なのか、本当に1件も無いのかを分けるため**だけに使う。
 * 本当に1件も無いときだけ、画面は見本のカードを並べる（0件＝見本10枚）。
 *
 * 読めなかったときは -1 を返す。0 を返すと、読めなかっただけで
 * 見本が出てしまう（作品があるのに「まだありません」と書くことになる）。
 */
export async function countPublicWorks(): Promise<number> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("count_public_works");

  if (error) return -1;
  return typeof data === "number" ? data : -1;
}

/** 「興味なし」を付ける／外す。押すたびの入れ替えではなく、どちらにするかを渡す */
export async function callSetWorkUninterest(
  workId: string,
  uninterested: boolean,
): Promise<{ work_id: string; uninterested: boolean; applied: boolean }> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_work_uninterest", {
    p_work_id: workId,
    p_uninterested: uninterested,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return data as { work_id: string; uninterested: boolean; applied: boolean };
}
