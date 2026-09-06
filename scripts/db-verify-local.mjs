#!/usr/bin/env node
/**
 * db-verify-local.mjs ／ db-verify と同じ検査を、本番に触れずに実行する
 *
 * 【なぜ2本あるのか】
 *   db-verify.mjs は本番の Supabase へつなぐ。接続文字列が要るうえ、
 *   **migration を当てる前の状態しか見られない。**
 *   新しい migration を当てたあとの姿を確かめるには、当てられる場所が要る。
 *
 *   この端末には Docker も psql も無い（実測: どちらも command not found）。
 *   そこで PGlite（Postgres 本体を WebAssembly にしたもの）へ
 *   migration を全部当ててから、**同じ scripts/db-checks.mjs** を流す。
 *
 * 【本物と違うところ】
 *   ・Supabase の auth / storage は最小限の作りもの（test/db/harness.mjs）
 *   ・本番のデータは無い。件数を見る検査は「0件でも正しい」形のものだけ通る
 *   ・拡張・レプリケーション・Supabase 独自の設定は入っていない
 *
 *   したがって**これは本番の検証の代わりにはならない。**
 *   本番へ当てたあと、あらためて db:verify を回す必要がある。
 *   ここで見られるのは「migration が意図した構造と権限を作れているか」まで。
 *
 * 【使い方】
 *   npm run db:verify:local
 */

import { installLocalOnlyGuard } from "../test/guard/no-production.mjs";
import { createTestDb } from "../test/db/harness.mjs";

// **最初のネットワーク要求より前に柵を立てる。**
// 本番のURL・project ref・ホスト名・鍵が環境にあれば、ここで異常終了する。
installLocalOnlyGuard("DB構造検査（db:verify:local）");
import { checks, diagnostics, roleProbes } from "./db-checks.mjs";
import { recordCount } from "../test/counts.mjs";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/**
 * 本番のデータがあることを前提にした検査は、ここでは合否を出さない。
 *
 * **「0件だから合格」を作らないため。**たとえば「タグが156件ある」は
 * 本番のデータについての検査で、作りたての空のDBでは意味が変わる。
 */
const DATA_DEPENDENT = /行数|件数|156|タグ|本番/;

/**
 * 本番の Postgres と、ここで動かしている Postgres の違いで結果が変わるもの。
 *
 * 【いま1件だけある理由】
 *   `alter default privileges ... revoke execute on functions from public` は、
 *   本番（Supabase の Postgres）では pg_default_acl に行が残る。
 *   ここで使っている PGlite（PostgreSQL 18）では、同じ文を流しても行が残らない
 *   （実測。流した直後に pg_default_acl を数えて0件）。
 *
 *   **効いていないという意味ではない。**記録のされ方が違うだけで、
 *   この検査は「記録が残っているか」を見ている。
 *   本番での確認は db:verify のほうに任せる。
 */
const ENV_DEPENDENT = /PUBLIC EXECUTE が自動付与されない設定/;

async function main() {
  console.log(`${DIM}migration を全部当てています…${RESET}`);
  const db = await createTestDb();

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures = [];

  const line = (ok, label, detail = "") => {
    const mark = ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    console.log(`  ${mark} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ""}`);
    if (ok) passed += 1;
    else {
      failed += 1;
      failures.push(`${label} ${detail}`);
    }
  };

  // ───────────── 1. カタログ検査 ─────────────
  let currentGroup = "";
  for (const c of checks) {
    if (c.group !== currentGroup) {
      currentGroup = c.group;
      console.log(`\n${BOLD}[${currentGroup}]${RESET}`);
    }

    if (DATA_DEPENDENT.test(c.name)) {
      console.log(`  ${DIM}－ ${c.name}（本番のデータ前提。ここでは判定しない）${RESET}`);
      skipped += 1;
      continue;
    }

    if (ENV_DEPENDENT.test(c.name)) {
      console.log(`  ${DIM}－ ${c.name}（Postgres の版で記録のされ方が違う。db:verify で見る）${RESET}`);
      skipped += 1;
      continue;
    }

    try {
      const res = await db.query(c.sql, c.params ?? []);
      const actual = res.rows.length ? Number(Object.values(res.rows[0])[0]) : null;
      line(actual === c.expected, c.name, `期待 ${c.expected} / 実際 ${actual}`);

      if (actual !== c.expected && c.detailSql) {
        const detail = await db.query(c.detailSql, c.detailParams ?? []);
        for (const row of detail.rows) {
          console.log(`      ${DIM}${JSON.stringify(row)}${RESET}`);
        }
      }
    } catch (err) {
      line(false, c.name, `クエリ失敗: ${err.message}`);
    }
  }

  // ───────────── 2. 診断（すべて0行なら正常）─────────────
  console.log(`\n${BOLD}[診断] すべて0行なら正常${RESET}`);
  for (const d of diagnostics) {
    try {
      const res = await db.query(d.sql);
      line(res.rows.length === 0, `${d.id} ${d.label}`, `${res.rows.length}件`);
    } catch (err) {
      line(false, `${d.id} ${d.label}`, `クエリ失敗: ${err.message}`);
    }
  }

  // ───────────── 3. ロール成りすまし ─────────────
  console.log(`\n${BOLD}[実地確認] 実際に読めない／呼べないこと${RESET}`);
  let denied = 0;
  let allowed = 0;
  const probeFailures = [];

  for (const p of roleProbes) {
    await db.exec("begin");
    let outcome;
    try {
      await db.exec(`set local role ${p.role}`);
      await db.query(p.sql);
      outcome = "allowed";
    } catch (err) {
      outcome = /permission denied/i.test(err.message) ? "denied" : `error:${err.message}`;
    }
    try {
      await db.exec("rollback");
    } catch {
      /* 巻き戻し自体の失敗は元の結果を隠さない */
    }

    if (outcome === p.mode) {
      if (p.mode === "denied") denied += 1;
      else allowed += 1;
    } else {
      probeFailures.push(`${p.label}: 期待 ${p.mode} / 実際 ${outcome}`);
    }
  }

  const wantDenied = roleProbes.filter((p) => p.mode === "denied").length;
  const wantAllowed = roleProbes.filter((p) => p.mode === "allowed").length;

  line(denied === wantDenied, "拒否されるべき呼び出しがすべて拒否された", `${denied} / ${wantDenied}`);
  line(allowed === wantAllowed, "許可されるべき呼び出しがすべて成功した", `${allowed} / ${wantAllowed}`);
  for (const f of probeFailures) console.log(`      ${RED}${f}${RESET}`);

  console.log("");
  console.log("───────────────────────────────────────────");
  console.log(
    `合格 ${passed} ／ 不合格 ${failed} ／ 判定しない ${skipped}（本番のデータ前提）`,
  );
  console.log(
    `${DIM}これは本番の検証の代わりではありません。本番へ当てたあと npm run db:verify を回してください。${RESET}`,
  );
  console.log("───────────────────────────────────────────");

  // 文書に書いた件数と突き合わせられるように、実測を残す
  recordCount("DB構造の検査", passed);

  process.exit(failed === 0 && probeFailures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`${RED}想定外のエラー:${RESET} ${err.stack ?? err.message}`);
  process.exit(1);
});
