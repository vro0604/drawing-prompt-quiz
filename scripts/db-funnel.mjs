#!/usr/bin/env node
/**
 * db-funnel.mjs ／ 初回利用の進みぐあいを本番から「読むだけ」で数える
 *
 * 実行: npm run db:funnel            … 24時間・7日・30日・全期間をまとめて出す
 *       npm run db:funnel -- --period 7d
 *       npm run db:funnel -- --json  … 機械が読む形で出す
 *
 * 【やること】
 *   すでに書き込みで残っている行（profiles / draft_sessions / prompts /
 *   works / answers / terms_agreements）から、1人ずつの初回の進みを数える。
 *   数え方そのものは scripts/funnel-query.mjs に置いてある。
 *   **本番と、使い捨ての DB で試す試験は、同じ SQL を使う。**
 *
 * 【やらないこと】
 *   ・INSERT / UPDATE / DELETE / DDL を1文も投げない
 *   ・書き込みのある RPC を1本も呼ばない
 *   ・新しい記録の仕組み（解析サービス・cookie・閲覧の記録）を足さない
 *
 *   守り方は「気をつける」ではない。つないだ直後に
 *   `begin transaction read only` を張る。この中では Postgres 自身が書き込みを拒む。
 *   最後は commit ではなく rollback で閉じる（db-audit-prod.mjs と同じ作法）。
 *
 * 【個人情報を出さない】
 *   標準出力に出すのは人数と時刻の範囲だけ。電子メール・IP・外部の識別子・
 *   利用者の id（UUID）・秘密は1つも出さない。id は SQL の中でしか使わない。
 */

import { pathToFileURL } from "node:url";
import pg from "pg";
import { FUNNEL_SQL, LIMITS, PERIODS, cutoffFor, formatPeriod } from "./funnel-query.mjs";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function parseArgs(argv) {
  const out = { periods: PERIODS.map((p) => p.key), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--period") {
      const key = argv[i + 1];
      i += 1;
      if (!PERIODS.some((p) => p.key === key)) {
        console.error(`--period は ${PERIODS.map((p) => p.key).join(" / ")} のどれかです。`);
        process.exit(2);
      }
      out.periods = [key];
    } else if (a.startsWith("--period=")) {
      const key = a.slice("--period=".length);
      if (!PERIODS.some((p) => p.key === key)) {
        console.error(`--period は ${PERIODS.map((p) => p.key).join(" / ")} のどれかです。`);
        process.exit(2);
      }
      out.periods = [key];
    }
  }
  return out;
}

function connectionString() {
  const fromEnv = process.env.SUPABASE_DB_URL;
  if (fromEnv && fromEnv.trim() !== "") return fromEnv.trim();
  console.error(
    [
      "SUPABASE_DB_URL がありません。",
      "本番を読むときは npm run db:funnel を使ってください",
      "（キーチェーンから接続情報を組み立てる包みを通ります）。",
    ].join("\n"),
  );
  process.exit(2);
}

export async function collectFunnel(query, periodKeys, now = new Date()) {
  const out = {};
  for (const key of periodKeys) {
    const cutoff = cutoffFor(key, now);
    const { rows } = await query(FUNNEL_SQL, [cutoff]);
    out[key] = rows[0].result;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();

  let data;
  try {
    // **書き込みを Postgres 側で拒ませる。**読む前にこれを張る
    await client.query("begin transaction isolation level repeatable read read only");
    data = await collectFunnel((sql, params) => client.query(sql, params), args.periods);
    const { rows } = await client.query(
      `select min(created_at) as first_at, max(created_at) as last_at, count(*)::int as n
         from public.profiles`,
    );
    data.meta = {
      measured_at: new Date().toISOString(),
      profiles_total: rows[0].n,
      profiles_first_at: rows[0].first_at,
      profiles_last_at: rows[0].last_at,
    };
    await client.query("rollback");
  } finally {
    await client.end();
  }

  if (args.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log(`${BOLD}初回利用の進みぐあい（読むだけ）${RESET}`);
  console.log(
    `${DIM}測った時刻: ${data.meta.measured_at} ／ ` +
      `いま残っている人: ${data.meta.profiles_total} 人` +
      `（${data.meta.profiles_first_at?.toISOString?.() ?? data.meta.profiles_first_at} 〜 ` +
      `${data.meta.profiles_last_at?.toISOString?.() ?? data.meta.profiles_last_at}）${RESET}`,
  );

  for (const key of args.periods) console.log(formatPeriod(key, data[key]));

  console.log(`\n${BOLD}この数字で言えないこと${RESET}`);
  for (const line of LIMITS) console.log(`  ・${line}`);
  console.log(
    `${DIM}\n書き込みは1件もしていません（read only の取引を張り、rollback で閉じました）。${RESET}`,
  );
}

// 直に叩かれたときだけ走らせる（試験からは collectFunnel だけを読み込む）。
// 相対パスで起動されても分かるように、URL へ直してから比べる
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message ?? error);
    process.exit(1);
  });
}
