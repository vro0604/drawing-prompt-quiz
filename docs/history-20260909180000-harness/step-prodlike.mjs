import { withDb, createDb, WT } from "./lib.mjs"; import * as C from "./catalog.mjs"; import fs from "node:fs"; import { pathToFileURL } from "node:url";
const prod = JSON.parse(fs.readFileSync(`${process.argv[2]}`, "utf8"));
const Hh = await import(pathToFileURL(`${WT}/test/db/helpers.mjs`));
// 1. 正常対照 clean に種のデータを入れる（本番の個人データは使わない）
await withDb("clean", async (q, c) => {
  const db = { query: (s, p) => c.query(s, p), exec: (s) => c.query(s), close: async () => {} };
  if ((await q(`select count(*)::int n from public.profiles where handle='seed-author'`))[0].n) { console.log("seed already"); return; }
  const author = await Hh.makeMember(db, "seed-author"); const a1 = await Hh.makeMember(db, "seed-a1"); const a2 = await Hh.makeMember(db, "seed-a2"); await Hh.makeGuest(db);
  for (let i = 0; i < 2; i++) { const { prompt_id } = await Hh.drawPrompt(db, author, { timeLimit: 3600 }); const w = await Hh.postWork(db, author, prompt_id, `種の作品${i}`); await Hh.answerWork(db, a1, w, { correct: true }); await Hh.answerWork(db, a2, w, {}); }
  console.log("seed", (await q(`select (select count(*)::int from public.works) works, (select count(*)::int from public.answers) answers, (select count(*)::int from public.profiles) profiles`))[0]);
});
// 2. 本番に似せた異常 DB
await createDb("prodlike", "clean");
await withDb("prodlike", async (q) => {
  await q("begin");
  await q("delete from supabase_migrations.schema_migrations");
  for (const r of prod.history.rows) await q(`insert into supabase_migrations.schema_migrations (version, statements, name) values ($1, $2, $3)`, [r.version, r.statements, r.name]);
  // 本番の環境・データ由来で、migration ファイルからは再現されない2点を本番の値に合わせる
  await q(`revoke usage on schema public from postgres, anon, authenticated, service_role`); for (const r of ["postgres", "anon", "authenticated", "service_role"]) await q(`grant usage on schema public to ${r}`);
  await q(`create or replace function public.quiz_choice_dedupe_cutoff() returns bigint language sql immutable set search_path = '' as $f$ select 324::bigint $f$`);
  await q("commit");
});
const h = await withDb("prodlike", (q) => C.historyRows(q));
const cat = await withDb("prodlike", (q) => C.catalog(q));
console.log(JSON.stringify({
  historyExact: JSON.stringify(h.rows) === JSON.stringify(prod.history.rows), n: h.rows.length,
  schemaFpEqualProd: C.fp(cat.schema) === C.fp(prod.cat.schema), aclFpEqualProd: C.fp(cat.acl) === C.fp(prod.cat.acl),
  schemaDiff: C.diffMaps(prod.cat.schema, cat.schema), aclDiff: C.diffMaps(prod.cat.acl, cat.acl) }, null, 1));
