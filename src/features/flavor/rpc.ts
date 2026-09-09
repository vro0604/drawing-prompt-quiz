import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readableRpcError } from "@/features/draft/rpc";
import { isUuid } from "@/lib/uuid";
import type {
  FlavorReply,
  FlavorReplyToken,
  FlavorVocabItem,
  FlavorVocabSet,
  WorkFlavor,
  WorkHintResult,
} from "@/features/flavor/types";

/**
 * フレーバーテキスト（D162）の DB 呼び出し。サーバー専用。
 *
 * 【この画面まわりで正解が漏れうる場所は2つある】
 *   1. 回答前のヒント本文  … 近すぎる語を最初から選ばせない（DB 側の4段の関門）
 *   2. 返歌               … 正解の語をそのまま含みうる
 *
 *   2 のほうが見落としやすい。返歌を誰でも読めるようにすると、
 *   未回答の人が返歌から正解を読める。だから
 *   **返歌を読めるのは「作者」と「その作品に回答済みの人」だけ**にしてある。
 *   判定は DB の get_flavor_replies が持つ。ここでは判定しない。
 *
 * 【未サインインのときは問い合わせない】
 *   フレーバー系の RPC は authenticated だけが呼べる。
 *   anon のまま呼ぶと permission denied で画面が 500 になる（D90 と同じ形）。
 */

/** サインイン済みか。ゲストかどうかまでは見ない（見るのは呼び出し側） */
async function signedIn() {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  return { supabase, user: data.user };
}

/** 作者が自作の文章に使える語の一覧。作者以外・ゲストには null */
export async function fetchFlavorVocab(workId: string): Promise<FlavorVocabSet | null> {
  if (!isUuid(workId)) return null;

  const { supabase, user } = await signedIn();
  if (!user || user.is_anonymous) return null;

  const { data, error } = await supabase.rpc("get_flavor_vocab", { p_work_id: workId });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as FlavorVocabSet | null) ?? null;
}

/**
 * 作者の文章を保存する。近すぎる語が混じっていれば DB 側が断る。
 *
 * breaks は「この位置の語のあとで文が終わる」。**位置は0から数える。**
 * 最後の語に付いた印と、上限を超えた分は DB 側が落とす。
 */
export async function callSetFlavorText(
  workId: string,
  vocabIds: number[],
  breaks: number[] = [],
): Promise<WorkFlavor | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_flavor_text", {
    p_work_id: workId,
    p_vocab_ids: vocabIds,
    p_breaks: breaks,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as WorkFlavor | null) ?? null;
}

/**
 * フレーバーテキストを読む。
 *
 * 返るのは、作者・回答済みの登録者・ヒントを開いた登録者だけ。
 * それ以外には null。ゲストにも null（D164）。
 */
export async function fetchWorkFlavor(workId: string): Promise<WorkFlavor | null> {
  if (!isUuid(workId)) return null;

  const { supabase, user } = await signedIn();
  if (!user || user.is_anonymous) return null;

  const { data, error } = await supabase.rpc("get_work_flavor", { p_work_id: workId });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as WorkFlavor | null) ?? null;
}

/**
 * 回答前にヒントとして開く。**開いた事実がサーバーに残る。**
 *
 * 残すのは減点のためではなく、作者が
 * 「絵だけで伝わった割合」と「文章を添えて伝わった割合」を
 * 分けて見られるようにするため（D162）。
 */
export async function callOpenFlavorHint(workId: string): Promise<WorkFlavor | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("open_flavor_hint", { p_work_id: workId });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as WorkFlavor | null) ?? null;
}

/** 返歌の一覧。作者と回答済みの人にしか返らない */
export async function fetchFlavorReplies(workId: string): Promise<FlavorReply[]> {
  if (!isUuid(workId)) return [];

  const { supabase, user } = await signedIn();
  if (!user || user.is_anonymous) return [];

  const { data, error } = await supabase.rpc("get_flavor_replies", { p_work_id: workId });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as FlavorReply[] | null) ?? [];
}

/**
 * 返歌で使えるつなぎの語。
 *
 * 作者向けの一覧と違い、お題による絞り込みが無い。
 * 返歌は回答後なので、隠すものがもう無いため。
 * 正解の語そのものはこの一覧に入らない（お題のカードから選ぶ）。
 */
export async function fetchReplyVocab(): Promise<FlavorVocabItem[]> {
  const { supabase, user } = await signedIn();
  if (!user || user.is_anonymous) return [];

  const { data, error } = await supabase.rpc("get_reply_vocab");

  if (error) throw new Error(readableRpcError(error.message));
  return (data as FlavorVocabItem[] | null) ?? [];
}

/** 返歌を送る。正誤判定は無い（D162） */
export async function callPostFlavorReply(
  workId: string,
  tokens: FlavorReplyToken[],
): Promise<FlavorReply[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("post_flavor_reply", {
    p_work_id: workId,
    p_tokens: tokens,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as FlavorReply[] | null) ?? [];
}

/**
 * その作品に文章があるかだけを見る。
 *
 * **本文は返らない。**回答前の画面に「ヒントを開く」を出すかどうかの判断だけに使う。
 * 本文を返す fetchWorkFlavor は、まだ開いていない人には null を返すので、
 * 「文章が無い」のか「まだ開いていない」のかを区別できない。
 */
export async function fetchWorkHasFlavor(workId: string): Promise<boolean> {
  if (!isUuid(workId)) return false;

  const { supabase, user } = await signedIn();
  if (!user || user.is_anonymous) return false;

  const { data, error } = await supabase.rpc("work_has_flavor", { p_work_id: workId });

  if (error) throw new Error(readableRpcError(error.message));
  return data === true;
}

/** ヒント使用別の集計。作者だけに返る */
export async function fetchWorkHintResult(workId: string): Promise<WorkHintResult | null> {
  if (!isUuid(workId)) return null;

  const { supabase, user } = await signedIn();
  if (!user) return null;

  const { data, error } = await supabase.rpc("get_my_work_hint_result", {
    p_work_id: workId,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as WorkHintResult | null) ?? null;
}
