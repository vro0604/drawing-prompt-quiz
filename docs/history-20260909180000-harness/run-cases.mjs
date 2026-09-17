import { withDb, createDb, cli, url, H, WT } from "./lib.mjs"; import { measure, compare, brief } from "./measure.mjs"; import fs from "node:fs"; import { pathToFileURL } from "node:url";
const Hh = await import(pathToFileURL(`${WT}/test/db/helpers.mjs`));
const V = "20260909180000";
const res = {};
const runSql = (db, file) => withDb(db, async (q, c) => { try { await c.query(fs.readFileSync(file, "utf8")); return { ok: true }; } catch (e) { try { await c.query("rollback"); } catch {} return { ok: false, err: e.message }; } });
async function behavior(db) {
  return withDb(db, async (q, c) => {
    const d = { query: (s, p) => c.query(s, p), exec: (s) => c.query(s), close: async () => {} };
    const tag = db.replace(/[^a-z0-9]/g, "").slice(-10);
    const a = await Hh.makeMember(d, `b-${tag}-a`); const b = await Hh.makeMember(d, `b-${tag}-b`);
    const { prompt_id } = await Hh.drawPrompt(d, a, { timeLimit: 3600 }); const w = await Hh.postWork(d, a, prompt_id, "検証の作品"); await Hh.answerWork(d, b, w, { correct: true });
    const r = (await q(`select (select count(*)::int from public.works) works, (select count(*)::int from public.answers) answers`))[0];
    return r;
  });
}
async function futureMigration(from) {
  const db = `${from}_next`; await createDb(db, from);
  const before = await measure(db, { workdir: `${H}/wd-dummy`, cliRuns: false });
  const dry = cli(["db", "push", "--dry-run", "--db-url", url(db)], { workdir: `${H}/wd-dummy` });
  const push = cli(["db", "push", "--yes", "--db-url", url(db)], { workdir: `${H}/wd-dummy` });
  const after = await measure(db, { workdir: `${H}/wd-dummy` });
  const c = compare(before, after);
  const dummyRow = after.digests.find((d) => d.version === "20260918000000");
  return { dry: { code: dry.code, json: dry.out.split("\n").find((l) => l.startsWith("{")) }, push: { code: push.code, tail: push.out.trim().split("\n").filter((l) => !l.startsWith("{")).slice(-3).join(" / "), sqlCount: push.stmts.length },
    historyRowsChanged: c.historyRowsChanged, dummyRow, schemaAdded: c.schemaDiff.added, schemaRemoved: c.schemaDiff.removed, schemaChanged: c.schemaDiff.changed.map((x) => x.k), aclAdded: c.aclDiff.added, aclChanged: c.aclDiff.changed.map((x) => x.k),
    listAfter: { n: after.list.migrations?.length, allBoth: after.list.migrations?.every((m) => m.local && m.remote) }, dryAfter: after.dry, row0909After: after.row0909 };
}
await createDb("snap", "prodlike");
const snap = await measure("snap", { verify: true });
res.snap = brief(snap);
for (const X of ["A", "B", "C"]) {
  const db = `case_${X.toLowerCase()}`; await createDb(db, "snap");
  const before = await measure(db, { verify: true });
  const r = { sameAsSnapBefore: compare(snap, before) };
  let action = null;
  if (X === "A") action = { kind: "何もしない", note: "snap の複製のまま" };
  if (X === "B") { const x = cli(["migration", "repair", V, "--status", "applied", "--db-url", url(db)]); action = { kind: "CLI repair applied", code: x.code, out: x.out.trim().split("\n").slice(-2).join(" / "), sql: x.stmts.map((s) => s.replace(/^\[[^\]]*\] LOG:  /, "").replace(/\s+/g, " ").slice(0, 160)) }; }
  if (X === "C") action = { kind: "SQL 1行 update", ...(await runSql(db, `${H}/caseC-fix.sql`)) };
  const after = await measure(db, { verify: true });
  r.action = action; r.before = brief(before); r.after = brief(after); r.change = compare(before, after);
  r.afterVsClean = null;
  r.future = await futureMigration(db);
  // 実データの読み書きが今まで通りできるか（履歴の修復はアプリの動作に関係しないことの確認）
  const bdb = `${db}_behav`; await createDb(bdb, db); r.behavior = await behavior(bdb);
  if (X !== "A") {
    const rb = await runSql(db, `${H}/rollback-0909.sql`);
    const back = await measure(db, { verify: true });
    r.rollback = { run: rb, back: brief(back), vsBefore: compare(before, back), historyExactlyBefore: back.fp.history === before.fp.history };
    // 戻したあと、もう一度直せるか（同じ手順を2回目に使えるか）
    if (X === "C") { const again = await runSql(db, `${H}/caseC-fix.sql`); const m2 = await measure(db, { cliRuns: false }); r.reapply = { run: again, historySameAsAfter: m2.fp.history === after.fp.history }; }
    if (X === "B") { const x = cli(["migration", "repair", V, "--status", "applied", "--db-url", url(db)]); const m2 = await measure(db, { cliRuns: false }); r.reapply = { code: x.code, historySameAsAfter: m2.fp.history === after.fp.history }; }
  }
  // 前提違いで止まるか（C の SQL を、既に直した行へもう一度流す）
  if (X === "C") r.guardSecondRun = await runSql(db, `${H}/caseC-fix.sql`);
  res[X] = r;
  fs.writeFileSync(`${H}/cases.json`, JSON.stringify(res, null, 1));
  console.log(`CASE ${X} done`);
}
// B と C の修復後が完全に同じか
const bAfter = res.B.after.fp, cAfter = res.C.after.fp;
res.BvsC = { history: bAfter.history === cAfter.history, schema: bAfter.schema === cAfter.schema, acl: bAfter.acl === cAfter.acl, data: bAfter.data === cAfter.data, list: bAfter.list === cAfter.list };
const cleanM = await measure("clean", { cliRuns: false });
res.afterVsCleanHistory = { B: res.B.after.fp.history === cleanM.fp.history, C: res.C.after.fp.history === cleanM.fp.history };
fs.writeFileSync(`${H}/cases.json`, JSON.stringify(res, null, 1));
console.log("done");
