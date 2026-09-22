/**
 * 共有まわりの型。
 *
 * DB の関数（create_share / get_share_card / record_share_event）が返す JSON の
 * 形をそのまま写す。ほかの features 以下の types.ts と同じ作法で手書きしている。
 *
 * 【この経路にお題の答えは1つも来ない】
 *   get_share_card は quiz_choices.is_correct にも prompt_cards にも触れない
 *   （移行ファイルの 9-7 が、関数の定義文を読んでそれを確かめている）。
 *   だからここに正解を書く場所そのものが無い。
 */

/** 共有先。DB の share_events.channel の CHECK と同じ4つ */
export type ShareChannel = "x" | "bluesky" | "native" | "copy";

/** 共有先の表示名。**アイコンだけにしない**（利用者の指示 10） */
export const SHARE_CHANNEL_LABEL: Record<ShareChannel, string> = {
  x: "Xで共有",
  bluesky: "Blueskyで共有",
  native: "その他のアプリ",
  copy: "リンクをコピー",
};

/** 共有先の並び順。上から順に出す（利用者の指示 10） */
export const SHARE_CHANNEL_ORDER: ShareChannel[] = ["x", "bluesky", "native", "copy"];

/**
 * カードを描くための材料（get_share_card の戻り値）。
 *
 * state が 'unavailable' のときは、ほかの欄が1つも入っていない。
 * 非公開・削除・運営が伏せた作品がこれになる。
 */
export type ShareCardSource =
  | { state: "unavailable" }
  | {
      state: "ok";
      work_id: string;
      /** 共有する問いの ID。問い無しの共有では null */
      question_id: number | null;
      /** カードに載せる問いの文。問い無しの共有では null */
      question_text: string | null;
      /** 投稿者の表示名。匿名の作品では null（いまのサービスに匿名は無い） */
      author_name: string | null;
      /** 作者を伏せる作品か。いまのサービスでは常に false */
      anonymous: boolean;
      /** AI生成の部門か（works.division = 'ai'） */
      ai: boolean;
      /** ぼかして出す作品か。いまのサービスでは常に false */
      sensitive: boolean;
      image_path: string;
      image_width: number;
      image_height: number;
    };

/** create_share の戻り値 */
export type ShareCreated = {
  share_id: string;
  revision_id: string;
  question_id: number | null;
};

/** usage_events に足した6種類。共有操作そのものは share_events が持つ */
export type ShareEventKey =
  | "share_modal_open"
  | "share_question_select"
  | "share_landing"
  | "share_answer_submit"
  | "share_result_view"
  | "share_continue";

/**
 * 共有モーダルが選ばせる問い1件。
 *
 * get_work_quiz の1問から作る。**選択肢は持たない。**
 * 共有の面で選ぶのは「どの問いを出すか」だけで、
 * 答えを選ばせる場所ではない（利用者の指示 1 / 39）。
 */
export type ShareQuestionOption = {
  question_id: number;
  /** 「モチーフ はどれ？」のような1行。**カードに載るのと同じ文字列** */
  text: string;
  /**
   * 同じ文が2つ以上並ぶときだけ入る見分けの1行（「1問目」など）。
   *
   * 【なぜ要るか】
   *   お題の枠は呼び名が重複する。「モチーフ」は morph_1 / morph_2 / morph_3 の
   *   3つに付くので、問いの文だけを並べると**同じ行が2つ出て、
   *   どちらを選んだのか分からない。**回答画面は頭に番号を振って
   *   区別している（「3. モチーフ はどれ？」）。
   *
   * 【なぜカードには載せないか】
   *   カードに出る問いは1つだけなので、何問目かに意味が無い。
   *   選ぶ場所にだけ要る情報なので、選ぶ場所にだけ置く。
   */
  note?: string | null;
};
