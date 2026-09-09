/**
 * 残り時間の危険度（P5）。
 *
 * ============================================================================
 * 【なぜ1つのファイルに集めるか】
 * ============================================================================
 *
 *   危険度は3か所で使う。制作中ページの大きな帯、他ページの細い帯、
 *   読み上げソフトへ出す知らせ。**同じ数を3か所に書くと、
 *   1か所だけ直したときに「赤いのに文言は平常」という画面が出る。**
 *   ここが唯一の出どころで、呼ぶ側は段階の名前だけを見る。
 *
 * ============================================================================
 * 【しきい値は暫定（私が設定）】
 * ============================================================================
 *
 *   下の4つの数はユーザーの承認を受けていない。**恒久仕様ではない。**
 *   決まったらここだけを直す。画面にも試験にも数を書き写していないので、
 *   直す場所は1か所で済む。docs/decisions.md に暫定と明記してある。
 *
 * ============================================================================
 * 【割合と秒の両方を見る理由。そして「両方が当てはまったとき」だけ進める】
 * ============================================================================
 *
 *   割合だけで決めると、24時間枠は残り5%（＝72分）で点滅を始める。
 *   まだ1時間以上あるのに赤くなるので、警告が意味を失う。
 *
 *   秒だけで決めると、5分枠は始まった瞬間から「残り15分を切った」ことに
 *   なってしまう。枠そのものが15分より短いからで、
 *   **最初から最後まで警告が出っぱなしになる。**
 *
 *   そこで、その段階へ入るのは**割合と秒の両方が当てはまったとき**だけにした。
 *   結果として、短い枠では割合が、長い枠では秒が、実際の切り替え点を決める。
 *
 *     5分枠   … 半分（150秒）→ 1分（20%）→ 15秒（5%）
 *     24時間枠 … 15分 → 5分 → 1分
 *
 *   枠の長さが分からないとき（期限だけあって枠が無い古いお題）は、秒だけで見る。
 */

/**
 * 危険度。数が大きいほど差し迫っている。
 *
 * 【over は失敗ではない（2026-09-09）】
 *   予定終了時刻を過ぎた状態。**挑戦は続いていて、投稿も延長もできる。**
 *   以前はここから猶予に入り、猶予も過ぎると失敗になったが、その経路は撤去した。
 *
 * 【discarded は時間切れではない】
 *   長いあいだ操作が無かったために自動で破棄された状態。
 *   予定終了時刻をどれだけ超過しても、ここへは来ない。
 */
export type WarnLevel = "calm" | "notice" | "warn" | "danger" | "over" | "discarded";

/** 段階の順序。比べるために数へ直す */
const ORDER: WarnLevel[] = ["calm", "notice", "warn", "danger", "over", "discarded"];

/**
 * しきい値。**暫定（私が設定）。ユーザーの承認を受けていない。**
 *
 * ratio は「残り ÷ 枠」、seconds は残りの秒。
 * 残りがどちらかを下回ったら、その段階に入る。
 */
export const THRESHOLDS = {
  notice: { ratio: 0.5, seconds: 15 * 60 },
  warn: { ratio: 0.2, seconds: 5 * 60 },
  danger: { ratio: 0.05, seconds: 60 },
} as const;

/**
 * いまの危険度を決める。
 *
 * @param secondsLeft 残りの秒。過ぎていれば負。期限が無ければ null
 * @param limitSeconds 枠の秒。無制限・期限なしなら null
 * @param discarded 長い放置で自動破棄されたか（超過では立たない）
 */
export function warnLevel(
  secondsLeft: number | null,
  limitSeconds: number | null,
  discarded = false,
): WarnLevel {
  if (discarded) return "discarded";
  if (secondsLeft === null) return "calm";   // 無制限・期限なし
  if (secondsLeft < 0) return "over";        // 超過中。**失敗ではない**

  // その段階へ入るのは、割合と秒の**両方**が当てはまったときだけ。
  // 枠の長さが分からなければ、秒だけで見る。
  const reached = (t: { ratio: number; seconds: number }) => {
    if (secondsLeft > t.seconds) return false;
    if (limitSeconds === null || limitSeconds <= 0) return true;
    return secondsLeft / limitSeconds <= t.ratio;
  };

  if (reached(THRESHOLDS.danger)) return "danger";
  if (reached(THRESHOLDS.warn)) return "warn";
  if (reached(THRESHOLDS.notice)) return "notice";
  return "calm";
}

/** その段階のほうが危ないか */
export function isWorse(a: WarnLevel, b: WarnLevel): boolean {
  return ORDER.indexOf(a) > ORDER.indexOf(b);
}

/**
 * 点滅させるか。
 *
 * **動きを減らす設定への対応は CSS 側**（globals.css）。
 * ここでは「点滅の段階に入ったか」だけを返し、
 * 実際に動かすかどうかはブラウザの設定が決める。
 * 動かさない場合も、色と下の文言で危険度は伝わる。
 */
export function shouldBlink(level: WarnLevel): boolean {
  return level === "danger" || level === "over";
}

/**
 * 読み上げソフトへ出す文。
 *
 * **毎秒読み上げない。**段階が変わった瞬間だけ差し替える。
 * 秒を1つずつ読み上げると、他の操作の案内が全部埋もれる。
 */
export function warnAnnouncement(level: WarnLevel): string | null {
  switch (level) {
    case "notice":
      return "制作時間が半分を切りました。";
    case "warn":
      return "制作時間が残りわずかです。";
    case "danger":
      return "まもなく期限です。制作時間を延ばすか、投稿してください。";
    case "over":
      return "制作予定時間を超過しました。制作はそのまま続けられます。必要なら延長できます。";
    case "discarded":
      return "長いあいだ操作が無かったため、この制作は自動的に破棄されました。";
    default:
      return null;
  }
}

/** 目に見える言葉。色だけに頼らないための添え書き */
export function warnLabel(level: WarnLevel): string | null {
  switch (level) {
    case "notice":
      return "半分を切りました";
    case "warn":
      return "残りわずか";
    case "danger":
      return "まもなく期限";
    case "over":
      return "制作予定時間を超過中";
    case "discarded":
      return "自動破棄されました";
    default:
      return null;
  }
}
