// CASE C の SQL と、B/C 共通の戻す SQL を、DB の中身から組み立てる（手で文字列を写さない）
import { withDb, H } from "./lib.mjs"; import fs from "node:fs";
const V = "20260909180000";
const oldRow = (await withDb("prodlike", (q) => q(`select name, md5(statements::text) m, array_length(statements,1) n, format('%L', statements::text) lit from supabase_migrations.schema_migrations where version=$1`, [V])))[0];
const newRow = (await withDb("clean", (q) => q(`select name, md5(statements::text) m, array_length(statements,1) n, format('%L', statements::text) lit from supabase_migrations.schema_migrations where version=$1`, [V])))[0];
const block = (from, to, label) => `-- ${label}
-- 対象: supabase_migrations.schema_migrations の version='${V}' の1行だけ。
-- 前提が1つでも違えば例外で止まり、何も変わらない（1トランザクション）。
begin;
set local lock_timeout = '4s';
set local statement_timeout = '30s';
do $check$
declare v_n int; v_total int;
begin
  select count(*) into v_total from supabase_migrations.schema_migrations;
  if v_total <> 67 then raise exception 'STOP: 履歴が67行ではない（%）', v_total; end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '${V}' and name = '${from.name}' and md5(statements::text) = '${from.m}' and array_length(statements, 1) = ${from.n}) then
    raise exception 'STOP: 対象行が想定の状態（name=${from.name} / ${from.n}文 / md5 ${from.m}）ではない';
  end if;
  update supabase_migrations.schema_migrations
     set name = '${to.name}', statements = ${to.lit}::text[]
   where version = '${V}' and name = '${from.name}' and md5(statements::text) = '${from.m}';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'STOP: 更新した行が1行ではない（%）', v_n; end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '${V}' and name = '${to.name}' and md5(statements::text) = '${to.m}' and array_length(statements, 1) = ${to.n}) then
    raise exception 'STOP: 更新後の行が想定（name=${to.name} / ${to.n}文 / md5 ${to.m}）と違う';
  end if;
  select count(*) into v_total from supabase_migrations.schema_migrations;
  if v_total <> 67 then raise exception 'STOP: 更新後に履歴が67行ではない（%）', v_total; end if;
end
$check$;
commit;
`;
fs.writeFileSync(`${H}/caseC-fix.sql`, block(oldRow, newRow, "CASE C: 履歴の1行を、手元のファイルを CLI が記録するのと同じ name / statements に書き換える"));
fs.writeFileSync(`${H}/rollback-0909.sql`, block(newRow, oldRow, "戻す: 履歴の1行を、修復前（本番で 2026-09-17 に読んだ行）へ戻す"));
console.log({ old: { name: oldRow.name, n: oldRow.n, m: oldRow.m }, new: { name: newRow.name, n: newRow.n, m: newRow.m } });
