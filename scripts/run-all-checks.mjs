#!/usr/bin/env node
/**
 * run-all-checks.mjs ／ ローカルで回せる検査を一括で通す
 *
 * 実行: npm run test:all
 *
 * 【この1本で回るもの】
 *   1. 本番接続を止める柵の自己試験      … 柵が効くことを先に確かめる
 *   2. まっさらなDBへの全 migration 適用 ＋ 縦断試験
 *   3. 旧 migration 状態からのアップグレード試験
 *   4. DB構造・権限・漏洩経路の検査
 *   5. 語彙の検査と棚卸しの書き出し
 *   6. TypeScript / ESLint / 配色 / build
 *   7. 落ちたときに記録が残るかの自己試験（わざと1件落とす）
 *   8. ブラウザ試験（スマホ幅を含む）
 *   9. 既存スモーク11本（検証用の環境へ向けて）
 *  10. 文書に書いた件数と、この回の実測の突き合わせ
 *
 * 【この1本で回らないもの】
 *   本番の Supabase を相手にする検査（db:verify / smoke:prod）。
 *   資格情報が要るので、ここからは呼ばない。**未確認として残る。**
 *
 * 柵の自己試験を最初に置くのは、柵が壊れていたら
 * 後続がすべて「本番へ行きうる状態」で走るため。
 *
 * 【工程は1つずつ。重ねない】
 *   next dev を立てる工程（ブラウザ試験・スモーク・自己試験）が2つ同時に
 *   走ると、計算機を奪い合って「画面が出ない」形で落ちる。アプリの不具合と
 *   区別が付かない失敗になるので、**構造として同時に走れないようにする。**
 *     ・重い検査は `.test-locks/heavy.lock` を取った1本だけが走る
 *     ・工程と工程のあいだで、札とポート（3220 / 3230）が空くのを待つ
 *   別の窓で test:e2e を走らせたまま test:all を始めても、
 *   奪い合わずに順番待ちになる。
 *
 * 【記録】
 *   工程ごとの出力を、**合格・不合格を問わず全文**
 *   `.test-logs/all-<日時>/` へ落とす。抜き出した数十行だけを残す形はやめた。
 *   原因の手前にある行が消えて、追えなくなるため。
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectEnvironment, neutraliseEnvFiles } from "../test/guard/no-production.mjs";
import { acquireHeavyLock, heavyLockHolder, waitForFreePort } from "../test/e2e/exclusive.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOG_DIR = join(ROOT, ".test-logs");

/**
 * 検証用サーバーが使うポート。
 *
 * **工程と工程のあいだで、必ず空いていることを確かめる。**
 * 前の工程の next dev が残ったまま次を始めると、次は古いアプリを叩き、
 * 原因の分からない失敗が並ぶ（2026-09-05 に実測）。
 */
const SERVER_PORTS = [3220, 3230];

/**
 * 子プロセスへ渡す環境。
 *
 * 【.env.local の値が1つも入らないようにする】
 *   2つの手当てを重ねる。
 *
 *   1. NEXT_DISABLE_ENV_FILES=1 …… scripts/check-env.mjs がこの印を見て
 *      `.env.local` を開くのをやめる。**Next.js には効かない**
 *      （16.2.12 の @next/env にこの分岐は無い。実測）。
 *   2. `.env.local` に書かれている**名前を先に埋める** …… Next.js は
 *      「すでにある名前は上書きしない」ので、名前さえ埋めておけば
 *      本番の値は1つも入ってこない。埋める値は当たり障りのない印。
 *
 *   これで `npm run test:all` の全工程が、本番の値を1つも受け取らない。
 *
 * 【代わりの値を置く】
 *   読まないと build が接続先を持たないので、**ローカルの偽の値**を置く。
 *   127.0.0.1 なので、万一つなぎに行っても外へは出ない。
 *   実際に build が接続することはない（静的にする4ページは
 *   Supabase を呼ばない）。
 */
const CHILD_ENV = neutraliseEnvFiles({
  ...process.env,
  NEXT_DISABLE_ENV_FILES: "1",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_local_checks_only",
  SUPABASE_SECRET_KEY: "sb_secret_local_checks_only",
  NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:3000",
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
  TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
});

// **渡す前に、その環境に本番が混ざっていないか見る。**
// 親のシェルに本番の値が残っていたら、そのまま子へ流れる。
{
  const problems = inspectEnvironment(CHILD_ENV);
  if (problems.length > 0) {
    console.error("\n一括の検査へ渡す環境に本番が混ざっています:");
    for (const p of problems) console.error(`  ・${p}`);
    console.error("");
    process.exit(70);
  }
}

const STEPS = [
  { key: "guard", name: "本番接続を止める柵の自己試験", cmd: "npm", args: ["run", "test:guard"] },
  { key: "db", name: "まっさらなDBへの全 migration ＋ 縦断試験", cmd: "npm", args: ["run", "test:db"] },
  { key: "db-upgrade", name: "旧 migration 状態からのアップグレード試験", cmd: "npm", args: ["run", "test:db:upgrade"] },
  { key: "db-verify", name: "DB構造・権限・漏洩経路の検査", cmd: "npm", args: ["run", "db:verify:local"] },
  { key: "vocab", name: "語彙の検査と棚卸し", cmd: "npm", args: ["run", "check:vocab"] },
  { key: "typescript", name: "TypeScript", cmd: "npm", args: ["run", "typecheck"] },
  { key: "eslint", name: "ESLint", cmd: "npx", args: ["eslint"] },
  { key: "contrast", name: "配色（contrast）", cmd: "npm", args: ["run", "check:contrast"] },
  // build だけは、この一括の側で札を取る。
  // `npm run build` は Vercel でも走るので、npm scripts には包みを付けない
  // （あちらに同時に走る相手が居ないため）。
  { key: "build", name: "build", cmd: "npm", args: ["run", "build"], holdLock: true },
  // **記録の自己試験を、本番のブラウザ試験より先に置く。**
  // わざと1件落とす回なので、あとに置くと .test-logs の「最新」が
  // 落ちた回で上書きされ、直前の合格の記録が読めなくなる。
  { key: "record-selftest", name: "落ちたときに記録が残るかの自己試験", cmd: "npm", args: ["run", "test:e2e:selftest"] },
  { key: "e2e", name: "ブラウザ試験", cmd: "npm", args: ["run", "test:e2e"] },
  { key: "smoke", name: "既存スモーク11本", cmd: "npm", args: ["run", "test:smoke:local"] },
  // **最後に置く。**文書に書いた件数を、この回の実測と突き合わせる。
  // 先に置くと、まだ走っていない検査の件数が「未計測」になる。
  { key: "doc-counts", name: "文書に書いた件数の突き合わせ", cmd: "npm", args: ["run", "check:docs"] },
];

// 連続実行の回数は引数で変えられる。
//   npm run test:all -- --e2e-rounds 3 --smoke-rounds 5
function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const e2eRounds = Number.parseInt(argValue("--e2e-rounds", "1"), 10);
const smokeRounds = Number.parseInt(argValue("--smoke-rounds", "1"), 10);

if (e2eRounds > 1) {
  const step = STEPS.find((x) => x.name === "ブラウザ試験");
  step.name = `ブラウザ試験（${e2eRounds}周連続）`;
  step.repeat = e2eRounds;
}
if (smokeRounds > 1) {
  const step = STEPS.find((x) => x.name === "既存スモーク11本");
  step.name = `既存スモーク11本（${smokeRounds}周連続）`;
  step.args = ["run", "test:smoke:local", "--", "--rounds", String(smokeRounds)];
}

/**
 * 1工程を走らせる。**プロセスが終わり切るまで返らない。**
 *
 * close は「標準出力も標準エラーも閉じ、プロセスが終わった」時点で来る。
 * exit だけを見ると、まだ出力を書いている途中で次へ進んでしまう。
 */
function run(step) {
  return new Promise((resolve) => {
    const child = spawn(step.cmd, step.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: CHILD_ENV,
    });
    const out = [];
    child.stdout.on("data", (d) => out.push(d.toString()));
    child.stderr.on("data", (d) => out.push(d.toString()));
    child.on("error", (e) => out.push(`\n[起動できませんでした] ${e.message}\n`));
    child.on("close", (code, signal) =>
      resolve({ code: code ?? (signal ? 128 : 1), signal, output: out.join("") }),
    );
  });
}

/**
 * 次の工程へ進んでよいかを確かめる。
 *
 * 【なぜ要るか】
 *   工程を順番に並べるだけでは足りない。**前の工程が残したもの**が
 *   次の工程を壊す。見るのは2つ。
 *     1. 重い検査の札を、他の誰かが持っていないか
 *        （別の窓で test:e2e を走らせている、など）
 *     2. 検証用サーバーのポートが空いているか
 *   どちらも「待てば解決する」ものなので、待つ。待っても駄目なら、
 *   そのことを名前を付けて言う。**黙って次を始めない。**
 */
async function waitUntilQuiet({ waitMs = 10 * 60_000 } = {}) {
  const started = Date.now();
  let announced = false;

  for (;;) {
    const holder = heavyLockHolder();
    if (!holder) break;
    if (!announced) {
      console.log(
        `\n（順番待ち: いま別の重い検査が走っています — 「${holder.name}」` +
          `／PID ${holder.pid}）`,
      );
      announced = true;
    }
    if (Date.now() - started > waitMs) {
      return `重い検査の札が ${Math.round((Date.now() - started) / 1000)} 秒 空きませんでした（${holder.name}）`;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  for (const port of SERVER_PORTS) {
    const code = await waitForFreePort(port, { timeoutMs: 30_000 });
    if (code !== null) return `ポート ${port} が空きません（${code}）`;
  }
  return null;
}

const results = [];

// この実行ぶんの記録の置き場所。**合格・不合格を問わず全文を残す。**
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(LOG_DIR, `all-${stamp}`);
mkdirSync(runDir, { recursive: true });
console.log(`記録の置き場所: ${runDir}\n`);

/**
 * 記録ファイルの名前。
 *
 * 工程の名前は日本語なので、そのままではファイル名として読みにくい
 * （置き換えると全部 `_` になる）。工程ごとに短い英字の合言葉（key）を
 * 付けてあるので、番号と合わせて使う。**あとから中身を探せることが目的。**
 */
function slug(step, i) {
  return `${String(i + 1).padStart(2, "0")}-${step.key ?? "step"}`;
}

for (const [i, step] of STEPS.entries()) {
  // **工程どうしを重ねない。**前の工程の後片づけが終わるのを待ってから始める
  const busy = await waitUntilQuiet();
  if (busy) {
    console.log(`── ${step.name} … 開始できません（${busy}）`);
    const rec = { ...step, code: 78, output: `工程を始められませんでした: ${busy}`, secs: 0 };
    writeFileSync(join(runDir, `${slug(step, i)}.log`), rec.output);
    results.push(rec);
    continue;
  }

  process.stdout.write(`── ${step.name} … `);
  const started = Date.now();

  // 自分では札を取らない工程（build）は、ここで札を取って走らせる。
  // 取らないと、別の窓で走っているブラウザ試験と計算機を奪い合う。
  const release = step.holdLock ? await acquireHeavyLock(`一括の検査: ${step.name}`) : null;

  // ブラウザ試験だけは、同じコマンドを指定回数くり返す
  // （中で周回できる作りになっていないため）。
  let r = { code: 0, output: "" };
  const rounds = [];
  try {
    for (let round = 1; round <= (step.repeat ?? 1); round += 1) {
      const one = await run(step);
      rounds.push({ round, code: one.code, output: one.output });
      r = one;
      if (one.code !== 0) break;
    }
  } finally {
    if (release) release();
  }

  const secs = Math.round((Date.now() - started) / 1000);
  console.log(`${r.code === 0 ? "合格" : "不合格"}（${secs}秒）`);

  // **抜き出さずに、全文をそのまま置く。**周を重ねた場合は全周ぶん。
  const file = join(runDir, `${slug(step, i)}.log`);
  writeFileSync(
    file,
    rounds
      .map((x) => `===== ${step.name} ${x.round}周目（終了コード ${x.code}）=====\n${x.output}`)
      .join("\n"),
  );

  results.push({ ...step, ...r, secs, logFile: file, rounds: rounds.length });
}

const failed = results.filter((r) => r.code !== 0);

// --- 機械で読める要約。**合格した工程も全部載せる** --------------------------
writeFileSync(
  join(runDir, "summary.json"),
  JSON.stringify(
    {
      startedAt: stamp,
      endedAt: new Date().toISOString(),
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      steps: results.map((r) => ({
        name: r.name,
        code: r.code,
        secs: r.secs,
        rounds: r.rounds ?? 1,
        log: r.logFile ?? null,
      })),
    },
    null,
    2,
  ),
);

console.log("\n===== 工程ごとの記録 =====");
for (const r of results) {
  console.log(
    `  ${r.code === 0 ? "合格" : "不合格"}  ${String(r.secs).padStart(4)}秒  ${r.name}` +
      (r.logFile ? `\n         ${r.logFile}` : ""),
  );
}

console.log("\n===== 不合格の中身 =====");
if (failed.length === 0) console.log("（なし）");
for (const r of failed) {
  console.log(`\n── ${r.name}（終了コード ${r.code}）`);
  console.log(`   全文: ${r.logFile}`);
  const lines = r.output.split("\n").filter((l) => /✗|error|Error|不合格|種類:|段:|URL:|※/.test(l));
  console.log(lines.slice(0, 40).join("\n") || r.output.slice(-2000));
}

console.log(
  `\n合計 ${results.length} 工程 / 合格 ${results.length - failed.length} / 不合格 ${failed.length}`,
);
console.log(
  "\nここで回っていないもの: 本番の Supabase を相手にする検査（db:verify / smoke:prod）。" +
    "\n本番の資格情報が要るので、この一括からは呼んでいない。",
);

process.exit(failed.length === 0 ? 0 : 1);
