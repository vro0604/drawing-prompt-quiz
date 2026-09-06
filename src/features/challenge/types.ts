/**
 * 制作挑戦（お題を引いてから投稿し終えるまで）の時間の型。
 *
 * DB の get_active_challenge が返す JSON をそのまま写す。
 *
 * 【この型に正解の語が1つも無いこと】
 *   全ページの上に出す帯が読む値なので、**お題の語を入れない。**
 *   入れると、共有された画面のスクリーンショットにまで答えが写る。
 *   入っているのは時刻と秒数と、戻り先の URL だけ。
 *
 * 【時刻はすべて ISO 文字列】
 *   ブラウザ側は server_now との差を取って自分の時計を補正する。
 *   ブラウザの時計が9時間ずれていても、表示はサーバーに合う。
 */

export type ChallengeKind = "draft" | "prompt";

export type ActiveChallenge = {
  /** draft＝カードをめくっている最中、prompt＝お題が決まって描いている最中 */
  kind: ChallengeKind;
  id: string;
  /** 「いまの挑戦へ戻る」で開く先 */
  href: string;
  status: string;

  /** 挑戦を始めた時刻。ここが総経過の起点で、途中で変わらない */
  started_at: string;
  /** サーバーの現在時刻。ブラウザの時計とのずれを取るために使う */
  server_now: string;
  /** 開始からの総経過秒。更新しても猶予に入っても減らない */
  elapsed_seconds: number;

  is_unlimited: boolean;
  has_deadline: boolean;
  deadline_at: string | null;
  /** 期限までの残り秒。過ぎていれば負 */
  seconds_left: number | null;
  overrun_seconds: number;
  /** 猶予が終わるまでの秒 */
  grace_left_seconds: number | null;

  can_renew: boolean;
  renew_opens_at: string | null;
  grace_ends_at: string | null;
  is_expired: boolean;
  renew_count: number;
  time_limit_seconds: number | null;

  /** 投稿・失敗で終わった挑戦か。true なら時計は止まっている */
  is_finished: boolean;
  finished_at: string | null;
  /** 投稿し終えた作品。終わった挑戦のときだけ入る */
  work_id: string | null;
};

/** 秒を 00:24:10 の形にする。負の値は符号を落とす（超過は呼ぶ側が言葉で書く） */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(Math.abs(seconds)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(h)}:${two(m)}:${two(sec)}`;
}

/** 制作時間の枠を「30分枠」の形にする。無制限は「無制限」 */
export function frameLabel(seconds: number | null): string {
  if (seconds === null) return "無制限";
  if (seconds % 86400 === 0) return `${seconds / 86400}日枠`;
  if (seconds % 3600 === 0) return `${seconds / 3600}時間枠`;
  if (seconds % 60 === 0) return `${seconds / 60}分枠`;
  return `${seconds}秒枠`;
}
