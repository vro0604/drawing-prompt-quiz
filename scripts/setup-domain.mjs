#!/usr/bin/env node
/**
 * setup-domain.mjs ／ ドメインまわりを一度に整える
 *
 * `docs/launch-checklist.md` は手順3〜4を「外部管理画面での作業」と書いているが、
 * **その前提は古い。**Cloudflare も Vercel も API で叩ける。
 * 人の手が要るのは**決済と認可だけ**なので、それ以外をここに集める。
 *
 * 【やること】
 *   1. Vercel にドメインを足す
 *   2. Cloudflare に DNS を入れる（Vercel 向け）
 *   3. Cloudflare Email Routing で contact@ を私用アドレスへ転送
 *   4. Turnstile の本番鍵を作る（sitekey と secret が応答で返る）
 *   5. 旧URL（*.vercel.app）をリダイレクトに畳む（D115）
 *   6. Vercel の環境変数を入れる（手順4）
 *
 * 【やらないこと】
 *   **ドメインの購入。**課金なので、必ず自分の手で買う。
 *   買ってから、このスクリプトを走らせる。
 *
 * 【安全のしかた】
 *   ・既定は下見。--apply を付けたときだけ外へ送る
 *   ・秘密は1文字も表示しない（長さだけ。D80 と同じ作法）
 *   ・Turnstile の secret は作った直後に Vercel へ渡すだけで、画面に出さない
 *
 * 【使い方】
 *   npm run setup:domain            … 下見（何も送らない）
 *   npm run setup:domain -- --apply … 実行
 *
 * 【要る環境変数】.env.local に置く（Git には入らない）
 *   CF_API_TOKEN        Cloudflare（Zone DNS 編集 / Email Routing / Turnstile Sites Write）
 *   CF_ACCOUNT_ID       Cloudflare のアカウントID
 *   VERCEL_TOKEN        Vercel
 *   VERCEL_PROJECT_ID   Vercel のプロジェクトID
 *   VERCEL_TEAM_ID      （個人アカウントなら不要）
 *   SITE_DOMAIN         tsutawarukana.com
 *   OLD_DOMAIN          drawing-prompt-quiz.vercel.app
 *   CONTACT_FORWARD_TO  contact@ の転送先（自分がふだん読むアドレス）
 */

import {
  DRY_RUN,
  BOLD,
  CYAN,
  DIM,
  GREEN,
  RESET,
  YELLOW,
  api,
  banner,
  need,
  optional,
  redact,
} from "./_setup-common.mjs";

const CF_TOKEN = need("CF_API_TOKEN", "Cloudflare の API トークン");
const CF_ACCOUNT = need("CF_ACCOUNT_ID", "Cloudflare のアカウントID");
const VC_TOKEN = need("VERCEL_TOKEN", "Vercel のトークン");
const VC_PROJECT = need("VERCEL_PROJECT_ID", "Vercel のプロジェクトID");
const VC_TEAM = optional("VERCEL_TEAM_ID");
const DOMAIN = need("SITE_DOMAIN", "本番のドメイン（例 tsutawarukana.com）");
const OLD_DOMAIN = optional("OLD_DOMAIN");
const FORWARD_TO = need("CONTACT_FORWARD_TO", "contact@ の転送先アドレス");

const SITE_URL = `https://${DOMAIN}`;

const CF = "https://api.cloudflare.com/client/v4";
const VC = "https://api.vercel.com";
const cfHeaders = { authorization: `Bearer ${CF_TOKEN}` };
const vcHeaders = { authorization: `Bearer ${VC_TOKEN}` };
const vcQuery = VC_TEAM ? `?teamId=${VC_TEAM}` : "";

banner(
  "[ドメインの下ごしらえ]",
  `${DOMAIN} を本番URLにして、DNS・メール転送・Turnstile・Vercel をそろえます`,
);

console.log(`  ドメイン        ${DOMAIN}`);
console.log(`  旧URL           ${OLD_DOMAIN ?? "（指定なし）"}`);
console.log(`  contact@ の転送先 ${FORWARD_TO}`);
console.log(`  Cloudflare      ${redact(CF_TOKEN)}`);
console.log(`  Vercel          ${redact(VC_TOKEN)}`);
console.log("");

// ── 0. ドメインが Cloudflare にあるか ─────────────────

console.log(`${BOLD}0. Cloudflare にゾーンがあるか${RESET}`);
console.log("");

const zones = await api("ゾーンを探す", {
  url: `${CF}/zones?name=${encodeURIComponent(DOMAIN)}`,
  headers: cfHeaders,
});

const zone = zones?.result?.[0];

if (!zone) {
  console.log(`  ${YELLOW}✗ ${DOMAIN} が Cloudflare にありません${RESET}`);
  console.log("");
  console.log(`  ${DIM}先にドメインを買ってください。購入は課金なので、このスクリプトはやりません。${RESET}`);
  console.log(`  ${DIM}Cloudflare → Domain Registration → Register Domains${RESET}`);
  console.log("");
  process.exit(1);
}

console.log(`  ${GREEN}✓${RESET} ゾーンがあります  ${DIM}${zone.id}${RESET}`);
console.log(`  ${DIM}状態: ${zone.status}${RESET}`);
console.log("");

const ZONE = zone.id;

// ── 1. Vercel にドメインを足す ───────────────────────

console.log(`${BOLD}1. Vercel にドメインを足す${RESET}`);
console.log("");

await api("本番ドメインを追加", {
  method: "POST",
  url: `${VC}/v10/projects/${VC_PROJECT}/domains${vcQuery}`,
  headers: vcHeaders,
  body: { name: DOMAIN },
}).catch(() => {
  // 既にある場合は失敗するが、それは進めてよい
  console.log(`    ${DIM}（既に追加されている場合はこのまま進みます）${RESET}`);
  console.log("");
});

// 旧URLは「畳む」。両方から入れる状態にすると、CAPTCHA のホスト名照合で
// **片方からの通報だけが黙って落ちる**（D115）。
if (OLD_DOMAIN) {
  await api("旧URLをリダイレクトに畳む（D115）", {
    method: "PATCH",
    url: `${VC}/v9/projects/${VC_PROJECT}/domains/${OLD_DOMAIN}${vcQuery}`,
    headers: vcHeaders,
    body: { redirect: DOMAIN, redirectStatusCode: 308 },
  }).catch(() => {
    console.log(`    ${YELLOW}旧URLの設定に失敗しました。Vercel の画面で確かめてください${RESET}`);
    console.log("");
  });
}

// ── 2. DNS（Vercel 向け） ────────────────────────────

console.log(`${BOLD}2. DNS を入れる${RESET}`);
console.log(`${DIM}   proxied は false。Vercel が自前で CDN と証明書を持っているので、`);
console.log(`   Cloudflare のプロキシを重ねない（D116）${RESET}`);
console.log("");

/** 既にある同名・同型のレコードは作り直さない */
async function putRecord(rec) {
  const found = await api("既存を調べる", {
    url: `${CF}/zones/${ZONE}/dns_records?type=${rec.type}&name=${encodeURIComponent(rec.name)}`,
    headers: cfHeaders,
  });

  const existing = found?.result?.[0];

  if (existing && existing.content === rec.content) {
    console.log(`  ${GREEN}✓${RESET} ${rec.type} ${rec.name} は既に正しい  ${DIM}${rec.content}${RESET}`);
    console.log("");
    return;
  }

  if (existing) {
    await api(`${rec.type} ${rec.name} を書き換える`, {
      method: "PUT",
      url: `${CF}/zones/${ZONE}/dns_records/${existing.id}`,
      headers: cfHeaders,
      body: rec,
    });
    return;
  }

  await api(`${rec.type} ${rec.name} を作る`, {
    method: "POST",
    url: `${CF}/zones/${ZONE}/dns_records`,
    headers: cfHeaders,
    body: rec,
  });
}

// Vercel が案内する A レコードの値。**画面が別の値を出したらそちらが正しい。**
// 変わることがあるので、環境変数で上書きできるようにしておく。
const A_RECORD = optional("VERCEL_A_RECORD") ?? "76.76.21.21";

console.log(`  ${DIM}A レコードの値: ${A_RECORD}`);
console.log(`  Vercel の Domains 画面が別の値を出していたら、`);
console.log(`  VERCEL_A_RECORD で上書きしてください${RESET}`);
console.log("");

await putRecord({
  type: "A",
  name: DOMAIN,
  content: A_RECORD,
  proxied: false,
  comment: "Vercel（DNS only。D116）",
});

await putRecord({
  type: "CNAME",
  name: `www.${DOMAIN}`,
  content: "cname.vercel-dns.com",
  proxied: false,
  comment: "Vercel（DNS only。D116）",
});

// ── 3. contact@ の転送 ───────────────────────────────

console.log(`${BOLD}3. contact@ を転送する${RESET}`);
console.log(`${DIM}   プライバシーポリシーに載せる連絡先。私用のアドレスを公開しないため${RESET}`);
console.log("");

await api("Email Routing を有効にする", {
  method: "POST",
  url: `${CF}/zones/${ZONE}/email/routing/enable`,
  headers: cfHeaders,
  body: {},
}).catch(() => {
  console.log(`    ${DIM}（既に有効な場合はこのまま進みます）${RESET}`);
  console.log("");
});

await api("転送先アドレスを登録する", {
  method: "POST",
  url: `${CF}/accounts/${CF_ACCOUNT}/email/routing/addresses`,
  headers: cfHeaders,
  body: { email: FORWARD_TO },
}).catch(() => {
  console.log(`    ${DIM}（登録済みの場合はこのまま進みます）${RESET}`);
  console.log("");
});

await api("contact@ の転送規則を作る", {
  method: "POST",
  url: `${CF}/zones/${ZONE}/email/routing/rules`,
  headers: cfHeaders,
  body: {
    name: "contact",
    enabled: true,
    matchers: [{ type: "literal", field: "to", value: `contact@${DOMAIN}` }],
    actions: [{ type: "forward", value: [FORWARD_TO] }],
  },
}).catch(() => {
  console.log(`    ${DIM}（規則が既にある場合はこのまま進みます）${RESET}`);
  console.log("");
});

console.log(`  ${YELLOW}!${RESET} 転送先には Cloudflare から確認メールが届きます。`);
console.log(`    ${DIM}承認するまで転送は始まりません${RESET}`);
console.log("");

// ── 4. Turnstile の本番鍵 ────────────────────────────

console.log(`${BOLD}4. Turnstile の本番鍵を作る（手順3）${RESET}`);
console.log(`${DIM}   登録するドメインは ${DOMAIN} だけ。`);
console.log(`   *.vercel.app を足すと、片方からの通報が黙って落ちる（D115）${RESET}`);
console.log("");

let siteKey = null;
let secretKey = null;

const widget = await api("ウィジェットを作る", {
  method: "POST",
  url: `${CF}/accounts/${CF_ACCOUNT}/challenges/widgets`,
  headers: cfHeaders,
  body: {
    name: "つたわるかな（本番）",
    domains: [DOMAIN],
    mode: "managed",
  },
});

if (widget?.result) {
  siteKey = widget.result.sitekey;
  secretKey = widget.result.secret;
  // sitekey は公開値なので出してよい。secret は出さない。
  console.log(`  ${GREEN}✓${RESET} sitekey  ${DIM}${siteKey}${RESET}`);
  console.log(`  ${GREEN}✓${RESET} secret   ${redact(secretKey)}  ${DIM}※ 表示しません${RESET}`);
  console.log("");
}

// ── 5. Vercel の環境変数（手順4） ────────────────────

console.log(`${BOLD}5. Vercel の環境変数を入れる（手順4）${RESET}`);
console.log("");

/** 同じ名前が既にあれば消してから入れ直す */
async function putEnv(key, value, type = "encrypted") {
  const list = await api("既存の環境変数を調べる", {
    url: `${VC}/v9/projects/${VC_PROJECT}/env${vcQuery}`,
    headers: vcHeaders,
  });

  const existing = (list?.envs ?? []).filter(
    (e) => e.key === key && (e.target ?? []).includes("production"),
  );

  for (const e of existing) {
    await api(`${key} の古い値を消す`, {
      method: "DELETE",
      url: `${VC}/v9/projects/${VC_PROJECT}/env/${e.id}${vcQuery}`,
      headers: vcHeaders,
    });
  }

  await api(`${key} を入れる`, {
    method: "POST",
    url: `${VC}/v10/projects/${VC_PROJECT}/env${vcQuery}`,
    headers: vcHeaders,
    body: { key, value, type, target: ["production"] },
    secretFields: ["value"],
  });
}

await putEnv("NEXT_PUBLIC_SITE_URL", SITE_URL, "plain");

if (siteKey) await putEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", siteKey, "plain");
if (secretKey) await putEnv("TURNSTILE_SECRET_KEY", secretKey, "encrypted");

if (DRY_RUN && !siteKey) {
  console.log(`  ${CYAN}下見では Turnstile の鍵が作られないので、その2本は表示していません${RESET}`);
  console.log("");
}

// ── まとめ ──────────────────────────────────────────

console.log("");

if (DRY_RUN) {
  console.log(`${CYAN}${BOLD}［下見］外へは何も送っていません。${RESET}`);
  console.log(`${DIM}  中身を確かめたら --apply を付けて実行してください${RESET}`);
  console.log("");
  process.exit(0);
}

console.log(`${GREEN}${BOLD}✓ ドメインの下ごしらえが終わりました${RESET}`);
console.log("");
console.log(`${BOLD}次にやること${RESET}`);
console.log(`  1. ${FORWARD_TO} に届く Cloudflare の確認メールを承認する`);
console.log(`  2. npm run setup:auth              … Supabase をこのドメインに向ける`);
console.log(`  3. Vercel で再デプロイする         … 環境変数を反映させる`);
console.log(`  4. npm run verify:launch -- --url ${SITE_URL} --old ${OLD_DOMAIN ?? ""}`);
console.log("");
