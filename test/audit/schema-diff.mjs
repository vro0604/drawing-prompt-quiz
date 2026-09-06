/**
 * schema-diff.mjs ／ 「いまの本番と同じ作り」と「18本を当てたあと」を並べて差を出す
 *
 * 実行: node test/audit/schema-diff.mjs
 *
 * 【何のためにあるか】
 *   本番は「DBを先に更新し、そのあと画面を差し替える」順で当てる。
 *   その間、**旧い画面と新しいDB**が同時に動く。
 *   旧い画面が触るDBの入口が1つでも形を変えていれば、そこが落ちる。
 *
 *   目で追うと数え落とす。2つのDBを実際に作って、
 *   関数の署名・表・列・権限を**機械で突き合わせる。**
 *
 * 【本番へはつながらない】
 *   使うのは PGlite（Node の中だけで動く Postgres）。
 *   最初のネットワーク要求より前に、本番向きの環境変数を見つけたら止まる柵を立てる。
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installLocalOnlyGuard } from "../guard/no-production.mjs";
import { createTestDb } from "../db/harness.mjs";

installLocalOnlyGuard("新旧スキーマ差分（audit:schema-diff）");

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "supabase", "migrations");
const NEW_FROM = "20260904090000";

async function apply(db, files) {
  for (const f of files) {
    const sql = await readFile(join(MIGRATIONS, f), "utf8");
    try {
      await db.exec(sql);
    } catch (e) {
      throw new Error(`migration ${f} が適用できません:\n${e.message}`);
    }
  }
}

const SNAPSHOT = {
  functions: `
    select p.oid::regprocedure::text as sig,
           p.proname                 as name,
           p.pronargs                as nargs,
           p.pronargdefaults         as ndefaults,
           p.prosecdef               as secdef,
           coalesce(array_to_string(p.proconfig, ','), '') as config,
           has_function_privilege('anon', p.oid, 'EXECUTE')          as anon_exec,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
           coalesce(pg_get_function_result(p.oid), '')               as result
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
     order by 1`,
  columns: `
    select c.table_name, c.column_name, c.data_type, c.is_nullable,
           coalesce(c.column_default, '') as col_default,
           has_column_privilege('anon', 'public.'||quote_ident(c.table_name),
                                c.column_name, 'SELECT') as anon_select,
           has_column_privilege('authenticated', 'public.'||quote_ident(c.table_name),
                                c.column_name, 'SELECT') as auth_select
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
     order by 1, 2`,
  tables: `
    select table_name,
           has_table_privilege('anon', 'public.'||quote_ident(table_name), 'SELECT') as anon_select,
           has_table_privilege('anon', 'public.'||quote_ident(table_name), 'INSERT') as anon_insert,
           has_table_privilege('authenticated', 'public.'||quote_ident(table_name), 'SELECT') as auth_select,
           has_table_privilege('authenticated', 'public.'||quote_ident(table_name), 'INSERT') as auth_insert,
           has_table_privilege('authenticated', 'public.'||quote_ident(table_name), 'UPDATE') as auth_update,
           has_table_privilege('authenticated', 'public.'||quote_ident(table_name), 'DELETE') as auth_delete
      from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
     order by 1`,
  policies: `
    select schemaname||'.'||tablename||' / '||policyname as name,
           cmd, coalesce(array_to_string(roles, ','), '') as roles
      from pg_policies where schemaname = 'public' order by 1`,
  constraints: `
    select conrelid::regclass::text as tbl, conname, contype,
           pg_get_constraintdef(oid) as def
      from pg_constraint
     where connamespace = 'public'::regnamespace
     order by 1, 2`,
  triggers: `
    select c.relname||' / '||t.tgname as name, pg_get_triggerdef(t.oid) as def
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and not t.tgisinternal
     order by 1`,
};

async function snapshot(db) {
  const out = {};
  for (const [k, sql] of Object.entries(SNAPSHOT)) {
    out[k] = (await db.query(sql)).rows;
  }
  return out;
}

function key(kind, row) {
  if (kind === "functions") return row.sig;
  if (kind === "columns") return `${row.table_name}.${row.column_name}`;
  if (kind === "tables") return row.table_name;
  if (kind === "policies") return row.name;
  if (kind === "constraints") return `${row.tbl} / ${row.conname}`;
  if (kind === "triggers") return row.name;
  return JSON.stringify(row);
}

function diff(kind, before, after) {
  const b = new Map(before.map((r) => [key(kind, r), r]));
  const a = new Map(after.map((r) => [key(kind, r), r]));
  const removed = [...b.keys()].filter((k) => !a.has(k));
  const added = [...a.keys()].filter((k) => !b.has(k));
  const changed = [];
  for (const [k, br] of b) {
    const ar = a.get(k);
    if (!ar) continue;
    const fields = Object.keys(br).filter((f) => String(br[f]) !== String(ar[f]));
    if (fields.length) changed.push({ k, fields, before: br, after: ar });
  }
  return { removed, added, changed };
}

// ---------------------------------------------------------------------------
// jsonb で返す関数は、返り値の「鍵」が契約である。
// 列と違ってカタログに出ないので、定義文から鍵の名前を拾って突き合わせる。
// **減った鍵**が、旧い画面が読めなくなるところ。
// ---------------------------------------------------------------------------
const KEYS_SQL = `
  select p.proname as name, pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f'`;

function jsonKeys(def) {
  const keys = new Set();
  const re = /jsonb_build_object\s*\(/g;
  while (re.exec(def) !== null) {
    // 開き括弧から対応する閉じ括弧までを切り出し、先頭の引用符付き語を拾う
    let depth = 1;
    let i = re.lastIndex;
    while (i < def.length && depth > 0) {
      if (def[i] === "(") depth += 1;
      else if (def[i] === ")") depth -= 1;
      i += 1;
    }
    const body = def.slice(re.lastIndex, i - 1);
    for (const k of body.matchAll(/'([a-z0-9_]+)'\s*,/g)) keys.add(k[1]);
  }
  return [...keys].sort();
}

async function jsonKeyMap(db) {
  const rows = (await db.query(KEYS_SQL)).rows;
  const map = new Map();
  for (const r of rows) {
    const k = jsonKeys(r.def);
    if (k.length) map.set(r.name, new Set(k));
  }
  return map;
}


const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
const oldFiles = files.filter((f) => f < NEW_FROM);
const newFiles = files.filter((f) => f >= NEW_FROM);

// いまの本番と同じ作り（追跡済み22本だけ）
const dbOld = await createTestDb({ before: NEW_FROM });
const before = await snapshot(dbOld);
const keysOld = await jsonKeyMap(dbOld);
await dbOld.close();

// 18本を当てたあと
const dbNew = await createTestDb({ before: NEW_FROM });
await apply(dbNew, newFiles);
const after = await snapshot(dbNew);
const keysNew = await jsonKeyMap(dbNew);
await dbNew.close();

const report = {};
for (const kind of Object.keys(SNAPSHOT)) report[kind] = diff(kind, before[kind], after[kind]);

const lostKeys = [];
for (const [name, ks] of keysOld) {
  const now = keysNew.get(name);
  if (!now) { lostKeys.push({ name, lost: [...ks], reason: "関数ごと無くなった" }); continue; }
  const lost = [...ks].filter((k) => !now.has(k));
  if (lost.length) lostKeys.push({ name, lost, reason: "鍵が減った" });
}
report.jsonKeys = { lost: lostKeys };

const out = join(HERE, "..", "..", "docs", "compat-matrix-data.json");
// 「追跡済み22本だけを当てた姿」もそのまま書き出す。
// 本番がこの姿とずれていないか（履歴と実スキーマのずれ）を
// scripts/db-audit-prod.mjs が突き合わせるのに使う。
const tracked = {
  functions: before.functions.map((r) => r.sig).sort(),
  tables: before.tables.map((r) => r.table_name).sort(),
  columns: before.columns.map((r) => `${r.table_name}.${r.column_name}`).sort(),
};

await writeFile(
  out,
  JSON.stringify(
    { oldFiles: oldFiles.length, newFiles: newFiles.length, tracked, report },
    null,
    2,
  ),
);

console.log(`\n=== jsonb の鍵 : 減った関数 ${lostKeys.length} 本`);
for (const l of lostKeys) console.log(`  ${l.name} [${l.reason}] → ${l.lost.join(", ")}`);

for (const kind of Object.keys(SNAPSHOT)) {
  const r = report[kind];
  console.log(`\n=== ${kind} : 消えた ${r.removed.length} / 増えた ${r.added.length} / 変わった ${r.changed.length}`);
  for (const k of r.removed) console.log(`  消えた   ${k}`);
  for (const c of r.changed) console.log(`  変わった ${c.k}  [${c.fields.join(", ")}]`);
}
console.log(`\n増えたものの一覧は ${out} にある`);
