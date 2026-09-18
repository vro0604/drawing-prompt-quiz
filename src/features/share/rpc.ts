import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readableRpcError } from "@/features/draft/rpc";
import type {
  ShareCardSource,
  ShareChannel,
  ShareCreated,
  ShareEventKey,
} from "@/features/share/types";

/**
 * 共有まわりの DB 呼び出し。サーバー専用。
 *
 * 【ここに判定を書かない】
 *   「共有してよいか」「カードを出してよいか」は、どれも DB 側の関数が
 *   works の3条件（公開・審査OK・未削除）で決める。
 *   このファイルは呼ぶだけで、条件を1つも持たない。
 *   持たせると、判定する場所が2つになる。
 *
 * 【お題の答えは通らない】
 *   get_share_card は quiz_choices にも prompt_cards にも触れない
 *   （移行ファイルの 9-7 が関数の定義文を読んで確かめている）。
 */

/**
 * カードを描くための材料。
 *
 * 共有IDを渡したときは、その共有をした時点の中身が返る。
 * ただし公開されているかどうかは、必ずいまの状態で判定される
 * （非公開になっていれば state が 'unavailable' になる）。
 */
export async function fetchShareCard(
  workId: string,
  questionId: number | null,
  shareId: string | null,
): Promise<ShareCardSource> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_share_card", {
    p_work_id: workId,
    p_question_id: questionId,
    p_share_id: shareId,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as ShareCardSource | null) ?? { state: "unavailable" };
}

/**
 * 共有を1件記録して shareId を確定させる。
 *
 * 【呼ばれるのは共有を実行した瞬間だけ】
 *   面を開いた・問いを選び直した・下見の絵ができた、では呼ばない
 *   （利用者の指示 14）。呼ぶ場所は works/[id]/share-actions.ts の1本。
 *
 * 【shareId をブラウザから受け取る】
 *   ブラウザの共有機能とコピーは、押した操作の中でその場で呼ばないと
 *   断られる。サーバーの返事を待つとその条件を外れるので、
 *   押した瞬間にブラウザ側で作った id をここへ送り、記録を追いかけさせる。
 *   **id は見る権利ではない**ので、外から作られても見えるものは増えない。
 */
export async function callCreateShare(
  workId: string,
  questionId: number | null,
  channel: ShareChannel,
  shareId: string | null,
): Promise<ShareCreated> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_share", {
    p_work_id: workId,
    p_question_id: questionId,
    p_channel: channel,
    p_share_id: shareId,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return data as ShareCreated;
}

/**
 * 共有の道すじを記録する。**失敗しても呼び出し元の操作を止めない。**
 *
 * 計測が落ちたせいで共有や画面遷移が失敗するのは順序が逆
 * （features/discover/rpc.ts の recordUsageEvent と同じ考え方）。
 */
export async function recordShareEvent(
  eventKey: ShareEventKey,
  args: {
    workId?: string | null;
    questionId?: number | null;
    shareId?: string | null;
    channel?: ShareChannel | null;
  } = {},
): Promise<void> {
  try {
    const supabase = await createSupabaseServerClient();
    await supabase.rpc("record_share_event", {
      p_event_key: eventKey,
      p_work_id: args.workId ?? null,
      p_question_id: args.questionId ?? null,
      p_share_id: args.shareId ?? null,
      p_channel: args.channel ?? null,
    });
  } catch {
    // 握りつぶす。利用者に見せる失敗ではない
  }
}
