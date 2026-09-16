#!/usr/bin/env node
/**
 * landing-d194-check.mjs ／ D194〜D196 を本番へ1本ずつ当てるときの、停止条件の確認（読むだけ）
 *
 * 【何をするか】
 *   本番（または SUPABASE_DB_URL の先）を、読み取り専用のトランザクションで読む。
 *   1本当てるたびに、ユーザーが決めた停止条件を1つずつ判定する。
 *   1つでも当たったら、次の1本へ進まない。
 *
 *   読むもの
 *     - 部品の一覧（関数・表・列・制約・索引・引き金・行の権限規則）と、その権限
 *     - 数字の指紋（作品ごとの回答数・枠ごと・ヒント別・回答者の成績・取り込み・除外・
 *       作者の分析・掘り下げ・回答一覧・枠の状態・作者の結果・答えた本人の集計・
 *       回答の履歴・順位）
 *   書くもの
 *     - 手元の JSON（--out）。DB へは1バイトも書かない
 *       （トランザクションを read only で開き、最後は rollback で閉じる）
 *
 * 【使い方】（docs/landing-d194-d196.md の手順どおりに）
 *   node scripts/landing-d194-check.mjs check pre    --out s0.json
 *   node scripts/landing-d194-check.mjs check phase1 --before s0.json --out s1.json
 *   node scripts/landing-d194-check.mjs check phase2 --before s1.json --out s2.json
 *   node scripts/landing-d194-check.mjs check d196   --before s2.json --out s3.json
 *
 * 【終了コード】
 *   0 = すべての停止条件を満たした（次へ進んでよい）
 *   1 = 停止条件に当たった（止まる）
 *   2 = 判定できない項目がある（本番で利用者の動きがあった等。人が見て決める）
 *   3 = 接続・実行の失敗
 *
 * 【期待値の出どころ】
 *   scripts/landing-d194-expected.json。本番の履歴と同じ順で本番と同じ本数を当てた使い捨ての
 *   PostgreSQL 17.6（本番と同じ UTF8 / ICU）へ3本を1本ずつ当て、そのたびに
 *   部品の一覧を取ったもの。作り方は docs/landing-d194-d196.md の「再現試験」。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import pg from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_FILE = path.join(ROOT, "scripts", "landing-d194-expected.json");
const KEYCHAIN_SERVICE = "drawing-prompt-quiz-supabase-db-password";
const POOLER_FILE = path.join(ROOT, "supabase", ".temp", "pooler-url");

export const STAGES = ["pre", "phase1", "phase2", "d196"];

/** システム回答の待ち行列を触る7つの窓口（D195） */
export const QUEUE_RPCS = [
  "enqueue_system_answer(uuid)",
  "claim_system_answer_jobs(integer)",
  "save_system_answer(uuid,jsonb)",
  "mark_system_answer_failed(uuid,text)",
  "cancel_system_answer_job(uuid,text)",
  "retry_system_answer_job(uuid)",
  "get_system_answer_job(uuid)",
];

/** D196 が「人の回答だけ」に絞った8本（構造検査 A62 と同じ） */
export const D196_FUNCTIONS = [
  "answers_after_insert_auto_import",
  "consume_import_capacity",
  "analysis_all_answers",
  "analysis_advanced_answers",
  "get_work_answer_list",
  "set_answer_excluded",
  "get_work_import_state",
  "get_my_answer_analysis",
];

const md5 = (s) => createHash("md5").update(s).digest("hex");

// ─────────────────────────────────────────────────────────────────────────────
// 部品の一覧（public スキーマだけ）
// ─────────────────────────────────────────────────────────────────────────────

const CATALOG_SQL = `
with fn as (
  select 'fn:' || p.oid::regprocedure::text as k,
         jsonb_build_object(
           'def', md5(pg_get_functiondef(p.oid)),
           'acl', coalesce(p.proacl::text, ''),
           'secdef', p.prosecdef,
           'config', coalesce(array_to_string(p.proconfig, ','), ''),
           'comment', md5(coalesce(obj_description(p.oid, 'pg_proc'), ''))) as v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind in ('f', 'p')
), rel as (
  select 'rel:' || c.relname as k,
         jsonb_build_object(
           'kind', c.relkind,
           'acl', coalesce(c.relacl::text, ''),
           'rls', c.relrowsecurity,
           'force_rls', c.relforcerowsecurity,
           'viewdef', case when c.relkind in ('v', 'm') then md5(pg_get_viewdef(c.oid)) end,
           'comment', md5(coalesce(obj_description(c.oid, 'pg_class'), ''))) as v
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S')
), col as (
  select 'col:' || c.relname || '.' || a.attname as k,
         jsonb_build_object(
           'type', format_type(a.atttypid, a.atttypmod),
           'notnull', a.attnotnull,
           'default', coalesce(pg_get_expr(d.adbin, d.adrelid), ''),
           'acl', coalesce(a.attacl::text, ''),
           'comment', md5(coalesce(col_description(c.oid, a.attnum), ''))) as v
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where n.nspname = 'public' and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
), con as (
  select 'con:' || c.relname || '.' || k.conname as k,
         jsonb_build_object('def', md5(pg_get_constraintdef(k.oid))) as v
    from pg_constraint k join pg_class c on c.oid = k.conrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
), idx as (
  select 'idx:' || i.indexrelid::regclass::text as k,
         jsonb_build_object('def', md5(pg_get_indexdef(i.indexrelid))) as v
    from pg_index i join pg_class c on c.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
), trg as (
  select 'trg:' || c.relname || '.' || t.tgname as k,
         jsonb_build_object('def', md5(pg_get_triggerdef(t.oid)), 'enabled', t.tgenabled) as v
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and not t.tgisinternal
), pol as (
  select 'pol:' || p.tablename || '.' || p.policyname as k,
         jsonb_build_object('def', md5(concat_ws('|', p.permissive, p.roles::text, p.cmd,
                                                 p.qual, p.with_check))) as v
    from pg_policies p where p.schemaname = 'public'
)
select k, v from fn union all select k, v from rel union all select k, v from col
union all select k, v from con union all select k, v from idx union all select k, v from trg
union all select k, v from pol
order by 1`;

/** 部品の一覧を {鍵: 値の文字列} で返す */
export async function readCatalog(client) {
  const { rows } = await client.query(CATALOG_SQL);
  const out = {};
  for (const r of rows) out[r.k] = JSON.stringify(r.v);
  return out;
}

/** 2つの一覧の差を返す（changed は鍵→[前, 後]） */
export function diffCatalog(before, after) {
  const added = {};
  const removed = {};
  const changed = {};
  for (const [k, v] of Object.entries(after)) {
    if (!(k in before)) added[k] = v;
    else if (before[k] !== v) changed[k] = [before[k], v];
  }
  for (const [k, v] of Object.entries(before)) if (!(k in after)) removed[k] = v;
  return { added, removed, changed };
}

// ─────────────────────────────────────────────────────────────────────────────
// 数字の指紋
// ─────────────────────────────────────────────────────────────────────────────
//
// 値そのものは持たず md5 だけを持つ（どの鍵が変わったかが分かれば止まれる）。
// 関数は savepoint の中で呼び、終わったら必ず savepoint へ戻す。
// 役（set local role）と券（request.jwt.claims）も一緒に戻るので、次の呼び出しへ漏れない。
// 失敗した呼び出しは、失敗の文言を値として持つ（前後で同じ失敗なら一致とみなす）。

async function callAs(client, who, sql, params = []) {
  await client.query("savepoint landing_call");
  try {
    if (who) {
      await client.query(`set local role ${who.role}`);
      if (who.uid) {
        const now = Math.floor(Date.now() / 1000);
        const claims = {
          sub: who.uid,
          role: who.role,
          is_anonymous: false,
          iat: now,
          amr: [{ method: "password", timestamp: now }],
        };
        await client.query(`select set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify(claims),
        ]);
      } else {
        await client.query(`select set_config('request.jwt.claims', '', true)`);
      }
    }
    const r = await client.query(sql, params);
    return JSON.stringify(r.rows);
  } catch (e) {
    return `ERROR:${e.code ?? ""}:${e.message}`;
  } finally {
    await client.query("rollback to savepoint landing_call");
    await client.query("release savepoint landing_call");
  }
}

const rowsJson = (table, key, extraMinus = "") => `
  select ${key} as k,
         md5(coalesce(jsonb_agg(to_jsonb(t) - 'updated_at'${extraMinus}
                       order by (to_jsonb(t) - 'updated_at'${extraMinus})::text)::text, '[]')) as v
    from public.${table} t group by ${key}`;

/** 数字の指紋を {鍵: md5} で返す。activity は「いつ時点の指紋か」を判定するための数 */
export async function readFingerprint(client) {
  const fp = {};
  const errors = {};
  const put = (k, v) => {
    const s = String(v);
    if (s.startsWith("ERROR:")) errors[k] = s.slice(0, 160);
    fp[k] = md5(s);
  };

  const activity = (
    await client.query(`
      select now() as t0,
             (select count(*)::int from public.answers) as answers_total,
             (select max(created_at) from public.answers) as answers_max,
             (select count(*)::int from public.works) as works_total,
             (select max(created_at) from public.works) as works_max`)
  ).rows[0];

  // 表から直接読むもの
  for (const r of (await client.query(`select id::text as k, answers_count from public.works`)).rows)
    put(`work.answers_count:${r.k}`, r.answers_count);
  const tables = [
    ["work_slot_stats", "t.work_id::text", "work_slot_stats"],
    ["work_hint_stats", "t.work_id::text", "work_hint_stats"],
    ["user_stats", "t.user_id::text", "user_stats"],
    ["user_slot_stats", "t.user_id::text", "user_slot_stats"],
    ["analysis_imports", "t.work_id::text", "analysis_imports"],
    ["analysis_exclusions", "t.work_id::text", "analysis_exclusions"],
    ["work_import_state", "t.work_id::text", "work_import_state"],
    ["work_capacity_grants", "t.work_id::text", "work_capacity_grants"],
    ["capacity_notifications", "t.work_id::text", "capacity_notifications"],
  ];
  for (const [table, key, label] of tables)
    for (const r of (await client.query(rowsJson(table, key))).rows) put(`${label}:${r.k}`, r.v);

  // 作者の立場で読むもの（回答が1件以上ある作品）
  const works = (
    await client.query(`
      select w.id::text as id, w.user_id::text as owner
        from public.works w
       where w.user_id is not null
         and exists (select 1 from public.answers a where a.work_id = w.id)
       order by w.id`)
  ).rows;
  for (const w of works) {
    const owner = { role: "authenticated", uid: w.owner };
    put(`owner.analysis:${w.id}`, await callAs(client, owner,
      `select public.get_work_answer_analysis($1) as j`, [w.id]));
    put(`owner.drilldown:${w.id}`, await callAs(client, owner,
      `select public.get_work_drilldown($1, null, '[]'::jsonb) as j`, [w.id]));
    put(`owner.answer_list:${w.id}`, await callAs(client, owner,
      `select public.get_work_answer_list($1) as j`, [w.id]));
    put(`owner.import_state:${w.id}`, await callAs(client, owner,
      `select public.get_work_import_state($1) as j`, [w.id]));
    put(`owner.work_result:${w.id}`, await callAs(client, owner,
      `select public.get_my_work_result($1::uuid) as j`, [w.id]));
  }

  // 答えた本人の立場で読むもの
  const pairs = (
    await client.query(`
      select distinct a.user_id::text as uid, a.work_id::text as wid
        from public.answers a where a.user_id is not null order by 1, 2`)
  ).rows;
  for (const p of pairs) {
    put(`answerer.analysis:${p.uid}:${p.wid}`, await callAs(client,
      { role: "authenticated", uid: p.uid },
      `select public.get_my_answer_analysis($1) as j`, [p.wid]));
  }
  const users = [...new Set(pairs.map((p) => p.uid))];
  for (const uid of users) {
    put(`answerer.my_answers:${uid}`, await callAs(client, { role: "authenticated", uid },
      `select coalesce(jsonb_agg(r), '[]'::jsonb) as j from public.get_my_answers(200, 0) r`));
    put(`public.answers:${uid}`, await callAs(client, { role: "anon" },
      `select coalesce(jsonb_agg(r), '[]'::jsonb) as j
         from public.get_public_answers($1::uuid, 200, 0) r`, [uid]));
  }

  // 全体の順位（未サインインで読む）
  for (const kind of ["accuracy", "popular"]) {
    put(`global.ranking:${kind}`, await callAs(client, { role: "anon" },
      `select coalesce(jsonb_agg(r), '[]'::jsonb) as j
         from public.get_rankings($1, 'normal', null, 50, 0) r`, [kind]));
  }

  return { activity, fp, errors };
}

/**
 * 前後の指紋を比べる。本番は動いているので、前の時点より後に回答や作品が
 * 増えた作品・利用者の鍵は「判定できない」へ分ける（止まる理由ではなく、人が見る理由）。
 */
export async function compareFingerprint(client, before, after) {
  const t0 = before.activity.t0;
  const moved = (
    await client.query(
      `select distinct a.work_id::text as wid, a.user_id::text as uid
         from public.answers a where a.created_at > $1`, [t0])
  ).rows;
  const newWorks = (
    await client.query(`select id::text as wid from public.works where created_at > $1`, [t0])
  ).rows;
  const touched = new Set();
  for (const m of moved) {
    touched.add(m.wid);
    if (m.uid) touched.add(m.uid);
  }
  for (const w of newWorks) touched.add(w.wid);
  const anyActivity = moved.length > 0 || newWorks.length > 0;

  const mismatched = [];
  const undecidable = [];
  const keys = new Set([...Object.keys(before.fp), ...Object.keys(after.fp)]);
  for (const k of [...keys].sort()) {
    if (before.fp[k] === after.fp[k]) continue;
    const ids = k.split(":").slice(1);
    const isGlobal = k.startsWith("global.");
    if ((isGlobal && anyActivity) || ids.some((id) => touched.has(id))) undecidable.push(k);
    else mismatched.push(k);
  }
  return { mismatched, undecidable, activity: { answers: moved.length, works: newWorks.length } };
}

// ─────────────────────────────────────────────────────────────────────────────
// 停止条件
// ─────────────────────────────────────────────────────────────────────────────

async function one(client, sql, params) {
  return (await client.query(sql, params)).rows[0];
}

async function history(client) {
  const rows = (
    await client.query(`select version, name from supabase_migrations.schema_migrations order by version`)
  ).rows;
  return { count: rows.length, max: rows.at(-1)?.version ?? null, versions: rows.map((r) => r.version) };
}

/**
 * 1つの段の判定を行い、[{label, ok, note}] を返す。
 * ok は true（満たした）/ false（停止）/ null（判定できない）。
 */
export async function evaluate(client, stage, expected, before, now) {
  const out = [];
  const add = (label, ok, note = "") => out.push({ label, ok, note });
  const exp = expected.stages[stage];

  // 履歴
  const h = await history(client);
  add(`履歴が ${exp.history.count} 本で、最大が ${exp.history.max}`,
    h.count === exp.history.count && h.max === exp.history.max, `いま ${h.count} 本 / 最大 ${h.max}`);
  const missing = exp.history.versions.filter((v) => !h.versions.includes(v));
  const extra = h.versions.filter((v) => !exp.history.versions.includes(v));
  add("履歴の版の並びが期待どおり（足りない版も余計な版も無い）",
    missing.length === 0 && extra.length === 0,
    [missing.length ? `足りない ${missing.join(",")}` : "", extra.length ? `余計 ${extra.join(",")}` : ""]
      .filter(Boolean).join(" / "));

  // 部品と権限
  if (stage === "pre") {
    const bad = Object.entries(expected.pre).filter(([k, v]) => (now.catalog[k] ?? null) !== v);
    add("当てる3本が触る部品が、使い捨てDB（本番の履歴と同じ順・同じ本数）と同じ定義・同じ権限",
      bad.length === 0, bad.slice(0, 8).map(([k]) => k).join(", "));
  } else {
    const d = diffCatalog(before.catalog, now.catalog);
    const got = {
      added: Object.keys(d.added).sort(),
      removed: Object.keys(d.removed).sort(),
      changed: Object.keys(d.changed).sort(),
    };
    const want = {
      added: Object.keys(exp.added).sort(),
      removed: Object.keys(exp.removed).sort(),
      changed: Object.keys(exp.changed).sort(),
    };
    const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    const listNote = (a, b) => {
      const extraKeys = a.filter((x) => !b.includes(x));
      const lackKeys = b.filter((x) => !a.includes(x));
      return [extraKeys.length ? `想定外 ${extraKeys.slice(0, 6).join(", ")}` : "",
              lackKeys.length ? `足りない ${lackKeys.slice(0, 6).join(", ")}` : ""].filter(Boolean).join(" / ");
    };
    add("増えた部品が期待どおり", same(got.added, want.added), listNote(got.added, want.added));
    add("消えた部品が期待どおり", same(got.removed, want.removed), listNote(got.removed, want.removed));
    add("変わった部品が期待どおり（それ以外の部品と権限は1つも変わっていない）",
      same(got.changed, want.changed), listNote(got.changed, want.changed));
    const wrongValue = [
      ...Object.entries(exp.added).filter(([k, v]) => d.added[k] !== undefined && d.added[k] !== v),
      ...Object.entries(exp.changed).filter(([k, v]) => d.changed[k] !== undefined && d.changed[k][1] !== v[1]),
    ].map(([k]) => k);
    add("増えた・変わった部品の定義と権限が、使い捨てDBで当てたものと一致",
      wrongValue.length === 0, wrongValue.slice(0, 6).join(", "));
  }

  // 指紋を読むときに関数が失敗した鍵（前後で同じ失敗なら「一致」になってしまい、中身を比べていない）
  const errs = Object.entries(now.errors ?? {});
  add(`数字の指紋を、失敗なしで読めた（鍵 ${Object.keys(now.fp).length} 個）`,
    errs.length === 0 ? true : null,
    errs.length ? `失敗 ${errs.length} 個: ${errs.slice(0, 4).map(([k, v]) => `${k} ${v}`).join(" / ")}` : "");

  // 数字の指紋
  if (stage !== "pre") {
    const c = await compareFingerprint(client, before, now);
    const note = `比べた鍵 ${Object.keys(now.fp).length} / 回答の増加 ${c.activity.answers} 件・作品の増加 ${c.activity.works} 件`;
    add(stage === "d196" ? "人の回答だけの分析・取り込み・集計の値が当てる前と同じ"
                         : "集計の指紋（回答数・枠・ヒント・成績・分析・履歴・順位）が当てる前と同じ",
      c.mismatched.length === 0, c.mismatched.length ? `違う鍵 ${c.mismatched.slice(0, 6).join(", ")}` : note);
    if (c.undecidable.length)
      add("当てている間に利用者が動いた作品・人の指紋（判定できない。人が見る）", null,
        c.undecidable.slice(0, 8).join(", "));
  }

  // 段ごとの条件
  if (stage === "pre") {
    const r = await one(client, `
      select (select count(*)::int from information_schema.columns
               where table_schema = 'public' and table_name = 'answers'
                 and column_name = 'answer_source') as col,
             to_regclass('public.system_answer_queue') is not null as queue`);
    add("回答の表にまだ種別の列が無い（Phase 1 は未適用）", r.col === 0);
    add("待ち行列の表がまだ無い（Phase 2 は未適用）", r.queue === false);
  }
  if (stage === "phase1" || stage === "phase2" || stage === "d196") {
    const r = await one(client, `
      select count(*)::int as total,
             count(*) filter (where answer_source = 'human')::int as human,
             count(*) filter (where answer_source is distinct from 'human')::int as other
        from public.answers`);
    add("回答が全件 human", r.human === r.total, `全 ${r.total} 件 / human ${r.human} 件`);
    add("human 以外の回答が0件", r.other === 0, `${r.other} 件`);
    if (stage === "phase1") {
      const same = r.total === before.fp_activity.answers_total;
      add("回答の総数が当てる前と同じ", same ? true : null,
        `前 ${before.fp_activity.answers_total} 件 / いま ${r.total} 件`);
    }
  }
  if (stage === "phase2" || stage === "d196") {
    const q = await one(client, `select count(*)::int as n from public.system_answer_queue`);
    add("待ち行列が0行", q.n === 0, `${q.n} 行`);
    const priv = (
      await client.query(`
        select f.sig,
               has_function_privilege('anon', ('public.' || f.sig)::regprocedure, 'execute') as anon,
               has_function_privilege('authenticated', ('public.' || f.sig)::regprocedure, 'execute') as auth
          from unnest($1::text[]) as f(sig)`, [QUEUE_RPCS])
    ).rows;
    const open = priv.filter((p) => p.anon || p.auth).map((p) => p.sig);
    add("anon と authenticated は、待ち行列の7つの窓口を1つも呼べない", open.length === 0, open.join(", "));
    const t = await one(client, `
      select has_table_privilege('anon', 'public.system_answer_queue', 'select,insert,update,delete') as anon,
             has_table_privilege('authenticated', 'public.system_answer_queue', 'select,insert,update,delete') as auth`);
    add("anon と authenticated は、待ち行列の表を読めも書けもしない", !t.anon && !t.auth);
    const caller = (
      await client.query(`
        select p.oid::regprocedure::text as f
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.prokind = 'f'
           and p.proname <> 'enqueue_system_answer'
           and pg_get_functiondef(p.oid) ~* 'enqueue_system_answer\\s*\\('`)
    ).rows.map((r) => r.f);
    add("システム回答を自動で積む道が DB に無い（積む窓口を呼ぶ関数・引き金が0）",
      caller.length === 0, caller.join(", "));
  }
  if (stage === "d196") {
    const r = (
      await client.query(`
        select p.proname, pg_get_functiondef(p.oid) ~ 'answer_source' as has
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any ($1::text[])`, [D196_FUNCTIONS])
    ).rows;
    const lack = D196_FUNCTIONS.filter((f) => !r.some((x) => x.proname === f && x.has));
    add("互換の検査: 8本すべてが人の回答に絞っている（構造検査 A62 と同じ判定）",
      lack.length === 0 && r.length === D196_FUNCTIONS.length, lack.join(", "));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────────────────────

function resolveUrl() {
  if (process.env.SUPABASE_DB_URL) return process.env.SUPABASE_DB_URL;
  if (!fs.existsSync(POOLER_FILE)) {
    console.log("✗ 接続先が分かりません。SUPABASE_DB_URL を設定するか、npm run db:link を済ませてください。");
    process.exit(3);
  }
  let password;
  try {
    password = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    console.log(`✗ キーチェーンに ${KEYCHAIN_SERVICE} が見つかりません。`);
    process.exit(3);
  }
  const u = new URL(fs.readFileSync(POOLER_FILE, "utf8").trim());
  u.password = password;
  return u.toString();
}

/** 読み取り専用で開いたトランザクションの中で fn を走らせ、必ず rollback で閉じる */
export async function readOnly(url, fn) {
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query("begin transaction isolation level repeatable read read only");
    const ro = (await client.query("show transaction_read_only")).rows[0].transaction_read_only;
    if (ro !== "on") throw new Error("読み取り専用のトランザクションになっていません");
    return await fn(client);
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end().catch(() => {});
  }
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  if (args[0] !== "check" || !STAGES.includes(args[1]) || !opt("--out")) {
    console.log("使い方: node scripts/landing-d194-check.mjs check <pre|phase1|phase2|d196> [--before 前.json] --out 後.json");
    process.exit(3);
  }
  const stage = args[1];
  if (stage !== "pre" && !opt("--before")) {
    console.log("✗ pre 以外は --before（1つ前の段で --out に書いたもの）が要ります。");
    process.exit(3);
  }
  const expected = JSON.parse(fs.readFileSync(EXPECTED_FILE, "utf8"));
  const before = stage === "pre" ? null : JSON.parse(fs.readFileSync(opt("--before"), "utf8"));
  if (before && before.stage !== STAGES[STAGES.indexOf(stage) - 1]) {
    console.log(`✗ --before は ${STAGES[STAGES.indexOf(stage) - 1]} の段で書いたものを渡してください（渡されたのは ${before.stage}）。`);
    process.exit(3);
  }

  const result = await readOnly(resolveUrl(), async (client) => {
    const catalog = await readCatalog(client);
    const { activity, fp, errors } = await readFingerprint(client);
    const now = { stage, catalog, fp, errors, activity, fp_activity: activity };
    const checks = await evaluate(client, stage, expected, before, now);
    return { now, checks };
  });

  fs.writeFileSync(opt("--out"), JSON.stringify({ ...result.now, checks: result.checks }));

  console.log("");
  console.log(`── 停止条件の判定: ${stage} ──`);
  for (const c of result.checks) {
    const mark = c.ok === true ? "○" : c.ok === false ? "✗" : "？";
    console.log(`${mark} ${c.label}${c.note ? `\n    ${c.note}` : ""}`);
  }
  const stop = result.checks.some((c) => c.ok === false);
  const unsure = result.checks.some((c) => c.ok === null);
  console.log("");
  console.log(stop ? "✗ 停止条件に当たりました。次の1本へ進まないでください。"
    : unsure ? "？ 判定できない項目があります。人が見て決めてください。"
    : "○ すべて満たしました。");
  console.log(`  控え: ${opt("--out")}`);
  process.exit(stop ? 1 : unsure ? 2 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.log("✗ 実行に失敗しました: " + (e?.message ?? e));
    process.exit(3);
  });
}
