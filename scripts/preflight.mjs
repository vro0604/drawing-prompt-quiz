#!/usr/bin/env node
/**
 * preflight.mjs ／ 本番を変える前の確認を、人が自分で打つための入口
 *
 * 実行:
 *   npm run preflight           … 共通の確認だけ
 *   npm run preflight:deploy    … 画面を本番へ出す前の確認
 *   npm run preflight:db        … 本番のデータベースへ書く前の確認
 *
 * 【自動でも呼ばれる】
 *   本番を変えるスクリプトは、実際に外へ送る直前でこれと同じ判定を通る。
 *   だから、ここを手で打つのは「いま出せる状態か」を先に見たいときである。
 *   打ち忘れても柵は効く。
 *
 * 【終了コード】
 *   0 … 条件を満たしている
 *   1 … 満たしていない（何が足りないかを画面に出す）
 *
 * 【試験のための引数】
 *   --cwd <パス>   別の作業木を見る
 *   --no-fetch     fetch しない（網の無いところで判定だけ試す）
 *   --json         判定を JSON で出す（人の目には読みにくいので、ふだんは使わない）
 */

import { collectFacts, judge, formatReport } from "./_preflight.mjs";

const argv = process.argv.slice(2);
const mode = argv.includes("--db") ? "db" : argv.includes("--deploy") ? "deploy" : "core";
const cwdIndex = argv.indexOf("--cwd");
const cwd = cwdIndex >= 0 ? argv[cwdIndex + 1] : process.cwd();
const doFetch = !argv.includes("--no-fetch");
const asJson = argv.includes("--json");

const facts = collectFacts({ cwd, doFetch });
const verdict = judge(facts, { mode });

if (asJson) {
  console.log(JSON.stringify({ facts, verdict }, null, 2));
} else {
  console.log(formatReport(facts, verdict));
}

process.exit(verdict.ok ? 0 : 1);
