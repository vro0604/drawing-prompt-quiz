import { cli, url } from "./lib.mjs"; import fs from "node:fs";
const out = {};
for (const [k, args] of [["list", ["migration", "list", "--db-url", url("prodlike")]], ["dry", ["db", "push", "--dry-run", "--db-url", url("prodlike")]]]) {
  const r = cli(args); out[k] = r;
  console.log(`== ${k} exit ${r.code}\n${r.out}\n-- 届いた文 ${r.stmts.length}`); console.log(r.stmts.map((s) => s.replace(/^\[[^\]]*\] LOG:  /, "")).join("\n"));
}
fs.writeFileSync(`${process.argv[2]}`, JSON.stringify(out, null, 1));
