#!/usr/bin/env node
/**
 * deploy-main.mjs ／ 画面を本番へ出す、唯一の入口
 *
 * 実行:
 *   npm run deploy:main             … 下見（何も送らない）
 *   npm run deploy:main -- --apply  … 実際に出す
 *
 * 【これが「デプロイ」である】
 *   このリポジトリに deploy コマンドは無い。Vercel が GitHub の main を見ていて、
 *   main が進むとビルドが始まる。つまり
 *
 *     git push origin <枝>:main
 *
 *   が本番への配信そのものである。docs/prod-runbook.md の 9「Vercel へデプロイ」は
 *   この1行を指している。**押した瞬間に利用者へ届く。**
 *
 * 【2回確かめる】
 *   1回目 … 出せる状態かの確認（scripts/_preflight.mjs）
 *   2回目 … 送る直前に、遠くの main をもう一度引き直す
 *
 *   2回目が要るのは、1回目のあと push するまでの間に、別の作業線や別の窓が
 *   main を進めているかもしれないからである。1回目の値を信じたまま押すと、
 *   その進みぶんを巻き戻す。**確認の結果には賞味期限がある。**
 *
 * 【やらないこと】
 *   force しない。merge も rebase もしない。早送りにならないなら、ただ止まる。
 */

import { execFileSync } from "node:child_process";
import { collectFacts, judge, formatReport, readRemoteMain, runGit } from "./_preflight.mjs";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const cwdIndex = argv.indexOf("--cwd");
const cwd = cwdIndex >= 0 ? argv[cwdIndex + 1] : process.cwd();
const remoteIndex = argv.indexOf("--remote");
const remote = remoteIndex >= 0 ? argv[remoteIndex + 1] : "origin";
const branchIndex = argv.indexOf("--branch");
const branch = branchIndex >= 0 ? argv[branchIndex + 1] : "main";
const srcIndex = argv.indexOf("--from");
const src = srcIndex >= 0 ? argv[srcIndex + 1] : "HEAD";

/* ── 1回目の確認 ──────────────────────────────────────── */

const facts = collectFacts({ cwd, remote, branch });
const verdict = judge(facts, { mode: "deploy" });
console.log(formatReport(facts, verdict));
if (!verdict.ok) {
  console.error("\n✗ 本番へは出しませんでした。");
  process.exit(1);
}

const before = facts.remoteMain.sha;

/* ── 何が出るのかを並べる ─────────────────────────────── */

const listing = runGit(["log", "--oneline", `${before}..${src}`], { cwd });
const outgoing = listing.ok && listing.out ? listing.out.split("\n") : [];

console.log("");
console.log("───────────────────────────────────────────");
console.log(` ${remote} の ${branch} へ出るコミット（${outgoing.length} 件）`);
console.log("───────────────────────────────────────────");
for (const line of outgoing) console.log(`  ${line}`);
if (outgoing.length === 0) console.log("  （無し。本番は変わりません）");

if (!APPLY) {
  console.log("");
  console.log("下見です。1バイトも送っていません。");
  console.log("出すときは --apply を付けてください:");
  console.log(`  npm run deploy:main -- --apply`);
  process.exit(0);
}

if (outgoing.length === 0) {
  console.log("\n出すものがありません。何もせずに終わります。");
  process.exit(0);
}

/* ── 2回目の確認（送る直前に引き直す） ───────────────── */

console.log("");
console.log("───────────────────────────────────────────");
console.log(" 送る直前の再確認");
console.log("───────────────────────────────────────────");

const now = readRemoteMain({ cwd, remote, branch });
if (!now.ok) {
  console.error(`  ✗ ${remote} の ${branch} を読み直せませんでした: ${now.error}`);
  console.error("  読めないまま送ることはしません。");
  process.exit(1);
}

console.log(`  確認したとき  ${before.slice(0, 7)}`);
console.log(`  いま          ${now.sha.slice(0, 7)}`);

if (now.sha !== before) {
  console.error("");
  console.error(`  ✗ 確認してから今までのあいだに ${remote}/${branch} が進みました。`);
  console.error("    このまま送ると、進んだぶんを本番から消します。");
  console.error("    やること: もう一度はじめからやり直してください。");
  console.error(`      git fetch ${remote}`);
  console.error(`      git worktree add -b <枝> ../dpq-<名前> ${remote}/${branch}`);
  process.exit(1);
}

const ff = runGit(["merge-base", "--is-ancestor", now.sha, src], { cwd });
if (!ff.ok) {
  console.error("");
  console.error(`  ✗ 早送りになりません（${src} が ${remote}/${branch} を含んでいません）。`);
  console.error("    この道具は force しません。");
  process.exit(1);
}
console.log("  → 変わっていません。早送りで送ります。");

/* ── 送る ─────────────────────────────────────────────── */

console.log("");
try {
  const out = execFileSync("git", ["push", remote, `${src}:refs/heads/${branch}`], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  console.log(out || "");
} catch (e) {
  console.error((e.stderr || "").toString());
  console.error("✗ push に失敗しました。本番は変わっていません。");
  process.exit(1);
}

const after = readRemoteMain({ cwd, remote, branch });
console.log("");
console.log(`✓ ${remote}/${branch} が ${after.ok ? after.sha.slice(0, 7) : "（読み直せず）"} になりました。`);
console.log("  Vercel のビルドがここから始まります。docs/prod-runbook.md の 10 へ進んでください。");
