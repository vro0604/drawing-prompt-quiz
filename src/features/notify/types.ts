/**
 * 利用者へ伝える「出来事」の型。
 *
 * DB の notification_events を写す。**お題の語は1つも入らない**
 * （ブラウザのプッシュはロック画面にも出るため、正解が漏れる経路になる）。
 *
 * 【3つの層】
 *   1. 出来事   … ここ。DB に残る。プッシュが届かなくても消えない
 *   2. サイト内 … 次にサイトを開いたときに出す（_notices.tsx）
 *   3. プッシュ … ブラウザが受け取る（public/sw.js）
 */

export type NotificationKind =
  /** 予定終了時刻を過ぎた。**失敗ではない** */
  | "deadline_overrun"
  /** 最終操作から24時間。あと1日で自動破棄 */
  | "inactivity_warning"
  /** 最終操作から48時間。自動破棄した */
  | "inactivity_discard"
  /** 制作時間を延ばした */
  | "deadline_extended";

export type AppNotification = {
  id: number;
  kind: NotificationKind;
  subject_kind: "draft" | "prompt";
  /** どの挑戦についてか。**本体が消えたあとも残る**ので、行があるとは限らない */
  subject_id: string;
  reason: "inactivity" | "deadline" | "user_action" | null;
  title: string;
  body: string;
  payload: { url?: string; granted_seconds?: number };
  created_at: string;
  /** 利用者が確認した時刻。null なら未確認で、次に来たときにも出す */
  acknowledged_at: string | null;
};

/** 未確認だけを取り出す。確認済みは履歴として残るが、繰り返し前へは出さない */
export function unacknowledged(list: AppNotification[]): AppNotification[] {
  return list.filter((n) => n.acknowledged_at === null);
}

/**
 * 前へ出すべき知らせか。
 *
 * 延長の成功はその場で分かるので、履歴には残すが割り込ませない。
 * 割り込ませるのは、見逃すと困る3つだけ。
 */
export function isInterrupting(n: AppNotification): boolean {
  return n.kind !== "deadline_extended";
}
