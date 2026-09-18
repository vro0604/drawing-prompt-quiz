#!/usr/bin/env node
/**
 * hook-selftest.mjs ／ main への push が本当に止まることを、実際に push して確かめる
 *
 * 実行: npm run test:preflight:hook
 *
 * 【test/preflight/selftest.mjs との違い】
 *   あちらは判定そのものを試す（`npm run preflight` が何と言うか）。
 *   こちらは**git の通り道に置いた hook が、push を実際に止めるか**を試す。
 *   手で `git push origin <枝>:main` と打つ穴を塞げているかは、
 *   判定だけを見ても分からない。**押してみるしかない。**
 *
 * 【本物のリポジトリは使わない】
 *   使い捨ての置き場に bare リポジトリ（遠くの origin 役）と複製を作り、
 *   そこへ hook を入れて push する。**本物の GitHub へは1バイトも送らない。**
 *   判定の道具（scripts/_preflight.mjs と scripts/preflight-pre-push.mjs）だけを
 *   複製へ写して使う。
 *
 * 【13の場面】
 *   A まっさらな最新          → main への push が通る
 *   B 1コミット遅れ           → 拒否
 *   C 73コミット遅れ          → 拒否
 *   D 86コミット遅れ          → 拒否
 *   E 未コミットがある        → 拒否
 *   F weave の2パスだけ汚れ   → 通る
 *   G weave ＋ ほかに1件      → 拒否
 *   H origin/main の migration が無い → 拒否
 *   I 版番号の重複            → 拒否
 *   J 枝 → 枝 の push         → hook は邪魔しない
 *   K 枝 → main の push       → hook が動く
 *   L 確認の途中で main が進む → 拒否
 *   M 道具が壊れている／無い  → 拒否（分からないから通す、はしない）
 *
 *   さらに、作業木3つ（主・A・B）から main へ push して、
 *   共有の hook が全部に効くことを確かめる。
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePrePushInput, productionLines } from "../../scripts/preflight-pre-push.mjs";
import { recordCount } from "../counts.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const INSTALLER = path.join(ROOT, "scripts", "guard-hooks.mjs");
const COPY_FILES = [
  ["scripts", "_preflight.mjs"],
  ["scripts", "preflight-pre-push.mjs"],
];
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const IDENTITY = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dpq-hook-"));
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
    env: { ...process.env, ...IDENTITY },
  }).replace(/\n$/, "");
}

/** push を試す。止まったかどうかと、遠くの main が動いたかを返す */
function tryPush(cwd, args, env = {}) {
  const before = git(["rev-parse", "main"], originOf(cwd));
  const r = spawnSync(REAL_GIT, ["push", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...IDENTITY, ...env },
  });
  const after = git(["rev-parse", "main"], originOf(cwd));
  return {
    code: r.status,
    out: `${r.stdout || ""}${r.stderr || ""}`,
    movedRemote: before !== after,
    before,
    after,
  };
}

const ORIGINS = new Map();
function originOf(cwd) {
  for (const [work, origin] of ORIGINS) {
    if (cwd.startsWith(work)) return origin;
  }
  throw new Error(`origin が分かりません: ${cwd}`);
}

/** 使い捨ての「遠くの origin」と複製を1組つくり、hook を入れる */
function newWorld(name, { commits = 2, migrations = ["20260901120000_alpha.sql"], installHook = true } = {}) {
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
  // 判定の道具を写す（本物の repo からコピーする。中身は書き換えない）
  for (const rel of COPY_FILES) {
    const dst = path.join(seed, ...rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(ROOT, ...rel), dst);
  }
  fs.writeFileSync(path.join(seed, "統合.md"), "weave が作り直すファイル\n");
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
  ORIGINS.set(dir, origin);

  if (installHook) {
    const r = spawnSync(process.execPath, [INSTALLER, "--install"], {
      cwd: work,
      encoding: "utf8",
      env: { ...process.env, ...IDENTITY },
    });
    if (r.status !== 0) throw new Error(`hook を入れられませんでした: ${r.stdout}${r.stderr}`);
  }
  return { dir, origin, seed, work };
}

function advanceOrigin(world, message) {
  fs.appendFileSync(path.join(world.seed, "file-0.txt"), `${message}\n`);
  git(["add", "-A"], world.seed);
  git(["commit", "-m", message], world.seed);
  git(["push", "origin", "main"], world.seed);
}

function localCommit(repo, name) {
  fs.writeFileSync(path.join(repo, `${name}.txt`), `${name}\n`);
  git(["add", "-A"], repo);
  git(["commit", "-m", name], repo);
}

console.log("");
console.log("main への push を捕まえる hook の自己試験（本物の origin へは1バイトも送りません）");
console.log("");

/* ── A まっさらな最新 ─────────────────────────────────── */
{
  const w = newWorld("A");
  localCommit(w.work, "出したい変更");
  const r = tryPush(w.work, ["origin", "HEAD:refs/heads/main"]);
  check("A まっさらな最新の作業木からは main へ push できる", r.code === 0 && r.movedRemote, `終了コード ${r.code} / 遠くが動いた ${r.movedRemote}`);
  check("A hook が確認したことを出す", /条件を満たしています/.test(r.out) && /main への push を通します/.test(r.out), "");
}

/* ── B / C / D 遅れ ───────────────────────────────────── */
for (const [label, n] of [["B", 1], ["C", 73], ["D", 86]]) {
  const w = newWorld(`${label}${n}`);
  localCommit(w.work, "出したい変更");
  for (let i = 0; i < n; i += 1) advanceOrigin(w, `追いついていない ${i}`);
  const r = tryPush(w.work, ["origin", "HEAD:refs/heads/main"]);
  check(`${label} ${n}コミット遅れの作業木からの main push は止まる`, r.code !== 0 && !r.movedRemote, `終了コード ${r.code}`);
  check(`${label} 遅れの数をそのまま出す`, new RegExp(`${n} コミット遅れ`).test(r.out), `「${n} コミット遅れ」`);
}

/* ── E 未コミットがある ───────────────────────────────── */
{
  const w = newWorld("E");
  localCommit(w.work, "出したい変更");
  fs.appendFileSync(path.join(w.work, "file-0.txt"), "手元だけの変更\n");
  const r = tryPush(w.work, ["origin", "HEAD:refs/heads/main"]);
  check("E 未コミットがある作業木からの main push は止まる", r.code !== 0 && !r.movedRemote, `終了コード ${r.code}`);
  check("E 何件あるかを出す", /未コミットの変更が 1 件/.test(r.out), "");
}

/* ── F weave の2パスだけ ──────────────────────────────── */
{
  const w = newWorld("F");
  localCommit(w.work, "出したい変更");
  fs.appendFileSync(path.join(w.work, "統合.md"), "weave が書き足した\n");
  fs.mkdirSync(path.join(w.work, "統合サムネイル"), { recursive: true });
  fs.writeFileSync(path.join(w.work, "統合サムネイル", "1.png"), "x");
  const r = tryPush(w.work, ["origin", "HEAD:refs/heads/main"]);
  check("F weave の2パスだけが汚れていても main へ push できる", r.code === 0 && r.movedRemote, `終了コード ${r.code}`);
  check(
    "F 例外があることを出力に明示する",
    /未コミットから外した例外 2 件（完全一致の2パスのみ）/.test(r.out) && /前方一致も部分一致もしない/.test(r.out),
    "",
  );
}

/* ── G weave ＋ ほかに1件 ─────────────────────────────── */
{
  const w = newWorld("G");
  localCommit(w.work, "出したい変更");
  fs.appendFileSync(path.join(w.work, "統合.md"), "weave が書き足した\n");
  fs.writeFileSync(path.join(w.work, "統合.md.bak"), "似た名前だが weave ではない\n");
  const r = tryPush(w.work, ["origin", "HEAD:refs/heads/main"]);
  check("G weave の2パス以外が1件でもあれば止まる", r.code !== 0 && !r.movedRemote, `終了コード ${r.code}`);
  check("G 似た名前（統合.md.bak）を例外にしない", /統合\.md\.bak/.test(r.out) && /未コミットの変更が 1 件/.test(r.out), "");
}

/* ── H origin/main の migration が無い ───────────────── */
{
  const w = newWorld("H");
  // 遠くにだけ migration を足す。ただし遅れを作らないよう、work 側へ取り込んでから消す。
  // ここで手元にコミットを作ると早送りにならなくなるので、取り込みが先。
  fs.writeFileSync(path.join(w.seed, "supabase", "migrations", "20260910120000_added.sql"), "select 1;\n");
  git(["add", "-A"], w.seed);
  git(["commit", "-m", "あとから入った migration"], w.seed);
  git(["push", "origin", "main"], w.seed);
  git(["fetch", "origin", "main"], w.work);
  git(["merge", "--ff-only", "origin/main"], w.work);
  // 取り込んだうえで、ファイルだけをコミットして消す（＝古い作業木が持っていない状態）
  fs.unlinkSync(path.join(w.work, "supabase", "migrations", "20260910120000_added.sql"));
  git(["add", "-A"], w.work);
  git(["commit", "-m", "migration を持っていない状態"], w.work);
  const r = tryPush(w.work, ["origin", "HEAD:refs/heads/main"]);
  check("H origin/main にある migration を持っていなければ止まる", r.code !== 0 && !r.movedRemote, `終了コード ${r.code}`);
  check("H 欠けている名前を出す", /20260910120000_added/.test(r.out), "");
}

/* ── I 版番号の重複 ───────────────────────────────────── */
{
  const w = newWorld("I", { migrations: ["20260909180000_billing_founding_creator_v0.sql"] });
  fs.writeFileSync(
    path.join(w.work, "supabase", "migrations", "20260909180000_profile_rpc_revoke_anon.sql"),
    "select 1;\n",
  );
  git(["add", "-A"], w.work);
  git(["commit", "-m", "同じ版番号を使ってしまった"], w.work);
  const r = tryPush(w.work, ["origin", "HEAD:refs/heads/main"]);
  check("I 版番号が重なっていれば止まる", r.code !== 0 && !r.movedRemote, `終了コード ${r.code}`);
  check("I どの版番号がどのファイルと重なるかを出す", /20260909180000/.test(r.out) && /profile_rpc_revoke_anon/.test(r.out), "");
}

/* ── J 枝 → 枝 の push（邪魔しない）───────────────────── */
{
  const w = newWorld("J");
  git(["checkout", "-b", "feature/foo"], w.work);
  localCommit(w.work, "枝だけの変更");
  // わざと危ない状態（未コミット＋遅れ）にしておく。それでも枝への push は通る。
  fs.appendFileSync(path.join(w.work, "file-0.txt"), "未コミット\n");
  advanceOrigin(w, "遠くが進んだ");
  const before = git(["rev-parse", "main"], w.origin);
  const r = spawnSync(REAL_GIT, ["push", "origin", "feature/foo:refs/heads/feature/foo"], {
    cwd: w.work,
    encoding: "utf8",
    env: { ...process.env, ...IDENTITY },
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  const remoteHasBranch = git(["rev-parse", "--verify", "refs/heads/feature/foo"], w.origin);
  check("J 枝への push は、危ない作業木からでも通る", r.status === 0, `終了コード ${r.status}`);
  check("J 枝への push では確認を1行も出さない", !/本番を変える前の確認/.test(out), "");
  check("J 枝は遠くに作られ、main は動いていない", remoteHasBranch.length === 40 && git(["rev-parse", "main"], w.origin) === before, "");
}

/* ── K 枝 → main の push（hook が動く）────────────────── */
{
  const w = newWorld("K");
  git(["checkout", "-b", "feature/foo"], w.work);
  localCommit(w.work, "枝の変更");
  const r = tryPush(w.work, ["origin", "feature/foo:refs/heads/main"]);
  check("K 枝 → main の push でも hook が動く", /本番を変える前の確認/.test(r.out), "");
  check("K 送り先が main であることを出す", /送り先は main/.test(r.out) && /refs\/heads\/main/.test(r.out), "");
  check("K 条件を満たしていれば通る", r.code === 0 && r.movedRemote, `終了コード ${r.code}`);
}

/* ── K' 取り出していない枝を main へ送ろうとした ──────── */
{
  const w = newWorld("Kx");
  git(["checkout", "-b", "feature/bar"], w.work);
  localCommit(w.work, "別の枝の変更");
  git(["checkout", "main"], w.work);
  const r = tryPush(w.work, ["origin", "feature/bar:refs/heads/main"]);
  check("K' 取り出していない枝を main へ送るのは止まる", r.code !== 0 && !r.movedRemote, `終了コード ${r.code}`);
  check("K' 測ったものと送るものが違うと言う", /送るものが、この作業木の内容ではない/.test(r.out), "");
}

/* ── K'' main を消す push ─────────────────────────────── */
{
  const w = newWorld("Kd");
  const r = tryPush(w.work, ["origin", ":refs/heads/main"]);
  check("K'' main を消す push は止まる", r.code !== 0 && !r.movedRemote, `終了コード ${r.code}`);
  check("K'' 消す操作だと名指しで言う", /main を消す push である/.test(r.out), "");
}

/* ── L 確認の途中で遠くの main が進む ─────────────────── */
{
  const w = newWorld("L");
  localCommit(w.work, "出したい変更");

  // hook が「いまの遠くの main」を引きにいったその瞬間に、別の誰かが main を進める。
  // git を PATH で差し替えて割り込ませる。**製品の側に試験用の穴は作らない。**
  const bin = path.join(w.dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const counter = path.join(w.dir, "ls-remote-count");
  const log = path.join(w.dir, "interrupt.log");
  const interrupt = path.join(w.dir, "interrupt.sh");
  fs.writeFileSync(
    interrupt,
    [
      "#!/bin/sh",
      "set -e",
      `cd ${w.seed}`,
      `${REAL_GIT} -c user.name=t -c user.email=t@example.invalid commit --allow-empty -m 割り込み`,
      `${REAL_GIT} push origin main`,
      "",
    ].join("\n"),
  );
  fs.chmodSync(interrupt, 0o755);
  // git は hook を走らせるとき、自分の exec-path を PATH の先頭へ足す。
  // macOS の git-core には git 本体も入っているので、PATH に置いただけの
  // 差し替えは負ける（2026-09-18 に実測）。**node の側を差し替えて、
  // node が起きたあとで PATH を並べ替える。**
  fs.writeFileSync(
    path.join(bin, "node"),
    ["#!/bin/sh", `PATH="${bin}:$PATH"`, "export PATH", `exec ${process.execPath} "$@"`, ""].join("\n"),
  );
  fs.chmodSync(path.join(bin, "node"), 0o755);
  fs.writeFileSync(
    path.join(bin, "git"),
    [
      "#!/bin/sh",
      `if [ "$1" = "ls-remote" ]; then`,
      `  n=$(cat ${counter} 2>/dev/null || echo 0)`,
      "  n=$((n+1))",
      `  echo "$n" > ${counter}`,
      '  if [ "$n" -eq 1 ]; then',
      `    ${interrupt} >> ${log} 2>&1 || echo "割り込みに失敗" >> ${log}`,
      "  fi",
      "fi",
      `exec ${REAL_GIT} "$@"`,
      "",
    ].join("\n"),
  );
  fs.chmodSync(path.join(bin, "git"), 0o755);

  const r = tryPush(w.work, ["origin", "HEAD:refs/heads/main"], { PATH: `${bin}:${process.env.PATH}` });
  const interrupted = fs.existsSync(log) && !fs.readFileSync(log, "utf8").includes("割り込みに失敗");
  check("L 割り込みそのものが起きた（試験の前提）", interrupted, interrupted ? "" : fs.existsSync(log) ? fs.readFileSync(log, "utf8").slice(0, 200) : "記録なし");
  check("L 確認の途中で遠くの main が進めば止まる", r.code !== 0, `終了コード ${r.code}`);
  check("L 手元のコミットは遠くへ入っていない", r.after !== git(["rev-parse", "HEAD"], w.work), "");
  check("L 控えと遠くが食い違ったことを理由に出す", /手元の控えが古い/.test(r.out), "");
}

/* ── M 道具が壊れている／無い ─────────────────────────── */
{
  const w = newWorld("M1");
  localCommit(w.work, "出したい変更");
  fs.writeFileSync(path.join(w.work, "scripts", "_preflight.mjs"), "これは JavaScript ではない {{{\n");
  const r = tryPush(w.work, ["origin", "HEAD:refs/heads/main"]);
  check("M 判定の道具が壊れていたら止まる", r.code !== 0 && !r.movedRemote, `終了コード ${r.code}`);
  check("M 読み込めなかったと言う", /確認の道具を読み込めませんでした/.test(r.out), "");

  const w2 = newWorld("M2");
  localCommit(w2.work, "出したい変更");
  fs.rmSync(path.join(w2.work, "scripts", "preflight-pre-push.mjs"));
  const r2 = tryPush(w2.work, ["origin", "HEAD:refs/heads/main"]);
  check("M 入口そのものが無くても止まる（awk の受け皿）", r2.code !== 0 && !r2.movedRemote, `終了コード ${r2.code}`);
  check("M そのときも枝への push は通る", (() => {
    git(["checkout", "-b", "feature/zzz"], w2.work);
    const r3 = spawnSync(REAL_GIT, ["push", "origin", "feature/zzz:refs/heads/feature/zzz"], {
      cwd: w2.work,
      encoding: "utf8",
      env: { ...process.env, ...IDENTITY },
    });
    return r3.status === 0;
  })(), "");
}

/* ── 作業木3つへの効きかた（推測せず実測する）─────────── */
{
  const w = newWorld("WT");

  // 作業木A・B を、複製の中から作る（共有の git フォルダは work/.git）
  for (const name of ["wtA", "wtB"]) {
    git(["worktree", "add", "-b", `line/${name}`, path.join(w.dir, name), "main"], w.work);
    for (const rel of COPY_FILES) {
      const dst = path.join(w.dir, name, ...rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(ROOT, ...rel), dst);
    }
  }

  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], path.join(w.dir, "wtA"));
  check(
    "作業木A から見た共有 git フォルダが、主作業木のものと同じ",
    common === git(["rev-parse", "--path-format=absolute", "--git-common-dir"], w.work),
    path.basename(common),
  );
  check("hook はその共有フォルダに1つだけある", fs.existsSync(path.join(common, "hooks", "pre-push")), "");

  // 3つの作業木それぞれから main へ push を試す。
  //
  // 2つ気をつけることがある。
  //   ・**送るものが無い push では、git は hook を呼ばない。**だから各作業木に
  //     自分のコミットを1つ持たせる。持たせないと「効いた」の判定が嘘になる。
  //   ・1つ目が成功すると遠くの main が進み、2つ目からは食い違う（早送りにならない）。
  //     それでは「hook が止めたのか git が断ったのか」が混ざる。だから押すたびに、
  //     遠くの main を基点へ戻して、どの回も同じ条件にする。
  const base = git(["rev-parse", "main"], w.origin);
  for (const [label, cwd] of [["主作業木", w.work], ["作業木A", path.join(w.dir, "wtA")], ["作業木B", path.join(w.dir, "wtB")]]) {
    git(["update-ref", "refs/heads/main", base], w.origin);
    localCommit(cwd, `${label}から出す変更`);
    const r = tryPush(cwd, ["origin", "HEAD:refs/heads/main"]);
    check(`${label} からの main push で hook が動いた`, /本番を変える前の確認/.test(r.out), `終了コード ${r.code}`);
    check(`${label} からの push が通り、遠くの main が進んだ`, r.code === 0 && r.movedRemote, `終了コード ${r.code}`);
  }
  git(["update-ref", "refs/heads/main", base], w.origin);
}

/* ── ref の読みかた（文字列検索で雑に判定しない）───────── */
{
  const sample = [
    "refs/heads/main 1111111111111111111111111111111111111111 refs/heads/main-backup 2222222222222222222222222222222222222222",
    "refs/heads/feature/main-nav 3333333333333333333333333333333333333333 refs/heads/feature/main-nav 4444444444444444444444444444444444444444",
  ].join("\n");
  const parsed = parsePrePushInput(sample);
  check("ref 判定 main を含む別の枝を本番扱いにしない", productionLines(parsed).length === 0, `${parsed.lines.length} 行を読んで0件`);

  const real = parsePrePushInput(
    "refs/heads/feature/foo aaaa000000000000000000000000000000000000 refs/heads/main bbbb000000000000000000000000000000000000",
  );
  check("ref 判定 送り先が refs/heads/main の行だけを拾う", productionLines(real).length === 1, "");

  const del = parsePrePushInput(
    "(delete) 0000000000000000000000000000000000000000 refs/heads/main bbbb000000000000000000000000000000000000",
  );
  check("ref 判定 消す push を見分ける", productionLines(del)[0]?.deleting === true, "");

  const broken = parsePrePushInput("refs/heads/main 1111");
  check("ref 判定 4つに分けられない行は読めなかった扱いにする", broken.malformed.length === 1 && broken.lines.length === 0, "");
}

/* ── installer の作法 ─────────────────────────────────── */
{
  const w = newWorld("INST", { installHook: false });
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], w.work);
  const hookFile = path.join(common, "hooks", "pre-push");

  const st0 = spawnSync(process.execPath, [INSTALLER, "--status"], { cwd: w.work, encoding: "utf8" });
  check("installer 入っていないことを言える", st0.status === 1 && /入っていません/.test(st0.stdout), "");

  // 他人の hook を黙って上書きしない
  fs.mkdirSync(path.dirname(hookFile), { recursive: true });
  fs.writeFileSync(hookFile, "#!/bin/sh\n# だれかの既存 hook\nexit 0\n", { mode: 0o755 });
  const ins1 = spawnSync(process.execPath, [INSTALLER, "--install"], { cwd: w.work, encoding: "utf8" });
  check(
    "installer 別の pre-push があれば何も書かずに止まる",
    ins1.status === 1 && /何も書きませんでした/.test(ins1.stdout) && fs.readFileSync(hookFile, "utf8").includes("だれかの既存 hook"),
    "",
  );
  check("installer 続ける道を2つ出す", /--chain/.test(ins1.stdout), "");

  // chain なら、元のものを残したまま入る
  const ins2 = spawnSync(process.execPath, [INSTALLER, "--install", "--chain"], { cwd: w.work, encoding: "utf8" });
  const chained = path.join(common, "hooks", "pre-push.dpq-chained");
  check(
    "installer --chain で元の hook を残して入る",
    ins2.status === 0 && fs.existsSync(chained) && fs.readFileSync(chained, "utf8").includes("だれかの既存 hook"),
    "",
  );
  check("installer chain で入れた hook は元のものを先に呼ぶ", fs.readFileSync(hookFile, "utf8").includes("pre-push.dpq-chained"), "");

  // 外すと元のものが戻る
  const rm = spawnSync(process.execPath, [INSTALLER, "--remove"], { cwd: w.work, encoding: "utf8" });
  check(
    "installer 外すと元の hook が戻る",
    rm.status === 0 && fs.readFileSync(hookFile, "utf8").includes("だれかの既存 hook") && !fs.existsSync(chained),
    "",
  );
}

/* ── まとめ ───────────────────────────────────────────── */

fs.rmSync(TMP, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
recordCount("main push の柵の自己試験", results.length);

console.log("");
if (failed.length === 0) {
  console.log(`✓ ${results.length} 件すべて期待どおりでした。`);
  process.exit(0);
}
console.log(`✗ ${results.length} 件中 ${failed.length} 件が期待どおりではありません:`);
for (const f of failed) console.log(`  - ${f.name} ${f.detail}`);
process.exit(1);
