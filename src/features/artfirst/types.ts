/**
 * 持ち込み（art_first）で使う型。
 *
 * 【この経路が何か】
 *   既に描いてある絵を持ち込み、**作者が「この絵で何が伝わるか」を
 *   現行の語彙から選ぶ。**選んだ語がそのままクイズの正解になる。
 *   お題を引いて描く経路とは入口が逆で、投稿より後ろは同じ仕組みを通る。
 *
 * 【語の一覧はサーバーが決める】
 *   選べる語も、分類ごとに入れられる数も、画面に書き写さない。
 *   get_art_first_vocabulary が返した値をそのまま使う。
 *   書き写すと、DB の枠や規則を変えたときに画面だけ古くなる。
 */

/** 選べる語1つ */
export type VocabTag = {
  id: number;
  label: string;
  /** 読み。検索でかなからも引けるようにするために使う */
  reading: string | null;
};

/** 語の上位種別。カラーは状態ではない（D158 / D165） */
export type VocabKind = "morph" | "state" | "color";

/** 分類1つと、その中の語 */
export type VocabCategory = {
  category_key: string;
  kind: VocabKind;
  label: string;
  /**
   * この分類から選べる数の上限。
   *
   * DB 側が「格納できる枠の数」と「1つのお題に入れてよい数」の
   * 小さいほうを返す。画面はこの数で選択を止める。
   */
  capacity: number;
  tags: VocabTag[];
};

/** get_art_first_vocabulary の戻り値 */
export type ArtFirstVocabulary = {
  min_words: number;
  max_words: number;
  categories: VocabCategory[];
};

/** 上位種別の表示名 */
export function kindLabel(kind: VocabKind): string {
  return kind === "morph" ? "描く対象" : kind === "color" ? "色" : "状態";
}

/** 何も選べなかったときの空の一覧（画面を落とさないため） */
export const EMPTY_VOCABULARY: ArtFirstVocabulary = {
  min_words: 3,
  max_words: 6,
  categories: [],
};
