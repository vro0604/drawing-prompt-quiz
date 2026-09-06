/**
 * record-selftest.mjs ／ 「落ちたときに、ちゃんと記録が残るか」を確かめる
 *
 * 実行: npm run test:e2e:selftest
 *
 * 【なぜこれが要るか】
 *   2026-09-05 に、ブラウザ試験が単独で4回のうち1回だけ 39/40 になった。
 *   **どの1件が落ちたのか分からなかった。**記録が残っていなかったからで、
 *   原因を追う入口がそこで消えた。
 *
 *   記録を残す仕掛けを足したなら、その仕掛け自体が働くことを
 *   **実際に落として**確かめないと、同じことがもう一度起きる。
 *   「失敗したときにちゃんと動く道」は、成功したときには一度も通らない。
 *
 * 【2段構えで見る】
 *   1. 作り物の失敗5種類（プロセス終了・メモリ不足・ポート拒否・画面待ち・
 *      要素待ち）を記録係へ通し、**別々の種類として記録されるか**を見る。
 *      合格した試験も記録に残ることを、同じ回で確かめる。
 *   2. 重い検査の札を、2つのプロセスが同時に持てないことを見る。
 *   3. 本物のブラウザ試験を `E2E_FORCE_FAIL=1` で走らせる。
 *      在るはずのない部品を待って時間切れにし、
 *      **試験名・段・URL・内側の例外**が記録ファイルへ入ることを見る。
 *      （この2つ目は時間がかかるので `--no-browser` で外せる）
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installLocalOnlyGuard } from "../guard/no-production.mjs";
import { CATEGORY, LOG_DIR, createRecorder } from "./record.mjs";

installLocalOnlyGuard("記録の自己試験（test:e2e:selftest）");

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const results = [];

function check(name, cond, message = "") {
  results.push({ name, ok: Boolean(cond), message });
  console.log(`${cond ? "○" : "✗"} ${name}${cond ? "" : `\n      ${message}`}`);
}

/** 内側の原因を持った例外を作る（本物の fetch 失敗と同じ形） */
function withCause(message, causeMessage, code) {
  const cause = new Error(causeMessage);
  cause.code = code;
  const e = new Error(message);
  e.cause = cause;
  return e;
}

/* ===========================================================================
 * 1. 作り物の失敗を、種類ごとに分けて記録できるか
 * ========================================================================= */

const fakeServerLog = { value: [] };
const recorder = createRecorder({
  runName: "e2e-selftest",
  serverLogs: fakeServerLog.value,
  probe: () => ({ stage: "（外から拾った段）", urls: ["http://127.0.0.1:0/works"] }),
});

await recorder.test("S", "合格する試験（合格でも記録に残ること）", async (t) => {
  t.stage("何もしない");
});

await recorder.test("S", "要素待ちで落ちる", async (t) => {
  t.stage("在るはずのない部品を待つ");
  throw new Error(
    'Timeout 3000ms exceeded.\nCall log:\n  - waiting for locator("[data-nope]")',
  );
});

await recorder.test("S", "画面待ちで落ちる", async (t) => {
  t.stage("画面の遷移を待つ");
  throw new Error("page.goto: Timeout 30000ms exceeded. Navigation failed");
});

await recorder.test("S", "ポート拒否で落ちる", async (t) => {
  t.stage("検証用サーバーへつなぐ");
  throw withCause("fetch failed", "connect ECONNREFUSED 127.0.0.1:3220", "ECONNREFUSED");
});

await recorder.test("S", "通信断で落ちる", async (t) => {
  t.stage("応答を受け取る");
  throw withCause("fetch failed", "socket hang up", "ECONNRESET");
});

await recorder.test("S", "プロセス終了で落ちる", async (t) => {
  t.stage("ページを操作する");
  throw new Error("Target page, context or browser has been closed");
});

// メモリ不足は、サーバー側の出力に印が出たときだけ。
// **呼んだ側からは「つながらない」としか見えない**ので、そちらを本命にしない。
// 印は**その試験のあいだに**出たものだけを見るので、試験の中で足す。
await recorder.test("S", "メモリ不足で落ちる（サーバー側の出力で見分ける）", async (t) => {
  t.stage("画面を開く");
  fakeServerLog.value.push("Restarting server: approaching the used memory threshold\n");
  throw withCause("fetch failed", "connect ECONNREFUSED 127.0.0.1:3220", "ECONNREFUSED");
});

const { payload, jsonFile, textFile } = recorder.finish();

check("記録ファイルが2本できる（機械用と人用）", Boolean(jsonFile && textFile));
check(
  "合格した試験も記録に残る",
  payload.tests.some((t) => t.ok && t.name.includes("合格でも記録に残る")),
);
check(
  "全件が記録に残る（合格7件ぶんの行が欠けない）",
  payload.total === 7,
  `記録が ${payload.total} 件（7件のはず）`,
);

const byName = new Map(payload.tests.map((t) => [t.name, t]));
const expected = [
  ["要素待ちで落ちる", CATEGORY.ELEMENT_WAIT],
  ["画面待ちで落ちる", CATEGORY.PAGE_WAIT],
  ["ポート拒否で落ちる", CATEGORY.PORT_REFUSED],
  ["通信断で落ちる", CATEGORY.CONNECTION_LOST],
  ["プロセス終了で落ちる", CATEGORY.PROCESS_GONE],
  ["メモリ不足で落ちる（サーバー側の出力で見分ける）", CATEGORY.OUT_OF_MEMORY],
];
for (const [name, category] of expected) {
  const rec = byName.get(name);
  check(
    `「${name}」が別の種類として記録される`,
    rec && rec.category === category,
    `種類が ${rec?.category ?? "（記録なし）"}（${category} のはず）`,
  );
}

check(
  "落ちた段が記録される",
  byName.get("要素待ちで落ちる")?.failedStage === "在るはずのない部品を待つ",
  `段が ${byName.get("要素待ちで落ちる")?.failedStage}`,
);
check(
  "内側の原因（cause）まで記録される",
  byName.get("ポート拒否で落ちる")?.error?.some((c) => c.code === "ECONNREFUSED"),
);
check(
  "開始と終了の時刻が両方残る",
  payload.tests.every((t) => t.startedAt && t.endedAt),
);

const text = readFileSync(textFile, "utf8");
check(
  "人が読む要約に、全件ぶんの行がある",
  text.split("\n").filter((l) => /^[○✗] /.test(l)).length === 7,
);

/* ===========================================================================
 * 2. 重い検査が2つ同時に走らないこと
 *
 * 【なぜこれを試すか】
 *   2026-09-05 の 4/40 は、ブラウザ試験と他の検査を同時に回したときに出た。
 *   「同時に回さないでください」と書くだけでは、また同時に回る。
 *   **同時に取れない札**を置いたので、その札が働くことを確かめる。
 *
 * 【どう試すか】
 *   札を取って少し持つだけの小さなプロセスを2つ、同時に起動する。
 *   取った時刻と返した時刻を突き合わせて、**持っていた時間が重ならない**
 *   ことを見る。重なったら、札は働いていない。
 * ========================================================================= */

{
  const probe = (label) =>
    new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [join(ROOT, "test", "e2e", "_lock-probe.mjs"), "1200", label],
        { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
      );
      const out = [];
      child.stdout.on("data", (d) => out.push(d.toString()));
      child.stderr.on("data", (d) => out.push(d.toString()));
      child.on("close", (code) => resolve({ code, text: out.join("") }));
    });

  const [a, b] = await Promise.all([probe("A"), probe("B")]);

  const parse = (text, label) => {
    const got = /ACQUIRED \S+ (\d+)/.exec(text);
    const put = /RELEASED \S+ (\d+)/.exec(text);
    return got && put
      ? { label, from: Number(got[1]), to: Number(put[1]) }
      : null;
  };
  const ra = parse(a.text, "A");
  const rb = parse(b.text, "B");

  check("札を取る2つのプロセスが、どちらも最後まで走る", a.code === 0 && b.code === 0);
  check("取った時刻と返した時刻が両方とも残る", Boolean(ra && rb));

  if (ra && rb) {
    const overlap = ra.from < rb.to && rb.from < ra.to;
    check(
      "2つが同時に札を持っていない（重い検査が重ならない）",
      !overlap,
      `A ${ra.from}〜${ra.to} と B ${rb.from}〜${rb.to} が重なっている`,
    );
    check(
      "あとから来たほうは、前が返すまで待っている",
      Math.max(ra.from, rb.from) >= Math.min(ra.to, rb.to),
      "待たずに始まっている",
    );
  }

  check(
    "順番待ちになったことが、待った側の画面に出る",
    /順番待ち/.test(a.text) || /順番待ち/.test(b.text),
    "どちらにも順番待ちの表示が出ていない",
  );
}

/* ===========================================================================
 * 3. 本物のブラウザ試験を、わざと1件落として記録を見る
 * ========================================================================= */

if (process.argv.includes("--no-browser")) {
  console.log("\n（--no-browser が付いているので、本物のブラウザ試験は走らせません）");
} else {
  console.log("\n── 本物のブラウザ試験を E2E_FORCE_FAIL=1 で走らせます（数分かかります）");

  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, "test", "e2e", "browser.mjs")], {
      cwd: ROOT,
      env: { ...process.env, E2E_FORCE_FAIL: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = [];
    child.stdout.on("data", (d) => out.push(d.toString()));
    child.stderr.on("data", (d) => out.push(d.toString()));
    child.on("close", (c) => {
      // 失敗するのが正しいので、出力は結果の判定には使わない。
      // 記録ファイルのほうを見る
      resolve(c);
    });
  });

  check("わざと落とした回は、終了コードが0にならない", code !== 0, `終了コード ${code}`);

  const latest = JSON.parse(readFileSync(join(LOG_DIR, "e2e-latest.json"), "utf8"));
  const forced = latest.tests.find((t) => t.name.includes("わざと落とす"));

  check("落ちた試験の名前が記録に残る", Boolean(forced), "その名前の記録が無い");
  check(
    "落ちた試験が不合格として記録される",
    forced && forced.ok === false,
    `ok が ${forced?.ok}`,
  );
  check(
    "落ちた段が記録に残る",
    forced?.failedStage === "在るはずのない部品を待つ",
    `段が ${forced?.failedStage}`,
  );
  check(
    "そのときのURLが記録に残る",
    typeof forced?.url === "string" && forced.url.includes("/works"),
    `URL が ${forced?.url}`,
  );
  check(
    "要素待ちとして分類される",
    forced?.category === CATEGORY.ELEMENT_WAIT,
    `種類が ${forced?.category}`,
  );
  check(
    "内側の例外の文言が残る",
    forced?.error?.[0]?.message?.includes("data-this-element-never-exists"),
    `原因が ${forced?.error?.[0]?.message?.slice(0, 120)}`,
  );
  check(
    "落ちた回でも、ほかの全件が記録に残る",
    latest.tests.length > 40,
    `記録が ${latest.tests.length} 件`,
  );
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n合計 ${results.length} 件 / 合格 ${results.length - failed.length} 件 / 不合格 ${failed.length} 件`,
);
console.log(`記録の置き場所: ${LOG_DIR}`);
process.exit(failed.length === 0 ? 0 : 1);
