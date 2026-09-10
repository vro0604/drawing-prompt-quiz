#!/usr/bin/env node
/**
 * db-apply-many.mjs ／ 名指しした複数の migration を、1つのトランザクションで当てる
 *
 * 【なぜ要るか】
 *   `db-apply-one.mjs` は1本ずつ当てる。本数ぶんトランザクションが分かれるので、
 *   1本目を当ててから2本目を当てるまでのあいだ、**片方だけが入った状態**が
 *   本番に見えてしまう。
 *
 *   2026-09-10 に実際にその問題が出た。P0（20260907120000）は盤面の読み出し口
 *   （draft_state_json）を作り直す。先に本番へ入っている形の取っかかり（D191）と
 *   制作の手がかり（D193）は、そこで一度返らなくなる。返るように戻すのは
 *   次の1本（20260910190000）である。**その間、利用者から2つの値が消える。**
 *
 *   1つのトランザクションで両方を流せば、その空白は生まれない。
 *   トランザクションは commit するまで他の接続から見えないので、
 *   切り替わりは commit の一瞬だけになる。
 *
 * 【やること】
 *   1. 名指しされたファイルだけを、**渡された順に**読む
 *   2. 1つのトランザクションの中で、その順に流す
 *   3. 全部成功したときだけ commit する。1本でも失敗したら rollback
 *   4. 履歴表には一切触れない
 *
 * 【並べ替えない】
 *   版番号の順に直したりしない。渡された順がそのまま実行順である。
 *   上の例では 20260910190000 を 20260908120000 より先に流す。
 *   **これは間違いではない。**依存の順に並べた結果である。
 *
 * 【履歴表について】
 *   当てたあと、当てた版番号を1つずつ記録すること。
 *
 *     npx supabase migration repair <版番号> --status applied --linked
 *
 *   この道具は repair を実行しない。SQL の成功と履歴の記録を、
 *   **別々の失敗の境目**として扱うためである。SQL が入ったのに履歴が書けなかった
 *   ときは、SQL を流し直すのではなく repair だけをやり直す。
 *   逆に、当てていないものを repair だけするのは履歴に嘘を書く行為なので絶対にしない。
 *
 * 【接続先の取り違えを防ぐ】
 *   本番へ書く道具なので、--confirm-project で「どのプロジェクトへ当てるつもりか」を
 *   明示させる。実際に link されているプロジェクトと一致しなければ、接続する前に断る。
 *   プロジェクトの識別子をこのファイルに焼き付けることはしない。
 *
 * 【接続文字列】
 *   SUPABASE_DB_URL があればそれを使う。無ければ macOS のキーチェーンと
 *   supabase/.temp/pooler-url から組み立てる（db-apply-one.mjs と同じやり方）。
 *   値は画面に出さず、ファイルにも書かず、シェルへも残さない。
 *
 * 【使い方】
 *   npm run db:apply:many -- A.sql B.sql --dry-run
 *   npm run db:apply:many -- A.sql B.sql --confirm-project <プロジェクトの識別子>
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const KEYCHAIN_SERVICE = "drawing-prompt-quiz-supabase-db-password";
const POOLER_FILE = path.join(ROOT, "supabase", ".temp", "pooler-url");
const PROJECT_REF_FILE = path.join(ROOT, "supabase", ".temp", "project-ref");

/**
 * 当てるものの一覧を組み立てる。**DBへは触れない。**
 *
 * 名前の検査、重複の検査、実在の検査をここで全部済ませる。
 * 戻り値は { ok: true, items } か { ok: false, error }。
 * 例外を投げないのは、試験から呼んで断り文句そのものを確かめられるようにするため。
 */
export function buildPlan(names, { migrationsDir = MIGRATIONS } = {}) {
  if (!Array.isArray(names) || names.length < 2) {
    return { ok: false, error: "当てるファイルを2本以上指定してください（1本だけなら db:apply:one を使ってください）。" };
  }

  const items = [];
  const seenName = new Map();
  const seenVersion = new Map();

  for (const name of names) {
    if (typeof name !== "string" || name.length === 0) {
      return { ok: false, error: "ファイル名が空です。" };
    }
    if (name.includes("/") || name.includes("\\")) {
      return { ok: false, error: `ファイル名だけを指定してください（区切り文字が入っています）: ${name}` };
    }
    if (name.includes("..")) {
      return { ok: false, error: `ファイル名だけを指定してください（.. が入っています）: ${name}` };
    }
    if (path.basename(name) !== name) {
      return { ok: false, error: `ファイル名だけを指定してください: ${name}` };
    }

    const version = name.split("_")[0];
    if (!/^\d{14}$/.test(version)) {
      return { ok: false, error: `ファイル名の先頭が版番号（14桁）になっていません: ${name}` };
    }
    if (!name.endsWith(".sql")) {
      return { ok: false, error: `.sql で終わるファイルを指定してください: ${name}` };
    }

    const file = path.join(migrationsDir, name);
    if (!fs.existsSync(file)) {
      return { ok: false, error: `supabase/migrations/${name} がありません。` };
    }

    if (seenName.has(name)) {
      return { ok: false, error: `同じファイルを2回指定しています: ${name}` };
    }
    if (seenVersion.has(version)) {
      return {
        ok: false,
        error: `同じ版番号のファイルを2つ指定しています: ${version}（${seenVersion.get(version)} と ${name}）`,
      };
    }
    seenName.set(name, true);
    seenVersion.set(version, name);

    const sql = fs.readFileSync(file, "utf8");
    items.push({
      name,
      version,
      sql,
      lines: sql.split("\n").length,
      sha256: createHash("sha256").update(sql).digest("hex"),
    });
  }

  return { ok: true, items };
}

/**
 * 組み立てた一覧を、1つのトランザクションの中で順に流す。
 *
 * client は「query」を持つもの。本番では pg.Client、
 * 試験では手元のデータベースを包んだものを渡す。
 * 戻り値は { ok: true } か { ok: false, failed, error }。
 * failed には、落ちたファイルの名前が入る。
 */
export async function applyPlan(items, client, { log = console.log } = {}) {
  let opened = false;
  let current = null;
  try {
    await client.query("begin");
    opened = true;
    for (const it of items) {
      current = it.name;
      log(`  … ${it.name}`);
      await client.query(it.sql);
    }
    current = null;
    await client.query("commit");
    opened = false;
    return { ok: true };
  } catch (e) {
    if (opened) {
      try {
        await client.query("rollback");
        log("  → ロールバックしました。DBは当てる前のままです。");
      } catch {
        log("  → ロールバックにも失敗しました。手で状態を確かめてください。");
      }
    }
    return { ok: false, failed: current, error: e };
  }
}

/** link されているプロジェクトの識別子。読めなければ null */
export function linkedProjectRef({ file = PROJECT_REF_FILE } = {}) {
  if (!fs.existsSync(file)) return null;
  const v = fs.readFileSync(file, "utf8").trim();
  return v.length > 0 ? v : null;
}

// ── ここから下は、コマンドとして呼ばれたときだけ動く ──────────────

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const DRY = argv.includes("--dry-run");

  const confirmIndex = argv.indexOf("--confirm-project");
  const confirmRef = confirmIndex >= 0 ? argv[confirmIndex + 1] : null;

  const names = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--confirm-project") { i += 1; continue; }
    if (a.startsWith("--")) continue;
    names.push(a);
  }

  const plan = buildPlan(names);
  if (!plan.ok) {
    console.log("");
    console.log("✗ " + plan.error);
    console.log("");
    console.log("  使い方:");
    console.log("    npm run db:apply:many -- A.sql B.sql --dry-run");
    console.log("    npm run db:apply:many -- A.sql B.sql --confirm-project <プロジェクトの識別子>");
    console.log("");
    process.exit(1);
  }

  const items = plan.items;
  const linked = linkedProjectRef();

  console.log("");
  console.log("───────────────────────────────────────────");
  console.log(` 当てるもの（${items.length} 本。この順に、1つのトランザクションで）`);
  console.log("───────────────────────────────────────────");
  items.forEach((it, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${it.name}`);
    console.log(`      版番号 ${it.version} ／ ${it.lines} 行 ／ SHA256 ${it.sha256.slice(0, 16)}`);
  });
  console.log("");
  console.log(`  合計 ${items.length} 本。**版番号の順ではなく、渡された順に流します。**`);
  console.log(`  接続先のプロジェクト: ${linked ?? "（link されていません）"}`);
  console.log("");

  if (DRY) {
    console.log("--dry-run なので、ここで終わります。DBへは接続していません。");
    console.log("");
    process.exit(0);
  }

  if (!linked) {
    console.log("✗ どのプロジェクトへ当てるのか分かりません。npm run db:link を済ませてください。");
    process.exit(1);
  }
  if (!confirmRef) {
    console.log("✗ 当てる先を明示してください。");
    console.log(`    npm run db:apply:many -- ... --confirm-project ${linked}`);
    console.log("");
    console.log("  取り違えを防ぐための確認です。--dry-run のときは要りません。");
    process.exit(1);
  }
  if (confirmRef !== linked) {
    console.log("✗ 当てる先が食い違っています。何も実行していません。");
    console.log(`    指定された先: ${confirmRef}`);
    console.log(`    link された先: ${linked}`);
    process.exit(1);
  }

  const pg = (await import("pg")).default;

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

  const client = new pg.Client({ connectionString: resolveUrl(), ssl: { rejectUnauthorized: false } });
  client.on("notice", (n) => {
    const m = (n.message ?? "").trim();
    if (m) console.log("  [DBからの通知] " + m);
  });

  let result;
  try {
    await client.connect();
    console.log("接続しました。トランザクションを開きます。");
    result = await applyPlan(items, client);
  } finally {
    await client.end().catch(() => {});
  }

  if (result.ok) {
    console.log("");
    console.log(`✓ ${items.length} 本すべてを当てて、コミットしました。`);
    console.log("");
    console.log("  次にやること: 履歴表へ、この順に記録する");
    for (const it of items) {
      console.log(`    npx supabase migration repair ${it.version} --status applied --linked`);
    }
    console.log("");
    console.log("  記録し終えたら: npm run db:status ／ npm run db:verify:keychain");
    console.log("");
    process.exit(0);
  }

  console.log("");
  console.log("✗ 失敗しました。**1本も入っていません。**");
  if (result.failed) console.log(`  落ちたファイル: ${result.failed}`);
  const e = result.error;
  console.log("  理由: " + (e?.message ?? e));
  if (e?.detail) console.log("  詳細: " + e.detail);
  if (e?.where) console.log("  位置: " + e.where);
  console.log("");
  console.log("  履歴表には何も書いていません。repair も実行していません。");
  console.log("");
  process.exit(1);
}
