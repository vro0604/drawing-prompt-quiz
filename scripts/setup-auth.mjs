#!/usr/bin/env node
/**
 * setup-auth.mjs ／ Supabase の認証まわりを、本番の形にそろえる
 *
 * `docs/launch-checklist.md` の手順5・7・7-b・8 を1本にまとめたもの。
 * すべて Management API の `PATCH /v1/projects/{ref}/config/auth` で入る。
 *
 * 【いちばん効くのは手順7-b】
 *   D92 はこう書いている。
 *     「type はテンプレートごとに違う。**人が手で設定するので取り違えが起こる**」
 *   API で入れれば、**本文がリポジトリのファイルになる。**
 *   取り違えが構造的に起きなくなり、差分が見え、戻せる。
 *   本文は supabase/email-templates/ にある。
 *
 * 【このスクリプトがいちばん危ない】
 *   認証の設定を丸ごと書き換える。間違えると**誰もサインインできなくなる。**
 *   だから3つ置いてある。
 *     1. 既定は下見。--apply を付けたときだけ送る
 *     2. 送る前に、いまの設定を backup/ へ JSON で控える
 *     3. --restore <ファイル> で、控えた状態へ戻せる
 *
 * 【使い方】
 *   npm run setup:auth                          … 下見
 *   npm run setup:auth -- --apply               … 実行
 *   npm run setup:auth -- --restore backup/x.json --apply   … 戻す
 *
 * 【要る環境変数】.env.local に置く（Git には入らない）
 *   SUPABASE_ACCESS_TOKEN   Supabase の Management API トークン
 *   SUPABASE_PROJECT_REF    プロジェクトの参照（既定 oyyiutiptsffckujqkvl）
 *   SITE_DOMAIN             tsutawarukana.com
 *   RESEND_API_KEY          SMTP のパスワードとして使う
 *   SMTP_SENDER_EMAIL       noreply@tsutawarukana.com
 */

import { readFileSync } from "node:fs";
import {
  APPLY,
  DRY_RUN,
  BOLD,
  CYAN,
  DIM,
  GREEN,
  RESET,
  ROOT,
  YELLOW,
  api,
  banner,
  need,
  optional,
  redact,
  saveBackup,
} from "./_setup-common.mjs";

const TOKEN = need("SUPABASE_ACCESS_TOKEN", "Supabase の Management API トークン");
const REF = optional("SUPABASE_PROJECT_REF") ?? "oyyiutiptsffckujqkvl";
const DOMAIN = need("SITE_DOMAIN", "本番のドメイン（例 tsutawarukana.com）");

const SITE_URL = `https://${DOMAIN}`;
const API = `https://api.supabase.com/v1/projects/${REF}/config/auth`;
const headers = { authorization: `Bearer ${TOKEN}` };

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

const restoreFrom = arg("restore");

// ── 戻す ────────────────────────────────────────────

if (restoreFrom) {
  banner("[認証設定を戻す]", `${restoreFrom} の内容で上書きします`);

  const saved = JSON.parse(readFileSync(restoreFrom, "utf8"));

  // 控えは GET の応答そのもの。書き戻せない項目が混ざっているので、
  // **このスクリプトが触る項目だけ**を戻す。余計なものを送らない。
  const TOUCHED = [
    "site_url",
    "uri_allow_list",
    "mailer_autoconfirm",
    "external_email_enabled",
    "smtp_host",
    "smtp_port",
    "smtp_user",
    "smtp_admin_email",
    "smtp_sender_name",
    "smtp_max_frequency",
    "rate_limit_anonymous_users",
    "rate_limit_email_sent",
    "mailer_subjects_confirmation",
    "mailer_subjects_email_change",
    "mailer_subjects_magic_link",
    "mailer_subjects_recovery",
    "mailer_templates_confirmation_content",
    "mailer_templates_email_change_content",
    "mailer_templates_magic_link_content",
    "mailer_templates_recovery_content",
  ];

  const body = {};
  for (const k of TOUCHED) if (k in saved) body[k] = saved[k];

  console.log(`  ${DIM}戻す項目: ${Object.keys(body).length}件${RESET}`);
  console.log(`  ${YELLOW}smtp_pass は控えに入っていません。必要なら入れ直してください${RESET}`);
  console.log("");

  await api("認証設定を戻す", { method: "PATCH", url: API, headers, body });

  if (DRY_RUN) {
    console.log(`${CYAN}${BOLD}［下見］外へは何も送っていません。${RESET}`);
    console.log(`${DIM}  戻すには --apply も付けてください${RESET}`);
  } else {
    console.log(`${GREEN}${BOLD}✓ 戻しました${RESET}`);
  }
  console.log("");
  process.exit(0);
}

// ── 送る内容を組み立てる ─────────────────────────────

const RESEND_KEY = need("RESEND_API_KEY", "SMTP のパスワードとして使う");
const SENDER = need("SMTP_SENDER_EMAIL", "送信元（例 noreply@tsutawarukana.com）");

function template(file) {
  return readFileSync(`${ROOT}/supabase/email-templates/${file}`, "utf8");
}

banner("[認証設定]", `Supabase を ${SITE_URL} に向けて、メールを送れるようにします`);

console.log(`  プロジェクト    ${REF}`);
console.log(`  本番URL         ${SITE_URL}`);
console.log(`  送信元          ${SENDER}`);
console.log(`  Resend の鍵     ${redact(RESEND_KEY)}`);
console.log("");

// ── 1. いまの設定を控える（戻し道） ──────────────────

console.log(`${BOLD}1. いまの設定を控える${RESET}`);
console.log("");

const current = await api("現在の設定を読む", { url: API, headers });

saveBackup("auth-config", current);

// 控えを取れないまま先へ進まない。戻れなくなる。
if (!current || Object.keys(current).length === 0) {
  console.log(`${YELLOW}${BOLD}✗ いまの設定を読めませんでした。戻し道が作れないので中止します。${RESET}`);
  console.log("");
  process.exit(1);
}

// ── 2. 何が変わるかを見せる ─────────────────────────

const desired = {
  // 手順7 … 本番URLへ向ける
  site_url: SITE_URL,
  // D115。vercel.app も個別 Deployment URL も入れない
  uri_allow_list: [`${SITE_URL}/**`].join(","),

  // 手順8 … 確認メールを必須に戻す
  mailer_autoconfirm: false,
  external_email_enabled: true,

  // 手順5 … カスタムSMTP。内蔵は1時間2通しか送れず、限定公開が成立しない
  smtp_host: "smtp.resend.com",
  smtp_port: 465,
  smtp_user: "resend",
  smtp_pass: RESEND_KEY,
  smtp_admin_email: SENDER,
  smtp_sender_name: "つたわるかな",
  smtp_max_frequency: 10,

  // 手順5 … 回数制限。ゲストが入口なので匿名を絞りすぎない（D83）
  rate_limit_anonymous_users: 100,
  rate_limit_email_sent: 100,

  // 手順7-b … 本文4種。ここがこのスクリプトの本題
  mailer_subjects_confirmation: "【つたわるかな】メールアドレスの確認",
  mailer_subjects_email_change: "【つたわるかな】メールアドレスの確認",
  mailer_subjects_magic_link: "【つたわるかな】サインイン",
  mailer_subjects_recovery: "【つたわるかな】パスワードの再設定",
  mailer_templates_confirmation_content: template("confirmation.html"),
  mailer_templates_email_change_content: template("email-change.html"),
  mailer_templates_magic_link_content: template("magic-link.html"),
  mailer_templates_recovery_content: template("recovery.html"),
};

console.log(`${BOLD}2. 変わるところ${RESET}`);
console.log("");

const TEMPLATE_KEYS = new Set(
  Object.keys(desired).filter((k) => k.startsWith("mailer_templates_")),
);

let changes = 0;

for (const [key, next] of Object.entries(desired)) {
  const before = current[key];
  const same = TEMPLATE_KEYS.has(key)
    ? String(before ?? "") === String(next)
    : JSON.stringify(before) === JSON.stringify(next);

  if (same) continue;
  changes += 1;

  if (key === "smtp_pass") {
    console.log(`  ${CYAN}·${RESET} ${key}`);
    console.log(`      ${DIM}${redact(before)} → ${redact(next)}${RESET}`);
    continue;
  }

  if (TEMPLATE_KEYS.has(key)) {
    const hadCode = /\?code=|{{ \.ConfirmationURL }}/.test(String(before ?? ""));
    console.log(`  ${CYAN}·${RESET} ${key}`);
    console.log(
      `      ${DIM}${before ? `${String(before).length}文字` : "未設定"} → ${String(next).length}文字${RESET}`,
    );
    if (hadCode) {
      console.log(`      ${YELLOW}いまは ?code= 方式です。別の端末で開くと通りません（D92）${RESET}`);
    }
    continue;
  }

  console.log(`  ${CYAN}·${RESET} ${key}`);
  console.log(`      ${DIM}${JSON.stringify(before) ?? "未設定"} → ${JSON.stringify(next)}${RESET}`);
}

console.log("");

if (changes === 0) {
  console.log(`${GREEN}${BOLD}✓ 変えるところはありません。既にそろっています。${RESET}`);
  console.log("");
  process.exit(0);
}

console.log(`  ${BOLD}${changes}項目が変わります${RESET}`);
console.log("");

// ── 3. 送る ─────────────────────────────────────────

console.log(`${BOLD}3. 送る${RESET}`);
console.log("");

await api("認証設定を書き換える", {
  method: "PATCH",
  url: API,
  headers,
  body: desired,
  secretFields: [
    "smtp_pass",
    "mailer_templates_confirmation_content",
    "mailer_templates_email_change_content",
    "mailer_templates_magic_link_content",
    "mailer_templates_recovery_content",
  ],
});

// ── 4. 読み直して確かめる ───────────────────────────

if (APPLY) {
  console.log(`${BOLD}4. 読み直して確かめる${RESET}`);
  console.log("");

  const after = await api("設定を読み直す", { url: API, headers });

  let wrong = 0;
  for (const [key, want] of Object.entries(desired)) {
    if (key === "smtp_pass") continue; // 読み返せない
    const got = after?.[key];
    const ok = TEMPLATE_KEYS.has(key)
      ? String(got ?? "") === String(want)
      : JSON.stringify(got) === JSON.stringify(want);
    if (!ok) {
      wrong += 1;
      console.log(`  ${YELLOW}✗ ${key} が送ったとおりになっていません${RESET}`);
    }
  }

  if (wrong === 0) {
    console.log(`  ${GREEN}✓ 送った内容どおりになっています${RESET}`);
  }
  console.log("");
}

// ── まとめ ──────────────────────────────────────────

if (DRY_RUN) {
  console.log(`${CYAN}${BOLD}［下見］外へは何も送っていません。${RESET}`);
  console.log(`${DIM}  中身を確かめたら --apply を付けて実行してください${RESET}`);
  console.log("");
  process.exit(0);
}

console.log(`${GREEN}${BOLD}✓ 認証設定を書き換えました${RESET}`);
console.log("");
console.log(`${BOLD}次にやること${RESET}`);
console.log(`  1. 自分宛に登録して、届いたメールのリンクを見る`);
console.log(`     ${DIM}…/auth/confirm?token_hash=…&type=… になっていること${RESET}`);
console.log(`  2. **PCで登録して、スマホでそのリンクを開く**（D92 の答え合わせ）`);
console.log(`  3. 続けて3人ぶん登録しても届く（SMTP の答え合わせ）`);
console.log(`  4. npm run verify:launch -- --url ${SITE_URL}`);
console.log("");
console.log(`${DIM}  戻すには: npm run setup:auth -- --restore backup/auth-config-….json --apply${RESET}`);
console.log("");
