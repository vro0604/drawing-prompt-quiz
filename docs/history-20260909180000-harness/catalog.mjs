// 本番・使い捨て DB の両方に同じ問い合わせを流し、指紋を作る。書き込みはしない。
import crypto from "node:crypto";

const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

export async function historyTableShape(q) {
  return {
    columns: await q(`select column_name, data_type, udt_name, is_nullable, column_default from information_schema.columns where table_schema='supabase_migrations' and table_name='schema_migrations' order by ordinal_position`),
    constraints: await q(`select conname, pg_get_constraintdef(oid) def from pg_constraint where conrelid='supabase_migrations.schema_migrations'::regclass order by 1`),
    tables: await q(`select c.relname, pg_get_userbyid(c.relowner) owner, c.relacl::text acl from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='supabase_migrations' and c.relkind in ('r','S','v') order by 1`),
    schemaAcl: (await q(`select pg_get_userbyid(nspowner) owner, nspacl::text acl from pg_namespace where nspname='supabase_migrations'`))[0] ?? null,
  };
}

export async function historyRows(q) {
  const cols = (await q(`select column_name from information_schema.columns where table_schema='supabase_migrations' and table_name='schema_migrations' order by ordinal_position`)).map((r) => r.column_name);
  const rows = await q(`select to_jsonb(s) j from supabase_migrations.schema_migrations s order by version`);
  return { cols, rows: rows.map((r) => r.j) };
}

export function rowDigest(r) {
  const st = r.statements ?? [];
  return { version: r.version, name: r.name, n: st.length, md5: md5(JSON.stringify(st)), extra: Object.fromEntries(Object.entries(r).filter(([k]) => !["version", "name", "statements"].includes(k))) };
}

// 構造（schema）と権限（acl）を分けて持つ。キー → 値。
export async function catalog(q) {
  const schema = {};
  const acl = {};
  const put = (o, k, v) => { o[k] = v ?? ""; };
  // 関数: public は全部。auth/storage は migration が作ったもの（=本番の Supabase 既製品を除くため public だけ定義を取る）
  for (const r of await q(`select p.oid, n.nspname ns, p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' sig, pg_get_userbyid(p.proowner) owner, p.prosecdef, p.provolatile, p.proconfig::text cfg, p.proacl::text acl, pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind in ('f','p')`)) {
    put(schema, `fn:${r.ns}.${r.sig}`, `${r.owner}|${r.prosecdef}|${r.provolatile}|${r.cfg ?? ""}|${md5(r.def)}`);
    put(acl, `fn:${r.ns}.${r.sig}`, r.acl);
  }
  for (const r of await q(`select c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) owner, c.relacl::text acl, case when c.relkind in ('v','m') then md5(pg_get_viewdef(c.oid)) else '' end vdef from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','v','m','S','p')`)) {
    put(schema, `rel:${r.relname}`, `${r.relkind}|${r.relrowsecurity}|${r.relforcerowsecurity}|${r.owner}|${r.vdef}`);
    put(acl, `rel:${r.relname}`, r.acl);
  }
  for (const r of await q(`select c.relname, a.attname, format_type(a.atttypid,a.atttypmod) t, a.attnotnull, pg_get_expr(d.adbin,d.adrelid) dflt, a.attgenerated, a.attidentity, a.attacl::text acl from pg_attribute a join pg_class c on c.oid=a.attrelid left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where c.relnamespace='public'::regnamespace and c.relkind in ('r','v','m','p') and a.attnum>0 and not a.attisdropped`)) {
    put(schema, `col:${r.relname}.${r.attname}`, `${r.t}|${r.attnotnull}|${r.dflt ?? ""}|${r.attgenerated}|${r.attidentity}`);
    if (r.acl) put(acl, `col:${r.relname}.${r.attname}`, r.acl);
  }
  for (const r of await q(`select indexname, indexdef from pg_indexes where schemaname='public'`)) put(schema, `idx:${r.indexname}`, r.indexdef);
  for (const r of await q(`select conrelid::regclass::text t, conname, pg_get_constraintdef(oid) d from pg_constraint where connamespace='public'::regnamespace`)) put(schema, `con:${r.t}.${r.conname}`, r.d);
  for (const r of await q(`select n.nspname ns, c.relname, t.tgname, pg_get_triggerdef(t.oid) d, t.tgenabled from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and (n.nspname='public' or (n.nspname='auth' and c.relname='users') or (n.nspname='storage' and c.relname='objects')) and pg_get_triggerdef(t.oid) ~ 'public\\.'`)) put(schema, `trg:${r.ns}.${r.relname}.${r.tgname}`, `${r.d}|${r.tgenabled}`);
  for (const r of await q(`select schemaname, tablename, policyname, permissive, roles::text roles, cmd, qual, with_check from pg_policies where schemaname='public' or (schemaname='storage' and tablename='objects' and (qual ~ 'avatar|work|public\\.' or with_check ~ 'avatar|work|public\\.'))`)) put(schema, `pol:${r.schemaname}.${r.tablename}.${r.policyname}`, `${r.permissive}|${r.roles}|${r.cmd}|${r.qual ?? ""}|${r.with_check ?? ""}`);
  for (const r of await q(`select t.typname, t.typtype, coalesce((select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid=t.oid),'') labels, pg_get_userbyid(t.typowner) owner, t.typacl::text acl from pg_type t where t.typnamespace='public'::regnamespace and t.typtype in ('e','d','c') and not exists (select 1 from pg_class c where c.reltype=t.oid and c.relkind<>'c')`)) {
    put(schema, `type:${r.typname}`, `${r.typtype}|${r.labels}|${r.owner}`);
    if (r.acl) put(acl, `type:${r.typname}`, r.acl);
  }
  const ns = (await q(`select nspacl::text a, pg_get_userbyid(nspowner) o from pg_namespace where nspname='public'`))[0];
  put(acl, `schema:public`, ns.a);
  for (const r of await q(`select pg_get_userbyid(d.defaclrole) role, coalesce(n.nspname,'*') ns, d.defaclobjtype t, d.defaclacl::text a from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace where coalesce(n.nspname,'*') in ('public','*') and pg_get_userbyid(d.defaclrole)='postgres'`)) put(acl, `defacl:${r.role}.${r.ns}.${r.t}`, r.a);
  // storage のバケット（migration が作る行。データではなく設定）
  try { for (const r of await q(`select id, public, file_size_limit, allowed_mime_types::text m from storage.buckets`)) put(schema, `bucket:${r.id}`, `${r.public}|${r.file_size_limit ?? ""}|${r.m ?? ""}`); } catch { /* 無い */ }
  return { schema, acl };
}

export function fp(o) {
  return md5(Object.keys(o).sort().map((k) => `${k}=${o[k]}`).join("\n"));
}

export function diffMaps(a, b) {
  const added = Object.keys(b).filter((k) => !(k in a)).sort();
  const removed = Object.keys(a).filter((k) => !(k in b)).sort();
  const changed = Object.keys(a).filter((k) => k in b && a[k] !== b[k]).sort().map((k) => ({ k, a: a[k], b: b[k] }));
  return { added, removed, changed };
}

// public の全表の件数とハッシュ（本番では件数とハッシュだけ持ち、中身は持ち出さない）
export async function dataFp(q) {
  const out = {};
  for (const { tablename } of await q(`select tablename from pg_tables where schemaname='public' order by 1`)) {
    const r = (await q(`select count(*)::int n, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) m from public.${JSON.stringify(tablename).slice(1, -1)} x`))[0];
    out[tablename] = `${r.n}:${r.m}`;
  }
  const au = (await q(`select count(*)::int n, md5(coalesce(string_agg(x.id::text, '|' order by x.id::text), '')) m from auth.users x`))[0];
  out["auth.users(id)"] = `${au.n}:${au.m}`;
  return out;
}

const TARGET_FNS = `('get_my_specialties','set_my_specialties','set_my_avatar','enqueue_my_avatar_cleanup','app_specialty_rows')`;
export async function profileAcl(q) {
  return q(`select p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' sig, p.proacl::text acl,
    has_function_privilege('anon', p.oid, 'EXECUTE') anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') authed,
    has_function_privilege('service_role', p.oid, 'EXECUTE') svc,
    exists(select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') public_exec
    from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ${TARGET_FNS} order by 1`);
}
export { md5 };
