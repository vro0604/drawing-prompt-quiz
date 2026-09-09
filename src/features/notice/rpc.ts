import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readableRpcError } from "@/features/draft/rpc";
import {
  UNSEEN_LIST_LIMIT,
  type UnseenResultWork,
} from "@/features/notice/types";

/**
 * 回答の知らせの DB 呼び出し。サーバー専用。
 *
 * 3本とも authenticated だけが呼べる（migration 側で配り直している）。
 * 未サインインで呼んでも DB が null / 空を返すので、
 * 画面側で「誰か」を判定してから呼ぶ必要はない。
 */

/**
 * 自分の作品に未確認の回答があるか。
 *
 * ヘッダーは全ページに出るので、ここが重いと全体が重くなる。
 * だから**真偽値だけ**を聞く。件数も一覧も取らない。
 *
 * 失敗しても投げない。知らせが出ないだけで、
 * 作品を見ることも描くこともできる。
 * **枠の付随機能のために、全ページが落ちる形にしない。**
 */
export async function fetchHasUnseenResults(): Promise<boolean> {
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("has_unseen_results");
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

/**
 * 未確認の回答がある自分の作品の一覧。
 *
 * 作品ごとに1行。回答1件ごとの行にはしない。
 * 出所: ユーザー指示（2026-09-10）「未確認回答の存在する『作品』を
 * 一覧にする。回答1件を通知1件として並べない。」
 */
export async function fetchUnseenResultWorks(): Promise<UnseenResultWork[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_unseen_result_works", {
    p_limit: UNSEEN_LIST_LIMIT,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as UnseenResultWork[] | null) ?? [];
}
