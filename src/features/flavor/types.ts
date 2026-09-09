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

/** 語の品詞。並べ方に使う。**探し方の軸は分類のほう** */
export type FlavorVocabKind =
  | "connective"
  | "noun"
  | "verb"
  | "adjective"
  | "particle"
  | "state";

/** 作者が選べる語1つ */
export type FlavorVocabItem = {
  id: number;
  label: string;
  kind: FlavorVocabKind;
  /** そのお題の間接表現として有効だと登録されている語。先に見せる */
  suggested: boolean;
};

/**
 * 語を探すための分類（P5）。
 *
 * **分類ごとに選べる数の枠は無い。**同じ分類から5語、他が0語でもよい。
 * 分類は「どこを探せばあるか」を示すためだけのもの。
 */
export type FlavorVocabCategory = {
  key: string;
  label: string;
  hint: string | null;
  words: FlavorVocabItem[];
};

/** 作者の作文画面へ渡す一式 */
export type FlavorVocabSet = {
  work_id: string;
  /** 語数の上限。**技術上の上限**（DOM と DB を守るための数） */
  max_tokens: number;
  /** 文数の上限。**文章としての決まり** */
  max_sentences: number;
  categories: FlavorVocabCategory[];
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
  /** 文ごとに分けた語の並び。表示はこちらを使う */
  sentences: string[][];
  /** 作者にだけ返る。作り直しの初期値に使う */
  token_ids?: number[];
  /** 作者にだけ返る。印が付いている位置 */
  breaks?: number[];
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

/**
 * 文ごとに分けた語の並びを、読める文にする。
 *
 * **語と語のあいだは空ける。**助詞を選んでいない並び（「影 消える」）でも
 * 切れ目が分かるようにするため。文の終わりに「。」を付ける。
 *
 * 上限の数はここに書かない。**DB（flavor_limits）が唯一の出どころ**で、
 * get_flavor_vocab が max_tokens / max_sentences として返す。
 */
export function flavorLines(flavor: { sentences?: string[][]; tokens: string[] }): string[] {
  const groups =
    flavor.sentences && flavor.sentences.length > 0
      ? flavor.sentences
      : flavor.tokens.length > 0
        ? [flavor.tokens]
        : [];
  return groups.map((g) => `${g.join(" ")}。`);
}

/** 正答率を百分率にする。回答が0なら null（「まだ分からない」） */
export function hintAccuracy(row: HintStatRow): number | null {
  if (row.total_items === 0) return null;
  return Math.round((row.correct_items / row.total_items) * 100);
}
