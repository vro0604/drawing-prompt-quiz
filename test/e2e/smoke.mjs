/**
 * smoke.mjs ／ 既存のスモーク11本を、検証用の環境で実際に走らせる
 *
 * 実行:
 *   npm run test:smoke:local                        11本を1周
 *   npm run test:smoke:local -- --rounds 5          11本を5周（毎周まっさら）
 *   npm run test:smoke:local -- --only anon --times 10   1本を10回（毎回まっさら）
 *   npm run test:smoke:local -- --rounds 5 --share-server
 *                                                   1つの環境に5周ぶん流す
 *
 * スモークは本来「動いている本番相当のサーバー」を叩く道具で、
 * 本番の Supabase を前提にしている。ここでは
 *   ・DB は PGlite
 *   ・Supabase の API は test/e2e/supabase-mock.mjs
 *   ・アプリは next dev
 * の3つを立て、そこへ向けて同じスクリプトをそのまま走らせる。
 *
 * **スクリプト側は1行も変えていない。**変えるのは環境変数だけ。
 *
 * ============================================================================
 * 【周ごとに検証環境を作り直す】
 * ============================================================================
 *
 *   1周は「11本を頭から通す」こと。2周目はまっさらな環境で始める。
 *
 *   1つの環境に5周ぶん流したときに何が起きるかは、2026-09-05 に実測した。
 *
 *     ・next dev は、使っている記憶領域が上限の8割を超えると
 *       自分を終了させて立て直す（node_modules/next/dist/server/lib/
 *       start-server.js の "approaching the used memory threshold"）。
 *       立て直しのあいだ番号は接続を受け付けず、そこへ来た要求は
 *       ECONNRESET → ECONNREFUSED になる。呼んだ側からは
 *       「TypeError: fetch failed」としか見えない。
 *       上限を 2240MB から 4096MB へ上げても、40分続けると届いた。
 *
 *     ・同じ PGlite にデータが積み上がる。1周目に10秒だった smoke-work が
 *       3周目には181秒になった。前提（一覧の中身・いいねの有無）も変わる。
 *
 *   どちらも「11本を5回続けて回す」ことの本質ではない。**環境を作り直す。**
 *   1周のあいだに起きることは、ふだんの1回の実行とまったく同じになる。
 *
 *   1つの環境で通しで流したいときは `--share-server` を付ける。
 *   そちらは長時間の連続稼働に何が起きるかを見るための、別の試験になる。
 *
 * ============================================================================
 * 【1本ごとに、サーバーが応答することを先に確かめる】
 * ============================================================================
 *
 *   以前は最初に1回だけ「/ が開くか」を見て、あとは11本を続けて回していた。
 *   その形だと、途中でサーバーが落ちたり作り直しに入ったりしたときに、
 *   **次のスクリプトが「通信が切れました」で落ちる。**
 *   落ちた側のスクリプトの名前だけが残るので、原因がそこにあるように見える。
 *
 *   ここでやるのは待つことではなく、**切り分け**である。
 *     ・始める前に応答しなければ「サーバーが応答しない」と言って止める
 *     ・終わったあとに応答しなければ「このスクリプトの最中に落ちた」と言う
 *   どちらもスクリプトの失敗とは別の事実なので、別の言葉で出す。
 *
 * ============================================================================
 * 【失敗したらサーバー側の出力も並べる】
 * ============================================================================
 *
 *   通信が切れたとき、切れた側（スクリプト）の言い分しか残らないと、
 *   相手が何をしていたのか分からない。next dev の出力を溜めておいて、
 *   失敗したスクリプトの詳細の後ろに、その間に出た行を並べる。
 */

import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installLocalOnlyGuard } from "../guard/no-production.mjs";
import { startApp } from "./server.mjs";
import { acquireHeavyLock } from "./exclusive.mjs";
import { recordCount } from "../counts.mjs";

// **最初のネットワーク要求より前に柵を立てる。**
// 本番のURL・project ref・ホスト名・鍵が環境にあれば、ここで異常終了する。
installLocalOnlyGuard("ローカルのスモーク一括（test:smoke:local）");
import { ANON_KEY, SERVICE_KEY } from "./supabase-mock.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const ALL_SCRIPTS = [
  "smoke-draft.mjs",
  "smoke-play.mjs",
  "smoke-work.mjs",
  "smoke-answer.mjs",
  "smoke-social.mjs",
  "smoke-ranking.mjs",
  "smoke-profile.mjs",
  "smoke-report.mjs",
  "smoke-account.mjs",
  "smoke-race.mjs",
  "smoke-anon.mjs",
];

function argValue(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const only = argValue("--only");
const rounds = Number.parseInt(argValue("--rounds", "1"), 10);
const times = Number.parseInt(argValue("--times", "1"), 10);

const SCRIPTS = only
  ? [only.endsWith(".mjs") ? only : `smoke-${only}.mjs`]
  : ALL_SCRIPTS;

const REPEAT = only ? times : rounds;

function run(script, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, "scripts", script)], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const out = [];
    child.stdout.on("data", (d) => out.push(d.toString()));
    child.stderr.on("data", (d) => out.push(d.toString()));
    child.on("close", (code) => resolve({ code, output: out.join("") }));
  });
}

/**
 * サーバーが応答するか。**待たずに1回だけ聞く用と、待つ用の両方に使う。**
 * 返すのは「応答したか」と、応答しなかったときの理由。
 */
async function ping(base, { timeoutMs = 0 } = {}) {
  const started = Date.now();
  let lastError = "";
  for (;;) {
    try {
      const res = await fetch(`${base}/`, { redirect: "manual" });
      if (res.status < 500) return { ok: true, waitedMs: Date.now() - started };
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = `${e.message}${e.cause?.code ? `（${e.cause.code}）` : ""}`;
    }
    if (Date.now() - started >= timeoutMs) {
      return { ok: false, waitedMs: Date.now() - started, error: lastError };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

const shareServer = process.argv.includes("--share-server");

function envFor(app) {
  return {
    ...process.env,
    SMOKE_BASE_URL: app.base,
    NEXT_PUBLIC_SUPABASE_URL: app.mock.url,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ANON_KEY,
    SUPABASE_SECRET_KEY: SERVICE_KEY,
    NEXT_PUBLIC_SITE_URL: app.base,
    CRON_SECRET: "e2e-cron-secret",
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
    TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
    // 本番向けの控えを上書きしない
    SMOKE_FIXTURES_FILE: join(ROOT, ".smoke-fixtures.e2e.json"),
  };
}

/**
 * 周ごとに使う控えの置き場所を分ける。
 *
 * 検査用の利用者の Cookie をここへ書き留めて使い回している。
 * 環境を作り直すと利用者もいなくなるので、**前の周の控えを持ち越さない。**
 * 持ち越すと、居ない人の Cookie で入ろうとして落ちる。
 */
function fixturesFileFor(round) {
  return join(ROOT, `.smoke-fixtures.e2e${round > 1 ? `.${round}` : ""}.json`);
}

// **重い検査は1つずつ。**next dev を立てるものが2つ同時に走ると、
// 計算機を奪い合って「サーバーが応答しない」形で落ちる。
const releaseHeavyLock = await acquireHeavyLock("ローカルのスモーク（test:smoke:local）");

/** この実行で作った控えファイル。**終わったら消す** */
const fixtureFiles = new Set();

const results = [];
let shared = shareServer ? await startApp({ port: 3230 }) : null;

for (let round = 1; round <= REPEAT; round += 1) {
  if (REPEAT > 1) {
    console.log(
      `\n===== ${round} 周目 / 全 ${REPEAT} 周` +
        `（${shareServer ? "環境は使い回し" : "まっさらな環境"}）=====`,
    );
  }

  const app = shared ?? (await startApp({ port: 3230 }));
  const fixtures = fixturesFileFor(round);
  fixtureFiles.add(fixtures);
  const env = { ...envFor(app), SMOKE_FIXTURES_FILE: fixtures };

  try {
    for (const script of SCRIPTS) {
      const label = REPEAT > 1 ? `${script}（${round}周目）` : script;
      process.stdout.write(`── ${label} … `);

      // --- 始める前に、相手が応答することを確かめる -------------------------
      //
      // 起動直後は、まだ道筋をひとつも組み立てていないことがある。
      // **待つのが目的ではなく、応答しないことをここで名指しするのが目的。**
      const beforeMark = app.logs.length;
      const before = await ping(app.base, { timeoutMs: 60_000 });
      if (!before.ok) {
        console.log("不合格（サーバーが応答しない）");
        results.push({
          script: label,
          code: -1,
          output: `検証用サーバーが応答しませんでした: ${before.error}`,
          failed: true,
          serverLog: app.logs.slice(beforeMark).join(""),
          reason: "サーバーが応答しない（このスクリプトを走らせる前）",
        });
        continue;
      }

      const started = Date.now();
      const r = await run(script, env);
      const secs = Math.round((Date.now() - started) / 1000);

      // --- 終わったあと、相手がまだ生きているか -----------------------------
      const after = await ping(app.base, { timeoutMs: 5_000 });

      const failed = /✗/.test(r.output) || r.code !== 0;

      // --- 検証用サーバーが途中で自分を作り直していないか -------------------
      //
      // next dev は記憶領域の8割で自分を終了させ、親が立て直す。
      // 立て直しのあいだ番号は接続を受け付けないので、そこへ来た要求は
      // ECONNRESET → ECONNREFUSED になる。呼んだ側には
      // 「TypeError: fetch failed」としか見えない。
      // **そう見えたときに、こちらが理由を言えるようにしておく。**
      const serverLog = app.logs.slice(beforeMark).join("");
      const restarted = serverLog.includes("approaching the used memory threshold");

      console.log(
        (failed
          ? after.ok
            ? "不合格"
            : "不合格（この最中にサーバーが落ちた）"
          : "合格") +
          `（${secs}秒）` +
          (restarted ? "  ※ この最中にサーバーが領域不足で作り直されました" : ""),
      );

      results.push({
        script: label,
        ...r,
        failed,
        serverLog,
        reason: !after.ok
          ? "このスクリプトの最中に検証用サーバーが応答しなくなった"
          : restarted
            ? "このスクリプトの最中に検証用サーバーが領域不足で作り直された" +
              "（接続の拒否は、その立て直しのあいだに起きたもの）"
            : null,
      });

      if (!after.ok) break;
    }
  } finally {
    if (!shared) await app.close();
  }
}

if (shared) await shared.close();
releaseHeavyLock();

/* --- 控えファイルを消す ------------------------------------------------------
 *
 * この控えには、検査用の利用者の Cookie と合言葉が入っている。
 * 中身が指しているのは**この実行のあいだだけ存在した PGlite の利用者**で、
 * 環境ごと消えたあとは何の役にも立たない。それでも置いたままにすると、
 * Git の追跡から漏れた瞬間に Cookie がリポジトリへ入る。
 * 役に立たないものを危険なまま置かない。**毎回消す。**
 */
{
  const removed = [];
  for (const f of fixtureFiles) {
    try {
      rmSync(f, { force: true });
      removed.push(f.split("/").pop());
    } catch (e) {
      console.warn(`（控えファイルを消せませんでした: ${f} … ${e.message}）`);
    }
  }
  if (removed.length > 0) {
    console.log(`\n（控えファイルを ${removed.length} 本 片づけました: ${removed.join(" ")}）`);
  }
}

console.log("\n===== 詳細 =====");
for (const r of results.filter((x) => x.failed)) {
  console.log(`\n── ${r.script}（終了コード ${r.code}）`);
  if (r.reason) console.log(`   ${r.reason}`);
  const lines = r.output.split("\n").filter((l) => /✗|Error|error|段:|原因:|用件:|経過:/.test(l));
  console.log(lines.slice(0, 24).join("\n") || r.output.slice(-1500));

  // サーバー側が何を言っていたか。**切れた側の言い分だけで終わらせない**
  //
  // 画面には終わりの40行だけ出し、**全文はファイルに落として場所を書く。**
  // 落ちた場所が始めのほうだと、終わりだけ見ても何も分からない。
  const server = (r.serverLog ?? "").split("\n").filter((l) => l.trim() !== "");
  if (server.length > 0) {
    const file = join(
      tmpdir(),
      `dpq-smoke-${r.script.replace(/[^\w.-]/g, "_")}-${Date.now()}.log`,
    );
    writeFileSync(file, `--- スクリプトの出力 ---\n${r.output}\n\n--- 検証用サーバーの出力 ---\n${server.join("\n")}\n`);
    console.log(`   --- そのあいだの検証用サーバーの出力（末尾40行。全文: ${file}）---`);
    for (const l of server.slice(-40)) console.log(`   ${l}`);
  }
}

const bad = results.filter((x) => x.failed).length;
console.log(
  `\n合計 ${results.length} 本 / 合格 ${results.length - bad} 本 / 不合格 ${bad} 本`,
);

// 文書に書いた本数と突き合わせられるように、実測を残す（1周ぶんの本数）
recordCount("スモーク", SCRIPTS.length);
process.exit(bad === 0 ? 0 : 1);
