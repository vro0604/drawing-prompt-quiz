import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readableRpcError } from "@/features/draft/rpc";

/**
 * 回答したあとの行き先（次の作品）と、最小限の計測。
 *
 * 【なぜ「次の作品」がサーバー側の関数なのか】
 *   一覧に戻すと、答えたばかりの人が「まだ答えていない作品」を
 *   自分で探すところからやり直しになる。1件だけ返す関数にすれば、
 *   画面は行き先を1つ受け取って移動するだけで済む。
 *
 * 【何を計測するか】
 *   共有を押したことと、次の作品へ移ったこと。この2つだけ。
 *   回答・制作開始・持ち出しは、それぞれ行が増えるので既存の表から数えられる。
 *   **外部の解析サービスは1つも足していない。**
 */

/**
 * まだ回答していない公開作品を1件。無ければ null。
 *
 * 【部門はここでは決めない】
 *   渡すのは「いま答えた作品のID」だけ。次に出す作品の部門は、
 *   その作品の行から DB が読む（D169 の12）。
 *   **画面が部門を渡せる余地を残していない。**渡せると、その値を
 *   書き換えるだけで別の部門へ移れてしまう。
 *
 * 【どれが返るか】
 *   条件を満たす候補のうち、**回答0件の作品があればその中だけから**
 *   無作為に1件。0件の作品が無ければ、回答1件以上の中から無作為に1件。
 *   1回答の作品と10回答の作品に順位は付かない（D169 の3）。
 */
export async function fetchNextWorkId(
  currentWorkId: string | null,
): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_next_work", {
    p_current_work_id: currentWorkId,
  });

  if (error) throw new Error(readableRpcError(error.message));

  const row = data as { work_id: string | null; has_next: boolean } | null;
  return row?.work_id ?? null;
}

/**
 * 記録する。**失敗しても呼び出し元の操作を止めない。**
 *
 * 計測が落ちたせいで共有や画面遷移が失敗するのは、順序が逆。
 * 数えられなかったことは数の側の問題として扱う。
 */
export async function recordUsageEvent(
  eventKey: "share_opened" | "next_work_opened",
  workId: string | null,
): Promise<void> {
  try {
    const supabase = await createSupabaseServerClient();
    await supabase.rpc("record_usage_event", {
      p_event_key: eventKey,
      p_work_id: workId,
    });
  } catch {
    // 握りつぶす。利用者に見せる失敗ではない
  }
}
