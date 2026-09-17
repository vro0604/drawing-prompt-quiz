#!/usr/bin/env node
/**
 * smoke-billing.mjs ／ 課金 v0 の入口が、販売停止のまま安全側に閉じているか（本番で確かめる）
 *
 * 【何を確かめるか】
 *   課金 v0 の DB は 2026-09-17 に本番へ入った。商品 founding_creator_v0 は
 *   is_active = false（販売していない）。この検査は、その状態で
 *     1. 画面（/founder・/tokushoho・/founder/members）が「販売していない」と出し、
 *        買う操作・ログインへの誘導・残り枠を出していない
 *     2. 購入の受け口が決済ページの URL を返さない（鍵が無ければ 503、
 *        鍵があっても販売停止で断る）
 *     3. 知らせの受け口が、署名の無い本文・でたらめな署名を処理しない
 *        （鍵が無ければ 503、鍵があれば 400）
 *   を、未サインインと登録利用者の両方から見る。
 *
 * 【お金は動かない】
 *   Stripe は呼ばれない。購入の受け口は、鍵が無ければ設定の確認で止まり、
 *   鍵があっても DB の予約（販売停止なら OFFER_CLOSED）で止まる。どちらも Stripe より前。
 *   知らせの受け口は、鍵か署名の確認で止まる。どちらも DB より前。
 *   出所: src/app/api/billing/checkout/route.ts・src/app/api/billing/webhook/route.ts
 *
 * 【この検査が作るもの】
 *   固定の検査用利用者 dpq-fixture-billing-check@dpq-smoke.invalid を1人。
 *   購入・権限・顧客・知らせの行は作らない。終わったら
 *   `npm run smoke:prod -- fixtures --apply --expect 1` で消す。
 *
 * 【販売を始めたら】
 *   この検査は「販売停止中」を期待値にしている。販売を始めたら落ちるので、
 *   そのときに期待値を直す（落ちることで、販売が始まっていることに気づける）。
 *
 * 【使い方】
 *   npm run smoke:prod -- billing
 */

import { BASE, accountUserId, finish, fixtureSession, must, section, textOf } from "./_smoke-http.mjs";

const CLOSED = "ただいま販売しておりません";
const TOKUSHOHO_CLOSED = "現在、この商品は販売していません";
const url = new URL(BASE);

/** 画面の本文から、販売していないことと、買う入口が無いことを見る */
function checkFounderPage(label, page) {
  const text = textOf(page.html);
  must(page.status === 200, `${label}: /founder が開ける`, String(page.status));
  must(text.includes(CLOSED), `${label}: 「${CLOSED}」が出ている`);
  must(!/残り\s*\d+\s*枠/.test(text), `${label}: 残り枠を出していない`);
  must(!text.includes("ログイン・登録の画面へ"), `${label}: ログイン・登録へ誘っていない`);
  must(!/購入する|購入手続き|お支払いの手続きを続ける/.test(text), `${label}: 買う操作を出していない`);
  must(!page.html.includes("/api/billing/checkout"), `${label}: 購入の受け口を指す記述が無い`);
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
must(tokuText.includes(TOKUSHOHO_CLOSED), `/tokushoho に「${TOKUSHOHO_CLOSED}」が出ている`);
must(tokuText.includes("3,000円"), "/tokushoho に販売を始めるときの価格（3,000円）が載っている");

const members = await fetch(`${BASE}/founder/members`).then(async (r) => ({ status: r.status, html: await r.text() }));
must(members.status === 200, "/founder/members が開ける", String(members.status));
must(textOf(members.html).includes("まだどなたも購入されていません"), "Founder 一覧は空");

section("未サインイン: 受け口");

checkCheckoutClosed("購入の受け口（Cookie なし）", await rawPost("/api/billing/checkout"), [401, 503]);
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

checkFounderPage("登録利用者", await member.get("/founder"));

const cookie = Object.entries(member.cookies()).map(([k, v]) => `${k}=${v}`).join("; ");
const memberCheckout = await rawPost("/api/billing/checkout", { headers: { cookie, origin: url.origin } });
// 鍵が無ければ 503、鍵があれば予約の段で販売停止（OFFER_CLOSED → 409）
checkCheckoutClosed("購入の受け口（登録利用者）", memberCheckout, [409, 503]);

const after = await member.get("/founder");
must(!textOf(after.html).includes("お支払いの手続きが途中です"), "受け口を叩いたあとも、枠を押さえた状態になっていない");

await finish();
