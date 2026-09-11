#!/usr/bin/env node
/**
 * smoke-unseen.mjs ／ 知らせの有無を、サインインの有無で呼び分けているか（本番で確かめる）
 *
 * 【何を確かめるか】
 *   2026-09-11 の修正（68344c8）で、未サインインのページ表示では
 *   has_unseen_results を DB に聞かなくなった。サインイン済みなら今までどおり1回聞く。
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

import { finish, fixtureSession, must, section, session } from "./_smoke-http.mjs";

const PAGES = ["/", "/works", "/rankings"];

section("未サインイン（DB に聞かない）");

const anon = session("unseen-anon");
const anonFrom = new Date().toISOString();
for (const path of PAGES) {
  const page = await anon.get(path);
  must(page.status === 200, `${path} が開ける`, String(page.status));
  must(/data-unseen="no"/.test(page.html), `${path} のヘッダーに知らせの入口があり、「無し」になっている`);
}
const anonTo = new Date().toISOString();
console.log(`  未サインインで開いた時刻: ${anonFrom} 〜 ${anonTo}（${PAGES.length} 画面）`);

section("サインイン済み（今までどおり1回聞く）");

const member = await fixtureSession("unseen-check");

// サインインの途中でも画面を開くので、そのぶんの呼び出しと混ざらないよう、
// 前後に間を空けて1画面だけ開く（記録の時計とこちらの時計は少しずれる）
const GAP_MS = 15000;
await new Promise((r) => setTimeout(r, GAP_MS));
const memberFrom = new Date().toISOString();
const page = await member.get("/works");
const memberTo = new Date().toISOString();
await new Promise((r) => setTimeout(r, GAP_MS));
must(page.status === 200, "/works が開ける", String(page.status));
must(/data-unseen="(yes|no)"/.test(page.html), "ヘッダーに知らせの入口がある");
console.log(`  サインイン済みで開いた時刻: ${memberFrom} 〜 ${memberTo}（1 画面）`);

await finish();
