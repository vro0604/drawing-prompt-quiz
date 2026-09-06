#!/usr/bin/env node
/**
 * scan-migration-ops.mjs ／ 未適用 migration の「何をする文か」を全件数え上げる
 *
 * 実行: npm run audit:migration-ops
 *
 * 【何のためにあるか】
 *   本番へ当てる前に、**当てた瞬間に何が起きるか**を数える。
 *   「データを消す文は無い」と総括で済ませない。文を1本ずつ拾って表にする。
 *
 * 【分けて数えるもの】
 *   ・適用時に走る文  … migration を当てたその瞬間に実行される
 *   ・関数の中の文    … 関数の定義に書かれているだけで、当てた瞬間は走らない
 *                       （利用者が RPC を呼んだときに走る）
 *   この2つを混ぜると、「DELETE が5本ある」と読めてしまう。
 *   実際には当てた瞬間に走る DELETE は1本も無い、ということが見えなくなる。
 *
 * 【数え方の限界】
 *   行の頭を見る単純な照合である。1文を複数行に分けて書いた場合、
 *   先頭行しか拾えない。**数は下限として読む。**
 *   ここで0本と出たものは、grep でも0本であることを別に確かめること。
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "supabase", "migrations");
const FROM = process.argv[2] ?? "20260904090000";

const APPLY_TIME = [
  ["DROP TABLE", /^\s*drop\s+table\b.*$/gim],
  ["DROP COLUMN", /^\s*alter\s+table\s+\S+\s+drop\s+column\b.*$/gim],
  ["DROP FUNCTION", /^\s*drop\s+function\b.*$/gim],
  ["DROP TRIGGER", /^\s*drop\s+trigger\b.*$/gim],
  ["DROP POLICY", /^\s*drop\s+policy\b.*$/gim],
  ["DROP INDEX", /^\s*drop\s+index\b.*$/gim],
  ["TRUNCATE", /^\s*truncate\b.*$/gim],
  ["ALTER TYPE", /^\s*alter\s+type\b.*$/gim],
  ["ALTER COLUMN", /^\s*alter\s+table\s+\S+\s+alter\s+column\b.*$/gim],
  ["SET NOT NULL", /^.*set\s+not\s+null.*$/gim],
  ["ADD CONSTRAINT", /^\s*alter\s+table\s+.*add\s+constraint\b.*$/gim],
  ["ADD COLUMN", /^\s*alter\s+table\s+\S+\s+add\s+column\b.*$/gim],
  ["CREATE TABLE", /^\s*create\s+table\b.*$/gim],
  ["CREATE INDEX", /^\s*create\s+(unique\s+)?index\b.*$/gim],
  ["CREATE/REPLACE FUNCTION", /^\s*create\s+(or\s+replace\s+)?function\b.*$/gim],
  ["CREATE TRIGGER", /^\s*create\s+(or\s+replace\s+)?trigger\b.*$/gim],
  ["CREATE POLICY", /^\s*create\s+policy\b.*$/gim],
  ["GRANT", /^\s*grant\b.*$/gim],
  ["REVOKE", /^\s*revoke\b.*$/gim],
  ["RLS", /^\s*alter\s+table\s+.*row\s+level\s+security.*$/gim],
  ["INSERT", /^\s*insert\s+into\b.*$/gim],
  ["UPDATE", /^\s*update\s+public\.\S+.*$/gim],
  ["DELETE", /^\s*delete\s+from\b.*$/gim],
];

const RUNTIME = [
  ["INSERT", /^\s*insert\s+into\b.*$/gim],
  ["UPDATE", /^\s*update\s+\S+.*$/gim],
  ["DELETE", /^\s*delete\s+from\b.*$/gim],
];

/** 関数の本体（ドル引用の中）と行コメントを外す。残るのが「当てた瞬間に走る文」 */
function applyTimeOnly(src) {
  let s = src.replace(/\$fn\$[\s\S]*?\$fn\$/g, "\n").replace(/\$\$[\s\S]*?\$\$/g, "\n");
  return s
    .split("\n")
    .map((ln) => (ln.indexOf("--") >= 0 ? ln.slice(0, ln.indexOf("--")) : ln))
    .join("\n");
}

const DESTRUCTIVE = new Set([
  "DROP TABLE", "DROP COLUMN", "DROP FUNCTION", "DROP TRIGGER", "DROP POLICY",
  "DROP INDEX", "TRUNCATE", "ALTER TYPE", "ALTER COLUMN", "SET NOT NULL",
  "UPDATE", "DELETE",
]);

const files = (await readdir(MIGRATIONS))
  .filter((f) => f.endsWith(".sql") && f >= FROM)
  .sort();

const perFile = [];
const destructive = [];
const runtime = [];

for (const f of files) {
  const raw = await readFile(join(MIGRATIONS, f), "utf8");
  const body = applyTimeOnly(raw);
  const counts = new Map();
  for (const [label, re] of APPLY_TIME) {
    for (const m of body.matchAll(re)) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
      if (DESTRUCTIVE.has(label)) {
        destructive.push({ f, label, text: m[0].trim().replace(/\s+/g, " ").slice(0, 120) });
      }
    }
  }
  perFile.push({ f, counts });

  for (const m of raw.matchAll(/\$fn\$([\s\S]*?)\$fn\$|\$\$([\s\S]*?)\$\$/g)) {
    const t = m[1] ?? m[2] ?? "";
    for (const [label, re] of RUNTIME) {
      for (const x of t.matchAll(re)) {
        runtime.push({ f, label, text: x[0].trim().replace(/\s+/g, " ").slice(0, 100) });
      }
    }
  }
}

console.log(`対象: ${FROM} 以降の ${files.length} 本\n`);
console.log("### 1. 当てた瞬間に走る文（migration ごと）");
for (const { f, counts } of perFile) {
  console.log(`\n-- ${f}`);
  for (const k of [...counts.keys()].sort()) console.log(`   ${k.padEnd(24)}${counts.get(k)}`);
}

console.log("\n\n### 2. 破壊・更新にあたる文だけ、全文");
if (destructive.length === 0) console.log("  1本も無い");
for (const d of destructive) console.log(`${d.f.slice(0, 14)} | ${d.label.padEnd(15)} | ${d.text}`);

console.log("\n\n### 3. 関数の中の書き込み（当てた瞬間は走らない。RPC を呼んだときに走る）");
const agg = new Map();
for (const r of runtime) {
  const k = `${r.f.slice(0, 14)} ${r.label}`;
  agg.set(k, (agg.get(k) ?? 0) + 1);
}
for (const k of [...agg.keys()].sort()) console.log(`  ${k.padEnd(24)}${agg.get(k)}`);

const totals = new Map();
for (const { counts } of perFile) {
  for (const [k, v] of counts) totals.set(k, (totals.get(k) ?? 0) + v);
}
console.log("\n\n### 4. 合計");
for (const k of [...totals.keys()].sort()) console.log(`  ${k.padEnd(24)}${totals.get(k)}`);
