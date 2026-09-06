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
 *
 * 【問数は固定ではない（D165）】
 *   お題として確定した語はすべて出題される。3語なら3問、6語なら6問。
 *   **正答率の分母は question_count。**3で割る場所を作らない。
 *
 * 【回答方式は2つ（D165）】
 *   ビタ当て（exact）… 4択から1語を選ぶ。「この語である」と断定した
 *   2択当て（pair） … 4択から2語を選ぶ。「この2語のどちらかまでは絞れた」
 *   どちらも正解へ到達しうるが、同じ種類の正答ではない。混ぜて数えない。
 */

/** 選択肢1つ。正解かどうかは含まれない。1問あたり4つ、作れないときは3つ */
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
  /** 3 か 4。語彙が足りないときだけ3になる（D165 の 11-4） */
  choice_count: number;
  choices: QuizChoice[];
};

/** 作品1件ぶんの出題（get_work_quiz の戻り値） */
export type WorkQuiz = {
  work_id: string;
  mode_key: string;
  answered_by_me: boolean;
  /** 作者本人は自作に回答できない（D28）。入力を出さないための印 */
  is_author: boolean;
  /** お題の語数と同じ（D165） */
  question_count: number;
  questions: QuizQuestion[];
};

/** 回答の方式。exact＝ビタ当て（1語）／pair＝2択当て（2語） */
export type AnswerMode = "exact" | "pair";

/** 回答の内訳1件。**ここで初めて正解が出てくる** */
export type AnswerItem = {
  question_id: number;
  card_slot_key: string;
  card_slot_label: string;
  answer_mode: AnswerMode;
  selected_tag_id: number;
  selected_label: string;
  /** 2択当てのときだけ入る */
  selected_tag_id_2: number | null;
  selected_label_2: string | null;
  is_correct: boolean;
  correct_tag_id: number;
  correct_label: string;
};

/** 自分の回答1件（get_my_answer / submit_answer の戻り値） */
export type MyAnswer = {
  work_id: string;
  work_title: string;
  correct_count: number;
  /** 実際に出題された問の数。**正答率の分母はこれ** */
  question_count: number;
  exact_attempts: number;
  exact_corrects: number;
  pair_attempts: number;
  pair_corrects: number;
  /** v1_fixed_count＝旧方式の回答／v2_all_words＝全語出題・2方式 */
  scoring_version: "v1_fixed_count" | "v2_all_words";
  answered_at: string;
  items: AnswerItem[];
};

/**
 * submit_answer へ渡す1問ぶんの選択。
 *
 * tag_id だけならビタ当て。tag_id_2 も入れると2択当てになる。
 */
export type AnswerSelection = {
  question_id: number;
  tag_id: number;
  tag_id_2?: number;
};

/** 「5問中4問 的中」のような表示を作る */
export function scoreLabel(answer: MyAnswer): string {
  const total = answer.question_count || answer.items.length;
  return `${total}問中 ${answer.correct_count}問 的中`;
}

/** 「ビタ当て3問中3問・2択当て2問中1問」のような内訳を作る */
export function modeBreakdown(answer: MyAnswer): string {
  const parts: string[] = [];
  if (answer.exact_attempts > 0) {
    parts.push(`ビタ当て ${answer.exact_attempts}問中 ${answer.exact_corrects}問`);
  }
  if (answer.pair_attempts > 0) {
    parts.push(`2択当て ${answer.pair_attempts}問中 ${answer.pair_corrects}問`);
  }
  return parts.join("・");
}

/** 方式の呼び名。画面の文言を1か所にまとめる */
export const MODE_LABEL: Record<AnswerMode, string> = {
  exact: "ビタ当て",
  pair: "2択当て",
};
