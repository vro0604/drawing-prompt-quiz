#!/usr/bin/env node
/**
 * db-apply-one.mjs ／ migration を1本だけ名指しで当てる
 *
 * 【なぜ要るか】
 *   ふだんの反映は `npm run db:deploy`（= supabase db push）で行う。
 *   これは「リモートの履歴に無いものを全部、ファイル名の順に」当てる。
 *   選べない。だから、別の作業線が書きかけの migration を
 *   migrations/ に置いている間は、こちらの1本だけを出せない。
 *
 *   2026-09-08 に実際にその状態になった。dry-run の実測:
 *     Would push these migrations:
 *       • 20260907120000_single_pass_draw_and_slot_redo.sql  ← 書きかけ。出さない
 *       • 20260908090000_art_first.sql                        ← これだけ出したい
 *
 *   書きかけのファイルを動かす・消す・名前を変えるのは、
 *   持ち主の作業線の判断であって、こちらが勝手にやることではない。
 *   そこで「当てる1本を名指しする」入口を作った。
 *
 * 【やること】
 *   1. 名指しされた1本だけを読む（他のファイルには触れない）
 *   2. 1つのトランザクションの中で流す。途中で失敗したら何も残らない
 *   3. 履歴表への記録はしない
 *
 * 【履歴表について】
 *   当てたあと、必ず次を実行して履歴へ記録すること。
 *
 *     npx supabase migration repair <版番号> --status applied --db-url <接続文字列>
 *
 *   記録しないと、次の db push が同じ1本をもう一度当てようとして止まる。
 *   逆に、当てていないものを repair だけするのは**履歴に嘘を書く行為**なので
 *   絶対にしない。repair は「実際に当てた直後」にだけ使う。
 *
 * 【接続先】
 *   SUPABASE_DB_URL があればそれを使う。無ければ macOS のキーチェーンと
 *   supabase/.temp/pooler-url から組み立てる（db-verify-keychain.sh と同じやり方）。
 *   値は画面に出さず、ファイルにも書かず、シェルへも残さない。
 *
 * 【使い方】
 *   npm run db:apply:one -- 20260908090000_art_first.sql
 *   npm run db:apply:one -- 20260908090000_art_first.sql --dry-run
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import pg from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const KEYCHAIN_SERVICE = "drawing-prompt-quiz-supabase-db-password";
const POOLER_FILE = path.join(ROOT, "supabase", ".temp", "pooler-url");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const name = args.find((a) => !a.startsWith("--"));

if (!name) {
  console.log("");
  console.log("当てる migration のファイル名を1つ指定してください。");
  console.log("  npm run db:apply:one -- 20260908090000_art_first.sql");
  console.log("");
  process.exit(1);
}

if (name.includes("/") || name.includes("..")) {
  console.log("✗ ファイル名だけを指定してください（supabase/migrations/ の中から探します）。");
  process.exit(1);
}

const file = path.join(MIGRATIONS, name);
if (!fs.existsSync(file)) {
  console.log(`✗ supabase/migrations/${name} がありません。`);
  process.exit(1);
}

const version = name.split("_")[0];
if (!/^\d{14}$/.test(version)) {
  console.log(`✗ ファイル名の先頭が版番号（14桁）になっていません: ${name}`);
  process.exit(1);
}

const sql = fs.readFileSync(file, "utf8");
const others = fs
  .readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql") && f !== name);

console.log("");
console.log("───────────────────────────────────────────");
console.log(" 当てるもの（この1本だけ）");
console.log("───────────────────────────────────────────");
console.log(`  ${name}  （${sql.split("\n").length} 行 / 版番号 ${version}）`);
console.log("");
console.log(`  同じフォルダにある他の ${others.length} 本には触れません。`);
console.log("");

if (DRY) {
  console.log("--dry-run なので、ここで終わります。DBは変更していません。");
  process.exit(0);
}

// ── 接続文字列を組み立てる（画面には出さない）──────────────────

function resolveUrl() {
  if (process.env.SUPABASE_DB_URL) return process.env.SUPABASE_DB_URL;
  if (!fs.existsSync(POOLER_FILE)) {
    console.log("✗ 接続先が分かりません。");
    console.log("  SUPABASE_DB_URL を設定するか、npm run db:link を済ませてください。");
    process.exit(1);
  }
  let password;
  try {
    password = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    console.log(`✗ キーチェーンに ${KEYCHAIN_SERVICE} が見つかりません。`);
    console.log("  scripts/db-verify-keychain.sh の説明にある手順で登録してください。");
    process.exit(1);
  }
  const u = new URL(fs.readFileSync(POOLER_FILE, "utf8").trim());
  u.password = password;
  return u.toString();
}

const url = resolveUrl();

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
client.on("notice", (n) => {
  const m = (n.message ?? "").trim();
  if (m) console.log("  [DBからの通知] " + m);
});

let ok = false;
try {
  await client.connect();
  console.log("接続しました。トランザクションを開きます。");
  await client.query("begin");
  await client.query(sql);
  await client.query("commit");
  ok = true;
  console.log("");
  console.log("✓ 適用してコミットしました。");
  console.log("");
  console.log("  次にやること: 履歴表へ記録する");
  console.log(`    npx supabase migration repair ${version} --status applied --db-url <接続文字列>`);
} catch (e) {
  console.log("");
  console.log("✗ 失敗しました: " + (e?.message ?? e));
  if (e?.detail) console.log("  詳細: " + e.detail);
  if (e?.where) console.log("  位置: " + e.where);
  try {
    await client.query("rollback");
    console.log("  → ロールバックしました。DBは当てる前のままです。");
  } catch {
    console.log("  → ロールバックにも失敗しました。手で状態を確かめてください。");
  }
} finally {
  await client.end().catch(() => {});
}

process.exit(ok ? 0 : 1);
