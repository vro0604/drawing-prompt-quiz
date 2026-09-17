import { withDb, cli, url, WT } from "./lib.mjs"; import * as C from "./catalog.mjs"; import { spawnSync } from "node:child_process";
const json = (out) => { const l = out.split("\n").find((x) => x.startsWith("{")); return l ? JSON.parse(l) : { raw: out }; };
export async function measure(db, { workdir = WT, verify = false, cliRuns = true } = {}) {
  const m = await withDb(db, async (q) => {
    const h = await C.historyRows(q);
    const cat = await C.catalog(q);
    const data = await C.dataFp(q);
    return { cols: h.cols, rows: h.rows, digests: h.rows.map(C.rowDigest), schema: cat.schema, acl: cat.acl, data, profileAcl: await C.profileAcl(q) };
  });
  m.fp = { history: C.md5(JSON.stringify(m.rows)), historyExcept0909: C.md5(JSON.stringify(m.rows.filter((r) => r.version !== "20260909180000"))), schema: C.fp(m.schema), acl: C.fp(m.acl), data: C.fp(m.data), fnDefs: C.fp(Object.fromEntries(Object.entries(m.schema).filter(([k]) => k.startsWith("fn:")))) };
  m.row0909 = m.digests.find((d) => d.version === "20260909180000") ?? null;
  if (cliRuns) {
    const l = cli(["migration", "list", "--db-url", url(db)], { workdir }); const d = cli(["db", "push", "--dry-run", "--db-url", url(db)], { workdir });
    m.list = json(l.out); m.listCode = l.code; m.dry = json(d.out); m.dryCode = d.code; m.dryText = d.out.split("\n").filter((x) => !x.startsWith("{")).join("\n");
    m.fp.list = C.md5(JSON.stringify(m.list));
  }
  if (verify) {
    const r = spawnSync("node", ["scripts/db-verify.mjs"], { cwd: WT, encoding: "utf8", env: { ...process.env, SUPABASE_DB_URL: `${url(db)}` } });
    const t = r.stdout.replace(/\x1b\[[0-9;]*m/g, "");
    m.verify = { code: r.status, summary: t.split("\n").filter((x) => /すべて期待どおり|期待と異なります/.test(x)).join(" "), linesMd5: C.md5(t.split("\n").filter((x) => /✓|✗/.test(x)).join("\n")) };
  }
  return m;
}
export function compare(a, b) {
  const byV = (m) => new Map(m.rows.map((r) => [r.version, JSON.stringify(r)]));
  const A = byV(a), B = byV(b);
  const rowsChanged = [...new Set([...A.keys(), ...B.keys()])].sort().filter((v) => A.get(v) !== B.get(v));
  return {
    historyRowsChanged: rowsChanged, row0909: { before: a.row0909, after: b.row0909 },
    schemaSame: a.fp.schema === b.fp.schema, aclSame: a.fp.acl === b.fp.acl, dataSame: a.fp.data === b.fp.data, fnDefsSame: a.fp.fnDefs === b.fp.fnDefs,
    schemaDiff: C.diffMaps(a.schema, b.schema), aclDiff: C.diffMaps(a.acl, b.acl), dataDiff: C.diffMaps(a.data, b.data),
    listSame: a.fp.list === b.fp.list, dry: { before: a.dry, after: b.dry },
    verify: a.verify && b.verify ? { before: a.verify.summary, after: b.verify.summary, linesSame: a.verify.linesMd5 === b.verify.linesMd5 } : null,
  };
}
export const brief = (m) => ({ n: m.rows.length, row0909: m.row0909, fp: m.fp, dry: m.dry, verify: m.verify });
