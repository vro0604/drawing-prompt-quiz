#!/usr/bin/env node
/**
 * smoke-consent.mjs ／ 同意の関門を本番で1周する（P5）
 *
 * 【なぜ要るか】
 *   2026-09-10 の本番切り替えで、同意の関門が入った。以後、
 *   いまの版に同意していない登録者は、次に開いたときに /consent へ送られる。
 *   **ここが動かないと、その人はサイトのどこにも入れない。**
 *   手元の試験は擬似の Supabase を相手にしているので、本物の
 *   `consent_status` / `agree_to_documents` を通した確認が別に要る。
 *
 * 【何を通すか】
 *   1. まだ同意していない登録者を用意する（使い捨て）
 *   2. サインインする。**このときは同意を押さない**
 *   3. 守られている画面（/play）へ行くと /consent へ送られる
 *   4. いまの版の規約とポリシーが画面に出ている
 *   5. 同意する
 *   6. 保存される（consent_status が「要らない」に変わる）
 *   7. もとの画面へ戻れる
 *   8. 同じセッションでもう一度開いても、二度と止められない
 *   9. /consent を開き直すと、用が無いのでトップへ戻される
 *
 * 【本番に何を残すか】
 *   使い捨ての登録者を1人作る。作品もお題も作らない。
 *   後片づけは `npm run smoke:fixtures:purge` が拾う（メールの形で選ぶ）。
 *   **同意の記録は消さない。**利用者を消すと記録から識別子が外れる作りで
 *   （terms_agreements.user_id は ON DELETE SET NULL）、
 *   これは規約12条・ポリシー5条に書いてある扱いそのもの。
 *   本物の利用者の同意記録には触れない。
 *
 * 【使い方】
 *   SMOKE_BASE_URL=https://<本番> npm run smoke:prod -- consent
 */

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

import {
  BASE,
  finish,
  forms,
  isConsentGate,
  must,
  section,
  targetEnv,
  textOf,
  throwawaySession,
} from "./_smoke-http.mjs";

console.log(`\n接続先: ${BASE}`);

const env = targetEnv();

/**
 * その人自身として `consent_status()` を読む。
 *
 * **画面のふるまいだけでなく、判定そのものを見る。**
 * 止める・止めないを決めているのは DB のこの関数で、画面はそれに従うだけ。
 * 食い違ったときにどちらが違うのかを言えるようにしておく。
 */
async function consentStatusOf(email, password) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("接続先と公開鍵がありません（npm run smoke:prod で実行してください）。");

  const c = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error: signInError } = await c.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`検査用の利用者でサインインできません: ${signInError.message}`);

  const { data, error } = await c.rpc("consent_status");
  if (error) throw new Error(`consent_status を読めません: ${error.message}`);
  return data;
}

/** 守られている画面。ここが関門の手前で止まる */
const GUARDED = "/works/new";

/**
 * 入口で requireConsent() を呼んでいる画面のうち、
 * **通信だけで送り先を見分けられるもの。**
 *
 * 出所は src/app 以下の page.tsx にある requireConsent の呼び出し箇所。
 */
const GUARDED_PATHS = ["/works/new", "/works/import"];

/**
 * 同じく守られているが、**流し込みで描く**画面。
 *
 * 【なぜ分けるか】
 *   この3つには loading.tsx があり、本文を少しずつ送りながら描く。
 *   途中まで送ったあとで送り先を変えることはできないので、
 *   Next.js は「どこへ行くか」を本文の中に混ぜて渡し、ブラウザが動く。
 *   **通信の応答だけを見ると 200 のまま**で、送り先が変わったと分からない。
 *   だからここはブラウザで見る。通信で見て「素通りした」と書くのは誤り。
 *   （2026-09-10 に一度そう書きかけた。出所: src/app/play/loading.tsx ほか2つ）
 */
const STREAMED_GUARDED_PATHS = ["/play", "/saves", "/works"];

/** その人の Cookie を持ったブラウザの頁を1つ作る */
async function browserPage(s) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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

/** ブラウザでその画面を開き、落ち着いた先の道筋を返す */
async function landingOf(page, path) {
  await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 45000 });
  await page
    .waitForFunction(() => !(document.querySelector("main")?.innerText ?? "").includes("読み込み中"), { timeout: 15000 })
    .catch(() => {});
  return new URL(page.url()).pathname;
}

const siteUrl = new URL(BASE);
const browser = await chromium.launch();

// ══════════════════════════════════════════════════════
// 1. まだ同意していない登録者
// ══════════════════════════════════════════════════════

section("1. まだ同意していない登録者を用意する");

// consent:false ——「サインインしたら押しておく」を、この検査だけは止める。
// 押す前の状態を見たいのがこの検査の本題なので。
const { session: user, email, password } = await throwawaySession("consent", { consent: false });
must(!!email, "使い捨ての登録者を作れた", email.replace(/@.*/, "@…"));

const before = await consentStatusOf(email, password);
must(before?.is_anonymous === false, "登録者として見えている");
must(before?.needs_consent === true, "まだ同意が要る状態", JSON.stringify(before?.needs_consent));
must(before?.gate_required === true, "関門の対象になっている",
  `gate_required=${before?.gate_required} / セッション開始 ${before?.session_started_at ?? "読めず"}`);

// ══════════════════════════════════════════════════════
// 2. 守られている画面へ行くと、関門へ送られる
// ══════════════════════════════════════════════════════

section("2. 守られている画面が関門へ送る");

// 入口で requireConsent() を呼んでいる画面を全部見る。
// **1つでも通れてしまうと、関門は無いのと同じ。**
for (const path of GUARDED_PATHS) {
  const res = await user.get(path);
  must(res.path.startsWith("/consent"), `${path} から /consent へ送られた`,
    `${res.path}（${res.status}）`);
}

const blocked = await user.get(GUARDED);
must(isConsentGate(blocked.html), "関門の画面が出ている");

// 流し込みで描く画面は、ブラウザで見ないと送り先が分からない
const beforeBrowser = await browserPage(user);
for (const path of STREAMED_GUARDED_PATHS) {
  const landed = await landingOf(beforeBrowser.page, path);
  must(landed === "/consent", `${path} から /consent へ送られた（ブラウザ）`, landed);
}
await beforeBrowser.ctx.close();

// ══════════════════════════════════════════════════════
// 3. いまの版が画面に出ている
// ══════════════════════════════════════════════════════

section("3. いまの版の規約とポリシーが出ている");

const gate = await user.get("/consent");
const gateText = textOf(gate.html);

must(/利用規約への同意/.test(gateText), "見出しが出ている");
must(/利用規約を読む/.test(gateText), "規約の本文が畳んで置いてある");
must(/プライバシーポリシーを読む/.test(gateText), "ポリシーの本文が畳んで置いてある");

const form = forms(gate.html).find((f) => /同意して続ける/.test(f.text));
must(!!form?.actionId, "同意のボタンが出ている");

const termsVersion = form?.fields?.termsVersion ?? "";
const privacyVersion = form?.fields?.privacyVersion ?? "";
must(/^\d{4}-\d{2}-\d{2}$/.test(termsVersion), "規約の版が入っている", termsVersion);
must(/^\d{4}-\d{2}-\d{2}$/.test(privacyVersion), "ポリシーの版が入っている", privacyVersion);
must(gateText.includes(termsVersion), "画面にも版が出ている", termsVersion);

// 同意しない道が塞がれていないこと。閉じ込める画面にしない決まり
must(/サインアウト|アカウントの画面/.test(gateText), "サインアウトへの行き先がある");
must(/退会/.test(gateText), "退会への行き先がある");

// ══════════════════════════════════════════════════════
// 4. 同意する
// ══════════════════════════════════════════════════════

section("4. 同意して先へ進む");

const agreed = await user.post("/consent", {
  [form.actionId]: "",
  ...form.fields,
});

must(!isConsentGate(agreed.html), "同意したあとは関門の画面ではない", agreed.path);
must(!agreed.path.startsWith("/consent"), "関門から出られた", agreed.path);

// ══════════════════════════════════════════════════════
// 5. 記録されている
// ══════════════════════════════════════════════════════

section("5. 同意が記録されている");

const after = await consentStatusOf(email, password);
must(after?.terms_agreed === true, "規約への同意が記録された");
must(after?.privacy_agreed === true, "ポリシーへの同意が記録された");
must(after?.needs_consent === false, "もう同意は要らない");
must(after?.gate_required === false, "もう関門の対象ではない");

for (const path of GUARDED_PATHS) {
  const res = await user.get(path);
  must(!res.path.startsWith("/consent"), `${path} へ入れる`, `${res.path}（${res.status}）`);
}

const afterBrowser = await browserPage(user);
for (const path of STREAMED_GUARDED_PATHS) {
  const landed = await landingOf(afterBrowser.page, path);
  must(landed === path, `${path} へ入れる（ブラウザ）`, landed);
}
await afterBrowser.ctx.close();

const again = await user.get(GUARDED);
must(!isConsentGate(again.html), "関門の画面ではない");

// ══════════════════════════════════════════════════════
// 6. 同じセッションで二度と止められない
// ══════════════════════════════════════════════════════

section("6. 同じセッションで二度目は止められない");

for (const path of ["/", "/works", "/notices", "/account"]) {
  const res = await user.get(path);
  must(!res.path.startsWith("/consent"), `${path} で止められない`, res.path);
}

// 用が無くなった関門を開くと、行き先を失わせずトップへ戻す
const revisit = await user.get("/consent");
must(!isConsentGate(revisit.html), "同意済みで /consent を開くと関門は出ない", revisit.path);
must(revisit.path === "/", "トップへ戻される", revisit.path);

await browser.close();

console.log("");
console.log("  [控え] この検査が本番へ残したもの: 使い捨ての登録者 1 人");
console.log("         作品・お題・回答は作っていません。");
console.log("         登録者は npm run smoke:fixtures:purge で消せます。");

await finish();
