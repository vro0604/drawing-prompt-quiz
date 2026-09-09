/**
 * 長押しで回答を確定する仕掛けの「時間の勘定」だけを取り出したもの。
 *
 * 【なぜ画面から切り離すか】
 *   長押しは時間で決まる。時間で決まるものを画面ごと試そうとすると、
 *   試験が本物の1.5秒を待つことになり、遅いうえに機械の混み具合で
 *   落ちたり通ったりする。ここには**画面もブラウザも出てこない。**
 *   「いまが何ミリ秒か」を外から渡す形にしてあるので、
 *   試験は時計を自分で進められる。
 *
 * 【この4つの状態しかない】
 *   idle      … 触っていない。0%
 *   holding   … 押している。時間とともに増える
 *   rewinding … 離した。時間とともに減る
 *   done      … 100%に届いた。ここで初めて回答が確定する
 *
 * 【確定は「離したとき」ではなく「100%に届いたとき」】
 *   押しっぱなしのまま 1.5 秒が過ぎた瞬間に done になる。
 *   離すのを待たない。離す前に確定するのが仕様（利用者から見ると、
 *   押している指の下でゲージが満ちた瞬間に決まる）。
 */

/**
 * 100%に届くまでの長押し時間。**確定するかどうかは、この値だけが決める。**
 *
 * 見た目の充填曲線（gaugeFraction）はこの時間を1ミリ秒も動かさない。
 * 曲線を変えても、確定は必ず 1.5 秒。
 */
export const HOLD_MS = 1500;

/** 100%未満で離したあと、0% へ戻りきるまでの時間 */
export const REWIND_MS = 2300;

/**
 * 100%に届いてから次のセクションへ移るまでの間。
 *
 * **0 にしない。**満ちた瞬間に画面が飛ぶと、自分が何を確定したのかを
 * 見る時間が無い。長くもしない（待たされている感じになる）。
 */
export const CONFIRM_FEEDBACK_MS = 520;

export type HoldPhase = "idle" | "holding" | "rewinding" | "done";

/**
 * 長押し1つぶんの状態。
 *
 * progress は**時間そのものの割合**（0〜1）で、見た目の曲線は混ぜない。
 * at は「この progress を計算した時刻」。次に時計を進めるときの起点になる。
 */
export type Hold = {
  phase: HoldPhase;
  progress: number;
  at: number;
};

export const IDLE: Hold = { phase: "idle", progress: 0, at: 0 };

/** 時計を now まで進める。押している間は増え、離した後は減る */
export function advance(h: Hold, now: number): Hold {
  const dt = Math.max(0, now - h.at);

  if (h.phase === "holding") {
    const p = Math.min(1, h.progress + dt / HOLD_MS);
    return p >= 1
      ? { phase: "done", progress: 1, at: now }
      : { phase: "holding", progress: p, at: now };
  }

  if (h.phase === "rewinding") {
    const p = Math.max(0, h.progress - dt / REWIND_MS);
    return p <= 0
      ? { phase: "idle", progress: 0, at: now }
      : { phase: "rewinding", progress: p, at: now };
  }

  return { phase: h.phase, progress: h.progress, at: now };
}

/**
 * 押し始め。
 *
 * **巻き戻しの途中で押し直したときに 0 へ戻さない。**
 * その時点まで減った値から充填を続ける。0.8秒押して離し、0.4秒後に
 * 押し直したなら、残っている分の続きから始まる。
 */
export function press(h: Hold, now: number): Hold {
  const cur = advance(h, now);
  if (cur.phase === "done") return cur;
  return { phase: "holding", progress: cur.progress, at: now };
}

/** 離した。100%に届いていなければ巻き戻しに入る */
export function release(h: Hold, now: number): Hold {
  const cur = advance(h, now);
  if (cur.phase !== "holding") return cur;
  return { phase: "rewinding", progress: cur.progress, at: now };
}

/**
 * 指が画面の外へ出た、通知が割り込んだ、など、押下が取り消されたとき。
 *
 * **確定させない。**離したときと同じく巻き戻す。
 * すでに 100% に届いていた場合は、その時点で確定済みなので done のまま。
 */
export function cancel(h: Hold, now: number): Hold {
  return release(h, now);
}

/**
 * 見た目の充填量。**確定の判定には一切使わない。**
 *
 * 開始直後は速く、終盤ほど遅くなる（ease-out）。
 * 押した手応えが早く出て、最後のひと押しが長く感じる形。
 * 0 で 0、1 で 1 になるので、満ちた見た目と確定は必ず同時に起きる。
 */
export function gaugeFraction(progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return 1 - Math.pow(1 - p, 2.2);
}
