#!/usr/bin/env node
/**
 * guard-hooks.mjs ／ main への push を捕まえる hook を、置く・見る・外す
 *
 * 実行:
 *   npm run guard:hooks:status    … いま入っているかを見る（何も書かない）
 *   npm run guard:hooks:install   … 入れる
 *   npm run guard:hooks:remove    … 外す
 *
 * 【なぜ入口を作るか】
 *   hook は Git では共有されない（`.git/hooks` は追跡されない）。だからといって
 *   「各自 .git/hooks へ手で書いてください」にすると、書いた人と書いていない人が
 *   混ざる。**書いたかどうかを1つのコマンドで言えるようにする。**
 *
 * 【どこへ置くか】
 *   作業木（git worktree）が何個あっても、hook は**共有の git フォルダ1か所**に
 *   ある。`git rev-parse --git-common-dir` が指す先の hooks/ である。
 *   だから1回入れれば、どの作業木からの push にも効く
 *   （本当に効くことは test/preflight/hook-selftest.mjs が作業木3つで確かめる）。
 *   `core.hooksPath` が設定されている場合は、そちらが優先されるのでそこへ置く。
 *
 * 【他人の hook を黙って上書きしない】
 *   すでに pre-push があって、それがこの道具の書いたものでなければ、
 *   **何も書かずに止まる。**続ける道は2つ出す。
 *     ・中身を見てから消して入れ直す
 *     ・--chain で、既存のものを先に走らせる形にする（消さずに残す）
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";

const MARK = "dpq-guard-pre-push";
const VERSION = "v1";
const CHAINED = "pre-push.dpq-chained";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const argv = process.argv.slice(2);
const MODE = argv.includes("--install")
  ? "install"
  : argv.includes("--remove")
    ? "remove"
    : "status";
const CHAIN = argv.includes("--chain");

/** hook の中身。**作業木の scripts/preflight-pre-push.mjs を呼ぶだけの薄い殻** */
function hookBody({ chain }) {
  return `#!/bin/sh
# ${MARK} ${VERSION}
#
# main を更新する push だけを確かめる。置いたのは npm run guard:hooks:install。
# 外すのは npm run guard:hooks:remove。中身を手で書き換えないこと
# （書き換えると status が「別のもの」と言うだけで、守りは戻らない）。
#
# 判定の本体は、push しようとしている作業木の scripts/preflight-pre-push.mjs。
# git は hook を作業木の一番上で走らせるので、相対パスで届く。
#
# 標準入力は一度しか読めないので、先に受け取ってから配る。

set -u
INPUT=$(cat)
${
  chain
    ? `
# 先に、元々あった pre-push を走らせる。落ちたらそこで止める。
CHAINED_HOOK="$(dirname "$0")/${CHAINED}"
if [ -x "$CHAINED_HOOK" ]; then
  printf '%s\\n' "$INPUT" | "$CHAINED_HOOK" "$@"
  CHAINED_CODE=$?
  if [ $CHAINED_CODE -ne 0 ]; then
    exit $CHAINED_CODE
  fi
fi
`
    : ""
}
if [ -f scripts/preflight-pre-push.mjs ] && command -v node >/dev/null 2>&1; then
  printf '%s\\n' "$INPUT" | node scripts/preflight-pre-push.mjs
  exit $?
fi

# ここへ来るのは、この作業木に確認の道具が無いか、node が無いとき。
# main を更新する push かどうかだけを、**送り先の ref の完全一致**で見る。
# main を触らない push は、道具が無くても通す（別の窓の作業を止めないため）。
if printf '%s\\n' "$INPUT" | awk 'NF>0 && NF!=4 { bad=1 } NF==4 && $3=="refs/heads/main" { found=1 } END { exit !(found || bad) }'; then
  echo "" >&2
  echo "✗ main への push を止めました。" >&2
  echo "  この作業木に scripts/preflight-pre-push.mjs が無い（か node が見つからない）ため、" >&2
  echo "  遅れ・未コミット・migration を確かめられません。確かめていないものは通しません。" >&2
  echo "" >&2
  echo "  最新の origin/main から作業木を作って、そこから出してください:" >&2
  echo "    git fetch origin" >&2
  echo "    git worktree add -b <枝の名前> ../dpq-<名前> origin/main" >&2
  echo "    cd ../dpq-<名前> && npm run deploy:main -- --apply" >&2
  exit 1
fi

exit 0
`;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** hook を置く場所。core.hooksPath があればそちらが優先される */
function hooksDir() {
  let configured = null;
  try {
    configured = git(["config", "--get", "core.hooksPath"]);
  } catch {
    configured = null;
  }
  if (configured) {
    return { dir: path.resolve(configured), source: "core.hooksPath" };
  }
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return { dir: path.join(common, "hooks"), source: "共有の git フォルダ" };
}

/** いまある pre-push が何なのかを見分ける */
function inspect(file) {
  if (!existsSync(file)) return { state: "none" };
  const text = readFileSync(file, "utf8");
  const mine = text.includes(MARK);
  const executable = (statSync(file).mode & 0o111) !== 0;
  const chained = text.includes(CHAINED);
  return { state: mine ? "mine" : "other", text, executable, chained };
}

const { dir, source } = hooksDir();
const file = path.join(dir, "pre-push");
const chainedFile = path.join(dir, CHAINED);
const found = inspect(file);

console.log("");
console.log(`${BOLD}main への push を捕まえる hook${RESET}`);
console.log(`${DIM}  置き場所: ${file}${RESET}`);
console.log(`${DIM}  決め方  : ${source}${RESET}`);
console.log("");

/* ── 見る ─────────────────────────────────────────────── */

if (MODE === "status") {
  if (found.state === "none") {
    console.log(`${YELLOW}・入っていません。${RESET}`);
    console.log("  手で `git push origin <枝>:main` と打つと、確認を通らずに本番へ出せます。");
    console.log("  入れる: npm run guard:hooks:install");
    process.exit(1);
  }
  if (found.state === "other") {
    console.log(`${YELLOW}・別のものが入っています（この道具が書いたものではありません）。${RESET}`);
    console.log("  中身を見てから決めてください。上書きはしません。");
    process.exit(1);
  }
  const version = /dpq-guard-pre-push (v\d+)/.exec(found.text)?.[1] ?? "（版が読めません）";
  const expected = hookBody({ chain: found.chained });
  const same = found.text === expected;
  console.log(`${GREEN}・入っています${RESET}（${version}${found.chained ? "・既存の hook を先に走らせる形" : ""}）`);
  console.log(`  実行できる: ${found.executable ? "はい" : `${RED}いいえ（このままでは働きません）${RESET}`}`);
  console.log(`  中身      : ${same ? "いま入れる版と同じ" : `${YELLOW}いま入れる版と違う（入れ直すと揃います）${RESET}`}`);
  console.log("");
  console.log("  main を更新する push だけを確かめます。ほかの枝への push は素通りします。");
  process.exit(found.executable && same ? 0 : 1);
}

/* ── 外す ─────────────────────────────────────────────── */

if (MODE === "remove") {
  if (found.state === "none") {
    console.log("・入っていないので、何もしませんでした。");
    process.exit(0);
  }
  if (found.state === "other") {
    console.log(`${RED}✗ この道具が書いたものではないので、外しませんでした。${RESET}`);
    console.log("  中身を見て、自分で判断してください。");
    process.exit(1);
  }
  unlinkSync(file);
  if (existsSync(chainedFile)) {
    renameSync(chainedFile, file);
    console.log(`${GREEN}✓ 外しました。${RESET}元々あった pre-push を戻しました。`);
  } else {
    console.log(`${GREEN}✓ 外しました。${RESET}`);
  }
  console.log("  手で main へ push できる状態に戻りました。");
  process.exit(0);
}

/* ── 入れる ───────────────────────────────────────────── */

let chain = false;

if (found.state === "other") {
  if (!CHAIN) {
    console.log(`${RED}✗ すでに別の pre-push があります。何も書きませんでした。${RESET}`);
    console.log("");
    console.log("  いまある中身の先頭:");
    for (const line of found.text.split("\n").slice(0, 6)) console.log(`    ${line}`);
    console.log("");
    console.log("  続ける道は2つあります。");
    console.log("    1. 中身を見て要らないと分かったら、消してから入れ直す");
    console.log(`       rm ${file} && npm run guard:hooks:install`);
    console.log("    2. 消さずに、元々あるほうを先に走らせる形にする");
    console.log("       npm run guard:hooks:install -- --chain");
    console.log(`       ${DIM}（元のファイルは ${CHAINED} へ移し、外すときに戻します）${RESET}`);
    process.exit(1);
  }
  if (existsSync(chainedFile)) {
    console.log(`${RED}✗ ${CHAINED} がすでにあります。何も書きませんでした。${RESET}`);
    console.log("  移す先が埋まっているので、どちらを残すかを人が決めてください。");
    process.exit(1);
  }
  renameSync(file, chainedFile);
  chmodSync(chainedFile, 0o755);
  chain = true;
  console.log(`・元々あった pre-push を ${CHAINED} へ移しました。こちらを先に走らせます。`);
} else if (existsSync(chainedFile)) {
  // 以前 --chain で入れてある。外したときに戻せるよう、その形を保つ。
  chain = true;
  console.log(`・${CHAINED} があるので、こちらを先に走らせる形で入れます。`);
}

writeFileSync(file, hookBody({ chain }), { mode: 0o755 });
chmodSync(file, 0o755);

const after = inspect(file);
console.log(`${GREEN}✓ 入れました。${RESET}`);
console.log(`  実行できる: ${after.executable ? "はい" : `${RED}いいえ${RESET}`}`);
console.log("");
console.log("  これから、送り先が refs/heads/main の push だけが確認を通ります。");
console.log("  ほかの枝への push は、これまでどおり素通りします。");
console.log("  確認できないとき（作業木に道具が無い・node が無い・遠くの main が引けない）は通しません。");
console.log("  外す: npm run guard:hooks:remove");
process.exit(after.executable ? 0 : 1);
