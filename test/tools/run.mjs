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
import {
  isFixtureEmail,
  purgeFixtureUsers,
  summarizeFailures,
} from "../../scripts/_smoke-users.mjs";
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

// ============================================================================
// 検査用の利用者を片づける道具
// ============================================================================
//
// 2026-09-10 に、本番で317人を消そうとして133人しか消えなかった。
// 原因は「1ページ読む → その場で消す → 次のページ」という順で、
// 消すと後ろの人が前へ詰まり、ページの境目にいた人が飛ばされていたこと。
// ここでは本番へつながず、同じ形の名簿を手元で作って確かめる。

console.log("\n検査用の利用者を片づける道具");

/** 名簿を持った偽の Admin API。消すと本当に減る（本番と同じ詰まり方をする） */
function fakeDirectory(users) {
  const store = [...users];
  return {
    store,
    client: {
      auth: {
        admin: {
          listUsers: async ({ page, perPage }) => ({
            data: { users: store.slice((page - 1) * perPage, page * perPage) },
            error: null,
          }),
        },
      },
    },
    remove: async (id) => {
      const i = store.findIndex((u) => u.id === id);
      if (i < 0) return "居ません";
      store.splice(i, 1);
      return null;
    },
  };
}

await test("片づけ", "ページの境目にいる人を飛ばさない", async () => {
  // 検査用と本物を混ぜて、境目（200人ごと）をまたぐ人数にする
  const users = [];
  for (let i = 0; i < 450; i += 1) {
    users.push(
      i % 3 === 0
        ? { id: `f${i}`, email: `dpq-fixture-role-${i}-1@dpq-smoke.invalid` }
        : { id: `r${i}`, email: `person${i}@example.org` },
    );
  }
  const d = fakeDirectory(users);
  const r = await purgeFixtureUsers({ client: d.client, remove: d.remove, pauseMs: 0 });

  assert(r.matched === 150, `対象の数が違う: ${r.matched}`);
  assert(r.removed === 150, `消えた数が違う: ${r.removed}（飛ばしている）`);
  assert(d.store.length === 300, `名簿に ${d.store.length} 人残っている（300人のはず）`);
  assert(
    d.store.every((u) => !isFixtureEmail(u.email)),
    "検査用の人が残っている",
  );
});

await test("片づけ", "本物の利用者には触れない", async () => {
  const d = fakeDirectory([
    { id: "a", email: "songcunyizhi@gmail.com" },
    { id: "b", email: "vro.artcode@gmail.com" },
    { id: "c", email: null },
    { id: "d", email: "dpq-smoke-artist-1-2@example.com" },
    { id: "e", email: "dpq-fixture-artist@dpq-smoke.invalid" },
  ]);
  const r = await purgeFixtureUsers({ client: d.client, remove: d.remove, pauseMs: 0 });
  assert(r.matched === 1, `対象の数が違う: ${r.matched}`);
  assert(d.store.length === 4, `名簿に ${d.store.length} 人残っている（4人のはず）`);
  assert(d.store.some((u) => u.email === "songcunyizhi@gmail.com"), "本物を消してしまった");
});

await test("片づけ", "下見では1人も消さない", async () => {
  const d = fakeDirectory([
    { id: "e", email: "dpq-fixture-artist@dpq-smoke.invalid" },
    { id: "a", email: "songcunyizhi@gmail.com" },
  ]);
  const r = await purgeFixtureUsers({ dryRun: true, client: d.client, remove: d.remove, pauseMs: 0 });
  assert(r.matched === 1, `対象の数が違う: ${r.matched}`);
  assert(r.removed === 0, "下見なのに消している");
  assert(d.store.length === 2, "下見なのに名簿が減っている");
});

await test("片づけ", "消せなかった理由を握りつぶさない", async () => {
  const d = fakeDirectory([
    { id: "x1", email: "dpq-fixture-a-1-1@dpq-smoke.invalid" },
    { id: "x2", email: "dpq-fixture-b-1-1@dpq-smoke.invalid" },
    { id: "x3", email: "dpq-fixture-c-1-1@dpq-smoke.invalid" },
  ]);
  const r = await purgeFixtureUsers({
    client: d.client,
    pauseMs: 0,
    remove: async (id) => (id === "x3" ? null : "500 Database error deleting user"),
  });
  assert(r.matched === 3, `対象の数が違う: ${r.matched}`);
  assert(r.removed === 1, `消えた数が違う: ${r.removed}`);
  assert(r.failures.length === 1, `理由の並びが違う: ${JSON.stringify(r.failures)}`);
  assert(
    /^2 人: 500 Database error deleting user$/.test(r.failures[0]),
    `理由の書き方が違う: ${r.failures[0]}`,
  );
});

await test("片づけ", "理由が何種類あるかが分かる", () => {
  const out = summarizeFailures(["A", "B", "A", "A", ""]);
  assert(out.length === 3, `種類の数が違う: ${JSON.stringify(out)}`);
  assert(out[0] === "3 人: A", `いちばん多い理由が違う: ${out[0]}`);
  assert(
    out.some((line) => /理由が返らなかった/.test(line)),
    `空の理由が落ちている: ${JSON.stringify(out)}`,
  );
});

await test("片づけ", "消す相手の見分けかたは1か所だけ", () => {
  const yes = ["dpq-fixture-artist@dpq-smoke.invalid", "dpq-fixture-a-1-2@dpq-smoke.invalid"];
  const no = [
    "songcunyizhi@gmail.com",
    "dpq-smoke-artist-1-2@example.com",
    "dpq-fixture-artist@example.com",
    "artist@dpq-smoke.invalid",
    "dpq-fixture-artist@dpq-smoke.invalid.example.com",
    "",
    null,
    undefined,
  ];
  for (const e of yes) assert(isFixtureEmail(e), `検査用と見なされない: ${e}`);
  for (const e of no) assert(!isFixtureEmail(e), `本物を検査用と見なした: ${e}`);
});

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
console.log(`\n合計 ${results.length} 件 / 合格 ${passed} 件 / 不合格 ${failed.length} 件`);
for (const f of failed) console.log(`  ✗ [${f.group}] ${f.name}: ${f.why}`);
recordCount("道具の自己試験", results.length);
process.exit(failed.length === 0 ? 0 : 1);
