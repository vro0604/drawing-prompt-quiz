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
  /** 予定終了時刻。**作りかけを壊す期限ではない**（過ぎても挑戦は続く） */
  deadline_at: string | null;
  /** 予定終了時刻までの残り秒。過ぎていれば負 */
  seconds_left: number | null;
  /** 予定終了時刻を過ぎてからの秒。過ぎていなければ 0 */
  overrun_seconds: number;
  /** 予定終了時刻を過ぎているか。過ぎていても失敗ではない */
  is_overrun: boolean;

  /**
   * within   … 制作時間内
   * overrun  … 制作時間超過中（挑戦は続いている）
   * discarded… 長い放置で自動破棄済み
   * finished … 投稿・放棄で終わった
   */
  phase: "within" | "overrun" | "discarded" | "finished";

  /** 長い放置で自動破棄されたか。**予定終了時刻の超過ではここは立たない** */
  is_discarded: boolean;
  discarded_at: string | null;

  /** この挑戦で最後に意味のある操作があった時刻 */
  last_activity_at: string;
  /** 放置の予告が出る時刻（最終操作から24時間） */
  inactivity_warn_at: string | null;
  /** 自動破棄される時刻（最終操作から48時間） */
  auto_discard_at: string | null;
  /** 自動破棄までの残り秒 */
  seconds_until_discard: number | null;

  /** 時刻の窓は無い。進行中で期限を持てば、いつでも延ばせる */
  can_renew: boolean;
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

/**
 * 「時間を延ばす」を押したときにサーバーが返すもの。
 *
 * 帯は、これをそのまま文にする。**押しただけで成功と書かない**ので、
 * 延ばした量と新しい終了予定が返ってきたときにだけ「延長しました」と出せる。
 */
export type RenewResult = ActiveChallenge & {
  renewed: true;
  /** 今回足された秒数 */
  granted_seconds: number;
  deadline_before: string | null;
  deadline_after: string | null;
};

/** 秒を「1時間30分」「22分30秒」の形にする。延長した量を文にするときに使う */
export function spanLabel(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}時間`);
  if (m > 0) parts.push(`${m}分`);
  if (sec > 0 && h === 0) parts.push(`${sec}秒`);
  return parts.length > 0 ? parts.join("") : "0秒";
}

/** 時刻を「17:04」の形にする。ずれないよう、渡すのはサーバーが作った ISO 文字列 */
export function hhmm(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}
