#!/usr/bin/env node
/**
 * run-production-smoke.mjs ／ 本番へ向けてスモークを走らせる、別の入口
 *
 * 実行: npm run smoke:prod -- draft
 *       npm run smoke:prod -- answer
 *
 * 【なぜ入口を分けるのか】
 *   `npm run smoke:draft` は**ローカル専用**になった。.env.local を読まず、
 *   本番の値が環境にあれば通信の前に止まる。
 *   本番を確かめる必要はあるので、その道をこちらに分けた。
 *
 *   分けたのは名前と経路の両方で、環境変数では切り替わらない。
 *   ここが `--production` を付けて子プロセスを起動する唯一の場所になる。
 *
 * 【この入口が本番へ何をするか】
 *   スモークは本番へ**書き込む。**検査用の作品と回答が増える
 *   （終わったら消す作りだが、消し残ることもある）。
 *   打つ前に、それでよいかを確かめること。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PRODUCTION_ENTRY_MARK } from "./_env-target.mjs";

const name = process.argv[2];

if (!name) {
  console.error(
    [
      "",
      "本番へ向けるスモークの名前を指定してください。",
      "",
      "  npm run smoke:prod -- draft",
      "  npm run smoke:prod -- answer",
      "",
      "使える名前: draft / play / work / answer / social / ranking /",
      "            profile / report / account / race / anon",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

const path = fileURLToPath(new URL(`./smoke-${name}.mjs`, import.meta.url));

if (!existsSync(path)) {
  console.error(`scripts/smoke-${name}.mjs がありません。`);
  process.exit(2);
}

console.log("");
console.log("=== 本番へ向けて実行します ===");
console.log(` 対象: scripts/smoke-${name}.mjs`);
console.log(" .env.local を読み、本番の Supabase へ接続します。");
console.log(" 本番に検査用のデータが増えます。");
console.log("");

// **入口の印を渡すのはここだけ。**
// これが無いと、子プロセスは --production を無視してローカル扱いになる
// （scripts/_env-target.mjs の isProductionRun）。
const child = spawn(process.execPath, [path, "--production", ...process.argv.slice(3)], {
  stdio: "inherit",
  env: { ...process.env, DPQ_PRODUCTION_ENTRY: PRODUCTION_ENTRY_MARK },
});

child.on("close", (code) => process.exit(code ?? 1));
