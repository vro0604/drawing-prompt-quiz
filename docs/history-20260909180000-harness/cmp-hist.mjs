import { withDb } from "./lib.mjs"; import * as C from "./catalog.mjs"; import fs from "node:fs";
const prod = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const local = await withDb(process.argv[2], (q) => C.historyRows(q));
const P = new Map(prod.history.rows.map((r) => [r.version, r])); const L = new Map(local.rows.map((r) => [r.version, r]));
const vs = [...new Set([...P.keys(), ...L.keys()])].sort();
let same = 0; const diffs = [];
for (const v of vs) {
  const p = P.get(v), l = L.get(v);
  if (!p || !l) { diffs.push({ v, only: p ? "prod" : "local" }); continue; }
  const eqName = p.name === l.name, eqSt = JSON.stringify(p.statements) === JSON.stringify(l.statements);
  if (eqName && eqSt) same++; else diffs.push({ v, eqName, eqSt, prod: C.rowDigest(p), local: C.rowDigest(l) });
}
console.log(JSON.stringify({ prodCols: prod.history.cols, localCols: local.cols, prodN: P.size, localN: L.size, sameExactly: same, diffs }, null, 1));
