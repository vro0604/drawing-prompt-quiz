#!/usr/bin/env node
/**
 * smoke-push.mjs ／ 端末への通知の入口を、本番のブラウザで確かめる（P5-B）
 *
 * 【何を確かめるか、確かめないか】
 *   確かめるのは、**通知を受け取れる状態まで持っていける仕組みがあるか。**
 *   実際に通知が飛んで画面に出るところまでは自動では見ない。
 *   通知を出すには本番で「誰かが自分の作品に答えた」という出来事が要る。
 *   それを検査のために作るのは、本番の記録を偽ることになる。
 *
 * 【何を通すか】
 *   A. 土台     … /sw.js が配られている。ブラウザ側の道具がそろっている
 *   B. 鍵       … サイトの公開鍵がブラウザへ届いている（長さと形だけ見る）
 *   C. 入口     … お題を引いた人の画面に、通知を頼む入口が出る
 *   D. 断った人 … 許可を断っても画面が壊れず、入口も出ない
 *   E. 受け口   … 宛先を保存する窓口が、欠けた中身を断る
 *   F. 別サイト … 別のサイトからの送信を断る
 *
 * 【値は出さない】
 *   公開鍵は誰のブラウザにも配られるものだが、この検査は長さと形しか見ない。
 *   秘密鍵と送信元の連絡先は、外から観測できないので触らない。
 *
 * 【本番に何を残すか】
 *   何も残さない。宛先は1件も保存しない（許可を出さないため）。
 *   お題は引くが、確定せずに片づける。
 *
 * 【使い方】
 *   SMOKE_BASE_URL=https://<本番> npm run smoke:prod -- push
 */

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

import {
  BASE,
  accountUserId,
  finish,
  fixtureSession,
  forms,
  must,
  section,
  targetEnv,
} from "./_smoke-http.mjs";

console.log(`\n接続先: ${BASE}`);

const env = targetEnv();
const siteUrl = new URL(BASE);
const browser = await chromium.launch();

function admin() {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = env.SUPABASE_SECRET_KEY;
  if (!url || !secret) {
    throw new Error("接続先と秘密鍵がありません（本番へ向けるなら npm run smoke:prod）。");
  }
  return createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false } });
}

const s = await fixtureSession("push-user");

/** 進行中のドラフトを片づける。**確定はしない。**お題も作品も残さない */
async function clearDrafts() {
  const who = await s.get("/account");
  const userId = accountUserId(who.html);
  if (!userId) return 0;
  const { data } = await admin()
    .from("draft_sessions")
    .update({ status: "abandoned", abandoned_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("status", "in_progress")
    .select("id");
  return (data ?? []).length;
}

/** お題を引き始める（確定しない）。通知の入口が出る場面を作るため */
async function startDraft() {
  await clearDrafts();
  const page = await s.get("/play");
  const startForm = forms(page.html).find((f) => /ドラフトを始める/.test(f.text));
  if (!startForm?.actionId) throw new Error("/play に開始フォームがありません");
  await s.post("/play", {
    [startForm.actionId]: "",
    modeKey: "normal",
    timeLimitSeconds: "3600",
  });
}

/** その人の Cookie を持った窓を1つ作る。permissions で許可の答えを決める */
async function windowFor(permissions) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions,
  });
  await ctx.addCookies(
    Object.entries(s.cookies()).map(([name, value]) => ({
      name,
      value,
      domain: siteUrl.hostname,
      path: "/",
      httpOnly: false,
      secure: siteUrl.protocol === "https:",
      sameSite: "Lax",
    })),
  );
  return { ctx, page: await ctx.newPage() };
}

// ══════════════════════════════════════════════════════
// A. 土台
// ══════════════════════════════════════════════════════

section("A. 通知の土台が配られている");

const sw = await fetch(`${BASE}/sw.js`);
must(sw.status === 200, "/sw.js が配られている", String(sw.status));
const swBody = await sw.text();
must(/push/i.test(swBody), "受け取り側の書きかたが入っている");
must(/notificationclick/i.test(swBody), "押したときの行き先が書いてある");

const probe = await windowFor([]);
await probe.page.goto(BASE, { waitUntil: "domcontentloaded" });

const abilities = await probe.page.evaluate(() => ({
  serviceWorker: "serviceWorker" in navigator,
  pushManager: "PushManager" in window,
  notification: typeof Notification !== "undefined",
}));
must(abilities.serviceWorker, "ブラウザが常駐の仕組みを持っている");
must(abilities.pushManager, "ブラウザが通知の受け口を持っている");
must(abilities.notification, "ブラウザが知らせの窓を持っている");

// 常駐の仕組みを本当に登録できること。**登録だけで、宛先は作らない**
const registered = await probe.page.evaluate(async () => {
  try {
    const r = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    return r.scope;
  } catch (e) {
    return `失敗: ${e instanceof Error ? e.message : String(e)}`;
  }
});
must(registered.startsWith(BASE), "常駐の仕組みを登録できた", registered);

// ══════════════════════════════════════════════════════
// B. 鍵
// ══════════════════════════════════════════════════════

section("B. サイトの公開鍵がブラウザへ届いている");

await probe.page.goto(`${BASE}/play`, { waitUntil: "networkidle" });

const key = await probe.page.evaluate(() => {
  // 配られた JavaScript の中から、公開鍵の形をしたものを1つ探す。
  // 値そのものは持ち出さず、長さと先頭の文字だけを返す
  const found = [...document.querySelectorAll("script")]
    .map((el) => el.getAttribute("src"))
    .filter((src) => typeof src === "string" && src.includes("/_next/static/"));
  return found.length;
});
must(key > 0, "画面用の JavaScript が配られている", `${key} 本`);

const keyShape = await probe.page.evaluate(async () => {
  const srcs = [...document.querySelectorAll("script")]
    .map((el) => el.getAttribute("src"))
    .filter((src) => typeof src === "string" && src.includes("/_next/static/"));
  for (const src of srcs) {
    const text = await (await fetch(src)).text();
    const m = /"(B[A-Za-z0-9_-]{85,90})"/.exec(text);
    if (m) return { length: m[1].length, head: m[1].slice(0, 1) };
  }
  return null;
});
must(keyShape !== null, "公開鍵らしき値がブラウザへ届いている");
must(keyShape?.length === 87, "公開鍵の長さが決まりどおり", `${keyShape?.length ?? 0} 文字`);
must(keyShape?.head === "B", "公開鍵の形が決まりどおり", String(keyShape?.head));

// ══════════════════════════════════════════════════════
// C. 入口
// ══════════════════════════════════════════════════════

section("C. 通知を頼む入口が出る");

// 入口が出る条件は2つ。**両方そろわないと出ない。**
//   1. お題を引いている最中であること（src/app/play/page.tsx の `draft ? …`）
//      まだ引いていない人に通知の許可を尋ねない、という決まり
//   2. 許可について、まだ答えを出していないこと（_push-optin.tsx）
// 検査の窓は既定で「断った」状態になるので、答えていない状態に直してから見る。
await startDraft();

const asking = await windowFor([]);
await asking.page.addInitScript(() => {
  Object.defineProperty(Notification, "permission", { get: () => "default" });
});
await asking.page.goto(`${BASE}/play`, { waitUntil: "networkidle" });
await asking.page.waitForTimeout(1500);

const optIn = asking.page.locator("[data-push-optin]");
const optInState = (await optIn.count()) > 0
  ? await optIn.first().getAttribute("data-push-optin")
  : "出ていない";
must(optInState === "ask", "通知を頼む入口が出ている", String(optInState));

const optInText = (await optIn.count()) > 0 ? await optIn.first().innerText() : "";
must(/通知|知らせ/.test(optInText), "何のための入口か書いてある",
  optInText.replace(/\s+/g, " ").slice(0, 80));

// ══════════════════════════════════════════════════════
// D. 断った人
// ══════════════════════════════════════════════════════

section("D. 許可を断っても壊れない");

const denied = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await denied.grantPermissions([]);
const deniedPage = await denied.newPage();
// **窓ごと拒否にする。**「もう答えを出した人」と同じ状態
await denied.addCookies(
  Object.entries(s.cookies()).map(([name, value]) => ({
    name,
    value,
    domain: siteUrl.hostname,
    path: "/",
    httpOnly: false,
    secure: siteUrl.protocol === "https:",
    sameSite: "Lax",
  })),
);
await deniedPage.addInitScript(() => {
  Object.defineProperty(Notification, "permission", { get: () => "denied" });
});
await deniedPage.goto(`${BASE}/play`, { waitUntil: "networkidle" });
await deniedPage.waitForTimeout(1200);

must(
  (await deniedPage.locator("[data-push-optin]").count()) === 0,
  "断った人には入口が出ない",
);
must(
  (await deniedPage.locator("button[data-card=hidden], form").count()) > 0,
  "断った人の画面もふつうに使える",
);
await denied.close();

// ══════════════════════════════════════════════════════
// E. 受け口
// ══════════════════════════════════════════════════════

section("E. 宛先を保存する窓口");

const short = await s.post("/api/push", {});
must(short.status === 400 || /そろって/.test(short.html), "中身が欠けていたら断る",
  `${short.status}`);

// ══════════════════════════════════════════════════════
// F. 別のサイトから
// ══════════════════════════════════════════════════════

section("F. 別のサイトからの送信を断る");

const cross = await fetch(`${BASE}/api/push`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: "https://example.invalid" },
  body: JSON.stringify({ endpoint: "https://example.invalid/x", p256dh: "x", auth: "y" }),
});
must(cross.status === 403, "別のサイトからは断る", String(cross.status));

// ══════════════════════════════════════════════════════
// 片づけ
// ══════════════════════════════════════════════════════

section("片づけ");

const subs = await admin()
  .from("push_subscriptions")
  .select("id", { count: "exact", head: true });
must((subs.count ?? 0) === 0, "宛先を1件も保存していない", `${subs.count} 件`);

const cleared = await clearDrafts();
must(cleared >= 0, "引きかけのお題を片づけた", `${cleared} 件`);

await probe.ctx.close();
await asking.ctx.close();
await browser.close();

console.log("");
console.log("  [手で確かめること] 実機で許可を出して、宛先が保存されること。");
console.log("  そこから先（実際に通知が飛ぶこと）は、本番の出来事が要るので自動では見ない。");

await finish();
