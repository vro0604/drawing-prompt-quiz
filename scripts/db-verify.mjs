#!/usr/bin/env node
/**
 * db-verify.mjs ／ リモートDBの状態を自動検証する
 *
 * 【やること】
 *   1. 構造・権限・関数・漏洩経路を SQL カタログで確認する
 *   2. Step 3E の必須診断（A1〜A14）を実行する。すべて0行なら正常
 *   3. anon / authenticated に成りすまして、実際に読めない／呼べないことを確かめる
 *
 * 【やらないこと】
 *   データを1行も追加・変更・削除しない。
 *   ロール切り替えの試験は BEGIN ... ROLLBACK の中だけで行う。
 *
 * 【接続情報の扱い】
 *   接続文字列はファイルにもログにも Git にも残さない。
 *   環境変数 SUPABASE_DB_URL が無ければ、その場で入力を求める（入力は伏せ字）。
 *
 *   接続文字列は Supabase ダッシュボード → 画面上部の Connect
 *   → Session pooler / Direct connection の URI をコピーして使う。
 *
 * 【使い方】
 *   npm run db:verify
 */

import { createInterface } from "node:readline";
import pg from "pg";
import { checks, diagnostics, roleProbes } from "./db-checks.mjs";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** ターミナルで伏せ字入力を求める。入力値はどこにも保存しない。 */
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const onData = (char) => {
      const s = String(char);
      if (s === "\n" || s === "\r" || s === "") {
        process.stdin.removeListener("data", onData);
      } else {
        process.stdout.write("\x1b[2K\x1b[200D" + question + "*".repeat(rl.line.length));
      }
    };
    process.stdin.on("data", onData);
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

async function getConnectionString() {
  const fromEnv = process.env.SUPABASE_DB_URL;
  if (fromEnv && fromEnv.trim() !== "") return fromEnv.trim();

  console.log("");
  console.log(`${BOLD}接続文字列が必要です${RESET}`);
  console.log(
    `${DIM}  Supabase ダッシュボード → 上部の Connect → Session pooler の URI をコピー`,
  );
  console.log(`  入力した値はファイルにもログにも残しません。`);
  console.log(
    `  毎回聞かれたくない場合は、ターミナルで次を実行してください（そのウィンドウの間だけ有効）:`,
  );
  console.log(`    export SUPABASE_DB_URL='postgresql://...'${RESET}`);
  console.log("");

  const url = await askHidden("接続文字列: ");
  if (!url) {
    console.error(`${RED}接続文字列が空です。中止します。${RESET}`);
    process.exit(1);
  }
  return url;
}

/** 秘密が混ざりうる文字列をログに出す前に伏せる。 */
function scrub(text) {
  return String(text).replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "postgresql://***");
}

async function main() {
  const connectionString = await getConnectionString();
  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    application_name: "dpq-db-verify",
  });

  try {
    await client.connect();
  } catch (err) {
    console.error(`${RED}接続に失敗しました:${RESET} ${scrub(err.message)}`);
    process.exit(1);
  }

  let failed = 0;
  let passed = 0;

  const line = (ok, label, detail = "") => {
    const mark = ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    console.log(`  ${mark} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ""}`);
    if (ok) passed += 1;
    else failed += 1;
  };

  // ───────────── 1. カタログ検査 ─────────────
  let currentGroup = "";
  for (const c of checks) {
    if (c.group !== currentGroup) {
      currentGroup = c.group;
      console.log(`\n${BOLD}[${currentGroup}]${RESET}`);
    }
    try {
      const res = await client.query(c.sql, c.params ?? []);
      const actual = res.rows.length ? Number(Object.values(res.rows[0])[0]) : null;
      line(actual === c.expected, c.name, `期待 ${c.expected} / 実際 ${actual}`);
    } catch (err) {
      line(false, c.name, `クエリ失敗: ${scrub(err.message)}`);
    }
  }

  // ───────────── 2. Step 3E 診断 ─────────────
  console.log(`\n${BOLD}[Step 3E 診断] すべて0行なら正常${RESET}`);
  for (const d of diagnostics) {
    try {
      const res = await client.query(d.sql);
      line(res.rowCount === 0, `${d.id} ${d.label}`, `${res.rowCount}件`);
    } catch (err) {
      line(false, `${d.id} ${d.label}`, `クエリ失敗: ${scrub(err.message)}`);
    }
  }

  // ───────────── 3. ロール成りすまし ─────────────
  console.log(`\n${BOLD}[実地確認] 実際に読めない／呼べないこと${RESET}`);
  let probeDenied = 0;
  let probeAllowed = 0;
  const probeFailures = [];

  for (const p of roleProbes) {
    // 1件ずつ独立したトランザクションで実行し、必ず巻き戻す
    await client.query("begin");
    let outcome;
    try {
      await client.query(`set local role ${p.role}`);
      await client.query(p.sql);
      outcome = "allowed";
    } catch (err) {
      outcome = err.code === "42501" ? "denied" : `error:${err.code}`;
      if (outcome !== "denied") probeFailures.push(`${p.label} → ${scrub(err.message)}`);
    }
    await client.query("rollback");

    const ok = outcome === p.mode;
    if (ok) {
      if (p.mode === "denied") probeDenied += 1;
      else probeAllowed += 1;
    } else {
      probeFailures.push(`${p.label}: 期待 ${p.mode} / 実際 ${outcome}`);
    }
  }

  const expectedDenied = roleProbes.filter((p) => p.mode === "denied").length;
  const expectedAllowed = roleProbes.filter((p) => p.mode === "allowed").length;
  line(
    probeDenied === expectedDenied,
    "拒否されるべき呼び出しがすべて拒否された",
    `${probeDenied} / ${expectedDenied}`,
  );
  line(
    probeAllowed === expectedAllowed,
    "許可されるべき呼び出しがすべて成功した",
    `${probeAllowed} / ${expectedAllowed}`,
  );
  for (const f of probeFailures) console.log(`      ${RED}${f}${RESET}`);

  await client.end();

  console.log("");
  console.log("───────────────────────────────────────────");
  if (failed === 0) {
    console.log(`${GREEN}${BOLD}✓ すべて期待どおり（${passed}項目）${RESET}`);
    console.log("───────────────────────────────────────────");
    process.exit(0);
  } else {
    console.log(`${RED}${BOLD}✗ ${failed}項目が期待と異なります（成功 ${passed}）${RESET}`);
    console.log("───────────────────────────────────────────");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`${RED}想定外のエラー:${RESET} ${scrub(err.stack ?? err.message)}`);
  process.exit(1);
});
