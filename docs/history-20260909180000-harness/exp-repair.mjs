// migration repair の正体を、使い捨ての DB の前後で測る
import { createDb, cli, url, H } from "./lib.mjs"; import { measure, compare } from "./measure.mjs"; import fs from "node:fs";
const show = (r) => r.stmts.map((s) => s.replace(/^\[[^\]]*\] LOG:  /, "").replace(/\s+/g, " ").slice(0, 200));
const out = {};
async function exp(key, template, steps) {
  const db = `r_${key}`; await createDb(db, template);
  const before = await measure(db, { cliRuns: false });
  const runs = [];
  for (const s of steps) { const r = cli([...s.args, "--db-url", url(db)], { workdir: s.workdir, cliVersion: s.cliVersion }); runs.push({ args: s.args.join(" "), workdir: s.workdir ?? "origin/main の作業木", cli: s.cliVersion ?? "2.111.0", code: r.code, out: r.out.trim().split("\n").slice(-4).join(" / "), sql: show(r) }); }
  const after = await measure(db, { cliRuns: false });
  const c = compare(before, after);
  out[key] = { runs, historyRowsChanged: c.historyRowsChanged, row0909: c.row0909, schemaSame: c.schemaSame, aclSame: c.aclSame, dataSame: c.dataSame, fnDefsSame: c.fnDefsSame, n: [before.rows.length, after.rows.length] };
  console.log(`\n===== ${key}\n` + JSON.stringify(out[key], null, 1));
}
const V = "20260909180000";
await exp("applied_only", "prodlike", [{ args: ["migration", "repair", V, "--status", "applied"] }]);
await exp("reverted_only", "prodlike", [{ args: ["migration", "repair", V, "--status", "reverted"] }]);
await exp("reverted_then_applied", "prodlike", [{ args: ["migration", "repair", V, "--status", "reverted"] }, { args: ["migration", "repair", V, "--status", "applied"] }]);
await exp("old_file_applied_on_clean", "clean", [{ args: ["migration", "repair", V, "--status", "applied"], workdir: `${H}/wd-old` }]);
await exp("no_local_file_applied", "prodlike", [{ args: ["migration", "repair", "20990101000000", "--status", "applied"] }]);
await exp("no_local_file_reverted", "prodlike", [{ args: ["migration", "repair", "20990101000000", "--status", "reverted"] }]);
await exp("applied_only_cli2117", "prodlike", [{ args: ["migration", "repair", V, "--status", "applied"], cliVersion: "2.117.0" }]);
await exp("reverted_cli2117", "prodlike", [{ args: ["migration", "repair", V, "--status", "reverted"], cliVersion: "2.117.0" }]);
fs.writeFileSync(`${H}/exp-repair.json`, JSON.stringify(out, null, 1));
