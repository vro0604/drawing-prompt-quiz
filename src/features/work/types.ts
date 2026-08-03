/**
 * 作品まわりの型。
 *
 * DB の関数（get_work_detail / get_my_work / create_work）が返す JSON の形を
 * そのまま写す。手で書いているのは features/draft/types.ts と同じ事情で、
 * Supabase CLI の型生成をまだ入れていないため。
 *
 * **prompt_id はどの型にも現れない。** DB 側がそもそも返さないので
 * （D23）、ここに書きようがない。
 */

/** Storage のバケット名（spec 8-6） */
export const WORKS_BUCKET = "works";

/** 画像の上限。バケット側の file_size_limit と同じ値にしておく */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 部門。works.division の CHECK 制約と同じ3つ */
export type Division = "original" | "fanart" | "ai";

export const DIVISIONS: { value: Division; label: string; note: string }[] = [
  {
    value: "original",
    label: "オリジナル",
    note: "自分で考えたキャラクター・世界の絵",
  },
  {
    value: "fanart",
    label: "ファンアート",
    note: "既存の作品やキャラクターを描いたもの。元作品名が必須",
  },
  {
    value: "ai",
    label: "AI生成",
    note: "生成AIを使ったもの。通常のフィードとは分けて扱う",
  },
];

/** 実制作時間の選択肢。空 = 申告しない。DB の CHECK は 1〜600000 秒 */
export const ACTUAL_TIME_CHOICES: { value: string; label: string }[] = [
  { value: "", label: "申告しない" },
  { value: "600", label: "10分" },
  { value: "1800", label: "30分" },
  { value: "3600", label: "1時間" },
  { value: "7200", label: "2時間" },
  { value: "10800", label: "3時間" },
  { value: "21600", label: "6時間" },
  { value: "43200", label: "12時間" },
  { value: "86400", label: "1日以上" },
];

/** 枠ごとの伝達率（get_work_detail / get_my_work の slot_stats） */
export type SlotStat = {
  card_slot_key: string;
  card_slot_label: string;
  attempts: number;
  corrects: number;
};

/** 作品の投稿者（get_work_detail の author） */
export type WorkAuthor = {
  id: string;
  handle: string | null;
  display_name: string;
  bio: string | null;
  links: Record<string, string>;
};

/** 公開作品1件（get_work_detail の戻り値） */
export type WorkDetail = {
  id: string;
  title: string;
  image_path: string;
  image_width: number;
  image_height: number;
  division: Division;
  source_title: string | null;
  source_character: string | null;
  fanart_note: string | null;
  actual_time_seconds: number | null;
  time_limit_seconds: number | null;
  mode_key: string;
  was_rerolled: boolean;
  likes_count: number;
  saves_count: number;
  answers_count: number;
  created_at: string;
  author: WorkAuthor;
  is_author: boolean;
  liked_by_me: boolean;
  saved_by_me: boolean;
  answered_by_me: boolean;
  slot_stats: SlotStat[];
};

/**
 * 自分の作品1件（get_my_work の戻り値）。
 *
 * 公開作品と違い、非公開・審査中・削除済みも返る。
 * その代わり author を持たない（自分だとわかっているため）。
 */
export type MyWork = {
  id: string;
  title: string;
  image_path: string;
  image_width: number;
  image_height: number;
  division: Division;
  source_title: string | null;
  source_character: string | null;
  fanart_note: string | null;
  actual_time_seconds: number | null;
  time_limit_seconds: number | null;
  mode_key: string;
  is_published: boolean;
  review_status: "ok" | "flagged" | "hidden";
  deleted_at: string | null;
  likes_count: number;
  saves_count: number;
  answers_count: number;
  created_at: string;
  can_edit_actual_time: boolean;
  slot_stats: SlotStat[];
};

/** create_work / update_work の戻り値 */
export type WorkWriteResult = {
  work_id: string;
  is_published: boolean;
};

/** 部門キーから表示名を引く。未知の値はそのまま返す */
export function divisionLabel(division: string): string {
  return DIVISIONS.find((d) => d.value === division)?.label ?? division;
}

/** 実制作時間の秒数を「2時間30分」のような表示に変える。null は未申告 */
export function formatActualTime(seconds: number | null): string {
  if (seconds === null) return "未申告";

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);

  if (hours === 0) return `${minutes}分`;
  if (minutes === 0) return `${hours}時間`;
  return `${hours}時間${minutes}分`;
}
