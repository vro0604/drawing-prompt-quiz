import { createDb, withDb, url, H, WT } from "./lib.mjs"; import { measure, compare } from "./measure.mjs"; import { spawnSync } from "node:child_process"; import fs from "node:fs";
const run = (db, a, root = WT) => { const r = spawnSync("node", [`${root}/scripts/db-history-0909.mjs`, ...a], { cwd: root, encoding: "utf8", env: { ...process.env, SUPABASE_DB_URL: url(db) } }); return { code: r.status, out: (r.stdout + r.stderr).trim() }; };
const log = []; const step = (name, r, extra = {}) => { const s = { name, code: r.code, last: r.out.split("\n").filter(Boolean).slice(-2).join(" / "), state: (r.out.match(/判定\s+(\S+)/g) || []).join(" → "), ...extra }; log.push(s); console.log(JSON.stringify(s)); };
await createDb("rehearsal", "snap");
const m0 = await measure("rehearsal", { verify: true });
step("1 check", run("rehearsal", ["check"]));
step("2 fix（--yes なし）", run("rehearsal", ["fix"]), { historyUnchanged: (await measure("rehearsal", { cliRuns: false })).fp.history === m0.fp.history });
step("3 fix --yes", run("rehearsal", ["fix", "--yes"]));
const m1 = await measure("rehearsal", { verify: true }); const c1 = compare(m0, m1);
log.push({ name: "3後の比較", rows: c1.historyRowsChanged, schema: c1.schemaSame, acl: c1.aclSame, data: c1.dataSame, fn: c1.fnDefsSame, list: c1.listSame, dry: m1.dry.message, verify: m1.verify.summary, sameAsCaseC: m1.fp.history === JSON.parse(fs.readFileSync(`${H}/cases.json`, "utf8")).C.after.fp.history }); console.log(JSON.stringify(log.at(-1)));
step("4 fix --yes を2回目", run("rehearsal", ["fix", "--yes"]));
step("5 rollback --yes", run("rehearsal", ["rollback", "--yes"]));
const m2 = await measure("rehearsal", { verify: true }); const c2 = compare(m0, m2);
log.push({ name: "5後の比較（修復前と）", historyExact: m2.fp.history === m0.fp.history, rows: c2.historyRowsChanged, schema: c2.schemaSame, acl: c2.aclSame, data: c2.dataSame, list: c2.listSame, dry: m2.dry.message, verify: m2.verify.summary }); console.log(JSON.stringify(log.at(-1)));
step("6 rollback --yes を2回目", run("rehearsal", ["rollback", "--yes"]));
step("7 fix --yes（戻した後にもう一度）", run("rehearsal", ["fix", "--yes"]));
// 止まるべき場面
step("8 履歴が68行（後ろに1本入った後）", run("case_a_next", ["check"]));
await createDb("rehearsal_odd", "snap"); await withDb("rehearsal_odd", (q) => q(`update supabase_migrations.schema_migrations set name='something_else' where version='20260909180000'`));
step("9 対象行が想定外", run("rehearsal_odd", ["fix", "--yes"]));
await createDb("rehearsal_other", "snap"); await withDb("rehearsal_other", (q) => q(`update supabase_migrations.schema_migrations set name=name||'_x' where version='20260803013433'`));
step("10 ほかの行が違う", run("rehearsal_other", ["fix", "--yes"]));
// 同じ版番号のファイルが2つある作業木（手元の main と同じ形）
const odd = `${H}/root-dup`; fs.rmSync(odd, { recursive: true, force: true }); fs.mkdirSync(`${odd}/scripts`, { recursive: true }); fs.cpSync(`${WT}/supabase`, `${odd}/supabase`, { recursive: true, filter: (p) => !p.includes("/.temp") }); fs.copyFileSync(`${WT}/scripts/db-history-0909.mjs`, `${odd}/scripts/db-history-0909.mjs`); fs.symlinkSync(`${WT}/node_modules`, `${odd}/node_modules`);
fs.copyFileSync(`${H}/wd-old/supabase/migrations/20260909180000_billing_founding_creator_v0.sql`, `${odd}/supabase/migrations/20260909180000_billing_founding_creator_v0.sql`);
await createDb("rehearsal_dup", "snap");
step("11 同じ版のファイルが2つある作業木", run("rehearsal_dup", ["fix", "--yes"], odd), { historyUnchanged: (await measure("rehearsal_dup", { cliRuns: false })).fp.history === m0.fp.history });
fs.writeFileSync(`${H}/rehearse.json`, JSON.stringify(log, null, 1));
