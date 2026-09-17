import { withDb } from "./lib.mjs"; import fs from "node:fs";
const prod = JSON.parse(fs.readFileSync(`${process.argv[2]}`, "utf8"));
const P = prod.history.rows.find((r) => r.version === "20260909180000").statements;
const L = (await withDb("r_old_file_applied_on_clean", (q) => q(`select statements from supabase_migrations.schema_migrations where version='20260909180000'`)))[0].statements;
const sP = new Set(P), sL = new Set(L);
console.log("prod106 ⊂ file111:", P.every((s) => sL.has(s)), "file中で本番に無い:", L.filter((s) => !sP.has(s)).length, "本番中でfileに無い:", P.filter((s) => !sL.has(s)).length);
for (const s of L.filter((s) => !sP.has(s))) console.log(" + file only:", s.replace(/\s+/g, " ").slice(0, 200));
for (const s of P.filter((s) => !sL.has(s))) console.log(" - prod only:", s.replace(/\s+/g, " ").slice(0, 200));
