#!/usr/bin/env node
/**
 * setup-protection.mjs ／ Vercel の Deployment Protection の範囲を変える（D155）
 *
 * 【なぜ要るか】
 *   Vercel Cron は本番ドメインを叩かない。**デプロイ1件ごとに付く長いURL**
 *   （`<project>-<hash>-<team>.vercel.app`）を叩く。
 *
 *   ssoProtection が `all_except_custom_domains` だと、そのホストだけが
 *   Vercel のログイン画面へ 302 で飛ばされる。**掃除の処理まで届かない。**
 *
 *     …-869xkje1a-….vercel.app/api/cron/cleanup  → 302 vercel.com/sso-api
 *     drawing-prompt-quiz.vercel.app/api/cron/cleanup → 401（鍵が無いので正しい）
 *
 *   しかも 302 はエラーではない。**Vercel 側は「実行した」と記録できる。**
 *   手順6 の「手動実行を押して成功が記録される」はこの状態でも通る。
 *   「成功が記録される」と「掃除が動いた」は別（D123・D152・D154 と同じ形）。
 *
 * 【なぜ公開範囲が増えないか】
 *   ・その先は `CRON_SECRET` が守る（route.ts。鍵なしは 401、未設定なら 503）
 *   ・本番ドメインは**すでに誰でも 200 で開ける**。長いURLが開いても増えない
 *   ・`x-robots-tag: noindex` は next.config.ts が全応答に付ける（302 にも付いていた）
 *   ・**プレビューは守ったまま。**保護を切るのではなく `preview` に狭める
 *
 * 【要る環境変数】.env.local に置く（Git には入らない）
 *   VERCEL_TOKEN        Vercel のトークン
 *   VERCEL_PROJECT_ID   Vercel のプロジェクトID（省略時は名前で引く）
 *   VERCEL_TEAM_ID      （個人アカウントなら不要）
 *
 * 【使い方】
 *   npm run setup:protection                        … 下見。何も送らない
 *   npm run setup:protection -- --apply             … 送る
 *   npm run setup:protection -- --restore <控え> --apply … 控えの値へ戻す
 */

import { readFileSync } from "node:fs";
import {
  BOLD,
  CYAN,
  DIM,
  DRY_RUN,
  GREEN,
  RESET,
  YELLOW,
  api,
  banner,
  need,
  optional,
  saveBackup,
} from "./_setup-common.mjs";

const TOKEN = need("VERCEL_TOKEN", "Vercel のトークン（vercel.com/account/tokens）");
const PROJECT = optional("VERCEL_PROJECT_ID") ?? "drawing-prompt-quiz";
const TEAM = optional("VERCEL_TEAM_ID");

const query = TEAM ? `?teamId=${TEAM}` : "";
const URL_PROJECT = `https://api.vercel.com/v9/projects/${PROJECT}${query}`;
const headers = { authorization: `Bearer ${TOKEN}` };

/** 目標の状態。プレビューだけを守り、本番のデプロイURLは開ける */
const TARGET = { deploymentType: "preview" };

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

const restoreFrom = arg("restore");

banner(
  restoreFrom ? "[保護の範囲を戻す]" : "[保護の範囲をプレビューだけに狭める]",
  restoreFrom
    ? `${restoreFrom} の内容で上書きします`
    : "Vercel Cron が叩く「長いURL」をログイン画面の外に出します（D155）",
);

// ── いまの状態を読む ─────────────────────────────────

const before = await api("現在の設定を読む", { url: URL_PROJECT, headers });

console.log(`  ${DIM}プロジェクト${RESET}  ${before.name}`);
console.log(`  ${DIM}いまの保護${RESET}    ${BOLD}${JSON.stringify(before.ssoProtection ?? null)}${RESET}`);
console.log(`  ${DIM}Cron の登録${RESET}   ${before.crons?.disabledAt ? "止められている" : "有効"}`);
for (const d of before.crons?.definitions ?? []) {
  console.log(`  ${DIM}Cron の呼び先${RESET} ${d.schedule}  https://${d.host}${d.path}`);
}
console.log("");

// ── 戻す ────────────────────────────────────────────

if (restoreFrom) {
  const saved = JSON.parse(readFileSync(restoreFrom, "utf8"));
  const target = saved.ssoProtection ?? null;
  console.log(`  ${DIM}戻す先${RESET}        ${BOLD}${JSON.stringify(target)}${RESET}`);
  console.log("");

  await api("保護の範囲を戻す", {
    method: "PATCH",
    url: URL_PROJECT,
    headers,
    body: { ssoProtection: target },
  });

  if (DRY_RUN) process.exit(0);
  console.log(`${GREEN}${BOLD}✓ 戻しました${RESET}`);
  console.log("");
  process.exit(0);
}

// ── 変える ──────────────────────────────────────────

// **控えより先に「もう終わっている」かを見る。**
// 逆にすると、目標の状態を「変更前」として控えてしまい、
// その控えで --restore したとき何も戻らない（戻し道が壊れる）。
if (JSON.stringify(before.ssoProtection ?? null) === JSON.stringify(TARGET)) {
  console.log(`${GREEN}すでにその状態です。何もしません。${RESET}`);
  console.log(`${DIM}（控えも書きません。目標の状態を「変更前」として残さないため）${RESET}`);
  console.log("");
  process.exit(0);
}

// 下見でも控えを書く。**先に戻し道を作る**
saveBackup("vercel-protection", {
  savedFor: "D155 ssoProtection をプレビューだけに狭める前の状態",
  savedFrom: URL_PROJECT.replace(query, ""),
  projectId: before.id,
  ssoProtection: before.ssoProtection ?? null,
  passwordProtection: before.passwordProtection ?? null,
  trustedIps: before.trustedIps ?? null,
});

await api("保護の範囲をプレビューだけにする", {
  method: "PATCH",
  url: URL_PROJECT,
  headers,
  body: { ssoProtection: TARGET },
});

if (DRY_RUN) {
  console.log(`${CYAN}下見はここまで。--apply を付けると送ります。${RESET}`);
  console.log("");
  process.exit(0);
}

const after = await api("変わったか読み直す", { url: URL_PROJECT, headers });
console.log(`  ${DIM}いまの保護${RESET}    ${BOLD}${JSON.stringify(after.ssoProtection ?? null)}${RESET}`);
console.log("");
console.log(`${YELLOW}次の答え合わせ${RESET}`);
console.log(`  ${DIM}1.${RESET} Cron の呼び先の /api/cron/cleanup が 302 ではなく ${BOLD}401${RESET} になる`);
console.log(`  ${DIM}2.${RESET} 明日 12:17〜12:59（JST）のあと、画像が未処理の作品が ${BOLD}100件減る${RESET}`);
console.log(`     ${DIM}2 が本当の答え合わせ。1 は「届くようになった」までしか言えない${RESET}`);
console.log("");
