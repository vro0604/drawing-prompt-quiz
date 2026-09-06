/**
 * harness.mjs ／ 本番に触れずに DB を丸ごと動かすための土台
 *
 * 【なぜこれが要るか】
 *   この端末には Docker も psql も無い（実測: `docker` `psql` ともに command not found）。
 *   つながる Postgres は本番の Supabase だけで、そこへ migration を当てる許可は
 *   今回の作業に含まれていない。
 *
 *   PGlite は Postgres 本体を WebAssembly に固めたもので、Node の中だけで動く。
 *   Docker も外部接続も要らない。**本番以外の実行可能な環境**はこれで作る。
 *
 * 【本物との違い（先に書いておく）】
 *   ・Supabase が用意する auth / storage スキーマは無いので、ここで最小限を作る。
 *     auth.uid() と auth.jwt() は、接続変数 request.jwt.claims から読む
 *     （本物と同じ読み方）。
 *   ・Storage の実体（画像ファイル）は無い。storage.objects は表だけ作る。
 *   ・Supabase の API ゲートウェイ（PostgREST）は通らない。RPC は SQL で直接呼ぶ。
 *     **権限の判定はすべて DB 側にあるので、ここを通しても検査の意味は変わらない。**
 *   ・拡張は1つも要らない（migration に create extension が1行も無いことを実測）。
 *
 * 【役の切り替え】
 *   asRole(role, uid, isAnonymous) で
 *     set local role <role>;
 *     set local request.jwt.claims = '{"sub": "...", "is_anonymous": ...}';
 *   を張る。RLS も列権限も、本物と同じように効く。
 */

import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "supabase", "migrations");

/**
 * Supabase 側が用意しているものの最小構成。
 *
 * ここに書くのは「Supabase が既に作っている前提のもの」だけ。
 * **アプリの表は1つも作らない。**それは migration の仕事で、
 * ここで先回りすると「migration が作れていない」ことに気づけなくなる。
 */
const SUPABASE_STUB = `
create schema if not exists auth;
create schema if not exists storage;

-- Supabase の3ロール。RLS と列権限がこの役の上で効く
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

-- 認証の表。アプリからは読まない（profiles と 1:1 で結ぶだけ）
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  is_anonymous boolean not null default true,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- 本物と同じ読み方をする2関数。接続変数から JWT の中身を取る
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ), ''
  )::uuid
$$;

create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), ''),
    '{}'
  )::jsonb
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;

-- Storage。実体は無いので表とパス分解の関数だけ
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text not null,
  owner uuid,
  created_at timestamptz not null default now()
);

alter table storage.objects enable row level security;

create or replace function storage.foldername(name text) returns text[]
language sql immutable as $$
  select string_to_array(name, '/')
$$;

grant usage on schema storage to anon, authenticated, service_role;
`;

/** migration が期待している「1件も無い状態」の目印 */
export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * migration をどこまで当てるかを選べる。
 *
 * before を渡すと、その名前より前のものだけを当てる。
 * 「古い状態のDBを作って、そこへ新しい migration を当てる」を再現するため。
 * **新しいDBに全部当てるのと、古いDBへ足すのは別の試験。**
 */
export async function createTestDb({ log = false, before = null } = {}) {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  await applyMigrations(db, { log, before });
  return db;
}

/** migration を順に当てる。from / before で範囲を切れる */
export async function applyMigrations(db, { log = false, from = null, before = null } = {}) {
  const files = (await readdir(MIGRATIONS))
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => (before === null ? true : f < before))
    .filter((f) => (from === null ? true : f >= from))
    .sort();

  for (const f of files) {
    const sql = await readFile(join(MIGRATIONS, f), "utf8");
    try {
      await db.exec(sql);
      if (log) console.log(`  適用 ${f}`);
    } catch (e) {
      throw new Error(`migration ${f} が適用できません:\n${e.message}`);
    }
  }

  return files;
}

/**
 * 指定の役で SQL を実行する。
 *
 * set local はトランザクションの中でだけ効くので、必ず begin/commit で挟む。
 * 例外が出たら rollback して投げ直す。
 */
export async function asRole(db, { role, uid = null, isAnonymous = false }, fn) {
  await db.exec("begin");
  try {
    await db.exec(`set local role ${role}`);
    if (uid) {
      const claims = JSON.stringify({ sub: uid, is_anonymous: isAnonymous });
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
    } else {
      await db.query(`select set_config('request.jwt.claims', '', true)`);
    }
    const out = await fn({
      query: (sql, params) => db.query(sql, params),
      exec: (sql) => db.exec(sql),
    });
    await db.exec("commit");
    return out;
  } catch (e) {
    try {
      await db.exec("rollback");
    } catch {
      /* rollback 自体の失敗は元の例外を隠さない */
    }
    throw e;
  }
}

/** 役を切り替えずに（＝所有者として）実行する。準備データの投入に使う */
export async function asOwner(db, sql, params) {
  return db.query(sql, params);
}

/** 登録ユーザーを1人作る。auth.users のトリガーが profiles を作る */
export async function createUser(db, { anonymous = false, handle = null } = {}) {
  const { rows } = await db.query(
    `insert into auth.users (email, is_anonymous)
     values ($1, $2) returning id`,
    [anonymous ? null : `${Math.random().toString(36).slice(2)}@example.test`, anonymous],
  );
  const id = rows[0].id;

  if (handle) {
    await db.query(`update public.profiles set handle = $2 where id = $1`, [id, handle]);
  }
  return id;
}

/** 「失敗するはず」を確かめる。成功したら、それ自体が異常 */
export async function expectFailure(promiseFactory, expectedFragment) {
  let message = null;
  try {
    await promiseFactory();
  } catch (e) {
    message = e.message ?? String(e);
  }

  if (message === null) {
    throw new Error(
      `失敗するはずの操作が成功しました（期待していた文言: ${expectedFragment}）`,
    );
  }
  if (expectedFragment && !message.includes(expectedFragment)) {
    throw new Error(
      `失敗はしましたが理由が違います。\n  期待: ${expectedFragment}\n  実際: ${message}`,
    );
  }
  return message;
}
