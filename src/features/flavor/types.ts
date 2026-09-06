/**
 * フレーバーテキスト（D162）の型。
 *
 * 【1つの文章が2回出てくる】
 *   作者が制限語彙で短い文章を作る。同じ文章が、
 *     回答前 … 任意で開ける「手掛かり」
 *     回答後 … 必ず開示される「作者の詩句」
 *   の2つの場面に出る。**別々の文章ではなく、同じもの。**
 *
 * 【回答前に正解を漏らさないための決まり】
 *   自由入力ではなく、決まった語の一覧から選ぶ。
 *   そのお題の正解に近すぎる語は、一覧に最初から出ない。
 *   「近い」の判定は DB 側が持っている（文字の重なり・同義グループ・明示的な禁止）。
 *
 * 【ヒントを使ったかどうか】
 *   画面からは送らない。ヒントを開いた事実をサーバーが記録していて、
 *   回答を保存するときにそれを見る。**減点はしない**（D162）。
 *   作者が「絵だけでどこまで伝わったか」と「文章を添えるとどうか」を
 *   分けて見られるようにするための記録。
 *
 * 【返歌】
 *   回答後に、鑑賞者が自分の意思で作る短い文章。正誤判定は無い。
 *   すでに正解が開示されているので、正解の語をそのまま置ける。
 */

/** 作者が選べる語1つ */
export type FlavorVocabItem = {
  id: number;
  label: string;
  kind: "connective" | "noun" | "verb" | "adjective";
  /** そのお題の間接表現として有効だと登録されている語。先に見せる */
  suggested: boolean;
};

/** 作者の作文画面へ渡す一式 */
export type FlavorVocabSet = {
  work_id: string;
  max_tokens: number;
  vocab: FlavorVocabItem[];
};

/** フレーバーテキスト1件。tokens は語の並び */
export type WorkFlavor = {
  work_id: string;
  /** 作者がまだ作っていなければ false */
  exists: boolean;
  is_author: boolean;
  /** この人がヒントとして開いたか */
  hint_used: boolean;
  /** 回答後の開示として見えているか */
  revealed: boolean;
  tokens: string[];
};

/** 返歌1件 */
export type FlavorReply = {
  id: number;
  is_mine: boolean;
  author_display_name: string;
  author_handle: string | null;
  created_at: string;
  tokens: string[];
};

/** 返歌の語1つ。制限語彙か、開示済みの正解タグのどちらか */
export type FlavorReplyToken = { vocab_id: number } | { tag_id: number };

/** ヒント使用別の集計1行 */
export type HintStatRow = {
  hint_used: boolean;
  answers_count: number;
  total_items: number;
  correct_items: number;
};

/** 作者へ返すヒント使用別の集計 */
export type WorkHintResult = {
  work_id: string;
  rows: HintStatRow[];
};

/** 1つの文章に置ける語の数の上限 */
export const MAX_FLAVOR_TOKENS = 12;

/** 語の並びを1行の文章にする。区切りは読点 */
export function flavorSentence(tokens: string[]): string {
  return tokens.join(" ");
}

/** 正答率を百分率にする。回答が0なら null（「まだ分からない」） */
export function hintAccuracy(row: HintStatRow): number | null {
  if (row.total_items === 0) return null;
  return Math.round((row.correct_items / row.total_items) * 100);
}
