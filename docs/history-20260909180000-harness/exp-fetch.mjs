import { cli, url, H, createDb, withDb } from "./lib.mjs"; import * as C from "./catalog.mjs"; import fs from "node:fs"; import crypto from "node:crypto";
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 16);
const WT = process.env.HIST_TREE;
const out = {};
for (const [k, db] of [["A", "case_a"], ["B", "case_b"]]) {
  for (const kind of ["repo", "empty"]) {
    const wd = `${H}/wd-fetch-${k}-${kind}`; const mig = `${wd}/supabase/migrations`;
    const before = fs.readdirSync(mig).sort();
    const f = cli(["migration", "fetch", "--db-url", url(db), "--yes"], { workdir: wd });
    const after = fs.readdirSync(mig).sort();
    const v0909 = after.filter((x) => x.startsWith("20260909180000"));
    const changedRepoFiles = kind === "repo" ? before.filter((x) => x.endsWith(".sql") && fs.existsSync(`${mig}/${x}`) && sha(`${mig}/${x}`) !== sha(`${WT}/supabase/migrations/${x}`)) : [];
    const list = cli(["migration", "list", "--db-url", url(db)], { workdir: wd });
    const dry = cli(["db", "push", "--dry-run", "--db-url", url(db)], { workdir: wd });
    const r = { fetch: { code: f.code, tail: f.out.trim().split("\n").slice(-3).join(" / ").slice(0, 400), sql: f.stmts.map((s) => s.replace(/^\[[^\]]*\] LOG:  /, "").slice(0, 120)) }, filesBefore: before.length, filesAfter: after.length, v0909, added: after.filter((x) => !before.includes(x)), changedRepoFiles, list: { code: list.code, tail: list.out.trim().split("\n").slice(-2).join(" / ").slice(0, 300) }, dry: { code: dry.code, tail: dry.out.trim().split("\n").slice(-2).join(" / ").slice(0, 300) } };
    // 履歴だけから作り直す（災害復旧で「本番の履歴を正本にする」場合）
    if (kind === "empty") {
      const fresh = `rebuild_${k.toLowerCase()}`; await createDb(fresh, "base");
      const p = cli(["db", "push", "--yes", "--db-url", url(fresh)], { workdir: wd });
      const errLine = p.out.split("\n").filter((l) => /ERROR|error|failed|Error/.test(l) && !/docker/.test(l)).slice(0, 6).join(" / ").slice(0, 800);
      const h = await withDb(fresh, (q) => q(`select count(*)::int n, max(version) m from supabase_migrations.schema_migrations`).catch(() => [{ n: null }]));
      let catCmp = null;
      if (p.code === 0) { const prod = JSON.parse(fs.readFileSync(`${H}/prod-1.json`, "utf8")); const cat = await withDb(fresh, (q) => C.catalog(q)); const ds = C.diffMaps(prod.cat.schema, cat.schema), da = C.diffMaps(prod.cat.acl, cat.acl); catCmp = { schemaAdded: ds.added.length, schemaRemoved: ds.removed.length, schemaChanged: ds.changed.map((x) => x.k), aclAdded: da.added.length, aclRemoved: da.removed.length, aclChanged: da.changed.map((x) => x.k), sampleAdded: ds.added.slice(0, 8) }; }
      r.rebuild = { code: p.code, lastApplying: p.out.split("\n").filter((l) => /Applying migration/.test(l)).slice(-1)[0], errLine, history: h[0], catalogVsProd: catCmp };
    }
    out[`${k}-${kind}`] = r; console.log(`\n===== ${k}-${kind}\n` + JSON.stringify(r, null, 1).slice(0, 3500));
  }
}
fs.writeFileSync(`${H}/exp-fetch.json`, JSON.stringify(out, null, 1));
