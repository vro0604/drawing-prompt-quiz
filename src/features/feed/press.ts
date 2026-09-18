/**
 * 一覧のカードを長押しして「いいね」する仕掛けの、時間と位置の勘定だけ。
 *
 * 【なぜ画面から切り離すか】
 *   features/quiz/hold.ts と同じ事情。長押しは時間で決まるので、
 *   画面ごと試すと本物の 0.5 秒を毎回待つことになり、
 *   機械の混み具合で通ったり落ちたりする。
 *   ここには**画面もブラウザも出てこない。**時刻も座標も外から渡す。
 *
 * 【回答の長押し（1.5秒）と同じ部品にしなかった理由】
 *   あちらは「途中で離しても、少しの間は残っている量から続けられる」。
 *   回答は1問ずつ確実に決める操作なので、押し直しを助ける意味がある。
 *
 *   いいねは違う。一覧をスクロールしながら何十枚もの絵の上を
 *   指が通る。量が残る作りにすると、**前に触れた絵の残りが乗って、
 *   触れたつもりのない絵にいいねが付く。**
 *   だからここでは、離した時点で必ず 0 に戻す。
 *
 * 【スクロールを止めない作りにするために、ここが受け持つこと】
 *   ブラウザの標準のスクロールには一切触れない（touch-action も
 *   preventDefault も使わない）。代わりに「まだ同じカードを押しているか」を
 *   **座標で**判定する。指が動かなくても、スクロールでカードのほうが
 *   逃げれば、押している座標はカードの外に出る。そこで失効させる。
 */

/** いいねが成立するまでの長押し時間 */
export const LIKE_PRESS_MS = 500;

export type PressPhase = "idle" | "holding" | "done";

/**
 * 長押し1つぶんの状態。
 *
 * progress は時間そのものの割合（0〜1）。
 * at は「この progress を計算した時刻」で、次に時計を進めるときの起点。
 */
export type Press = {
  phase: PressPhase;
  progress: number;
  at: number;
};

export const PRESS_IDLE: Press = { phase: "idle", progress: 0, at: 0 };

/**
 * 時計を now まで進める。押している間だけ増える。
 *
 * 100% に届いた瞬間に done になる。**離すのを待たない。**
 * 押している指の下で色が満ちた瞬間にいいねが決まる。
 */
export function pressAdvance(p: Press, now: number, durationMs = LIKE_PRESS_MS): Press {
  if (p.phase !== "holding") return { ...p, at: now };

  const dt = Math.max(0, now - p.at);
  const next = Math.min(1, p.progress + dt / Math.max(1, durationMs));

  return next >= 1
    ? { phase: "done", progress: 1, at: now }
    : { phase: "holding", progress: next, at: now };
}

/** 押し始め。**必ず 0 から。**前の押下の残りを持ち込まない（上の理由） */
export function pressStart(now: number): Press {
  return { phase: "holding", progress: 0, at: now };
}

/**
 * 離した・失効した。
 *
 * 100% に届いていなければ 0 に戻す。届いていれば done のまま
 * （すでに成立しているので、離しても取り消さない）。
 */
export function pressRelease(p: Press, now: number): Press {
  if (p.phase === "done") return { ...p, at: now };
  return { phase: "idle", progress: 0, at: now };
}

/**
 * 見た目の広がりかた。**成立の判定には一切使わない。**
 *
 * 中央から外へ広がる円の半径の割合。序盤をわずかに速くして、
 * 押した手応えが早く出るようにする。0 で 0、1 で 1 なので、
 * カード全体に届くのと成立は必ず同時に起きる。
 */
export function washFraction(progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return 1 - Math.pow(1 - p, 1.6);
}

/** 画面上の1点 */
export type Point = { x: number; y: number };

/** 画面上の長方形（getBoundingClientRect と同じ意味） */
export type Rect = { top: number; left: number; right: number; bottom: number };

/**
 * まだそのカードを押しているか。
 *
 * 【false になる場面（指示 13 の「失効」）】
 *   ・スクロールで、押している座標からカードが外れた
 *   ・カードが画面の外へ出た
 *   ・指が別のカードの上へ移った（呼ぶ側が、その時点の座標で
 *     別のカードだと分かるので、この判定より前に切る）
 *
 * 【指が少し動いただけでは false にならない】
 *   カードの中に座標が残っている限り true。
 *   一般的な「数 px 動いたら即取り消し」にはしない（指示 13）。
 */
export function stillPressing(
  point: Point,
  rect: Rect,
  viewport: { width: number; height: number },
): boolean {
  const inside =
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom;
  if (!inside) return false;

  // カードが画面から完全に出た。押し続けていても成立させない
  const visible =
    rect.bottom > 0 && rect.top < viewport.height && rect.right > 0 && rect.left < viewport.width;
  return visible;
}
