#!/usr/bin/env node
/**
 * db-history-0909.mjs ／ 履歴表の 20260909180000 の1行を、確かめてから直す（または戻す）
 *
 * 【何のためか】
 *   本番の履歴表（supabase_migrations.schema_migrations）の version = 20260909180000 の行は、
 *   name と statements が古い課金の下書きのままになっている。表・関数・権限は
 *   手元のファイル（profile_rpc_revoke_anon）どおりに入っていて、食い違っているのは
 *   この1行の記録だけ。経緯と、使い捨ての DB で3つの方式を比べた実測は
 *   docs/history-20260909180000.md にある。
 *
 * 【3つの使い方】
 *   node scripts/db-history-0909.mjs check      読むだけ（既定）。いまが修復前か修復後かを判定する
 *   node scripts/db-history-0909.mjs fix --yes  修復前であることを確かめてから、1行を直す
 *   node scripts/db-history-0909.mjs rollback --yes  修復後であることを確かめてから、修復前の行へ戻す
 *
 *   check は、履歴表を読み取り専用のトランザクションで読み、続けて
 *   `supabase migration list` と `supabase db push --dry-run` を流す（どちらも読むだけ）。
 *   fix / rollback は --yes が無ければ何もしない。
 *   どちらも、流す前と流した後に check と同じ確認を行い、
 *   ほかの66行が1文字も変わっていないこと・CLI から見た履歴が変わらないことを確かめる。
 *
 *   作業木は origin/main をそのまま取り出したものを使う。手元の main（6d24ec1）のように
 *   同じ版番号で別の中身のファイルがある作業木では、DB へつなぐ前に止まる。
 *
 * 【流す SQL】
 *   supabase/manual/20260909180000_history_fix.sql
 *   supabase/manual/20260909180000_history_rollback.sql
 *   どちらも1トランザクションで、前提が違えば例外で止まり何も変わらない。
 *   ファイルの sha256 をこのスクリプトに書いてあり、違えば流さない。
 *
 * 【接続先】
 *   SUPABASE_DB_URL があればそれを使う。無ければキーチェーンと supabase/.temp/pooler-url から
 *   組み立てる（db-apply-one.mjs と同じ）。値は画面に出さない。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import pg from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEYCHAIN_SERVICE = "drawing-prompt-quiz-supabase-db-password";
const POOLER_FILE = path.join(ROOT, "supabase", ".temp", "pooler-url");
const VERSION = "20260909180000";

// 2026-09-17 の実測（本番の読み取りと、使い捨ての PostgreSQL 17.6 で同じ値）
const EXPECT = {
  total: 67,
  others: { n: 66, md5: "8d7063f852030324dbfd3b0b7ae4ab11" },
  before: { name: "billing_founding_creator_v0", n: 106, md5: "e98153b0892a896ab75bb24860515720" },
  after: { name: "profile_rpc_revoke_anon", n: 11, md5: "e2158bec568e70801cefdfeff057b193" },
  localFile: { name: "20260909180000_profile_rpc_revoke_anon.sql", sha256: "f50e33fa682629ccc959bd8f83b94929722120c4f9efe219eaa01dd14014dc3d" },
  sql: {
    fix: { file: "supabase/manual/20260909180000_history_fix.sql", sha256: "30a27b72d45e32baa5579d7685c8d229ed855b4ad9c0c1b1031426e3cfe5c8ff" },
    rollback: { file: "supabase/manual/20260909180000_history_rollback.sql", sha256: "a1265f36a200b3d21e4dc27ab33200481ea9c2467cb1acb453444462170fac13" },
  },
};

const args = process.argv.slice(2);
const mode = args.find((a) => !a.startsWith("--")) ?? "check";
const YES = args.includes("--yes");
if (!["check", "fix", "rollback"].includes(mode)) {
  console.log("使い方: node scripts/db-history-0909.mjs [check | fix --yes | rollback --yes]");
  process.exit(1);
}

const sha256 = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const stop = (msg) => {
  console.log(`\n✗ 止めました: ${msg}`);
  process.exit(1);
};

// ── 手元のファイルの確認（DB へつなぐ前）──────────────────────────
// 同じ版番号のファイルが2つ以上ある作業木（手元の main など）では、
// CLI も人も別の中身を正本と取り違える。1つだけであることを確かめる。
const sameVersion = fs.readdirSync(path.join(ROOT, "supabase", "migrations")).filter((f) => f.startsWith(`${VERSION}_`));
if (sameVersion.length !== 1 || sameVersion[0] !== EXPECT.localFile.name) {
  stop(`supabase/migrations の ${VERSION} のファイルが「${EXPECT.localFile.name} の1つだけ」ではありません（${sameVersion.join(", ") || "無し"}）`);
}
if (sha256(path.join(ROOT, "supabase", "migrations", EXPECT.localFile.name)) !== EXPECT.localFile.sha256) {
  stop(`${EXPECT.localFile.name} の中身が、修復の値を作ったときと違います`);
}
if (mode !== "check") {
  const s = EXPECT.sql[mode];
  if (!fs.existsSync(path.join(ROOT, s.file)) || sha256(path.join(ROOT, s.file)) !== s.sha256) stop(`${s.file} が無いか、中身が確かめたものと違います`);
}

function resolveUrl() {
  if (process.env.SUPABASE_DB_URL) return process.env.SUPABASE_DB_URL;
  if (!fs.existsSync(POOLER_FILE)) stop("接続先が分かりません（SUPABASE_DB_URL か npm run db:link）");
  let password;
  try {
    password = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    stop(`キーチェーンに ${KEYCHAIN_SERVICE} が見つかりません`);
  }
  const u = new URL(fs.readFileSync(POOLER_FILE, "utf8").trim());
  u.password = password;
  return u.toString();
}

const DB_URL = resolveUrl();
const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false }, application_name: "dpq-history-0909" });

/**
 * CLI から見た状態。CLI は履歴表の version だけを読む（使い捨ての DB で、届いた文が
 * `SELECT version FROM supabase_migrations.schema_migrations` だけだったことを確かめた）。
 * だから修復の前後で結果は変わらないはずで、変わったら止める。
 */
function cliView(label) {
  const run = (a) => {
    try {
      const out = execFileSync("npx", ["supabase", ...a, "--db-url", DB_URL, "--output-format", "json", "--agent", "no", "--workdir", ROOT], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return JSON.parse(out.split("\n").find((l) => l.startsWith("{")));
    } catch (e) {
      stop(`${a.join(" ")} が失敗しました: ${String(e.stderr ?? e.message).replace(/postgres(ql)?:\/\/\S+/g, "postgresql://***").split("\n").slice(-3).join(" / ")}`);
    }
  };
  const list = run(["migration", "list"]);
  const dry = run(["db", "push", "--dry-run"]);
  const rows = list.migrations ?? [];
  const both = rows.filter((m) => m.local && m.remote && m.local === m.remote).length;
  console.log(`  migration list        ${rows.length}行 / 手元と本番の両方にある ${both}行（期待 ${EXPECT.total} / ${EXPECT.total}）`);
  console.log(`  db push --dry-run     ${dry.upToDate ? "up to date" : `当てるものがある: ${(dry.migrations ?? []).join(", ")}`}`);
  if (rows.length !== EXPECT.total || both !== EXPECT.total || dry.upToDate !== true) stop(`[${label}] CLI から見た履歴が期待と違います`);
}

/** 読み取り専用のトランザクションで、いまの状態を判定する */
async function inspect(label) {
  await client.query("begin transaction isolation level repeatable read read only");
  try {
    const total = (await client.query(`select count(*)::int n from supabase_migrations.schema_migrations`)).rows[0].n;
    const others = (await client.query(
      `select count(*)::int n, md5(string_agg(version||':'||coalesce(name,'')||':'||coalesce(md5(statements::text),''), '|' order by version)) m
         from supabase_migrations.schema_migrations where version <> $1`, [VERSION])).rows[0];
    const row = (await client.query(
      `select name, array_length(statements, 1) n, md5(statements::text) m from supabase_migrations.schema_migrations where version = $1`, [VERSION])).rows[0] ?? null;
    const same = (e) => row && row.name === e.name && row.n === e.n && row.m === e.md5;
    const state = same(EXPECT.before) ? "修復前" : same(EXPECT.after) ? "修復後" : "想定外";
    console.log(`\n[${label}]`);
    console.log(`  履歴の行数            ${total}（期待 ${EXPECT.total}）`);
    console.log(`  ほかの66行の指紋      ${others.n}行 / ${others.m}（期待 ${EXPECT.others.n}行 / ${EXPECT.others.md5}）`);
    console.log(`  ${VERSION} の行  ${row ? `${row.name} / ${row.n}文 / ${row.m}` : "無い"}`);
    console.log(`  判定                  ${state}`);
    const othersOk = others.n === EXPECT.others.n && others.m === EXPECT.others.md5;
    return { total, othersOk, state };
  } finally {
    await client.query("rollback");
  }
}

let exitCode = 1;
try {
  await client.connect();
  const pre = await inspect("いまの状態（読み取りのみ）");
  if (pre.total !== EXPECT.total) stop(`履歴が ${EXPECT.total} 行ではありません。新しい migration が入った後なら、この手順の値を作り直してください`);
  if (!pre.othersOk) stop("ほかの66行が、確かめたときと違います");
  if (pre.state === "想定外") stop(`${VERSION} の行が、修復前とも修復後とも違います`);
  cliView("流す前");

  if (mode === "check") {
    exitCode = 0;
  } else {
    const need = mode === "fix" ? "修復前" : "修復後";
    if (pre.state !== need) stop(`${mode} は「${need}」のときだけ流せます（いまは「${pre.state}」）`);
    if (!YES) {
      console.log(`\n--yes が無いので、ここで終わります。DB は変更していません。`);
      exitCode = 0;
    } else {
      const sql = fs.readFileSync(path.join(ROOT, EXPECT.sql[mode].file), "utf8");
      console.log(`\n${EXPECT.sql[mode].file} を流します（1トランザクション）。`);
      try {
        await client.query(sql);
      } catch (e) {
        try { await client.query("rollback"); } catch { /* 開いていなければ何もしない */ }
        stop(`SQL が止まりました。DB は流す前のままです: ${e.message}`);
      }
      const post = await inspect("流した後（読み取りのみ）");
      const want = mode === "fix" ? "修復後" : "修復前";
      if (post.total !== EXPECT.total || !post.othersOk || post.state !== want) {
        stop(`流した後の状態が期待（${want}・${EXPECT.total}行・ほかの66行が同じ）と違います。docs/history-20260909180000.md の「戻す」を見てください`);
      }
      cliView("流した後");
      console.log(`\n✓ ${want}になりました。続けて npm run db:verify:keychain を回してください。`);
      exitCode = 0;
    }
  }
} finally {
  await client.end().catch(() => {});
}
process.exit(exitCode);
