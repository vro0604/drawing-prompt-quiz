/**
 * クイズ（出題と回答）の型。
 *
 * DB の関数（get_work_quiz / get_my_answer / submit_answer）が返す JSON の
 * 形をそのまま写す。
 *
 * 【この2つの型の違いが、そのまま安全設計になっている】
 *
 *   QuizChoice … 出題。tag_id と label だけ。**正解の印を持たない**
 *   AnswerItem … 結果。正解タグを持つ
 *
 *   前者は誰でも取れる。後者は答え終わった本人だけが取れる。
 *   型に is_correct を書く場所が無いこと自体が、
 *   「出題の経路に正解を混ぜない」という決まりの写しになっている。
 */

/** 4択のうちの1つ。正解かどうかは含まれない */
export type QuizChoice = {
  tag_id: number;
  label: string;
  position: number;
};

/** 1問 */
export type QuizQuestion = {
  question_id: number;
  position: number;
  card_slot_key: string;
  card_slot_label: string;
  choices: QuizChoice[];
};

/** 作品1件ぶんの出題（get_work_quiz の戻り値） */
export type WorkQuiz = {
  work_id: string;
  mode_key: string;
  answered_by_me: boolean;
  /** 作者本人は自作に回答できない（D28）。入力を出さないための印 */
  is_author: boolean;
  questions: QuizQuestion[];
};

/** 回答の内訳1件。**ここで初めて正解が出てくる** */
export type AnswerItem = {
  question_id: number;
  card_slot_key: string;
  card_slot_label: string;
  selected_tag_id: number;
  selected_label: string;
  is_correct: boolean;
  correct_tag_id: number;
  correct_label: string;
};

/** 自分の回答1件（get_my_answer / submit_answer の戻り値） */
export type MyAnswer = {
  work_id: string;
  work_title: string;
  correct_count: number;
  answered_at: string;
  items: AnswerItem[];
};

/** submit_answer へ渡す1問ぶんの選択 */
export type AnswerSelection = {
  question_id: number;
  tag_id: number;
};

/** 「3問中2問正解」のような表示を作る */
export function scoreLabel(answer: MyAnswer): string {
  return `${answer.items.length}問中 ${answer.correct_count}問 正解`;
}
