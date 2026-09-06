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
 * 【build を npm scripts から包まない理由】
 *   `npm run build` は Vercel でも走る。あちらでこの札を作る意味は無い
 *   （同時に走る相手が居ない）ので、build は一括の検査
 *   （scripts/run-all-checks.mjs）の側で包む。
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

const release = await acquireHeavyLock(name);

const child = spawn(cmd, args, { stdio: "inherit", env: process.env });

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
