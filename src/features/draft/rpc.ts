import { createSupabaseServerClient } from "@/lib/supabase/server";
import type {
  CompletedDraft,
  DraftMode,
  DraftState,
  PromptDetail,
} from "@/features/draft/types";

/**
 * ドラフト関連の DB 呼び出しをまとめる。サーバー専用。
 *
 * 画面から直接テーブルを触らないのは、そもそも触れないから。
 * draft_candidates / prompt_cards などは権限を与えていないので、
 * 取り出せるのはここに並ぶ RPC を通したときだけ（D20 / D35）。
 *
 * 【エラーの扱い】
 *   DB 側の関数は 'NOT_ENOUGH_TAGS: タグが足りません' のように
 *   「英大文字のコード: 日本語の説明」という形で例外を投げる。
 *   画面に出すのは日本語の部分だけにしたいので、ここで切り分ける。
 */

/** RPC が投げたエラーから、画面に出す日本語部分を取り出す */
export function readableRpcError(message: string): string {
  // [\s\S] を使うのは、複数行のメッセージでも最後まで取るため
  // （. は既定で改行に当たらない。s フラグは tsconfig の target が古いと使えない）
  const m = /^[A-Z_]+:\s*([\s\S]+)$/.exec(message.trim());
  return m ? m[1] : message;
}

/** モード一覧。未サインインでも読める（公開マスタ） */
export async function fetchDraftModes(): Promise<DraftMode[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("draft_modes")
    // select * は使えない。列権限を絞ってあるため（D30）
    .select("mode_key, label, candidate_count, max_rerolls, quiz_question_count, sort_order")
    .order("sort_order");

  if (error) throw new Error(`モード一覧を取得できませんでした: ${error.message}`);
  return (data ?? []) as DraftMode[];
}

/**
 * 進行中のドラフト。無ければ null。
 *
 * この RPC は authenticated だけが呼べる。未サインイン（anon）が呼ぶと
 * permission denied になるため、呼ぶ前にサインイン済みか確かめること。
 */
export async function fetchCurrentDraft(): Promise<DraftState | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_current_draft");

  if (error) throw new Error(readableRpcError(error.message));
  return (data as DraftState | null) ?? null;
}

export async function callStartDraft(
  modeKey: string,
  timeLimitSeconds: number | null,
): Promise<DraftState> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("start_draft", {
    p_mode_key: modeKey,
    p_time_limit_seconds: timeLimitSeconds,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return data as DraftState;
}

export async function callRevealCard(
  sessionId: string,
  cardSlotKey: string,
  candidateIndex: number,
): Promise<DraftState> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("reveal_card", {
    p_session_id: sessionId,
    p_card_slot_key: cardSlotKey,
    p_candidate_index: candidateIndex,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return data as DraftState;
}

export async function callRerollDraft(sessionId: string): Promise<DraftState> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("reroll_draft", { p_session_id: sessionId });

  if (error) throw new Error(readableRpcError(error.message));
  return data as DraftState;
}

export async function callCompleteDraft(sessionId: string): Promise<CompletedDraft> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("complete_draft", { p_session_id: sessionId });

  if (error) throw new Error(readableRpcError(error.message));
  return data as CompletedDraft;
}

export async function callAbandonDraft(sessionId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("abandon_draft", { p_session_id: sessionId });

  if (error) throw new Error(readableRpcError(error.message));
}

/**
 * 確定したお題1件。**答えのカードを外へ出す唯一の経路**（作成者本人のみ）。
 * 他人のIDや存在しないIDには null が返る（D40）。
 */
export async function fetchMyPrompt(promptId: string): Promise<PromptDetail | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_my_prompt", { p_prompt_id: promptId });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as PromptDetail | null) ?? null;
}
