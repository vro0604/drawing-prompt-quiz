#!/usr/bin/env node
/**
 * heavy.mjs ／ 重い検査を「1本ずつ」に閉じ込めて走らせる包み
 *
 * 使い方: node scripts/heavy.mjs <名前> -- <コマンド> [引数...]
 *   例: node scripts/heavy.mjs "縦断試験" -- node test/db/run.mjs
 *
 * 【なぜ包むのか】
 *   この計算機で重い検査は4種類ある。ブラウザ試験・スモーク・DB試験・build。
 *   このうち2つが同時に走ると、計算機を奪い合って**画面が15秒以内に出ない**
 *   という形で落ちる。アプリの不具合と区別が付かない失敗になる。
 *   2026-09-06 より前は、同時に回すと 4/40 まで落ちた（実測）。
 *
 *   ブラウザ試験とスモークは自分で札を取るようにした。**残りをここで包む。**
 *   包んでおけば、別の窓から `npm run test:db` を叩いても、
 *   走っているブラウザ試験が終わるまで待つ。奪い合いが起きない。
 *
 * 【build と型検査も包む（2026-09-08 に広げた）】
 *   もとは「build は Vercel でも走るから包まない」としていた。ところが
 *   手元で `npm run build` を直に叩くと札を取らないので、
 *   **別の窓で走っているブラウザ試験と計算機を奪い合う。**
 *   実測: 8コア・8GB のこの端末で、ブラウザ試験と build ／ 2本のブラウザ試験が
 *   重なると、検証用サーバーの応答が 14〜21 秒に落ち、
 *   待ち時間で組んだ判定が「部品が出ない」形でランダムに落ちた
 *   （2026-09-08 の切り分け。負荷 14〜20 で落ち、5〜8 で全部通る）。
 *
 *   そこで build と型検査も npm scripts の側で包む。
 *   **Vercel と CI では札を取らない。**あちらには同時に走る相手が居ないうえ、
 *   書き込める場所とも限らないため（VERCEL / CI の環境変数で判定）。
 *
 * 【札の二重取りを避ける】
 *   一括の検査（scripts/run-all-checks.mjs）は、工程によっては自分で札を
 *   持ったまま子を起動する。そのとき子が同じ札を取りに行くと、
 *   **自分が持っている札を自分で待つ**ことになって進まない。
 *   親は子へ `DPQ_HEAVY_LOCK=held` を渡し、ここではその印を見て素通りする。
 */

import { spawn } from "node:child_process";
import { acquireHeavyLock } from "../test/e2e/exclusive.mjs";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 1 || sep === argv.length - 1) {
  console.error("使い方: node scripts/heavy.mjs <名前> -- <コマンド> [引数...]");
  process.exit(64);
}

const name = argv.slice(0, sep).join(" ");
const [cmd, ...args] = argv.slice(sep + 1);

/**
 * 札を取らずに素通りする場面。
 *
 *   VERCEL / CI            … 同時に走る相手が居ない。書ける場所とも限らない
 *   DPQ_HEAVY_LOCK=held    … 親がもう札を持っている（二重取りの防止）
 */
const skipReason =
  process.env.DPQ_HEAVY_LOCK === "held"
    ? "親がすでに札を持っています"
    : process.env.VERCEL
      ? "Vercel の上です"
      : process.env.CI
        ? "CI の上です"
        : null;

const release = skipReason ? () => {} : await acquireHeavyLock(name);

if (skipReason) console.log(`（重い検査の札は取りません: ${skipReason}）`);

// **子には「札は取ってある」と伝える。**子の中でさらに包みが呼ばれても、
// 同じ札を取りに行って自分を待つことがなくなる。
const child = spawn(cmd, args, {
  stdio: "inherit",
  env: { ...process.env, DPQ_HEAVY_LOCK: "held" },
});

// **子が終わるまで札を返さない。**返してしまうと、まだ動いている最中に
// 次の重い検査が始まり、包んだ意味が無くなる。
child.on("close", (code, signal) => {
  release();
  process.exit(code ?? (signal ? 128 : 1));
});
child.on("error", (e) => {
  release();
  console.error(`起動できませんでした: ${e.message}`);
  process.exit(127);
});
