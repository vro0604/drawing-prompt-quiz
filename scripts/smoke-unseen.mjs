#!/usr/bin/env node
/**
 * smoke-unseen.mjs ／ 知らせの有無を、サインインの有無で呼び分けているか（本番で確かめる）
 *
 * 【何を確かめるか】
 *   2026-09-11 の修正（68344c8）で、未サインインのページ表示では
 *   has_unseen_results を DB に聞かなくなった。サインイン済みなら今までどおり1回聞く。
 *
 *   2026-09-15（fab73e3）から、ヘッダーの知らせの入口は静的に配られ、
 *   未確認の有無は**描画のあとにブラウザが /api/notices/unseen から読む。**
 *   配られた HTML の data-unseen は、読み込み前の仮の値（いつも "no"）でしかない。
 *   そのため HTML を HTTP で取って data-unseen を読む形では、何も確かめられない
 *   （2026-09-17 に書き直した。smoke-notice は 2026-09-16 に同じ理由で直した）。
 *
 *   いまは実際のブラウザで開き、入口が「読み込み済み」（data-loaded="true"）になるのを
 *   待ってから読む。あわせて、そのときブラウザが受け取った /api/notices/unseen の
 *   答えと、入口の表示が食い違っていないことを見る。
 *
 *   **DB に聞いたかどうかは、アプリの画面からは見えない。**
 *   見えるのは Supabase の API 記録（edge_logs）だけなので、この検査は
 *     1. 未サインインとサインイン済みで、それぞれページを開いた時刻を出す
 *     2. どちらの画面でもヘッダーの知らせの入口が壊れていないことを見る
 *   までを受け持つ。記録との突き合わせは、出した時刻を使って別に行う。
 *
 * 【この検査が作るもの】
 *   固定の検査用利用者 dpq-fixture-unseen-check@dpq-smoke.invalid を1人。
 *   作品・お題・回答は作らない。終わったら
 *   `npm run smoke:prod -- fixtures --apply --expect 1` で消す。
 *
 * 【使い方】
 *   npm run smoke:prod -- unseen
 */

import { chromium } from "playwright";

import { BASE, accountUserId, finish, fixtureSession, must, section } from "./_smoke-http.mjs";

const PAGES = ["/", "/works", "/rankings"];
const ENTRY_LOADED = '[data-testid="notice-entry"][data-loaded="true"]';
const url = new URL(BASE);
const browser = await chromium.launch();

/**
 * 1画面を新しいタブで開き、入口の読み込みが済んでから状態を読む。
 * 読み込みの元になった /api/notices/unseen の答えも一緒に返す。
 *
 * タブを使い回すと、前の画面を離れるときの呼び出し（pageshow など）の答えを
 * 拾ってしまい、本文が読めない（2026-09-17 に /rankings で実際に起きた）。
 * だから画面ごとにタブを作り、そのタブで受け取った答えのうち最後のものを使う。
 */
async function openAndRead(ctx, path) {
  const page = await ctx.newPage();
  const answers = [];
  page.on("response", (r) => {
    if (new URL(r.url()).pathname !== "/api/notices/unseen" || r.request().method() !== "GET") return;
    answers.push(
      r.json()
        .then((body) => ({ status: r.status(), cache: r.headers()["cache-control"] ?? "", body }))
        .catch(() => null),
    );
  });
  const res = await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(ENTRY_LOADED, { timeout: 30000 });
  const entry = page.locator(ENTRY_LOADED);
  const out = {
    status: res?.status() ?? 0,
    unseen: await entry.getAttribute("data-unseen"),
    aria: await entry.getAttribute("aria-label"),
  };
  const got = (await Promise.all(answers)).filter(Boolean);
  const last = got.at(-1);
  await page.close();
  return {
    ...out,
    apiCalls: got.length,
    apiStatus: last?.status ?? 0,
    apiCache: last?.cache ?? "",
    apiHasUnseen: last?.body?.hasUnseen,
  };
}

section("未サインイン（DB に聞かない）");

const anonCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const anonFrom = new Date().toISOString();
for (const path of PAGES) {
  const r = await openAndRead(anonCtx, path);
  must(r.status === 200, `${path} が開ける`, String(r.status));
  must(r.apiStatus === 200 && r.apiHasUnseen === false,
    `${path}: ブラウザが読んだ未確認の有無が「無し」`, `${r.apiStatus} ${r.apiHasUnseen}`);
  must(/no-store/.test(r.apiCache), `${path}: その答えは共有キャッシュに載らない`, r.apiCache);
  must(r.unseen === "no", `${path}: 読み込みが済んだあとの入口が「無し」`, `${r.unseen} / ${r.aria}`);
}
const anonTo = new Date().toISOString();
console.log(`  未サインインで開いた時刻: ${anonFrom} 〜 ${anonTo}（${PAGES.length} 画面）`);
await anonCtx.close();

section("サインイン済み（今までどおり1回聞く）");

const member = await fixtureSession("unseen-check");
const who = await member.get("/account");
must(Boolean(accountUserId(who.html)), "検査用の利用者でサインインできている");

const memberCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await memberCtx.addCookies(
  Object.entries(member.cookies()).map(([name, value]) => ({
    name,
    value,
    domain: url.hostname,
    path: "/",
    httpOnly: false,
    secure: url.protocol === "https:",
    sameSite: "Lax",
  })),
);

// サインインの途中でも画面を開くので、そのぶんの呼び出しと混ざらないよう、
// 前後に間を空けて1画面だけ開く（記録の時計とこちらの時計は少しずれる）
const GAP_MS = 15000;
await new Promise((r) => setTimeout(r, GAP_MS));
const memberFrom = new Date().toISOString();
const m = await openAndRead(memberCtx, "/works");
const memberTo = new Date().toISOString();
await new Promise((r) => setTimeout(r, GAP_MS));
must(m.status === 200, "/works が開ける", String(m.status));
must(m.apiStatus === 200 && typeof m.apiHasUnseen === "boolean",
  "ブラウザがサインイン済みで未確認の有無を読めた", `${m.apiStatus} ${m.apiHasUnseen}`);
must(/no-store/.test(m.apiCache), "その答えは共有キャッシュに載らない", m.apiCache);
must(m.unseen === (m.apiHasUnseen ? "yes" : "no"),
  "読み込みが済んだあとの入口が、読んだ答えと一致している", `入口 ${m.unseen} / 答え ${m.apiHasUnseen}`);
console.log(`  サインイン済みで開いた時刻: ${memberFrom} 〜 ${memberTo}（1 画面）`);

await memberCtx.close();
await browser.close();
await finish();
