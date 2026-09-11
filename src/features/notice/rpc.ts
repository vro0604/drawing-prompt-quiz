import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readableRpcError } from "@/features/draft/rpc";
import {
  UNSEEN_LIST_LIMIT,
  type UnseenResultWork,
} from "@/features/notice/types";
import { hasUnseenResults } from "@/features/notice/unseen";

/**
 * 回答の知らせの DB 呼び出し。サーバー専用。
 *
 * 3本とも authenticated だけが呼べる（migration 側で配り直している。DB 検査 A44）。
 * 未サインインで呼ぶと、DB は null も false も返さず、権限なしで断る。
 * 全ページで呼ぶ has_unseen_results だけは、ここで未サインインを見分けて
 * DB に聞かずに false を返す（unseen.ts）。
 */

/**
 * 自分の作品に未確認の回答があるか。
 *
 * ヘッダーは全ページに出るので、ここが重いと全体が重くなる。
 * だから**真偽値だけ**を聞く。件数も一覧も取らない。
 * 未サインインなら DB に聞かない。失敗しても投げない（どちらも unseen.ts）。
 */
export async function fetchHasUnseenResults(): Promise<boolean> {
  try {
    const supabase = await createSupabaseServerClient();
    return await hasUnseenResults({
      getSession: () => supabase.auth.getSession(),
      rpc: (fn) => supabase.rpc(fn),
    });
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
