#!/usr/bin/env node
/**
 * run.mjs ／ 本番へ書く道具そのものを試す
 *
 * 実行: npm run test:tools
 *
 * 【何を試すか】
 *   scripts/db-apply-many.mjs は本番のデータベースへ書く。だから
 *   「当てる前に断るべきものを、ちゃんと断るか」を先に確かめる。
 *   断り損ねると、取り違えた先へ本番の変更が入る。
 *
 * 【本物のデータベースは使わない】
 *   当てる中身の検査（何本を、どの順で、どのファイルを）は、DBへ触れずに済む。
 *   トランザクションの振る舞い（全部入るか、1本も入らないか）は、
 *   手元のデータベース（PGlite）を包んで試す。**本番へは1バイトも送らない。**
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { buildPlan, applyPlan, linkedProjectRef } from "../../scripts/db-apply-many.mjs";
import { recordCount } from "../counts.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const results = [];

function assert(cond, message) {
  if (!cond) throw new Error(message);
}
async function test(group, name, fn) {
  try {
    await fn();
    results.push({ group, name, ok: true });
    console.log(`  ○ [${group}] ${name}`);
  } catch (e) {
    results.push({ group, name, ok: false, why: e.message });
    console.log(`  ✗ [${group}] ${name}\n      ${e.message}`);
  }
}

/** 試験専用の migration 置き場を作る。中身はこちらで決める */
function makeDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dpq-apply-many-"));
  for (const [name, sql] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), sql, "utf8");
  }
  return dir;
}

/** 手元のデータベースを、道具が期待する形（query を持つもの）に包む */
function wrap(db) {
  return { query: async (sql) => db.exec(sql) };
}

const OK2 = {
  "20260101000000_a.sql": "create table public.t_a (id int primary key);",
  "20260102000000_b.sql": "create table public.t_b (id int primary key);",
};

console.log("\n当てる中身の検査");

await test("道具", "2本ならそのまま受ける", () => {
  const dir = makeDir(OK2);
  const p = buildPlan(["20260101000000_a.sql", "20260102000000_b.sql"], { migrationsDir: dir });
  assert(p.ok, `断られた: ${p.error}`);
  assert(p.items.length === 2, `本数が ${p.items.length}`);
});

await test("道具", "1本だけなら断る（1本用の道具があるため）", () => {
  const dir = makeDir(OK2);
  const p = buildPlan(["20260101000000_a.sql"], { migrationsDir: dir });
  assert(!p.ok, "1本でも受けてしまった");
  assert(/2本以上/.test(p.error), `断り文句が違う: ${p.error}`);
});

await test("道具", "7本を、渡した順のまま並べる（版番号の順に直さない）", () => {
  const files = {};
  const order = [
    "20260107000000_g.sql", "20260110000000_x.sql", "20260108000000_h.sql",
    "20260109000000_i.sql", "20260111000000_j.sql", "20260112000000_k.sql",
    "20260113000000_l.sql",
  ];
  for (const n of order) files[n] = `-- ${n}\nselect 1;`;
  const dir = makeDir(files);
  const p = buildPlan(order, { migrationsDir: dir });
  assert(p.ok, `断られた: ${p.error}`);
  assert(p.items.length === 7, `本数が ${p.items.length}`);
  const got = p.items.map((x) => x.name);
  assert(JSON.stringify(got) === JSON.stringify(order), `並びが変わった: ${got.join(" ")}`);
  // 版番号の順に直されていたら、2本目は 20260108 になるはず
  assert(got[1] === "20260110000000_x.sql", "版番号の順に並べ替えられている");
});

console.log("\n断るべきものを断るか");

await test("道具", "区切り文字の入った名前は断る", () => {
  const dir = makeDir(OK2);
  const p = buildPlan(["../secret.sql", "20260101000000_a.sql"], { migrationsDir: dir });
  assert(!p.ok, "受けてしまった");
});

await test("道具", "上の階層をたどる名前は断る", () => {
  const dir = makeDir(OK2);
  const p = buildPlan(["20260101000000_a.sql", "..20260102000000_b.sql"], { migrationsDir: dir });
  assert(!p.ok, "受けてしまった");
});

await test("道具", "斜線を含む名前は断る", () => {
  const dir = makeDir(OK2);
  const p = buildPlan(["sub/20260101000000_a.sql", "20260102000000_b.sql"], { migrationsDir: dir });
  assert(!p.ok, "受けてしまった");
  assert(/区切り文字/.test(p.error), `断り文句が違う: ${p.error}`);
});

await test("道具", "無いファイルは断る", () => {
  const dir = makeDir(OK2);
  const p = buildPlan(["20260101000000_a.sql", "20260199000000_none.sql"], { migrationsDir: dir });
  assert(!p.ok, "受けてしまった");
  assert(/ありません/.test(p.error), `断り文句が違う: ${p.error}`);
});

await test("道具", "版番号になっていない名前は断る", () => {
  const dir = makeDir({ ...OK2, "hello_world.sql": "select 1;" });
  const p = buildPlan(["20260101000000_a.sql", "hello_world.sql"], { migrationsDir: dir });
  assert(!p.ok, "受けてしまった");
  assert(/14桁/.test(p.error), `断り文句が違う: ${p.error}`);
});

await test("道具", "同じファイルを2回指定したら断る", () => {
  const dir = makeDir(OK2);
  const p = buildPlan(
    ["20260101000000_a.sql", "20260102000000_b.sql", "20260101000000_a.sql"],
    { migrationsDir: dir },
  );
  assert(!p.ok, "受けてしまった");
  assert(/同じファイル/.test(p.error), `断り文句が違う: ${p.error}`);
});

await test("道具", "同じ版番号の別ファイルを指定したら断る", () => {
  const dir = makeDir({
    ...OK2,
    "20260101000000_a2.sql": "create table public.t_a2 (id int primary key);",
  });
  const p = buildPlan(["20260101000000_a.sql", "20260101000000_a2.sql"], { migrationsDir: dir });
  assert(!p.ok, "受けてしまった");
  assert(/同じ版番号/.test(p.error), `断り文句が違う: ${p.error}`);
});

console.log("\n当てる先の取り違えを防ぐか");

/** 道具をコマンドとして呼ぶ。戻りは { code, out } */
function runCli(args, { cwd = ROOT } = {}) {
  try {
    const out = execFileSync("node", [path.join(ROOT, "scripts", "db-apply-many.mjs"), ...args], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

const REAL = ["20260907120000_single_pass_draw_and_slot_redo.sql", "20260910190000_merge_draft_state_contract.sql"];

await test("道具", "空撃ちではDBへ接続しない（link していなくても通る）", () => {
  const r = runCli([...REAL, "--dry-run"]);
  assert(r.code === 0, `終了コードが ${r.code}\n${r.out}`);
  assert(/接続していません/.test(r.out), `接続しない旨が出ていない:\n${r.out}`);
  assert(!/接続しました/.test(r.out), "接続してしまっている");
});

await test("道具", "空撃ちでも、当てる順と本数は出る", () => {
  const r = runCli([...REAL, "--dry-run"]);
  const i1 = r.out.indexOf("20260907120000");
  const i2 = r.out.indexOf("20260910190000");
  assert(i1 >= 0 && i2 >= 0, "ファイル名が出ていない");
  assert(i1 < i2, "渡した順に出ていない");
  assert(/合計 2 本/.test(r.out), `本数が出ていない:\n${r.out}`);
});

await test("道具", "当てる先を明示しないと、接続せずに断る", () => {
  const r = runCli(REAL);
  assert(r.code === 1, `終了コードが ${r.code}`);
  assert(!/接続しました/.test(r.out), "接続してしまっている");
  const linked = linkedProjectRef();
  if (linked) assert(/当てる先を明示/.test(r.out), `断り文句が違う:\n${r.out}`);
  else assert(/link/.test(r.out), `断り文句が違う:\n${r.out}`);
});

await test("道具", "当てる先が食い違っていたら、接続せずに断る", () => {
  const r = runCli([...REAL, "--confirm-project", "zzzz-not-this-project"]);
  assert(r.code === 1, `終了コードが ${r.code}`);
  assert(!/接続しました/.test(r.out), "接続してしまっている");
  assert(/食い違って|link/.test(r.out), `断り文句が違う:\n${r.out}`);
});

await test("道具", "当てる先が一致していれば、そこで断らずに接続へ進む", () => {
  // link していない作業木でも確かめられるように、印だけを一時的に置く。
  // **本番へは接続しない。**届かないアドレスを渡して、接続で落ちることを見る。
  const refFile = path.join(ROOT, "supabase", ".temp", "project-ref");
  const had = fs.existsSync(refFile);
  const backup = had ? fs.readFileSync(refFile, "utf8") : null;
  fs.mkdirSync(path.dirname(refFile), { recursive: true });
  fs.writeFileSync(refFile, "dpq-selftest-ref\n", "utf8");
  try {
    const r = (() => {
      try {
        const out = execFileSync(
          "node",
          [path.join(ROOT, "scripts", "db-apply-many.mjs"), ...REAL, "--confirm-project", "dpq-selftest-ref"],
          { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, SUPABASE_DB_URL: "postgresql://u:p@127.0.0.1:1/none" } },
        );
        return { code: 0, out };
      } catch (e) {
        return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
      }
    })();
    assert(!/食い違って/.test(r.out), `一致しているのに食い違いと言われた:\n${r.out}`);
    assert(!/当てる先を明示/.test(r.out), `一致しているのに明示を求められた:\n${r.out}`);
    // 接続で落ちる。つまり突き合わせは通過している
    assert(r.code === 1, `終了コードが ${r.code}`);
  } finally {
    if (had) fs.writeFileSync(refFile, backup, "utf8");
    else fs.rmSync(refFile, { force: true });
  }
});

await test("道具", "link されている先と、指定した先を突き合わせている", () => {
  // link していない作業木でも、突き合わせの向きだけは確かめられる
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dpq-ref-"));
  const f = path.join(dir, "project-ref");
  fs.writeFileSync(f, "abcdefghijklmnopqrst\n", "utf8");
  assert(linkedProjectRef({ file: f }) === "abcdefghijklmnopqrst", "読めていない");
  assert(linkedProjectRef({ file: path.join(dir, "none") }) === null, "無いのに読めている");
});

console.log("\n全部入るか、1本も入らないか");

await test("道具", "全部成功すると、全部入る", async () => {
  const db = new PGlite();
  const dir = makeDir(OK2);
  const p = buildPlan(["20260101000000_a.sql", "20260102000000_b.sql"], { migrationsDir: dir });
  const r = await applyPlan(p.items, wrap(db), { log: () => {} });
  assert(r.ok, `失敗した: ${r.error?.message}`);
  const n = (await db.query(`select count(*)::int n from pg_tables where schemaname='public'`)).rows[0].n;
  assert(n === 2, `表が ${n} 個（2個のはず）`);
});

await test("道具", "途中で落ちると、1本も入らない", async () => {
  const db = new PGlite();
  const dir = makeDir({
    ...OK2,
    "20260103000000_bad.sql": "create table public.t_c (id int primary key);\nselect this_function_does_not_exist();",
    "20260104000000_d.sql": "create table public.t_d (id int primary key);",
  });
  const p = buildPlan(
    ["20260101000000_a.sql", "20260103000000_bad.sql", "20260104000000_d.sql"],
    { migrationsDir: dir },
  );
  const r = await applyPlan(p.items, wrap(db), { log: () => {} });
  assert(!r.ok, "落ちなかった");
  assert(r.failed === "20260103000000_bad.sql", `落ちたファイルの名前が違う: ${r.failed}`);
  const n = (await db.query(`select count(*)::int n from pg_tables where schemaname='public'`)).rows[0].n;
  assert(n === 0, `表が ${n} 個残っている（0個のはず）`);
});

await test("道具", "最後の1本で落ちても、前の分まで戻る", async () => {
  const db = new PGlite();
  const dir = makeDir({
    ...OK2,
    "20260105000000_bad.sql": "select 1 / 0;",
  });
  const p = buildPlan(
    ["20260101000000_a.sql", "20260102000000_b.sql", "20260105000000_bad.sql"],
    { migrationsDir: dir },
  );
  const r = await applyPlan(p.items, wrap(db), { log: () => {} });
  assert(!r.ok, "落ちなかった");
  const n = (await db.query(`select count(*)::int n from pg_tables where schemaname='public'`)).rows[0].n;
  assert(n === 0, `表が ${n} 個残っている（0個のはず）`);
});

await test("道具", "履歴表には何も書かない", async () => {
  const db = new PGlite();
  const dir = makeDir(OK2);
  const p = buildPlan(["20260101000000_a.sql", "20260102000000_b.sql"], { migrationsDir: dir });
  await applyPlan(p.items, wrap(db), { log: () => {} });
  const n = (await db.query(
    `select count(*)::int n from information_schema.schemata where schema_name = 'supabase_migrations'`,
  )).rows[0].n;
  assert(n === 0, "履歴の置き場を作ってしまっている");
});

await test("道具", "SQL のなかみを、そのまま流している（読み替えない）", () => {
  const dir = makeDir(OK2);
  const p = buildPlan(["20260101000000_a.sql", "20260102000000_b.sql"], { migrationsDir: dir });
  assert(p.items[0].sql === OK2["20260101000000_a.sql"], "1本目が書き換わっている");
  assert(p.items[1].sql === OK2["20260102000000_b.sql"], "2本目が書き換わっている");
});

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
console.log(`\n合計 ${results.length} 件 / 合格 ${passed} 件 / 不合格 ${failed.length} 件`);
for (const f of failed) console.log(`  ✗ [${f.group}] ${f.name}: ${f.why}`);
recordCount("道具の自己試験", results.length);
process.exit(failed.length === 0 ? 0 : 1);
