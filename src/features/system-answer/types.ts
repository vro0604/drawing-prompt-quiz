/**
 * システム回答（D195）の型。
 *
 * 【システム回答とは】
 *   新規利用者の最初の作品に、誰からも回答が来ないまま終わる時間を作らない
 *   ために、仕組みが1件だけ答えるもの。人の回答とは区別して保存され、
 *   伝達率・順位・配給・成績のどれも動かさない（D194 / Phase 1）。
 *
 * 【この段では、まだ誰も呼ばない】
 *   作品を投稿しても待ち行列へ自動では積まれない。外部の AI へもつながない。
 *   出所: ユーザー指示（2026-09-10）「まだ外部AIには接続しない。
 *   まだ投稿時に自動enqueueしない。」
 */

/** 待ち行列の状態。DB の許可値と1対1で対応する */
export type SystemAnswerJobStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

/** 待ち行列の1行 */
export type SystemAnswerJob = {
  id: number;
  work_id: string;
  owner_user_id: string | null;
  status: SystemAnswerJobStatus;
  attempts: number;
  enqueued_at: string;
  updated_at: string;
  last_attempt_at: string | null;
  last_error: string | null;
};

/**
 * 1問ぶんの選択。
 *
 * **正解かどうかは入っていない。**合っているかは DB の側が
 * quiz_choices を見て決める。ここから渡すのは「どれを選んだか」だけ。
 * 出所: ユーザー指示（2026-09-10）「保存入口は『AIが選んだ選択肢を保存する
 * 場所』であって、正解情報を供給する場所ではない。」
 */
export type SystemAnswerSelection = {
  question_id: number;
  tag_id: number;
  /** 2択当てのときだけ。1語目と同じ語は置けない */
  tag_id_2?: number;
};
