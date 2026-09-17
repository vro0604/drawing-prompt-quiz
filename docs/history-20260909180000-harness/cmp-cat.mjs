import { withDb } from "./lib.mjs"; import * as C from "./catalog.mjs"; import fs from "node:fs";
const prod = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const cat = await withDb(process.argv[2], (q) => C.catalog(q));
const pa = await withDb(process.argv[2], (q) => C.profileAcl(q));
const ds = C.diffMaps(prod.cat.schema, cat.schema), da = C.diffMaps(prod.cat.acl, cat.acl);
console.log(JSON.stringify({ keys: { prodSchema: Object.keys(prod.cat.schema).length, localSchema: Object.keys(cat.schema).length, prodAcl: Object.keys(prod.cat.acl).length, localAcl: Object.keys(cat.acl).length },
  fp: { prodSchema: C.fp(prod.cat.schema), localSchema: C.fp(cat.schema), prodAcl: C.fp(prod.cat.acl), localAcl: C.fp(cat.acl) },
  schemaDiff: { added: ds.added, removed: ds.removed, changed: ds.changed.slice(0, 15), changedN: ds.changed.length },
  aclDiff: { added: da.added, removed: da.removed, changed: da.changed.slice(0, 15), changedN: da.changed.length },
  profileAclEqual: JSON.stringify(pa) === JSON.stringify(prod.profileAcl) }, null, 1));
