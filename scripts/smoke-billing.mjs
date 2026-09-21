#!/usr/bin/env node
/**
 * smoke-billing.mjs ／ 課金 v0 の販売入口を本番で確かめる
 *
 * 【何を確かめるか】
 *   商品 founding_creator_v0 は本番販売中。この検査は、その状態で
 *     1. 画面（/founder・/tokushoho・/founder/members）が価格と残り枠を出す
 *     2. 未サインインの購入要求を断り、登録利用者には購入ボタンを出す
 *     3. 知らせの受け口が、署名の無い本文・でたらめな署名を処理しない
 *        （鍵が無ければ 503、鍵があれば 400）
 *   を、未サインインと登録利用者の両方から見る。
 *
 * 【お金は動かない】
 *   Stripe は呼ばれない。登録利用者では画面に購入ボタンがあるところまでを見て、
 *   押さない。未サインインの要求は Stripe より前で止まる。
 *   知らせの受け口は、鍵か署名の確認で止まる。どちらも DB より前。
 *   出所: src/app/api/billing/checkout/route.ts・src/app/api/billing/webhook/route.ts
 *
 * 【この検査が作るもの】
 *   固定の検査用利用者 dpq-fixture-billing-check@dpq-smoke.invalid を1人。
 *   購入・権限・顧客・知らせの行は作らない。終わったら
 *   `npm run smoke:prod -- fixtures --apply --expect 1` で消す。
 *
 * 【使い方】
 *   npm run smoke:prod -- billing
 */

import { BASE, accountUserId, finish, fixtureSession, must, section, textOf } from "./_smoke-http.mjs";

/** 画面の本文から、販売中の価格・枠・購入導線を見る */
function checkFounderPage(label, page, { signedIn = false } = {}) {
  const text = textOf(page.html);
  must(page.status === 200, `${label}: /founder が開ける`, String(page.status));
  must(text.includes("3,000円（税込・一回払い）"), `${label}: 3,000円の一回払いを表示する`);
  must(/残り\s*\d+\s*枠/.test(text), `${label}: 残り枠を表示する`);
  if (signedIn) {
    must(text.includes("Founding Creator を購入する"), `${label}: 購入ボタンを表示する`);
  } else {
    must(text.includes("ログイン・登録の画面へ"), `${label}: ログイン必須の導線を表示する`);
  }
}

/** 生の POST。Cookie と Origin を指定できる */
async function rawPost(path, { body = "", headers = {} } = {}) {
  const res = await fetch(BASE + path, { method: "POST", body, headers, redirect: "manual" });
  const text = await res.text();
  return { status: res.status, text };
}

/** 購入の受け口が URL を返さず、安全側の状態で断っているか */
function checkCheckoutClosed(label, r, allowed) {
  must(allowed.includes(r.status), `${label}: 断られる（${allowed.join(" / ")}）`, `${r.status} ${r.text.slice(0, 120)}`);
  must(!/"url"\s*:/.test(r.text) && !r.text.includes("checkout.stripe.com"), `${label}: 決済ページの URL を返していない`);
}

// ── 未サインイン ──────────────────────────────────────

section("未サインイン: 画面");

const anonFounder = await fetch(`${BASE}/founder`).then(async (r) => ({ status: r.status, html: await r.text() }));
checkFounderPage("未サインイン", anonFounder);

const toku = await fetch(`${BASE}/tokushoho`).then(async (r) => ({ status: r.status, html: await r.text() }));
const tokuText = textOf(toku.html);
must(toku.status === 200, "/tokushoho が開ける", String(toku.status));
must(tokuText.includes("3,000円"), "/tokushoho に販売を始めるときの価格（3,000円）が載っている");

const members = await fetch(`${BASE}/founder/members`).then(async (r) => ({ status: r.status, html: await r.text() }));
must(members.status === 200, "/founder/members が開ける", String(members.status));
must(textOf(members.html).includes("まだどなたも購入されていません"), "Founder 一覧は空");

section("未サインイン: 受け口");

checkCheckoutClosed("購入の受け口（Cookie なし）", await rawPost("/api/billing/checkout"), [401]);
const foreign = await rawPost("/api/billing/checkout", { headers: { origin: "https://evil.example" } });
must(foreign.status === 403, "購入の受け口: 別のサイトからの呼び出しは 403", String(foreign.status));

const fakeEvent = JSON.stringify({
  id: "evt_smoke_billing_fake",
  object: "event",
  type: "checkout.session.completed",
  livemode: true,
  created: Math.floor(Date.now() / 1000),
  data: { object: { id: "cs_smoke_fake", mode: "payment", payment_status: "paid", amount_total: 3000, currency: "jpy" } },
});
const unsigned = await rawPost("/api/billing/webhook", { body: fakeEvent, headers: { "content-type": "application/json" } });
must([400, 503].includes(unsigned.status), "知らせの受け口: 署名の無い本文を処理しない（400 / 503）", `${unsigned.status} ${unsigned.text.slice(0, 80)}`);
const forged = await rawPost("/api/billing/webhook", {
  body: fakeEvent,
  headers: { "content-type": "application/json", "stripe-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` },
});
must([400, 503].includes(forged.status), "知らせの受け口: でたらめな署名を処理しない（400 / 503）", `${forged.status} ${forged.text.slice(0, 80)}`);
const getHook = await fetch(`${BASE}/api/billing/webhook`);
must(getHook.status === 405, "知らせの受け口: GET は受け付けない（405）", String(getHook.status));

// ── 登録利用者 ────────────────────────────────────────

section("登録利用者: 画面と受け口");

const member = await fixtureSession("billing-check");
const who = await member.get("/account");
must(Boolean(accountUserId(who.html)), "検査用の利用者でサインインできている");

checkFounderPage("登録利用者", await member.get("/founder"), { signedIn: true });

await finish();
