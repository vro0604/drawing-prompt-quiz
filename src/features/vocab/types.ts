/**
 * 語彙を選ぶ画面が共通で使う型。
 *
 * 【なぜ持ち込み（art_first）から切り出したか】
 *   もとは持ち込みの投稿フォームだけが語を選んでいたので、型も
 *   features/artfirst に置いてあった。2026-09-08 にプロフィールの
 *   「描くのが得意」「見るのが得意」でも同じ語彙から選ぶようになり、
 *   **2か所から同じ形を参照する**ことになったので、中立な場所へ移した。
 *   features/artfirst/types.ts はここを読み直して同じ名前で出し続けるので、
 *   これまでの取り込み文はそのまま動く。
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
   * 小さいほうを返す。**お題を作るときだけ効く数**で、
   * プロフィールの得意分野には使わない（そちらは合計5件だけが上限）。
   */
  capacity: number;
  tags: VocabTag[];
};

/** get_art_first_vocabulary の戻り値 */
export type Vocabulary = {
  min_words: number;
  max_words: number;
  categories: VocabCategory[];
};

/** 上位種別の表示名 */
export function kindLabel(kind: VocabKind): string {
  return kind === "morph" ? "描く対象" : kind === "color" ? "色" : "状態";
}

/** 何も選べなかったときの空の一覧（画面を落とさないため） */
export const EMPTY_VOCABULARY: Vocabulary = {
  min_words: 3,
  max_words: 6,
  categories: [],
};
