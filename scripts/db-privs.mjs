#!/usr/bin/env node
/**
 * db-privs.mjs ／ 関数の EXECUTE 権限を引数型つきで一覧する
 *
 * 「誰がどの関数を呼べるのか」を目で確かめるための診断。
 * DBは一切変更しない。読むだけ。
 *
 * 【なぜ引数型まで出すか】
 *   Postgres は同じ名前で引数の違う関数を複数持てる。
 *   get_my_work という名前だけでは、どれの権限を見ているのか確定しない。
 *   oid::regprocedure は public.get_my_work(uuid) の形で表示してくれる。
 *
 * 【PUBLIC の見分けかた】
 *   ACL の文字列表記では PUBLIC は grantee 名が空になる（=X/postgres）。
 *   anon は anon=X/postgres。前者だけを取り出すには文字列比較ではなく
 *   aclexplode で grantee の oid が 0 かどうかを見る。
 *   （文字列で '=X/' を探すと anon=X/ にも当たってしまう）
 *
 * 【使い方】
 *   npm run db:privs
 */

import { createInterface } from "node:readline";
import pg from "pg";
import {
  FUNCTION_PRIV_SQL,
  ALL_FUNCS,
  PUBLIC_RPCS,
  OWNER_RPCS,
  DRAFT_RPCS,
  INTERNAL_FUNCS,
  TRIGGER_FUNCS,
} from "./db-checks.mjs";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** 関数名から「あるべき権限」を返す */
function expectationOf(name) {
  if (PUBLIC_RPCS.includes(name)) return { anon: true, auth: true, label: "公開" };
  if (OWNER_RPCS.includes(name)) return { anon: false, auth: true, label: "本人用" };
  if (DRAFT_RPCS.includes(name)) return { anon: false, auth: true, label: "ドラフト" };
  if (INTERNAL_FUNCS.includes(name)) return { anon: false, auth: false, label: "内部" };
  if (TRIGGER_FUNCS.includes(name)) return { anon: false, auth: false, label: "トリガー" };
  return { anon: false, auth: false, label: "不明" };
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const onData = () => {
      process.stdout.write("\x1b[2K\x1b[200D" + question + "*".repeat(rl.line.length));
    };
    process.stdin.on("data", onData);
    rl.question(question, (answer) => {
      process.stdin.removeListener("data", onData);
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

function scrub(text) {
  return String(text).replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "postgresql://***");
}

async function main() {
  let connectionString = process.env.SUPABASE_DB_URL?.trim();
  if (!connectionString) {
    console.log(`\n${BOLD}接続文字列が必要です${RESET}`);
    console.log(`${DIM}  Supabase → 上部の Connect → Session pooler の URI`);
    console.log(`  入力した値はファイルにもログにも残しません。${RESET}\n`);
    connectionString = await askHidden("接続文字列: ");
  }
  if (!connectionString) {
    console.error(`${RED}接続文字列が空です。中止します。${RESET}`);
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    application_name: "dpq-db-privs",
  });

  try {
    await client.connect();
  } catch (err) {
    console.error(`${RED}接続に失敗しました:${RESET} ${scrub(err.message)}`);
    process.exit(1);
  }

  const res = await client.query(FUNCTION_PRIV_SQL, [ALL_FUNCS]);

  console.log("");
  console.log(`${BOLD}public スキーマの関数と EXECUTE 権限${RESET}`);
  console.log(
    `${DIM}  P=PUBLIC  a=anon  A=authenticated   ✓=権限あり  ・=権限なし${RESET}`,
  );
  console.log("─".repeat(96));
  console.log(
    `  ${"区分".padEnd(10)} ${"P".padEnd(3)} ${"a".padEnd(3)} ${"A".padEnd(3)} シグネチャ`,
  );
  console.log("─".repeat(96));

  let ng = 0;
  for (const row of res.rows) {
    const name = row.signature.replace(/^public\./, "").replace(/\(.*$/, "");
    const exp = expectationOf(name);
    const mark = (b) => (b ? "✓" : "・");
    const bad =
      row.public_exec || row.anon_exec !== exp.anon || row.authenticated_exec !== exp.auth;
    if (bad) ng += 1;
    const color = bad ? RED : "";
    const reset = bad ? RESET : "";
    console.log(
      `  ${color}${exp.label.padEnd(10)} ${mark(row.public_exec).padEnd(3)} ` +
        `${mark(row.anon_exec).padEnd(3)} ${mark(row.authenticated_exec).padEnd(3)} ` +
        `${row.signature}${reset}`,
    );
    if (bad) {
      console.log(
        `             ${DIM}期待: P=・ a=${exp.anon ? "✓" : "・"} A=${exp.auth ? "✓" : "・"}${RESET}`,
      );
      console.log(`             ${DIM}ACL: ${row.acl}${RESET}`);
    }
  }

  console.log("─".repeat(96));

  // 今後作る関数のデフォルト権限
  const def = await client.query(`
    select coalesce(array_to_string(d.defaclacl, ' | '), '(なし)') as acl,
           exists (select 1 from aclexplode(d.defaclacl) a
                    where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec
      from pg_default_acl d
      join pg_namespace n on n.oid = d.defaclnamespace
     where n.nspname = 'public' and d.defaclobjtype = 'f'
  `);

  console.log("");
  console.log(`${BOLD}今後 public スキーマに作る関数のデフォルト権限${RESET}`);
  if (def.rows.length === 0) {
    console.log(
      `  ${RED}✗ 設定なし → Postgres の既定どおり PUBLIC へ EXECUTE が自動付与されます${RESET}`,
    );
    ng += 1;
  } else {
    for (const r of def.rows) {
      const ok = !r.public_exec;
      console.log(
        `  ${ok ? GREEN + "✓" : RED + "✗"} PUBLIC への EXECUTE: ${r.public_exec ? "あり" : "なし"}${RESET}`,
      );
      console.log(`    ${DIM}${r.acl}${RESET}`);
      if (!ok) ng += 1;
    }
  }

  await client.end();

  console.log("");
  if (ng === 0) {
    console.log(`${GREEN}${BOLD}✓ すべて期待どおりです${RESET}`);
    process.exit(0);
  } else {
    console.log(`${RED}${BOLD}✗ ${ng}件が期待と異なります（赤い行を確認してください）${RESET}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`${RED}想定外のエラー:${RESET} ${scrub(err.stack ?? err.message)}`);
  process.exit(1);
});
