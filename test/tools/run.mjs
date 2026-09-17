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
import { isTestAccountEmail, testAccountKind } from "../../scripts/_test-accounts.mjs";
import {
  OWN_ROW_TABLES,
  cleanupRunRows,
  createRunLedger,
  describeCleanup,
} from "../../scripts/_smoke-own-rows.mjs";
import {
  actorFromCookies,
  cleanupActors,
  cleanupFailed,
  createActorLedger,
  describeActor,
  maskId,
} from "../../scripts/_smoke-actors.mjs";
import {
  BASELINE_TABLES,
  baselineDrift,
  diffBaseline,
} from "../../scripts/_smoke-baseline.mjs";
import { asRole, createTestDb } from "../db/harness.mjs";
import { FUNNEL_SQL, ratio } from "../../scripts/funnel-query.mjs";
import { collectFunnel } from "../../scripts/db-funnel.mjs";
import {
  answerWork,
  asMember,
  drawPrompt,
  makeGuest,
  makeMember,
  pickTags,
  postArtFirstWork,
  postWork,
  startDraftOnly,
  value,
} from "../db/helpers.mjs";
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
  assert(r.ok && r.remaining === 0, `消し終わったのに ok になっていない: ${JSON.stringify({ ok: r.ok, remaining: r.remaining })}`);
  assert(
    d.store.every((u) => !isFixtureEmail(u.email)),
    "検査用の人が残っている",
  );
});

await test("片づけ", "本物の利用者には触れない（3つの形の検査用だけを消す）", async () => {
  const d = fakeDirectory([
    { id: "a", email: "songcunyizhi@gmail.com" },
    { id: "b", email: "vro.artcode@gmail.com" },
    { id: "c", email: null },
    { id: "d", email: "dpq-smoke-artist-1-2@example.com" },
    { id: "e", email: "dpq-fixture-artist@dpq-smoke.invalid" },
    { id: "p", email: "dpq-probe-1785793736280@example.com" },
  ]);
  const r = await purgeFixtureUsers({ client: d.client, remove: d.remove, pauseMs: 0 });
  assert(r.matched === 3, `対象の数が違う: ${r.matched}`);
  assert(r.ok, "消し終わったのに ok になっていない");
  assert(d.store.map((u) => u.id).join() === "a,b,c", `残った人が違う: ${d.store.map((u) => u.id).join()}`);
});

await test("片づけ", "ゲスト（メールなし）と、無関係な example.com は消さない", async () => {
  const d = fakeDirectory([
    { id: "g1", email: null },
    { id: "g2", email: "" },
    { id: "x1", email: "someone@example.com" },
    { id: "x2", email: "dpq-smoke@example.com" },
    { id: "s1", email: "dpq-smoke-fan-1-2@example.com" },
  ]);
  const r = await purgeFixtureUsers({ client: d.client, remove: d.remove, pauseMs: 0 });
  assert(r.matched === 1 && r.removed === 1 && r.ok, `結果が違う: ${JSON.stringify({ m: r.matched, r: r.removed, ok: r.ok })}`);
  assert(d.store.map((u) => u.id).join() === "g1,g2,x1,x2", `残った人が違う: ${d.store.map((u) => u.id).join()}`);
});

await test("片づけ", "対象の数が期待と違えば、1人も消さずに止める", async () => {
  const d = fakeDirectory([
    { id: "f", email: "dpq-fixture-a@dpq-smoke.invalid" },
    { id: "s", email: "dpq-smoke-a-1-2@example.com" },
    { id: "p", email: "dpq-probe-1@example.com" },
    { id: "r", email: "songcunyizhi@gmail.com" },
  ]);
  let stopped = null;
  try {
    await purgeFixtureUsers({ client: d.client, remove: d.remove, pauseMs: 0, expected: 2 });
  } catch (e) {
    stopped = e;
  }
  assert(stopped && /3 人/.test(stopped.message), `止まらなかった、または理由が違う: ${stopped?.message}`);
  assert(d.store.length === 4, `止めたはずなのに ${4 - d.store.length} 人消した`);

  const r = await purgeFixtureUsers({ client: d.client, remove: d.remove, pauseMs: 0, expected: 3 });
  assert(r.removed === 3 && r.ok, `期待どおりの数なのに消し切れない: ${JSON.stringify({ r: r.removed, ok: r.ok })}`);
});

/** 認証の管理 API の代わり。返す番号と本文を決め、叩かれた回数を数える */
function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, method: init?.method });
    return new Response(JSON.stringify(body), { status });
  };
  return { fn, calls };
}

await test("片づけ", "4xx はやり直さず、理由をそのまま返す（握りつぶさない）", async () => {
  const d = fakeDirectory([{ id: "f1", email: "dpq-fixture-a@dpq-smoke.invalid" }]);
  const f = fakeFetch(403, { msg: "User not allowed" });
  const r = await purgeFixtureUsers({ client: d.client, pauseMs: 0, retryDelayMs: 0, fetchImpl: f.fn });
  assert(f.calls.length === 1, `4xx なのに ${f.calls.length} 回叩いた`);
  assert(f.calls[0].method === "DELETE" && /\/auth\/v1\/admin\/users\/f1$/.test(f.calls[0].url), `叩いた先が違う: ${JSON.stringify(f.calls[0])}`);
  assert(r.removed === 0 && !r.ok, "消せていないのに成功になった");
  assert(/^1 人: 403 User not allowed$/.test(r.failures[0] ?? ""), `理由が違う: ${JSON.stringify(r.failures)}`);
});

await test("片づけ", "5xx は4回までやり直し、それでも駄目なら理由を返す", async () => {
  const d = fakeDirectory([{ id: "f1", email: "dpq-fixture-a@dpq-smoke.invalid" }]);
  const f = fakeFetch(500, { code: 500, msg: "Database error deleting user" });
  const r = await purgeFixtureUsers({ client: d.client, pauseMs: 0, retryDelayMs: 0, fetchImpl: f.fn });
  assert(f.calls.length === 4, `5xx のやり直しが ${f.calls.length} 回`);
  assert(r.removed === 0 && !r.ok, "消せていないのに成功になった");
  assert(/^1 人: 500 Database error deleting user$/.test(r.failures[0] ?? ""), `理由が違う: ${JSON.stringify(r.failures)}`);
});

await test("片づけ", "消えたと返ったのに名簿に残っていれば、不合格にする", async () => {
  const d = fakeDirectory([
    { id: "f1", email: "dpq-fixture-a@dpq-smoke.invalid" },
    { id: "s1", email: "dpq-smoke-a-1-2@example.com" },
  ]);
  const r = await purgeFixtureUsers({ client: d.client, pauseMs: 0, remove: async () => null });
  assert(r.removed === 2, `消えたと数えた数が違う: ${r.removed}`);
  assert(r.remaining === 2, `名簿に残った数が違う: ${r.remaining}`);
  assert(r.ok === false, "名簿に残っているのに成功になった");
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

await test("片づけ", "検査用の3つの形を見分け、ほかは見分けない（判定は1か所）", () => {
  const yes = {
    "dpq-fixture-artist@dpq-smoke.invalid": "fixture",
    "dpq-fixture-subdir-author@dpq-smoke.invalid": "fixture",
    "dpq-smoke-artist-81234-567890@example.com": "smoke",
    "dpq-smoke-anon1786-4242-12@example.com": "smoke",
    "dpq-smoke-report-fan-1-2@example.com": "smoke",
    "DPQ-Smoke-FanA-1-2@Example.com": "smoke",
    "dpq-probe-1785793736280@example.com": "probe",
  };
  const no = [
    "songcunyizhi@gmail.com",
    "vro.artcode+smtp1@gmail.com",
    // example.com は例示用に予約された実在のドメイン。接頭辞と形が揃わなければ検査用ではない
    "someone@example.com",
    "dpq-smoke@example.com",
    "dpq-smoke-artist@example.com",
    "dpq-smoke-artist-1-2@example.org",
    "dpq-smoke-artist-1-2@example.com.evil.test",
    "dpq-probe-abc@example.com",
    "dpq-probe-1@example.org",
    // .invalid は決して実在しないドメイン。ただし dpq-fixture- の形でなければ当てない
    "dpq-fixture-artist@example.com",
    "artist@dpq-smoke.invalid",
    "dpq-fixture-artist@dpq-smoke.invalid.example.com",
    "",
    null,
    undefined,
  ];
  for (const [e, kind] of Object.entries(yes)) {
    assert(testAccountKind(e) === kind, `${e} を ${kind} と見なさない: ${testAccountKind(e)}`);
    assert(isTestAccountEmail(e), `検査用と見なされない: ${e}`);
  }
  for (const e of no) assert(!isTestAccountEmail(e), `検査用でないものを検査用と見なした: ${e}`);
  // 固定の利用者を探す関数も、同じ判定を通っている
  assert(isFixtureEmail("dpq-fixture-artist@dpq-smoke.invalid"), "固定の利用者を見分けない");
  assert(!isFixtureEmail("dpq-smoke-artist-1-2@example.com"), "使い捨てを固定の利用者と見なした");
});

// ============================================================================
// 検査がこの実行で作った行だけを消す道具
// ============================================================================
//
// 2026-09-10 に、smoke-sub-directive の後片づけが本番で3回とも失敗していた。
// お題を「この作者のもの全部」で消そうとして、同じ作者の古いお題に
// 非公開にしただけの作品が残っていたため、外部キーで1文まるごと断られた。
// ここでは本物と同じ migration を当てた手元のDB（PGlite）で、その形を作って確かめる。

console.log("\n検査がこの実行で作った行だけを消す道具");

const ownDb = await createTestDb();
// 本物の Supabase では service_role が public の表をすべて読み書きできる（検査の admin() がそれ）。
// 手元の下地（harness の SUPABASE_STUB）はそこまで作らないので、ここで同じ権限を渡す
await ownDb.exec(`grant all on all tables in schema public to service_role`);

/** service_role として、ID の一覧で消す（本番の supabaseRemover と同じ1文） */
function sqlRemover(db) {
  return async (table, ids) => {
    if (!OWN_ROW_TABLES.includes(table)) throw new Error(`知らない表: ${table}`);
    try {
      const r = await asRole(db, { role: "service_role" }, (c) =>
        c.query(`delete from public.${table} where id = any($1::uuid[]) returning id`, [ids]),
      );
      return { ids: r.rows.map((x) => x.id), error: null };
    } catch (e) {
      return { ids: [], error: [e.code, e.message].filter(Boolean).join(" ") };
    }
  };
}

async function countWhere(sql, params) {
  const r = await ownDb.query(sql, params);
  return Number(Object.values(r.rows[0])[0]);
}

/**
 * 9/10 の本番と同じ形を作る。
 *   古いお題 … 同じ作者が前に出し、作品は画面から削除した（行は残る）
 *   今回     … 確定だけのお題 / 投稿して回答されたお題 / 持ち込みのお題
 */
async function sceneOf(tag) {
  const author = await makeMember(ownDb, `own-a-${tag}`);
  const guesser = await makeMember(ownDb, `own-g-${tag}`);

  const old = await drawPrompt(ownDb, author);
  const oldWork = await postWork(ownDb, author, old.prompt_id, "古い作品");
  await value(ownDb, asMember(author), `select public.delete_work($1::uuid)`, [oldWork]);

  const plain = await drawPrompt(ownDb, author);
  const main = await drawPrompt(ownDb, author);
  const work = await postWork(ownDb, author, main.prompt_id, "今回の作品");
  await answerWork(ownDb, guesser, work);
  const tagIds = [];
  for (const category of ["morph", "emotion", "color"]) {
    for (const t of await pickTags(ownDb, category, 1)) tagIds.push(t.id);
  }
  const art = await postArtFirstWork(ownDb, author, tagIds);
  // 持ち込みの戻り値にお題の ID は無い。検査と同じく、作品の行から引く
  art.prompt_id = (await ownDb.query(`select prompt_id from public.works where id = $1`,
    [art.workId])).rows[0]?.prompt_id;
  assert(art.prompt_id, "持ち込みのお題を特定できない");

  const ledger = createRunLedger();
  ledger.add("draft_sessions", plain.state.session_id);
  ledger.add("draft_sessions", main.state.session_id);
  ledger.add("prompts", plain.prompt_id);
  ledger.add("prompts", main.prompt_id);
  ledger.add("prompts", art.prompt_id);
  ledger.add("works", work);
  ledger.add("works", art.workId);

  return {
    author, ledger, work, artWork: art.workId, oldPrompt: old.prompt_id, oldWork,
    runPrompts: [plain.prompt_id, main.prompt_id, art.prompt_id],
  };
}

await test("この実行の分", "作者名でまとめて消すと、古いお題1件のせいで今回のお題も残る（9/10 の再現）", async () => {
  const s = await sceneOf("repro");
  await ownDb.exec("begin");
  let caught = null;
  try {
    await ownDb.query(`delete from public.works where id = any($1::uuid[])`, [[s.work, s.artWork]]);
    await ownDb.query(`delete from public.prompts where created_by = $1`, [s.author]);
  } catch (e) {
    caught = e;
  } finally {
    await ownDb.exec("rollback");
  }
  assert(caught, "作者名で消せてしまった（古いお題の作品が効いていない）");
  // 本番（PostgreSQL 17）は 23503、手元の PGlite（18）は 23001 で断る。
  // 18 から on delete restrict の違反に専用の番号が付いた。どちらも同じ外部キーで止まる
  assert(
    ["23503", "23001"].includes(caught.code) && /works_prompt_id_fkey/.test(caught.message),
    `断られ方が違う: ${caught.code} ${caught.message}`,
  );
  const left = await countWhere(
    `select count(*) from public.prompts where id = any($1::uuid[])`,
    [s.runPrompts],
  );
  assert(left === 3, `今回のお題が ${left} 件（1文まるごと断られるなら3件残る）`);
});

await test("この実行の分", "帳面の ID だけを消し、同じ作者の古いお題と作品には触れない", async () => {
  const s = await sceneOf("own");
  const report = await cleanupRunRows(s.ledger, sqlRemover(ownDb));
  for (const r of report) assert(r.ok, `${r.table}: ${describeCleanup(r)}`);

  const byTable = Object.fromEntries(report.map((r) => [r.table, r.removed]));
  assert(byTable.works === 2 && byTable.prompts === 3 && byTable.draft_sessions === 2,
    `消えた数が違う: ${JSON.stringify(byTable)}`);

  assert(await countWhere(`select count(*) from public.prompts where id = any($1::uuid[])`,
    [s.runPrompts]) === 0, "今回のお題が残っている");
  assert(await countWhere(`select count(*) from public.quiz_questions where prompt_id = any($1::uuid[])`,
    [s.runPrompts]) === 0, "今回のお題の問いが残っている");
  assert(await countWhere(`select count(*) from public.answers where work_id = $1`,
    [s.work]) === 0, "回答が作品と一緒に消えていない");
  assert(await countWhere(`select count(*) from public.prompts where id = $1`,
    [s.oldPrompt]) === 1, "古いお題まで消した");
  assert(await countWhere(`select count(*) from public.works where id = $1 and deleted_at is not null`,
    [s.oldWork]) === 1, "古い作品の行まで消した");
});

await test("この実行の分", "作品を積み忘れたお題は消えず、理由つきで不合格になる", async () => {
  const s = await sceneOf("forgot");
  const ledger = createRunLedger();
  for (const id of s.runPrompts) ledger.add("prompts", id);
  const report = await cleanupRunRows(ledger, sqlRemover(ownDb));
  const p = report.find((r) => r.table === "prompts");
  assert(!p.ok, "消せていないのに合格になった");
  assert(/23503|23001/.test(p.error ?? ""), `理由が出ていない: ${describeCleanup(p)}`);
  assert(p.missing.length === 3, `消えなかった ID の数が違う: ${p.missing.length}`);
  assert(/消えなかった: /.test(describeCleanup(p)), `ID が出ていない: ${describeCleanup(p)}`);
});

await test("この実行の分", "一部だけ消えた・頼んでいない行が消えた・例外、を合格にしない", async () => {
  const ledger = createRunLedger();
  ledger.add("works", "w1");
  ledger.add("prompts", "p1");
  ledger.add("prompts", "p2");
  ledger.add("draft_sessions", "d1");
  const report = await cleanupRunRows(ledger, async (table) => {
    if (table === "works") return { ids: ["w1", "w9"], error: null };
    if (table === "prompts") return { ids: ["p1"], error: null };
    throw new Error("接続が切れた");
  });
  const [w, p, d] = report;
  assert(!w.ok && w.extra.join() === "w9", `頼んでいない行を見逃した: ${describeCleanup(w)}`);
  assert(!p.ok && p.missing.join() === "p2", `残った行を見逃した: ${describeCleanup(p)}`);
  assert(!d.ok && /接続が切れた/.test(d.error ?? ""), `例外を握りつぶした: ${describeCleanup(d)}`);
  assert(report.length === 3, "途中の失敗で残りの表を飛ばした");
});

await test("この実行の分", "帳面に無い表は積めない。空の帳面では何も呼ばない", async () => {
  const ledger = createRunLedger();
  let threw = false;
  try {
    ledger.add("profiles", "x");
  } catch {
    threw = true;
  }
  assert(threw, "帳面に無い表を受けた");
  let called = 0;
  const report = await cleanupRunRows(ledger, async () => {
    called += 1;
    return { ids: [], error: null };
  });
  assert(called === 0, `空なのに ${called} 回呼んだ`);
  assert(report.every((r) => r.ok), "空の帳面が不合格になった");
});

await ownDb.close();

// ============================================================================
// 初回利用の進みぐあいを数える SQL（scripts/funnel-query.mjs）
// ============================================================================
//
// 本番を読む道具（scripts/db-funnel.mjs）と、ここで試す数え方は**同じ1本の SQL**。
// 数え方の間違いは本番では見つけられない（正解の人数を誰も知らないため）ので、
// 人数が分かっている小さな場を手元のDBに作って、期待どおりの人数と率になるかを見る。
//
// 置く人（すべて本物の migration を当てたDBへ、本物の RPC で作る）:
//   A … 登録して、お題を引き、確定し、投稿し、人から回答が付き、結果を開いた
//   B … ゲスト。ドラフトを始めただけ（確定していない）
//   C … ゲスト。3件に答えただけ（作っていない）
//   D … 登録して、絵を先に出す形（art_first）で投稿した
//   E … 仕組みの回答だけが付いた作品の作者（人からの回答は無い）
//   F … 同じ人が2件作って2件投稿した（人数が2重にならないか）

console.log("\n初回利用の進みぐあいを数える SQL");

const funnelDb = await createTestDb();
const funnelQuery = (sql, params) => funnelDb.query(sql, params);

/** 期間を指定して1回数える */
async function funnel(period = "all") {
  const got = await collectFunnel(funnelQuery, [period]);
  return got[period];
}

const scene = {};
{
  // A
  scene.a = await makeMember(funnelDb, "fn-a");
  const ap = await drawPrompt(funnelDb, scene.a);
  scene.aWork = await postWork(funnelDb, scene.a, ap.prompt_id, "A の作品");

  // C（答えるだけのゲスト。A の作品を含めて3件に答える）
  scene.c = await makeGuest(funnelDb);

  // F（同じ人が2件）
  scene.f = await makeMember(funnelDb, "fn-f");
  const fp1 = await drawPrompt(funnelDb, scene.f);
  scene.fWork1 = await postWork(funnelDb, scene.f, fp1.prompt_id, "F の作品1");
  const fp2 = await drawPrompt(funnelDb, scene.f);
  scene.fWork2 = await postWork(funnelDb, scene.f, fp2.prompt_id, "F の作品2");

  // E（仕組みの回答だけ）
  scene.e = await makeMember(funnelDb, "fn-e");
  const ep = await drawPrompt(funnelDb, scene.e);
  scene.eWork = await postWork(funnelDb, scene.e, ep.prompt_id, "E の作品");
  await funnelDb.query(
    `insert into public.answers (work_id, user_id, answer_source, correct_count, question_count)
     values ($1, null, 'system', 0, 0)`,
    [scene.eWork],
  );

  // C が3件に答える（A・F1・F2）。A には人の回答が付く
  await answerWork(funnelDb, scene.c, scene.aWork, { guest: true });
  await answerWork(funnelDb, scene.c, scene.fWork1, { guest: true });
  await answerWork(funnelDb, scene.c, scene.fWork2, { guest: true });

  // A が結果を開く（result_seen_at が入るのはこの経路だけ）
  await asRole(funnelDb, asMember(scene.a), (c) =>
    c.query(`select public.open_my_work_result($1)`, [scene.aWork]),
  );

  // B（ドラフトだけのゲスト）
  scene.b = await makeGuest(funnelDb);
  await startDraftOnly(funnelDb, scene.b);

  // D（絵が先）
  scene.d = await makeMember(funnelDb, "fn-d");
  const dTags = [];
  for (const category of ["morph", "emotion", "color"]) {
    for (const t of await pickTags(funnelDb, category, 1)) dTags.push(t.id);
  }
  scene.dWork = await postArtFirstWork(funnelDb, scene.d, dTags);
}

await test("ファネル", "作った人の段が、1人1回だけ数えられる", async () => {
  const f = await funnel();
  const c = f.creator_prompt_first;
  // 作る側から入ったのは A・F・E・B の4人（D は art_first で作るので入口は不明）
  assert(c.actor === 4, `作る側の人数が ${c.actor}（A・F・E・B の4人のはず）`);
  assert(c.draft === 4, `ドラフトが ${c.draft}`);
  assert(c.prompt === 3, `お題の確定が ${c.prompt}（B は確定していない）`);
  assert(c.work === 3, `投稿が ${c.work}（F は2件出しても1人）`);
  assert(c.human_answer === 2, `人からの回答が ${c.human_answer}（A と F。E は仕組みだけ）`);
  assert(c.result_seen === 1, `結果を開いたのが ${c.result_seen}（A だけ）`);
});

await test("ファネル", "回答が何件あっても、作った人の人数は増えない", async () => {
  const before = (await funnel()).creator_prompt_first.human_answer;
  await answerWork(funnelDb, await makeGuest(funnelDb), scene.aWork, { guest: true });
  await answerWork(funnelDb, await makeGuest(funnelDb), scene.fWork1, { guest: true });
  const after = (await funnel()).creator_prompt_first.human_answer;
  assert(after === before, `回答を足したら作った人が ${before} → ${after} に増えた`);
});

await test("ファネル", "仕組みの回答は、人からの回答に混ざらない", async () => {
  const f = await funnel();
  const c = f.creator_prompt_first;
  assert(c.system_answer === 1, `仕組みの回答が付いた人が ${c.system_answer}（E だけのはず）`);
  assert(
    c.human_answer === 2,
    `人からの回答の人数に仕組みが混ざっている: ${c.human_answer}`,
  );
});

await test("ファネル", "答えた回数で段が分かれる（1・2・3・5回以上）", async () => {
  const a = (await funnel()).answerer;
  assert(a.a1 >= 1, `1回答えた人が ${a.a1}`);
  assert(a.a3 >= 1, `3回答えた人が ${a.a3}（C が3件答えている）`);
  assert(a.a5 === 0, `5回以上の人が ${a.a5}（まだ居ないはず）`);
  assert(a.a2 >= a.a3, `2回以上(${a.a2}) が 3回以上(${a.a3}) より少ない`);
});

await test("ファネル", "絵が先（art_first）は、お題が先と別に数える", async () => {
  const f = await funnel();
  assert(f.creator_art_first.work === 1, `絵が先の投稿者が ${f.creator_art_first.work}（D だけ）`);
  assert(
    f.creator_prompt_first.work === 3,
    `お題が先の投稿者に絵が先が混ざっている: ${f.creator_prompt_first.work}`,
  );
});

await test("ファネル", "ゲストと登録済みを分けて数える", async () => {
  const f = await funnel();
  assert(f.by_identity.guest_work === 0, `ゲストが投稿したことになっている: ${f.by_identity.guest_work}`);
  assert(f.by_identity.registered_work === 3, `登録済みの投稿者が ${f.by_identity.registered_work}`);
  assert(f.by_identity.guest_draft >= 1, `ゲストのドラフトが ${f.by_identity.guest_draft}`);
});

await test("ファネル", "期間を切ると、古い人が母数から外れる", async () => {
  const all = await funnel("all");
  await funnelDb.query(
    `update public.profiles set created_at = now() - interval '40 days' where id = $1`,
    [scene.b],
  );
  const recent = await funnel("30d");
  const allAfter = await funnel("all");
  assert(
    allAfter.actors.total === all.actors.total,
    `全期間の人数が変わった: ${all.actors.total} → ${allAfter.actors.total}`,
  );
  assert(
    recent.actors.total === all.actors.total - 1,
    `30日の人数が ${recent.actors.total}（全期間 ${all.actors.total} から1人減るはず）`,
  );
});

await test("ファネル", "率は件数と一緒に出す（母数0で割らない）", () => {
  assert(ratio(3, 7) === "3 / 7 = 42.9%", `率の形が違う: ${ratio(3, 7)}`);
  assert(ratio(0, 0) === "0 / 0", `母数0で率を出している: ${ratio(0, 0)}`);
});

await test("ファネル", "読むだけ。SQL に書き込みの語が1つも無い", () => {
  const forbidden = /\b(insert|update|delete|truncate|create|drop|alter|grant|revoke)\b/i;
  assert(!forbidden.test(FUNNEL_SQL), "数える SQL に書き込みの語が入っている");
  assert(/^\s*with/i.test(FUNNEL_SQL), "select 以外から始まっている");
});


// **この試験は funnelDb の場面を壊すので、ファネルの試験の最後に置く。**
// ゲストを1人消し、関係する行がどうなるかを実際に見る（推測しない）
await test("片づけ", "ゲストを消すと、何が消えて何が残るかを実測する", async () => {
  await funnelQuery(
    `insert into public.usage_events (event_key, user_id, work_id) values ('next_work_opened', $1, $2)`,
    [scene.c, scene.aWork],
  );

  const before = await funnel("all");
  const countOf = async (sql, params) => Number((await funnelQuery(sql, params)).rows[0].n);

  const answersBefore = await countOf(`select count(*) n from public.answers where user_id = $1`, [scene.c]);
  assert(answersBefore === 3, `前提が違う（ゲストの回答が3件でない）: ${answersBefore}`);

  await funnelQuery(`delete from auth.users where id = $1`, [scene.c]);

  // 消えるもの
  const profileLeft = await countOf(`select count(*) n from public.profiles where id = $1`, [scene.c]);
  assert(profileLeft === 0, "人の行（profiles）が残っている");

  // 残るもの。**持ち主だけが外れる**
  const answersLeft = await countOf(`select count(*) n from public.answers where user_id is null and work_id = $1`, [scene.aWork]);
  assert(answersLeft === 1, `回答が残っていない（作品側の集計が過去に遡って減る）: ${answersLeft}`);
  const eventsLeft = await countOf(`select count(*) n from public.usage_events where user_id is null`, []);
  assert(eventsLeft === 1, `利用の記録が残っていない: ${eventsLeft}`);

  // ファネルは人から数えるので、消えた人はどの段からも外れる
  const after = await funnel("all");
  assert(after.actors.total === before.actors.total - 1, `人数が1人減っていない: ${before.actors.total} → ${after.actors.total}`);
  assert(
    after.answerer.a1 === before.answerer.a1 - 1,
    `答えた人の段から外れていない: ${before.answerer.a1} → ${after.answerer.a1}`,
  );
});

await funnelDb.close();

// ── スモークの後片づけ（この実行が作った人を、自分で消す） ─────────────
//
// 【何を確かめるか】
//   本番のスモークが匿名ゲストを残していた（2026-09-17 に2人）。
//   直したのは「作られたその場で ID を拾い、finally でその ID だけを消す」形。
//   ここでは本物の本番へ触らずに、その形が守られるかだけを試す。

const GUEST_ID = "11111111-2222-3333-4444-555555555555";
const B_ID = "66666666-7777-8888-9999-aaaaaaaaaaaa";

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

/** 本物と同じ形のセッション Cookie を組み立てる */
function sessionCookie(name, { sub, isAnonymous = true, encode = "base64", split = false }) {
  const token = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub, is_anonymous: isAnonymous })}.sig`;
  const json = JSON.stringify({ access_token: token, token_type: "bearer", user: { id: sub } });
  const value = encode === "base64" ? `base64-${Buffer.from(json, "utf8").toString("base64url")}` : json;
  if (!split) return [{ name, value }];
  const half = Math.ceil(value.length / 2);
  return [
    { name: `${name}.0`, value: value.slice(0, half) },
    { name: `${name}.1`, value: value.slice(half) },
  ];
}

await test("片づけ", "ゲストの ID を、ブラウザの Cookie から読める", () => {
  const got = actorFromCookies(sessionCookie("sb-abc123-auth-token", { sub: GUEST_ID }));
  assert(got?.id === GUEST_ID, `ID を読めていない: ${JSON.stringify(got)}`);
  assert(got.isAnonymous === true, "匿名の別を読めていない");
});

await test("片づけ", "割られた Cookie（.0 .1）をつなげて読める", () => {
  const cookies = sessionCookie("sb-abc123-auth-token", { sub: GUEST_ID, split: true });
  assert(cookies.length === 2, "割れていない");
  const got = actorFromCookies(cookies);
  assert(got?.id === GUEST_ID, `割られた Cookie を読めていない: ${JSON.stringify(got)}`);
});

await test("片づけ", "base64 を使わない版の Cookie でも読める", () => {
  const got = actorFromCookies(sessionCookie("sb-abc123-auth-token", { sub: B_ID, isAnonymous: false, encode: "plain" }));
  assert(got?.id === B_ID, "素の JSON を読めていない");
  assert(got.isAnonymous === false, "登録者を匿名と読んでいる");
});

await test("片づけ", "関係ない Cookie や壊れた Cookie では、当て推量をしない", () => {
  assert(actorFromCookies([]) === null, "空で null を返していない");
  assert(actorFromCookies([{ name: "session", value: "x" }]) === null, "無関係な Cookie を読んでいる");
  assert(actorFromCookies([{ name: "sb-abc-auth-token", value: "base64-@@@" }]) === null, "壊れた値で null を返していない");
  assert(
    actorFromCookies([{ name: "sb-abc-auth-token-code-verifier", value: "zzz" }]) === null,
    "セッション以外の Cookie を読んでいる",
  );
});

await test("片づけ", "帳面は、同じ人を二重に持たず、形の違う ID を受け付けない", () => {
  const led = createActorLedger();
  assert(led.add(GUEST_ID, { role: "ゲスト", how: "Cookie" }) === true, "1人目を積めていない");
  assert(led.add(GUEST_ID, { role: "ゲスト", how: "回答行" }) === false, "同じ人を二重に積んでいる");
  assert(led.size === 1, `帳面の人数が違う: ${led.size}`);
  assert(led.list()[0].how.includes("Cookie") && led.list()[0].how.includes("回答行"), "見つけかたを両方残していない");
  assert(led.add("guest-1") === false, "ID の形を見ていない");
  assert(led.add(null) === false, "空を積んでいる");
  assert(led.size === 1, "不正な ID が入っている");
});

await test("片づけ", "A: 一周が成功したとき、作った人が全員消える", async () => {
  const led = createActorLedger();
  led.add(GUEST_ID, { role: "ゲスト", anonymous: true, how: "Cookie" });
  led.add(B_ID, { role: "登録者B", how: "Admin API" });
  const asked = [];
  const report = await cleanupActors(led.list(), async (id) => {
    asked.push(id);
    return { error: null };
  });
  assert(report.length === 2 && report.every((r) => r.ok), "全員ぶんが合格になっていない");
  assert(cleanupFailed(report) === false, "失敗として返っている");
  assert(asked.length === 2 && asked.includes(GUEST_ID), "頼んだ相手が違う");
});

await test("片づけ", "B/C: 途中で止まっても、そこまでに作った人は帳面に残る", async () => {
  const led = createActorLedger();
  led.add(B_ID, { role: "作者", how: "Admin API" });
  try {
    led.add(GUEST_ID, { role: "ゲスト", anonymous: true, how: "Cookie" });
    throw new Error("[故障試験] ここで止める");
  } catch {
    // finally 相当。**止まった後でも帳面を使って消せること**が要点
  }
  const report = await cleanupActors(led.list(), async () => ({ error: null }));
  assert(report.length === 2, `止まった後に消せる人数が違う: ${report.length}`);
  assert(report.some((r) => r.role === "ゲスト"), "ゲストが帳面から落ちている");
});

await test("片づけ", "D: 片づけを2回呼んでも安全（2回目は「すでに居ない」）", async () => {
  const led = createActorLedger();
  led.add(GUEST_ID, { role: "ゲスト", anonymous: true, how: "Cookie" });
  const alive = new Set([GUEST_ID]);
  const remove = async (id) => {
    if (!alive.has(id)) return { error: "User not found" };
    alive.delete(id);
    return { error: null };
  };
  const first = await cleanupActors(led.list(), remove);
  const second = await cleanupActors(led.list(), remove);
  assert(!cleanupFailed(first), "1回目が失敗している");
  assert(!cleanupFailed(second), "2回目を失敗扱いにしている");
  assert(second[0].gone === true, "2回目を「すでに居ない」と読めていない");
});

await test("片づけ", "E: 相手がもう居なくても失敗にしない", async () => {
  const report = await cleanupActors([{ id: GUEST_ID, role: "ゲスト", anonymous: true, how: "Cookie" }], async () => {
    throw new Error("user_not_found");
  });
  assert(report[0].ok === true, "すでに居ない相手を失敗にしている");
  assert(/すでに居ません/.test(describeActor(report[0])), `説明が違う: ${describeActor(report[0])}`);
});

await test("片づけ", "消せなかったら、黙って合格にしない", async () => {
  const report = await cleanupActors([{ id: GUEST_ID, role: "ゲスト", anonymous: true, how: "Cookie" }], async () => ({
    error: "permission denied for table users",
  }));
  assert(report[0].ok === false, "失敗を合格にしている");
  assert(cleanupFailed(report) === true, "呼び出し側が失敗に気づけない");
  assert(/消せませんでした/.test(describeActor(report[0])), "理由が読めない");
});

await test("片づけ", "通常の出力に、生の利用者 ID を出さない", async () => {
  const report = await cleanupActors([{ id: GUEST_ID, role: "ゲスト", anonymous: true, how: "Cookie" }], async () => ({
    error: null,
  }));
  const line = describeActor(report[0]);
  assert(!line.includes(GUEST_ID), `生の ID が出ている: ${line}`);
  assert(line.includes(maskId(GUEST_ID)), "短縮した ID すら出ていない");
});

await test("片づけ", "頼んだ ID 以外には触らない（実利用者を巻き込まない）", async () => {
  const REAL = "deadbeef-0000-0000-0000-000000000000";
  const led = createActorLedger();
  led.add(GUEST_ID, { role: "ゲスト", anonymous: true, how: "Cookie" });
  const asked = [];
  await cleanupActors(led.list(), async (id) => {
    asked.push(id);
    return { error: null };
  });
  assert(asked.length === 1 && asked[0] === GUEST_ID, `頼んだ相手が違う: ${asked.join(",")}`);
  assert(!asked.includes(REAL), "帳面に無い人へ触っている");
});

await test("片づけ", "一周のスクリプトは、帳面を通してしか人を消さない", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "smoke-journey.mjs"), "utf8");
  assert(/cleanupActors\(/.test(src), "片づけを呼んでいない");
  assert(/captureGuest\(/.test(src), "ゲストの ID を拾っていない");
  const direct = src.match(/admin\.auth\.admin\.deleteUser\(/g) ?? [];
  assert(direct.length === 0, `帳面を通さずに人を消している箇所が ${direct.length} か所ある`);
  assert(!/created_at.*(gte|gt|lt)/.test(src), "時刻の範囲で消そうとしている");
  assert(/} finally {/.test(src), "finally で片づけていない");
});

await test("片づけ", "前後の件数は、1件でも違えば取りこぼさず出る", () => {
  const keys = ["auth_users", ...BASELINE_TABLES];
  const before = Object.fromEntries(keys.map((k) => [k, 10]));
  const same = diffBaseline(before, { ...before });
  assert(same.length === keys.length, `見ている項目が足りない: ${same.length}/${keys.length}`);
  assert(baselineDrift(same).length === 0, "同じなのに差が出ている");

  const after = { ...before, profiles: 11, answers: 12 };
  const drift = baselineDrift(diffBaseline(before, after));
  assert(drift.length === 2, `増えた項目を拾えていない: ${drift.length}`);
  assert(drift.find((r) => r.key === "profiles").delta === 1, "人の増分が違う");
  assert(drift.find((r) => r.key === "answers").delta === 2, "回答の増分が違う");

  const missing = baselineDrift(diffBaseline(before, null));
  assert(missing.length === keys.length, "数えられなかったときに、同じと読んでいる");
});


const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
console.log(`\n合計 ${results.length} 件 / 合格 ${passed} 件 / 不合格 ${failed.length} 件`);
for (const f of failed) console.log(`  ✗ [${f.group}] ${f.name}: ${f.why}`);
recordCount("道具の自己試験", results.length);
process.exit(failed.length === 0 ? 0 : 1);
