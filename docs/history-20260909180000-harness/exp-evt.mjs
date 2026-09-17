// 本番にある ddl_command_end のイベントトリガー（PostgREST のスキーマ再読込の合図など）が、B と C で発火するかを測る
import { createDb, withDb, cli, url, H } from "./lib.mjs"; import fs from "node:fs";
const setup = `create schema if not exists evt; create table if not exists evt.log (at timestamptz default clock_timestamp(), ev text, tag text, objs text);
create or replace function evt.rec() returns event_trigger language plpgsql as $$ begin insert into evt.log(ev, tag, objs) select tg_event, tg_tag, (select string_agg(object_identity, ',') from pg_event_trigger_ddl_commands()); end $$;
create event trigger evt_probe on ddl_command_end execute function evt.rec();`;
const out = {};
for (const X of ["B211", "B217", "C"]) {
  const db = `evt_${X.toLowerCase()}`; await createDb(db, "snap"); await withDb(db, (q, c) => c.query(setup));
  if (X === "B211") cli(["migration", "repair", "20260909180000", "--status", "applied", "--db-url", url(db)]);
  if (X === "B217") cli(["migration", "repair", "20260909180000", "--status", "applied", "--db-url", url(db)], { cliVersion: "2.117.0" });
  if (X === "C") await withDb(db, (q, c) => c.query(fs.readFileSync(`${H}/caseC-fix.sql`, "utf8")));
  out[X] = await withDb(db, (q) => q(`select ev, tag, coalesce(objs,'') objs from evt.log order by at`));
  out[X + "_row"] = await withDb(db, (q) => q(`select name, array_length(statements,1) n from supabase_migrations.schema_migrations where version='20260909180000'`));
}
console.log(JSON.stringify(out, null, 1));
