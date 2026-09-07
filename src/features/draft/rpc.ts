import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/uuid";
import type {
  CompletedDraft,
  DraftMode,
  DraftState,
  PromptDetail,
  PromptTimer,
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

/**
 * 想定していない失敗を伝えるときの文言。
 *
 * **DB がそのまま返した文章を画面に出さないため**に要る。
 */
const UNEXPECTED = "うまく処理できませんでした。時間をおいてもう一度お試しください。";

/**
 * RPC が投げたエラーから、画面に出す日本語部分を取り出す。
 *
 * 【この形に当てはまらないものは、本番では中身を出さない】
 *   RPC はどれも入力を先に検査して 'CODE: 日本語' で断る。
 *   それでも素の Postgres エラーが出てくる場面が残る。たとえば
 *   投稿ボタンを二度続けて押したとき、両方が「まだ作品が無い」検査を
 *   通り抜けてから、あとの1件が一意索引に当たる（検査してから入れるまでの
 *   すき間）。このとき届くのは
 *     duplicate key value violates unique constraint "works_prompt_id_key"
 *   のような文章で、利用者には意味が通じないうえ、
 *   **表と制約の名前をそのまま外へ見せてしまう。**
 *
 *   なので本番では差し替える。開発では原文を残す
 *   （ここを伏せると、直すときに何が起きたのか分からなくなる）。
 */
/**
 * 日本語を持たないまま投げられる合図と、その言い換え。
 *
 * 【なぜ要るか】
 *   RPC の多くは 'CODE: 日本語' の形で断るが、**8つだけ合図だけを投げる。**
 *   `raise exception 'TERMS_NOT_AGREED'` のように英字しか無い。
 *   下の分解は当たらないので、本番ではまとめて
 *   「うまく処理できませんでした」に化けていた。
 *
 *   本番で実際に起きていたこと（実測: 2026-09-07 の本番スモーク）:
 *     ・退会の合言葉を打ち間違えた人 … 何が違うのか分からない文が出る
 *     ・退会した人の ID を取ろうとした人 … 同上
 *     ・規約に同意せずに投稿した人 … 同上
 *
 *   **利用者は入力を直しようがない。**開発では原文が出るので気づけなかった。
 *   合図ごとに1行の日本語を持たせて、本番でも理由が読めるようにする。
 *
 * 【DB を直さない理由】
 *   合図を投げているのは引き金（trigger）で、置き換えるには migration が要る。
 *   文言は画面の言葉なので、画面側に置いても意味は変わらない。
 *   **本番のDBへ当てる回数を増やさない**ほうが、切替の最中は安全。
 */
const BARE_CODES: Record<string, string> = {
  TERMS_NOT_AGREED:
    "利用規約とプライバシーポリシーへの同意が必要です。同意の欄にチェックを入れて、もう一度お試しください。",
  HANDLE_RETIRED:
    "その ID は以前ほかの方が使っていたため登録できません。別の ID をお選びください。",
  CONFIRM_MISMATCH:
    "入力が一致しません。画面に表示されている言葉をそのまま入力してください。",
  ANONYMOUS_NOT_ALLOWED:
    "ゲストのままでは、この操作はできません。アカウントを登録してからお試しください。",
  ALREADY_PENDING: "このアカウントはすでに退会の処理に入っています。",
  ACCOUNT_DELETION_PENDING:
    "このアカウントは退会の処理に入っているため、操作できません。",
  NOT_SIGNED_IN: "サインインし直してから、もう一度お試しください。",
  VERSION_MISMATCH:
    "表示していた規約が、その間に新しくなりました。画面を読み込み直して、新しい内容をご確認ください。",
};

export function readableRpcError(message: string): string {
  const trimmed = message.trim();

  // [\s\S] を使うのは、複数行のメッセージでも最後まで取るため
  // （. は既定で改行に当たらない。s フラグは tsconfig の target が古いと使えない）
  const m = /^[A-Z_]+:\s*([\s\S]+)$/.exec(trimmed);
  if (m) return m[1];

  // 合図だけが投げられた場合。**前後に何が付いていても拾う。**
  // Postgres は文脈（CONTEXT 行）を足して返すことがある。
  for (const [code, text] of Object.entries(BARE_CODES)) {
    if (new RegExp(`\\b${code}\\b`).test(trimmed)) return text;
  }

  return process.env.NODE_ENV === "production" ? UNEXPECTED : message;
}

/** モード一覧。未サインインでも読める（公開マスタ） */
export async function fetchDraftModes(): Promise<DraftMode[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("draft_modes")
    // select * は使えない。列権限を絞ってあるため（D30）
    .select("mode_key, label, candidate_count, max_rerolls, sort_order, uses_two_stage, word_count_min, word_count_max, morph_max")
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

/**
 * ドラフトを始める。
 *
 * carriedElementIds を渡すと、その要素が最初から埋まった状態で始まる（D161）。
 * 空配列と null は同じ扱い（何も持ち出さない）。
 * 持ち出しは登録者だけで、判定は start_draft が JWT で行う（D164）。
 */
export async function callStartDraft(
  modeKey: string,
  timeLimitSeconds: number | null,
  carriedElementIds: number[] = [],
): Promise<DraftState> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("start_draft", {
    p_mode_key: modeKey,
    p_time_limit_seconds: timeLimitSeconds,
    p_carried_element_ids: carriedElementIds.length > 0 ? carriedElementIds : null,
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

/**
 * めくったカードに決める（D170）。
 *
 * **めくることと決めることは別の操作。**めくっただけでは枠は進まない。
 * ここを呼んで初めて確定し、次の枠へ進む。二度呼んでも壊れない。
 */
export async function callChooseCard(
  sessionId: string,
  cardSlotKey: string,
  candidateIndex: number,
): Promise<DraftState> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("choose_card", {
    p_session_id: sessionId,
    p_card_slot_key: cardSlotKey,
    p_candidate_index: candidateIndex,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return data as DraftState;
}

/** 枠の中で候補を残す／外す（D170）。上限は min(2, 候補数 - 1) */
export async function callHoldCard(
  sessionId: string,
  cardSlotKey: string,
  candidateIndex: number,
  hold: boolean,
): Promise<DraftState> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("hold_card", {
    p_session_id: sessionId,
    p_card_slot_key: cardSlotKey,
    p_candidate_index: candidateIndex,
    p_hold: hold,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return data as DraftState;
}

/** その枠の残り候補を開示する（D170）。残した候補があるときだけ通る */
export async function callRevealSlotPool(
  sessionId: string,
  cardSlotKey: string,
): Promise<DraftState> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("reveal_slot_pool", {
    p_session_id: sessionId,
    p_card_slot_key: cardSlotKey,
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
 *
 * 【サインインしていない人には、DB へ問い合わせない】
 *   get_my_prompt を実行できるのは authenticated だけ（ゲストも含む）。
 *   未サインインのまま呼ぶと Postgres が
 *   `permission denied for function get_my_prompt` を返し、
 *   例外になって**画面が 500 になっていた**（D90）。
 *
 *   500 はそれ自体が答えになる。形の正しい UUID でだけ 500 が出て、
 *   壊れた文字列では 404 が出るなら、**「ここは何かを持っている場所だ」**
 *   と読める。さらに開発では Postgres の文面がそのまま画面に出ていた。
 *
 *   ここで null を返せば、未サインインの人には
 *   **実在する ID も、しない ID も、区別なく 404** になる。
 *   これは他人のお題を渡されたときの振る舞いとも同じ（D40）。
 */
export async function fetchMyPrompt(promptId: string): Promise<PromptDetail | null> {
  // 形が違うIDは DB へ渡さない（500 ではなく 404 にそろえる）
  if (!isUuid(promptId)) return null;

  const supabase = await createSupabaseServerClient();

  // Cookie を信じずに問い合わせて確かめる（getSession ではなく getUser）
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return null;

  const { data, error } = await supabase.rpc("get_my_prompt", { p_prompt_id: promptId });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as PromptDetail | null) ?? null;
}

/**
 * 制作挑戦の残り時間（D163）。自分のお題以外には null が返る。
 *
 * **画面はこの値を毎回読み直す。**ブラウザ側で秒を数え続けても、
 * ページを閉じている間の経過は数えられない。時計はサーバーにしか無い。
 */
export async function fetchPromptTimer(promptId: string): Promise<PromptTimer | null> {
  if (!isUuid(promptId)) return null;

  const supabase = await createSupabaseServerClient();

  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return null;

  const { data, error } = await supabase.rpc("get_prompt_timer", {
    p_prompt_id: promptId,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as PromptTimer | null) ?? null;
}

/**
 * 期限を更新する（オーバー更新。D163）。
 *
 * 早すぎる／遅すぎる／無制限のときは、それぞれ別の理由で失敗する。
 * **失敗の文言をここで作らない。**DB 側が理由ごとに違う文を返す。
 */
export async function callRenewPromptDeadline(promptId: string): Promise<PromptTimer> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("renew_prompt_deadline", {
    p_prompt_id: promptId,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return data as PromptTimer;
}

/**
 * お題を放棄する（spec 4-4 の `abandoned` / D171）。
 *
 * 【「ドラフトを捨てる」とは別物】
 *   callAbandonDraft はお題が決まる前、カードをめくっている最中に捨てる操作。
 *   こちらは**お題が確定したあと**に「これは描かない」と決める操作。
 *   捨てるほうはお題が1件も残らないが、こちらはお題が記録に残り、
 *   引かなかったカードが開く。
 *
 * 投稿済みのお題は放棄できない（判定は DB 側）。
 */
export async function callAbandonPrompt(promptId: string): Promise<PromptDetail> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("abandon_prompt", {
    p_prompt_id: promptId,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return data as PromptDetail;
}

/**
 * 引かなかったカードを、自分の意思で開く（spec 4-4 の `manual` / D171）。
 *
 * **開いても投稿は続けられる**（spec 仮定A9）。放棄と違い、お題の状態は動かない。
 * 開いたことは取り消せない。二度呼んでも最初の記録が残る（判定は DB 側）。
 */
export async function callRevealPromptCandidates(
  promptId: string,
): Promise<PromptDetail> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("reveal_prompt_candidates", {
    p_prompt_id: promptId,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return data as PromptDetail;
}
