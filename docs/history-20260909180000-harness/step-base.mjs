import { withDb, createDb, WT, cli, url } from "./lib.mjs"; import { pathToFileURL } from "node:url"; import fs from "node:fs";
const { SUPABASE_STUB } = await import(pathToFileURL(`${WT}/test/db/harness.mjs`));
await createDb("base");
await withDb("base", async (q) => {
  await q(SUPABASE_STUB);
  // Supabase の既定: postgres が public に作った関数・順序・表を、3つの役へ直接配る
  for (const ns of ["public", "storage"]) {
    await q(`alter default privileges for role postgres in schema ${ns} grant execute on functions to postgres, anon, authenticated, service_role`);
    await q(`alter default privileges for role postgres in schema ${ns} grant usage, select, update on sequences to postgres, anon, authenticated, service_role`);
    await q(`alter default privileges for role postgres in schema ${ns} grant all on tables to postgres, anon, authenticated, service_role`);
  }
});
await createDb("clean", "base");
const r = cli(["db", "push", "--db-url", url("clean"), "--yes"]);
fs.writeFileSync(process.argv[2], JSON.stringify(r, null, 1));
console.log(r.code, r.out.slice(-3000)); console.log("stmts", r.stmts.length);
console.log(r.stmts.filter((s) => !/statement: (?!.*schema_migrations)/.test(s) || /schema_migrations/.test(s)).slice(0, 20).join("\n").slice(0, 4000));
