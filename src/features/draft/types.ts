/**
 * ドラフト関連の型。
 *
 * DB の関数（draft_state_json / get_my_prompt）が返す JSON の形をそのまま写す。
 * 手で書いているのは、Supabase CLI の型生成がまだ入っていないため。
 * 型生成に置き換えるときは、このファイルを消して import 先を差し替える。
 */

/** モード選択画面に出す1行（public.draft_modes の公開6列） */
export type DraftMode = {
  mode_key: string;
  label: string;
  candidate_count: number;
  max_rerolls: number;
  quiz_question_count: number;
  sort_order: number;
};

/**
 * 伏せカード1枚。
 *
 * **まだめくっていないカードは tag_id も label も null になる。**
 * tags 表は公開されているので、id を渡した時点で label を引けてしまう。
 * だから両方まとめて隠す（draft_state_json 側で実装）。
 */
export type DraftCandidate = {
  candidate_index: number;
  revealed: boolean;
  is_chosen: boolean;
  tag_id: number | null;
  label: string | null;
};

/** 1つの枠（モチーフA など）と、その枠の伏せカード一式 */
export type DraftSlot = {
  card_slot_key: string;
  card_slot_label: string;
  slot_order: number;
  /** いまめくれる枠かどうか。枠は slot_order の順に1つずつ進む */
  is_current: boolean;
  candidates: DraftCandidate[];
};

/** ドラフトの現在状態（draft_state_json の戻り値） */
export type DraftState = {
  session_id: string;
  mode_key: string;
  mode_label: string;
  status: "in_progress" | "completed" | "abandoned";
  candidate_count: number;
  max_rerolls: number;
  reroll_count: number;
  rerolls_left: number;
  quiz_question_count: number;
  time_limit_seconds: number | null;
  generation: number;
  current_slot_order: number;
  slot_count: number;
  chosen_count: number;
  is_ready_to_complete: boolean;
  slots: DraftSlot[];
};

/** complete_draft の戻り値 */
export type CompletedDraft = {
  prompt_id: string;
  mode_key: string;
  card_count: number;
  question_count: number;
};

/** 確定したお題のカード1枚（＝答え） */
export type PromptCard = {
  card_slot_key: string;
  card_slot_label: string;
  slot_order: number;
  tag_id: number;
  tag_label: string;
  pool_key: string;
};

/** 引かなかったカード。開示済みのときだけ入る */
export type UnchosenCard = {
  card_slot_key: string;
  card_slot_label: string;
  slot_order: number;
  candidate_index: number;
  tag_id: number;
  tag_label: string;
};

/** 確定したお題1件（get_my_prompt の戻り値） */
export type PromptDetail = {
  id: string;
  mode_key: string;
  mode_label: string;
  time_limit_seconds: number | null;
  was_rerolled: boolean;
  reroll_count: number;
  status: "active" | "submitted" | "abandoned";
  candidates_revealed_at: string | null;
  reveal_reason: string | null;
  created_at: string;
  work_id: string | null;
  cards: PromptCard[];
  unchosen: UnchosenCard[];
};

/** 制作時間の選択肢。null = 無制限。DB の CHECK は 60〜600000 秒 */
export const TIME_LIMIT_CHOICES: { value: string; label: string }[] = [
  { value: "", label: "無制限" },
  { value: "600", label: "10分" },
  { value: "1800", label: "30分" },
  { value: "3600", label: "1時間" },
  { value: "10800", label: "3時間" },
  { value: "86400", label: "1日" },
];

/** 秒数を「1時間」「30分」のような表示に変える */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "無制限";
  const known = TIME_LIMIT_CHOICES.find((c) => c.value === String(seconds));
  if (known) return known.label;
  if (seconds % 3600 === 0) return `${seconds / 3600}時間`;
  if (seconds % 60 === 0) return `${seconds / 60}分`;
  return `${seconds}秒`;
}
