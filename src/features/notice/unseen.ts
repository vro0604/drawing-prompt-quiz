/**
 * 自分の作品に未確認の回答があるかを決める手順（D192）。
 *
 * 【なぜ別のファイルか】
 *   Next.js にも Supabase にもつながない形で置き、単体試験（test:unit）から
 *   偽の相手を渡して直接呼べるようにするため。本番の呼び出しは rpc.ts から。
 *
 * 【未サインインなら DB に聞かない】
 *   has_unseen_results は authenticated にだけ配ってある（anon には配らない。
 *   DB 検査 A44）。未サインインで呼ぶと DB は false を返さず、権限なしで断る。
 *   2026-09-11 の本番で、未サインインのページ表示のたびに 401 が出ていた。
 *   だから、ここでセッションの有無を見て、無ければ呼ばずに false を返す。
 *
 * 【セッションの有無は getSession() で見る】
 *   getSession() は Cookie を読むだけで、Supabase へ問い合わせない。
 *   この判定のためだけに往復を増やさない。Cookie の検証と更新は、同じ要求の
 *   手前で proxy.ts が getUser() で済ませている。
 *   Cookie を偽っても、ここで分かれるのは「DB に聞くかどうか」だけで、
 *   聞いた先の判定は DB が券を検証して行う。偽の Cookie で見えるものは増えない。
 *
 * 【失敗しても投げない】
 *   知らせが出ないだけで、作品を見ることも描くこともできる。
 *   枠の付随機能のために、全ページが落ちる形にしない。
 */

export type UnseenClient = {
  getSession: () => Promise<{ data: { session: unknown } }>;
  rpc: (fn: "has_unseen_results") => PromiseLike<{ data: unknown; error: unknown }>;
};

export async function hasUnseenResults(client: UnseenClient): Promise<boolean> {
  try {
    const { data } = await client.getSession();
    if (!data.session) return false;

    const { data: value, error } = await client.rpc("has_unseen_results");
    if (error) return false;
    return value === true;
  } catch {
    return false;
  }
}
