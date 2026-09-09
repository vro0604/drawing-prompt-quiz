/**
 * 取り込み枠まわりの型と、画面で使う小さな計算。**DB もブラウザも出てこない。**
 *
 * DB 側（get_work_import_state）は数えた素の数だけを返す。
 * 割合や言い回しはここで作る。
 */

/** 枠を増やした記録1件 */
export type CapacityGrant = {
  id: number;
  quantity: number;
  /** どこから来た枠か。いまは運営が足すか、試験で足すかだけ */
  source_type: "checkout" | "admin" | "promotion" | "test";
  source_ref: string | null;
  created_at: string;
};

/** 残量が目盛りを下回ったことの記録1件 */
export type CapacityNotice = {
  kind: "remaining_20" | "remaining_5" | "exhausted";
  /** 枠の世代。枠を足すと1つ進む */
  epoch: number;
  remaining: number;
  base: number;
  created_at: string;
  /** メールを送れたか。**送る仕組みがまだ無いので、いまは必ず false** */
  email_sent: boolean;
};

/** 作品1件ぶんの取り込みの状態（get_work_import_state の戻り値） */
export type WorkImportState = {
  /** 台帳の合計。これまでに足した枠の総数 */
  granted_total: number;
  /** 取り込み済みの回答の数 */
  imported: number;
  /** 残り枠。granted_total − imported */
  remaining: number;
  /** 新しい回答を自動で取り込むか */
  auto_import: boolean;
  /** 枠の世代と、いまの世代が始まったときの残量（割合の分母） */
  epoch: number;
  epoch_base: number;

  /** その作品への回答の総数 */
  answers_total: number;
  /** まだ取り込んでいない回答の数 */
  unimported: number;
  /** 作者が分析から外している回答の数 */
  excluded: number;
  /** 高度な分析の対象になる回答の数（取り込み済み かつ 外していない） */
  advanced: number;

  /** 未取り込みの回答が、いつからいつまでのものか。1件も無ければ null */
  oldest_unimported_at: string | null;
  latest_unimported_at: string | null;

  grants: CapacityGrant[];
  notifications: CapacityNotice[];
};

/**
 * いまの世代に対する残量の割合（0〜100）。
 *
 * 分母は「いまの世代が始まったときの残量」。枠を足すとそこが基準になる。
 * まだ一度も枠を足していなければ分母が0なので null（割合を出さない）。
 */
export function remainingPercent(state: {
  remaining: number;
  epoch_base: number;
}): number | null {
  if (!state.epoch_base) return null;
  return Math.round((state.remaining / state.epoch_base) * 1000) / 10;
}

/** 目盛りの呼び名。画面の文言を1か所にまとめる */
export const NOTICE_LABEL: Record<CapacityNotice["kind"], string> = {
  remaining_20: "残りが2割を切りました",
  remaining_5: "残りが5%を切りました",
  exhausted: "枠を使い切ったので、自動の取り込みを止めました",
};

/** 枠の出どころの呼び名 */
export const GRANT_SOURCE_LABEL: Record<CapacityGrant["source_type"], string> = {
  checkout: "購入",
  admin: "運営による付与",
  promotion: "配布",
  test: "検査用の付与",
};

/**
 * 高度な分析を始められるか。
 *
 * 取り込み済みで、かつ分析から外していない回答が1件も無ければ始められない。
 * **枠が残っているかどうかとは別。**枠があっても、取り込むまでは始まらない。
 */
export function canDrillDown(advancedCount: number): boolean {
  return advancedCount > 0;
}
