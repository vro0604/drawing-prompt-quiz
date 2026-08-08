/**
 * 公開プロフィール（ポートフォリオ）まわりの型。
 *
 * DB の get_public_profile / get_saved_works / get_public_answers が
 * 返す形をそのまま写す。
 *
 * **お題のIDはどの型にも現れない**（D23）。お気に入り一覧の
 * prompt_answer だけが答えを含むが、これは「閲覧者がその作品へ
 * 回答済みのとき」に限って DB が入れてくる（spec 12-1）。
 */

import type { Division } from "@/features/work/types";

/** 公開プロフィールの URL。/{handle} ではなく /u/{handle}（D59） */
export function profilePath(handle: string): string {
  return `/u/${handle}`;
}

/** 枠ごとの集計。描き手の記録にも回答者の記録にも同じ形で入る */
export type SlotStatSummary = {
  card_slot_key: string;
  label: string;
  attempts: number;
  corrects: number;
};

/** 描き手としての記録。常に公開（spec 12-0） */
export type CreatorStats = {
  works_count: number;
  answers_count: number;
  /** 他人から受け取ったいいねの数。自作へのいいねは含まない（D57 と同じ考え方） */
  likes_received: number;
  total_actual_seconds: number;
  /** 伝わりやすさ（0〜1）。回答5人以上の作品だけで平均する。対象が無ければ null */
  accuracy: number | string | null;
  slot_stats: SlotStatSummary[];
};

/**
 * 描き手としての記録。
 *
 * **show_creator_stats が false の他人には、投稿数だけが返る**（D136）。
 * そのとき hidden が true になる。null にしないのは、
 * 作品グリッドから数えられる投稿数まで消すと、
 * 伏せている事実のほうが目立つため。
 */
export type MaskedCreatorStats = {
  works_count: number;
  hidden: true;
};

/** 回答者としての記録。show_answer_stats が false の他人には null */
export type AnswerStats = {
  total_answers: number;
  total_items: number;
  total_correct_items: number;
  slot_stats: SlotStatSummary[];
};

/** get_public_profile の戻り値。見つからなければ null */
export type PublicProfile = {
  id: string;
  handle: string;
  display_name: string;
  bio: string | null;
  links: Record<string, string>;
  created_at: string;
  is_self: boolean;
  show_answer_stats: boolean;
  show_answer_history: boolean;
  show_saved_works: boolean;
  show_creator_stats: boolean;
  creator: CreatorStats | MaskedCreatorStats;
  answer_stats: AnswerStats | null;
};

/** お気に入り作品のいまの状態。他人向けには public しか返らない */
export type WorkStatus = "public" | "private" | "review" | "deleted";

/** 回答済みの人にだけ返るお題の答え（1枠ぶん） */
export type PromptAnswerCard = {
  card_slot_key: string;
  slot_label: string;
  tag_label: string;
};

/** get_saved_works の1件 */
export type SavedWork = {
  work_id: string;
  title: string;
  image_path: string;
  image_width: number;
  image_height: number;
  division: Division;
  source_title: string | null;
  saved_at: string;
  author_id: string;
  author_handle: string | null;
  author_display_name: string;
  work_status: WorkStatus;
  answered_by_viewer: boolean;
  /** 閲覧者が回答済みのときだけ入る。それ以外は null（spec 12-1） */
  prompt_answer: PromptAnswerCard[] | null;
};

/** get_public_answers の1件。選んだタグは含まない（spec 12-0） */
export type PublicAnswer = {
  work_id: string;
  title: string;
  image_path: string;
  image_width: number;
  image_height: number;
  division: Division;
  correct_count: number;
  item_count: number;
  answered_at: string;
  author_id: string;
  author_handle: string | null;
  author_display_name: string;
};

/** ポートフォリオのタブ。作品3つは常に公開、残りは公開設定に従う */
export const PORTFOLIO_TABS: {
  key: string;
  label: string;
  /** 作品タブなら get_user_works に渡す部門 */
  division: Division | null;
  /** 公開設定に従うタブなら、その項目名 */
  gate: "show_saved_works" | "show_answer_history" | null;
}[] = [
  { key: "original", label: "オリジナル", division: "original", gate: null },
  { key: "fanart", label: "ファンアート", division: "fanart", gate: null },
  { key: "ai", label: "AI生成", division: "ai", gate: null },
  { key: "saves", label: "お気に入り", division: null, gate: "show_saved_works" },
  { key: "answers", label: "回答履歴", division: null, gate: "show_answer_history" },
];

/** 公開設定のチェックボックス。既定はすべて false（spec 12-0） */
export const VISIBILITY_FIELDS: {
  key:
    | "show_answer_stats"
    | "show_answer_history"
    | "show_saved_works"
    | "show_creator_stats";
  label: string;
  note: string;
}[] = [
  {
    key: "show_creator_stats",
    label: "描き手としての成績を公開する",
    note: "獲得いいね・総制作時間・伝わりやすさ・枠ごとの正答率。投稿した作品そのものは、この設定に関係なく見えます。",
  },
  {
    key: "show_answer_stats",
    label: "回答者としての成績を公開する",
    note: "クイズにどれだけ当てられたか。",
  },
  {
    key: "show_answer_history",
    label: "回答履歴を公開する",
    note: "どの作品にいつ答えて何問正解したか。選んだ選択肢は誰にも見せません。",
  },
  {
    key: "show_saved_works",
    label: "お気に入りを公開する",
    note: "切っている間は、タブも件数も他の人には出ません。自分では常に見られます。",
  },
];

/** 描き手の記録が伏せられているか（D136） */
export function isCreatorHidden(
  creator: CreatorStats | MaskedCreatorStats,
): creator is MaskedCreatorStats {
  return (creator as MaskedCreatorStats).hidden === true;
}

/** 状態の表示名。本人のお気に入り一覧でだけ使う */
export const WORK_STATUS_LABELS: Record<WorkStatus, string> = {
  public: "公開中",
  private: "現在非公開",
  review: "審査中",
  deleted: "削除済み",
};

/** 割合を百分率にする。分母が0なら null（「まだ分からない」） */
export function percentOf(corrects: number, attempts: number): number | null {
  if (attempts === 0) return null;
  return Math.round((corrects / attempts) * 100);
}

/** numeric で返る伝わりやすさを百分率にする */
export function ratioPercent(ratio: number | string | null): number | null {
  if (ratio === null) return null;
  const value = typeof ratio === "string" ? Number.parseFloat(ratio) : ratio;
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/** 秒数を「12時間30分」の形にする。0 は「未申告」 */
export function formatTotalTime(seconds: number): string {
  if (seconds <= 0) return "未申告";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours === 0) return `${minutes}分`;
  if (minutes === 0) return `${hours}時間`;
  return `${hours}時間${minutes}分`;
}
