#!/usr/bin/env node
/**
 * selftest.mjs ／ 古い作業木から本番へ出せないことを、実際に作って確かめる
 *
 * 実行: npm run test:preflight
 *
 * 【なぜ柵そのものを試すのか】
 *   柵は「何も起きないこと」を仕事にしている。効いていなくても、ふだんは
 *   何も起きないので気づけない。**わざと危ない作業木を作って、止まることを見る。**
 *   止まらなければ、この試験が落ちる。
 *   test/guard/selftest.mjs と同じ考え方である（あちらは本番への接続、
 *   こちらは本番への変更）。
 *
 * 【本物のリポジトリは使わない】
 *   使い捨ての置き場に、bare リポジトリ（遠くの origin の役）と
 *   その複製（手元の作業木の役）を作る。**本物の origin へは1バイトも送らない。**
 *   GitHub にも本番のデータベースにも触れない。
 *
 * 【8つの場面】
 *   A 最新でまっさら              → 通る
 *   B 1コミット遅れ               → 止まる
 *   C 73コミット遅れ              → 止まる（実際に起きた形）
 *   D 未コミットの変更がある      → 止まる
 *   E 確認の途中で遠くの main が進む → 送る直前に止まる
 *   F 手元だけ3コミット進んでいる → 通る。進みの数を申告する
 *   G 版番号が食い違う作業木      → DBへの書き込みだけ止まる
 *   G' origin/main の migration を持っていない作業木 → DBへの書き込みを止まる
 *   H 最新＋意図した migration 1本 → 通る
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { judge } from "../../scripts/_preflight.mjs";
import { recordCount } from "../counts.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PREFLIGHT = path.join(ROOT, "scripts", "preflight.mjs");
const DEPLOY = path.join(ROOT, "scripts", "deploy-main.mjs");
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dpq-preflight-"));
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "○" : "✗"} ${name}${detail ? `  ${detail}` : ""}`);
}

function git(args, cwd) {
  return execFileSync(REAL_GIT, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
  }).replace(/\n$/, "");
}

/** 使い捨ての「遠くの origin」と、その複製を1組つくる */
function newWorld(name, { commits = 2, migrations = ["20260901120000_alpha.sql"] } = {}) {
  const dir = path.join(TMP, name);
  const origin = path.join(dir, "origin.git");
  const seed = path.join(dir, "seed");
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "--bare", "-b", "main", origin], TMP);
  fs.mkdirSync(seed, { recursive: true });
  git(["init", "-b", "main", "."], seed);
  fs.mkdirSync(path.join(seed, "supabase", "migrations"), { recursive: true });
  for (const m of migrations) {
    fs.writeFileSync(path.join(seed, "supabase", "migrations", m), `-- ${m}\nselect 1;\n`);
  }
  for (let i = 0; i < commits; i += 1) {
    fs.writeFileSync(path.join(seed, `file-${i}.txt`), `${i}\n`);
    git(["add", "-A"], seed);
    git(["commit", "-m", `commit ${i}`], seed);
  }
  git(["remote", "add", "origin", origin], seed);
  git(["push", "-u", "origin", "main"], seed);

  const work = path.join(dir, "work");
  git(["clone", origin, work], dir);
  git(["config", "user.email", "t@example.invalid"], work);
  git(["config", "user.name", "t"], work);
  return { dir, origin, seed, work };
}

/** seed 側で1コミット進めて push する（＝別の誰かが main を進めた） */
function advanceOrigin(world, message) {
  fs.appendFileSync(path.join(world.seed, "file-0.txt"), `${message}\n`);
  git(["add", "-A"], world.seed);
  git(["commit", "-m", message], world.seed);
  git(["push", "origin", "main"], world.seed);
}

function addMigration(repo, name, commitMessage) {
  const dir = path.join(repo, "supabase", "migrations");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `-- ${name}\nselect 1;\n`);
  if (commitMessage) {
    git(["add", "-A"], repo);
    git(["commit", "-m", commitMessage], repo);
  }
}

function runPreflight(cwd, extra = [], env = {}) {
  const r = spawnSync(process.execPath, [PREFLIGHT, "--cwd", cwd, ...extra], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

console.log("");
console.log("作業木の柵の自己試験（本物の origin へは1バイトも送りません）");
console.log("");

/* ── A 最新でまっさら ─────────────────────────────────── */
{
  const w = newWorld("A");
  const core = runPreflight(w.work);
  const db = runPreflight(w.work, ["--db"]);
  const deploy = runPreflight(w.work, ["--deploy"]);
  check("A 最新でまっさらな作業木は通る（共通）", core.code === 0, `終了コード ${core.code}`);
  check("A 同じ作業木は DB 条件も通る", db.code === 0, `終了コード ${db.code}`);
  check("A 同じ作業木はデプロイ条件も通る", deploy.code === 0, `終了コード ${deploy.code}`);
}

/* ── B 1コミット遅れ ──────────────────────────────────── */
{
  const w = newWorld("B");
  advanceOrigin(w, "あとから入った1件");
  const r = runPreflight(w.work);
  check("B 1コミット遅れの作業木は止まる", r.code === 1, `終了コード ${r.code}`);
  check("B 遅れの数を出す", /1 コミット遅れ/.test(r.out), "「1 コミット遅れ」");
  check(
    "B 直しかたを出す（自分では直さない）",
    /git worktree add/.test(r.out) && /merge \/ rebase \/ reset \/ stash \/ commit を行いません/.test(r.out),
    "",
  );
}

/* ── C 73コミット遅れ（2026-09-18 に実際に起きた形） ──── */
{
  const w = newWorld("C");
  for (let i = 0; i < 73; i += 1) advanceOrigin(w, `追いついていない ${i}`);
  const core = runPreflight(w.work);
  const db = runPreflight(w.work, ["--db"]);
  check("C 73コミット遅れは止まる", core.code === 1, `終了コード ${core.code}`);
  check("C 73という数をそのまま出す", /73 コミット遅れ/.test(core.out), "");
  check("C DBへの書き込みも止まる", db.code === 1, `終了コード ${db.code}`);
}

/* ── D 未コミットの変更がある ─────────────────────────── */
{
  const w = newWorld("D");
  fs.appendFileSync(path.join(w.work, "file-0.txt"), "手元だけの変更\n");
  const r = runPreflight(w.work);
  check("D 未コミットの変更があると止まる", r.code === 1, `終了コード ${r.code}`);
  check("D 何件あるかとファイル名を出す", /未コミットの変更が 1 件/.test(r.out) && /file-0\.txt/.test(r.out), "");
}

/* ── D' 自動生成のファイルは数えない ──────────────────── */
{
  const w = newWorld("Dx");
  fs.writeFileSync(path.join(w.work, "統合.md"), "常駐ジョブが作り直すファイル\n");
  fs.mkdirSync(path.join(w.work, "統合サムネイル"), { recursive: true });
  fs.writeFileSync(path.join(w.work, "統合サムネイル", "1.png"), "x");
  const r = runPreflight(w.work);
  check("D' 常駐ジョブが作るファイルだけなら止まらない", r.code === 0, `終了コード ${r.code}`);
  check("D' それでも件数は申告する", /自動で書き換わるファイル/.test(r.out), "");
}

/* ── E 確認の途中で遠くの main が進む ─────────────────── */
{
  const w = newWorld("E");
  fs.appendFileSync(path.join(w.work, "file-0.txt"), "出したい変更\n");
  git(["add", "-A"], w.work);
  git(["commit", "-m", "出したい変更"], w.work);
  const mine = git(["rev-parse", "HEAD"], w.work);

  // 2回目の ls-remote の直前に、別の誰かが main を進める。
  // git を PATH で差し替えて割り込ませる。**製品の側には試験用の穴を作らない。**
  const bin = path.join(w.dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const counter = path.join(w.dir, "ls-remote-count");
  fs.writeFileSync(
    path.join(bin, "git"),
    [
      "#!/bin/sh",
      `if [ "$1" = "ls-remote" ]; then`,
      `  n=$(cat ${counter} 2>/dev/null || echo 0)`,
      "  n=$((n+1))",
      `  echo "$n" > ${counter}`,
      '  if [ "$n" -eq 2 ]; then',
      `    cd ${w.seed} && ${REAL_GIT} commit --allow-empty -m 割り込み >/dev/null 2>&1 && ${REAL_GIT} push origin main >/dev/null 2>&1`,
      `    cd ${w.work}`,
      "  fi",
      "fi",
      `exec ${REAL_GIT} "$@"`,
      "",
    ].join("\n"),
  );
  fs.chmodSync(path.join(bin, "git"), 0o755);

  const r = spawnSync(process.execPath, [DEPLOY, "--cwd", w.work, "--apply"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  const originMain = git(["rev-parse", "main"], w.origin);
  check("E 確認の途中で main が進んだら、送る前に止まる", r.status === 1, `終了コード ${r.status}`);
  check("E 進んだことを理由として出す", /進みました/.test(out), "");
  check("E 手元のコミットは送られていない", originMain !== mine, `origin/main=${originMain.slice(0, 7)} 手元=${mine.slice(0, 7)}`);
}

/* ── F 手元だけ3コミット進んでいる ────────────────────── */
{
  const w = newWorld("F");
  for (let i = 0; i < 3; i += 1) {
    fs.writeFileSync(path.join(w.work, `local-${i}.txt`), `${i}\n`);
    git(["add", "-A"], w.work);
    git(["commit", "-m", `手元だけ ${i}`], w.work);
  }
  const r = runPreflight(w.work);
  check("F 手元だけ進んでいるのは通る", r.code === 0, `終了コード ${r.code}`);
  check("F 進みの数を申告する", /しか無いコミットが 3 件/.test(r.out), "");
}

/* ── G 版番号が食い違う作業木（2026-09-09 の形）────────── */
{
  const w = newWorld("G", { migrations: ["20260909180000_billing_founding_creator_v0.sql"] });
  addMigration(w.work, "20260909180000_profile_rpc_revoke_anon.sql", "別の作業線が同じ版番号を使った");
  const core = runPreflight(w.work);
  const db = runPreflight(w.work, ["--db"]);
  check("G 版番号が重なっていても、共通の確認だけなら通る", core.code === 0, `終了コード ${core.code}`);
  check("G DBへの書き込みは止まる", db.code === 1, `終了コード ${db.code}`);
  check(
    "G どの版番号がどのファイルと重なっているかを出す",
    /20260909180000/.test(db.out) && /profile_rpc_revoke_anon/.test(db.out) && /billing_founding_creator_v0/.test(db.out),
    "",
  );
}

/* ── G' origin/main の migration を持っていない作業木 ──── */
{
  const w = newWorld("Gx");
  addMigration(w.seed, "20260910120000_added_after_clone.sql", "あとから入った migration");
  git(["push", "origin", "main"], w.seed);
  const db = runPreflight(w.work, ["--db"]);
  check("G' origin/main にある migration を持っていなければ止まる", db.code === 1, `終了コード ${db.code}`);
  check(
    "G' 欠けている本数と名前を出す",
    /無い migration が 1 本/.test(db.out) && /20260910120000_added_after_clone/.test(db.out),
    "",
  );
}

/* ── H 最新＋意図した migration 1本 ───────────────────── */
{
  const w = newWorld("H");
  addMigration(w.work, "20260920120000_intended_change.sql", "出すつもりの1本");
  const db = runPreflight(w.work, ["--db"]);
  const deploy = runPreflight(w.work, ["--deploy"]);
  check("H 最新の作業木＋意図した1本は通る", db.code === 0, `終了コード ${db.code}`);
  check("H これから当てる1本を名指しで出す", /20260920120000_intended_change/.test(db.out), "");
  check("H デプロイ条件も通る", deploy.code === 0, `終了コード ${deploy.code}`);

  const dry = spawnSync(process.execPath, [DEPLOY, "--cwd", w.work], { encoding: "utf8" });
  const out = `${dry.stdout || ""}${dry.stderr || ""}`;
  const before = git(["rev-parse", "main"], w.origin);
  check("H 下見は何も送らない", dry.status === 0 && /1バイトも送っていません/.test(out), `終了コード ${dry.status}`);
  check("H 下見のあとも origin/main は動いていない", git(["rev-parse", "main"], w.origin) === before, "");
}

/* ── 判定そのものの試験（git を呼ばない）──────────────── */
{
  const base = {
    remote: "origin",
    branch: "main",
    repo: "/tmp/x",
    worktree: "/tmp/x",
    head: "a".repeat(40),
    headSubject: "x",
    onBranch: "main",
    isMainWorktree: true,
    fetch: { done: true, error: null },
    remoteMain: { sha: "b".repeat(40), error: null },
    localRemoteRef: { sha: "b".repeat(40), error: null },
    refMatchesRemote: true,
    mergeBase: "b".repeat(40),
    behind: 0,
    ahead: 0,
    dirty: { unexpected: [], noise: [] },
    migrations: { local: [], remote: [], missing: [], localOnly: [], collisions: [], remoteError: null, exists: true },
    error: null,
  };

  const ok = judge(base, { mode: "db" });
  check("判定 条件がそろっていれば合格", ok.ok === true, "");

  const stale = judge({ ...base, refMatchesRemote: false, localRemoteRef: { sha: "c".repeat(40), error: null } }, { mode: "core" });
  check("判定 手元の控えが古ければ止める", stale.ok === false && stale.blockers.some((b) => b.code === "C2"), "");

  const noRemote = judge({ ...base, remoteMain: { sha: null, error: "つながりません" } }, { mode: "core" });
  check("判定 遠くの main を読めなければ止める", noRemote.ok === false && noRemote.blockers.some((b) => b.code === "C1"), "");

  const behind86 = judge({ ...base, behind: 86 }, { mode: "core" });
  check("判定 86コミット遅れを止める（主作業木の実測値）", behind86.ok === false && /86 コミット遅れ/.test(behind86.blockers[0].title), "");
}

/* ── まとめ ───────────────────────────────────────────── */

fs.rmSync(TMP, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
recordCount("作業木の柵の自己試験", results.length);

console.log("");
if (failed.length === 0) {
  console.log(`✓ ${results.length} 件すべて期待どおりでした。`);
  process.exit(0);
}
console.log(`✗ ${results.length} 件中 ${failed.length} 件が期待どおりではありません:`);
for (const f of failed) console.log(`  - ${f.name} ${f.detail}`);
process.exit(1);
