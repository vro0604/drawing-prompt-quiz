#!/usr/bin/env node
/**
 * check-env.mjs ／ 本番に要る環境変数がそろっているかを確かめる
 *
 * 【なぜ要るか】
 *   環境変数を1つ入れ忘れても、**ビルドは成功してしまう。**
 *   気づくのは公開したあとで、しかも画面は何も変わらないので
 *   「CAPTCHA が付いていない」ことに誰も気づけない。
 *
 *   ビルドの時点で止める。
 *
 * 【いつ止めるか】
 *   本番のビルドのときだけ。ローカルの `npm run build` は止めない
 *   （手元に本番の鍵を置かせないため）。
 *
 *   本番と判定するのは次のどちらか。
 *     ・VERCEL_ENV=production（Vercel が自動で入れる）
 *     ・REQUIRE_PROD_ENV=1（手で強制するとき）
 *
 *   本番でないときは、足りないものを**表示するだけ**で終了コードは0。
 *
 * 【値は出さない】
 *   有無と形式だけを見て、値そのものは1文字も表示しない。
 *
 * 【使い方】
 *   npm run check:env        … いまの環境を見る（止まらない）
 *   npm run check:env:prod   … 本番と同じ厳しさで見る（足りなければ失敗）
 *   npm run build            … 本番のときだけ自動で止まる
 */

import { readFileSync } from "node:fs";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Cloudflare の公式テスト鍵（公開値）。本番では使わせない */
const TEST_KEYS = new Set([
  "1x00000000000000000000AA",
  "2x00000000000000000000AB",
  "3x00000000000000000000FF",
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
]);

/** .env.local も見る（ローカルで確かめられるように） */
function loadEnvLocal() {
  try {
    const text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    const out = {};
    for (const line of text.split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {};
  }
}

const env = { ...loadEnvLocal(), ...process.env };

const strict =
  process.env.VERCEL_ENV === "production" || process.env.REQUIRE_PROD_ENV === "1";

/**
 * name    … 変数名
 * label   … 何に使うか
 * check   … 追加の形式検査。問題があれば理由を返す
 */
const REQUIRED = [
  { name: "NEXT_PUBLIC_SUPABASE_URL", label: "接続先" },
  { name: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", label: "ブラウザ用の鍵" },
  {
    name: "SUPABASE_SECRET_KEY",
    label: "退会と掃除（RLS を迂回する）",
    check: (v) =>
      v.startsWith("sb_secret_") ? null : "sb_secret_ で始まる新しい形式にしてください",
  },
  {
    name: "NEXT_PUBLIC_SITE_URL",
    label: "共有カードの絶対URL",
    check: (v) => {
      try {
        const u = new URL(v);
        return u.protocol === "https:" ? null : "本番では https にしてください";
      } catch {
        return "URL として読めません";
      }
    },
  },
  {
    name: "CRON_SECRET",
    label: "掃除 Cron の入口を守る",
    check: (v) => (v.length >= 24 ? null : "短すぎます（24文字以上にしてください）"),
  },
  {
    name: "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
    label: "通報の CAPTCHA（widget 用）",
    check: (v) => (TEST_KEYS.has(v) ? "本番でテスト鍵は使えません" : null),
  },
  {
    name: "TURNSTILE_SECRET_KEY",
    label: "通報の CAPTCHA（検証用）",
    check: (v) => (TEST_KEYS.has(v) ? "本番でテスト鍵は使えません" : null),
  },
];

const problems = [];
const lines = [];

for (const item of REQUIRED) {
  const value = (env[item.name] ?? "").trim();

  if (value === "") {
    problems.push(`${item.name} が未設定です（${item.label}）`);
    lines.push(`  ${RED}✗${RESET} ${item.name} ${DIM}未設定 — ${item.label}${RESET}`);
    continue;
  }

  const reason = item.check ? item.check(value) : null;

  if (reason) {
    problems.push(`${item.name}: ${reason}`);
    lines.push(`  ${RED}✗${RESET} ${item.name} ${DIM}${reason}${RESET}`);
    continue;
  }

  // 値は出さない。あることと長さだけ。
  lines.push(`  ${GREEN}✓${RESET} ${item.name} ${DIM}設定あり（${value.length}文字）${RESET}`);
}

// 秘密が NEXT_PUBLIC_ で公開されていないか。
// これは本番かどうかに関係なく、**いつでも致命的**。
const leaked = Object.keys(env).filter(
  (k) => k.startsWith("NEXT_PUBLIC_") && /SECRET|SERVICE_ROLE|PRIVATE/i.test(k),
);

console.log("");
console.log(`${BOLD}[環境変数]${RESET} ${DIM}${strict ? "本番と同じ厳しさ" : "参考表示（止まりません）"}${RESET}`);
console.log("");
for (const l of lines) console.log(l);

if (leaked.length > 0) {
  console.log("");
  for (const k of leaked) {
    console.log(`  ${RED}✗ ${k} — 秘密の値に NEXT_PUBLIC_ が付いています${RESET}`);
    console.log(`    ${DIM}この名前だとブラウザに埋め込まれ、誰でも読めます${RESET}`);
  }
}

console.log("");

if (leaked.length > 0) {
  console.log(`${RED}${BOLD}✗ 秘密の値が公開される名前になっています。必ず直してください。${RESET}`);
  process.exit(1);
}

if (problems.length === 0) {
  console.log(`${GREEN}${BOLD}✓ 本番に必要な環境変数はそろっています${RESET}`);
  process.exit(0);
}

if (strict) {
  console.log(`${RED}${BOLD}✗ ${problems.length}件たりません。本番のビルドを中止します。${RESET}`);
  for (const p of problems) console.log(`  ${RED}・${p}${RESET}`);
  console.log("");
  console.log(`${DIM}  設定する場所と一覧: docs/launch-checklist.md 2-3${RESET}`);
  process.exit(1);
}

console.log(`${YELLOW}${BOLD}△ ${problems.length}件たりません（本番でなければ問題ありません）${RESET}`);
for (const p of problems) console.log(`  ${YELLOW}・${p}${RESET}`);
console.log("");
console.log(`${DIM}  本番と同じ厳しさで見るには: npm run check:env:prod${RESET}`);
process.exit(0);
