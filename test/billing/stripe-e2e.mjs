/**
 * stripe-e2e.mjs ／ 課金 v0 を、D201 の8段の順に手元で一周させる
 *
 * 実行:
 *   npm run test:billing:stripe                  … 手元で署名した知らせを使う（Stripe へは通信しない）
 *   npm run test:billing:stripe -- --mode stripe … Stripe のテストモードへ実際に通信する
 *
 * 【どこにつながるか】
 *   アプリ … この端末の next dev（test/e2e/server.mjs の startApp）
 *   DB    … この端末の PGlite ＋ Supabase の代わりの小さな API（本番の Supabase へは行かない）
 *   Stripe … --mode stripe のときだけ api.stripe.com と checkout.stripe.com。
 *           知らせは Stripe CLI の `stripe listen` が手元のアプリへ転送する
 *
 * 【販売を開けるのは、この端末の DB だけ】
 *   founding_creator_v0 の is_active を true にするのは PGlite の中だけ。
 *   本番の DB へは接続しない（接続先が 127.0.0.1 以外なら始める前に止まる）。
 *
 * 【--mode stripe の鍵】
 *   macOS のキーチェーンの drawing-prompt-quiz-stripe-test-secret-key から読む。
 *   sk_test_ / rk_test_ で始まらない鍵、または Stripe が livemode=true と答えた鍵なら、
 *   何も作らずに止まる。鍵の値は画面にもファイルにも出さない。
 *   知らせの署名の鍵は `stripe listen --print-secret` が出すものを使う（Dashboard に受け口を作らない）。
 *   Stripe CLI は STRIPE_CLI（既定: PATH の stripe）。
 *
 * 【--mode local で置き換えるもの】
 *   1段目（決済ページを作る）と2段目（テストカードで払う）は Stripe が要るので、
 *   DB の関数で予約・顧客・決済ページの ID を記録して代わりにする。
 *   3段目以降の知らせは、Stripe と同じ形・同じ署名の手順で手元が作って、本物の受け口へ送る。
 *   **これは Stripe との通信の証拠にならない。**受け口と DB の確かめにだけ使う。
 */

import { createHmac, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chromium } from "playwright";
import { inspectEnvironment } from "../guard/no-production.mjs";
import { startApp } from "../e2e/server.mjs";
import { acquireHeavyLock } from "../e2e/exclusive.mjs";
import { asRole } from "../db/harness.mjs";

const MODE = process.argv.includes("--mode") ? process.argv[process.argv.indexOf("--mode") + 1] : "local";
if (!["local", "stripe"].includes(MODE)) {
  console.error(`--mode は local か stripe です（${MODE}）`);
  process.exit(2);
}
const STRIPE = MODE === "stripe";
const API_VERSION = "2026-08-26.dahlia";
const OFFER = "founding_creator_v0";
const EVENTS = [
  "checkout.session.completed",
  "checkout.session.expired",
  "refund.created",
  "refund.updated",
  "refund.failed",
  "charge.dispute.created",
  "charge.dispute.closed",
];

/* ---------------------------------------------------------------------------
 * 判定と記録
 * ------------------------------------------------------------------------- */

const results = [];
function check(stage, label, ok, note = "") {
  results.push({ stage, label, ok: Boolean(ok), note });
  console.log(`  ${ok ? "✓" : "✗"} [${stage}] ${label}${note ? `  ${note}` : ""}`);
  return Boolean(ok);
}
const section = (t) => console.log(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(what, fn, { timeoutMs = 60_000, everyMs = 500 } = {}) {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error(`${what} が ${timeoutMs}ms 以内に起きませんでした`);
    await sleep(everyMs);
  }
}

/* ---------------------------------------------------------------------------
 * 始める前の安全確認（Stripe へ最初に通信する前）
 * ------------------------------------------------------------------------- */

function readKeychain(service) {
  try {
    return execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

const envProblems = inspectEnvironment(process.env);
if (envProblems.length > 0) {
  console.error("本番の痕跡が環境にあります。止めます:");
  for (const p of envProblems) console.error(`  ・${p}`);
  process.exit(70);
}

let stripeKey = "";
let webhookSecret = `whsec_local_${randomUUID().replace(/-/g, "")}`;
let listener = null;
const stripeCli = process.env.STRIPE_CLI || "stripe";

async function stripeApi(method, path, form = null) {
  const body = form ? new URLSearchParams(form).toString() : undefined;
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      "Stripe-Version": API_VERSION,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Stripe ${method} ${path} → ${res.status} ${json.error?.code ?? ""} ${json.error?.message ?? ""}`);
  return json;
}

if (STRIPE) {
  section("0. Stripe へ通信する前の確認");
  stripeKey = readKeychain("drawing-prompt-quiz-stripe-test-secret-key");
  if (!stripeKey) {
    console.error("キーチェーンに drawing-prompt-quiz-stripe-test-secret-key がありません。docs/billing-stripe-test.md の 2 を済ませてください。");
    process.exit(78);
  }
  if (!/^(sk|rk)_test_/.test(stripeKey)) {
    console.error("鍵がテストモードの形（sk_test_ / rk_test_）ではありません。本番の鍵の可能性があるので止めます。");
    process.exit(78);
  }
  check("0", "鍵はテストモードの形（sk_test_ / rk_test_ で始まる）", true);
  // ここが Stripe への最初の通信。読むだけで何も作らない
  const balance = await stripeApi("GET", "/balance");
  if (balance.livemode !== false) {
    console.error("Stripe が livemode=true と答えました。止めます。");
    process.exit(78);
  }
  check("0", "Stripe がこの鍵を livemode=false と答えた（読むだけの呼び出し）", true);
  try {
    execFileSync(stripeCli, ["version"], { stdio: "ignore" });
  } catch {
    console.error(`Stripe CLI（${stripeCli}）が動きません。STRIPE_CLI にパスを渡してください。`);
    process.exit(78);
  }
  webhookSecret = execFileSync(stripeCli, ["listen", "--print-secret"], {
    encoding: "utf8",
    env: { ...process.env, STRIPE_API_KEY: stripeKey },
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  check("0", "stripe listen の署名の鍵を受け取った（whsec_ で始まる）", /^whsec_/.test(webhookSecret));
}

// アプリへ渡す。**値は表示しない**
process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
if (STRIPE) process.env.STRIPE_SECRET_KEY = stripeKey;
else delete process.env.STRIPE_SECRET_KEY;

const PORT = 3217;
const lock = await acquireHeavyLock(`課金の一周（${MODE}）`);
const app = await startApp({ port: PORT });
const db = app.db;
const BASE = app.base;
const browser = await chromium.launch();

check("0", "アプリは手元（127.0.0.1）で動いている", new URL(BASE).hostname === "127.0.0.1", BASE);
check("0", "アプリがつなぐ Supabase は手元の代わり（127.0.0.1）", new URL(app.mock.url).hostname === "127.0.0.1", app.mock.url);

/* ---------------------------------------------------------------------------
 * 手元の DB での準備
 * ------------------------------------------------------------------------- */

const SVC = { role: "service_role", uid: null };
const svc = (sql, params = []) =>
  asRole(db, SVC, async (c) => {
    const r = await c.query(sql, params);
    return r.rows[0] ? Object.values(r.rows[0])[0] : null;
  });
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0] ?? null;
const all = async (sql, params = []) => (await db.query(sql, params)).rows;

async function makeBuyer(tag) {
  const email = `billing-${tag}-${Date.now()}@example.com`;
  const { rows } = await db.query(`insert into auth.users (email, is_anonymous) values ($1, false) returning id`, [email]);
  const id = rows[0].id;
  const handle = `buyer-${tag}-${Math.random().toString(36).slice(2, 7)}`;
  await db.query(`update public.profiles set handle = $2, display_name = $3 where id = $1`, [id, handle, `購入者${tag}`]);
  const v = await one(`select (select version from public.terms_versions where is_current) t, (select version from public.privacy_versions where is_current) p`);
  await asRole(db, { role: "authenticated", uid: id, isAnonymous: false }, (c) =>
    c.query(`select public.agree_to_documents($1, $2)`, [v.t, v.p]),
  );
  return { id, email, handle, name: `購入者${tag}` };
}

async function signIn(email) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ja-JP" });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/account`);
  const form = "form:has(button:has-text('サインインする'))";
  await page.locator(`${form} input[name=email]`).fill(email);
  await page.locator(`${form} input[name=password]`).fill("dummy-password");
  await page.getByRole("button", { name: "サインインする" }).click();
  await page.waitForLoadState("networkidle");
  return { ctx, page };
}

/** ブラウザと同じ Cookie で受け口を叩く（連打・競合の試験用） */
async function postCheckoutAs(ctx) {
  const cookie = (await ctx.cookies(BASE)).map((c) => `${c.name}=${c.value}`).join("; ");
  const res = await fetch(`${BASE}/api/billing/checkout`, {
    method: "POST",
    headers: { cookie, origin: BASE, "content-type": "application/json" },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const purchaseOf = (profileId) =>
  all(`select id, status, founder_number, stripe_checkout_session_id sid, stripe_payment_intent_id pi,
              stripe_refund_id rid, founder_public, paid_at, refunded_at
         from public.billing_purchases where profile_id = $1 order by created_at`, [profileId]);
const entitlementsOf = (profileId) =>
  all(`select entitlement_key k, revoked_at from public.billing_entitlements where profile_id = $1 order by k`, [profileId]);
const offerStatus = () => asRole(db, { role: "anon", uid: null }, async (c) => (await c.query(`select public.get_founder_offer_status($1) s`, [OFFER])).rows[0].s);
const counts = () => one(`select (select count(*)::int from public.billing_purchases) purchases,
  (select count(*)::int from public.billing_entitlements) entitlements,
  (select count(*)::int from public.billing_customers) customers,
  (select count(*)::int from public.billing_webhook_events) events`);

/* ---------------------------------------------------------------------------
 * 知らせ（手元で作る場合と、再送・偽物の試験に使う）
 * ------------------------------------------------------------------------- */

const signFor = (payload, secret, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;

async function postWebhook(payload, header) {
  const res = await fetch(`${BASE}/api/billing/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(header ? { "stripe-signature": header } : {}) },
    body: payload,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function localEvent(type, object) {
  return JSON.stringify({
    id: `evt_local_${randomUUID().replace(/-/g, "")}`,
    object: "event",
    api_version: API_VERSION,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    type,
    data: { object },
  });
}

/* ---------------------------------------------------------------------------
 * 1段目の前: 販売を開けるのは、この DB だけ
 * ------------------------------------------------------------------------- */

let exitCode = 0;
const cleanupStripe = { sessions: new Set(), customers: new Set() };

try {
  section("準備: 手元の DB でだけ販売を開ける");
  const before = await one(`select is_active, amount, currency, sales_cap from public.billing_offers where code = $1`, [OFFER]);
  check("準備", "手元の DB の商品は、最初は販売停止（migration の既定）", before?.is_active === false, JSON.stringify(before));
  await db.query(`update public.billing_offers set is_active = true where code = $1`, [OFFER]);
  const st0 = await offerStatus();
  check("準備", "手元の DB でだけ販売中になった（3,000円・jpy・30枠・残り30）", st0.is_open && st0.amount === 3000 && st0.currency === "jpy" && st0.sales_cap === 30 && st0.remaining === 30, JSON.stringify({ is_open: st0.is_open, remaining: st0.remaining }));

  if (STRIPE) {
    listener = spawn(stripeCli, ["listen", "--latest", "--forward-to", `${BASE}/api/billing/webhook`, "--events", EVENTS.join(",")], {
      env: { ...process.env, STRIPE_API_KEY: stripeKey },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ready = new Promise((resolve) => {
      const onData = (d) => { if (/Ready!/.test(d.toString())) resolve(true); };
      listener.stdout.on("data", onData);
      listener.stderr.on("data", onData);
    });
    await Promise.race([ready, sleep(30_000)]);
    check("準備", "stripe listen が手元の受け口へ転送を始めた", listener.exitCode === null);
  }

  const buyer = await makeBuyer("a");
  const buyerB = await makeBuyer("b");

  /* ---------------- 1段目: /founder から決済ページを作る ---------------- */
  section("1段目: /founder から決済ページを作る");
  const A = await signIn(buyer.email);
  await A.page.goto(`${BASE}/founder`);
  const buyBtn = A.page.getByRole("button", { name: "Founding Creator を購入する" });
  check("1", "登録済み・同意済みの人には購入のボタンが出る", (await buyBtn.count()) === 1);

  let sessionId = null;
  let paymentIntent = null;
  if (STRIPE) {
    const checkoutAnswers = [];
    A.page.on("response", (r) => {
      if (new URL(r.url()).pathname === "/api/billing/checkout") {
        checkoutAnswers.push(r.text().then((t) => `${r.status()} ${t.replace(/https:\/\/checkout\.stripe\.com\S*/g, "<決済ページの URL>").slice(0, 300)}`).catch(() => `${r.status()}`));
      }
    });
    await buyBtn.click();
    try {
      await A.page.waitForURL(/checkout\.stripe\.com/, { timeout: 60_000 });
    } catch (e) {
      const answers = await Promise.all(checkoutAnswers);
      const logs = app.logs.join("").split("\n").filter((l) => /billing|STRIPE|Error|error/.test(l)).slice(-15).join("\n");
      throw new Error(`決済ページへ移らなかった。受け口の答え: ${answers.join(" / ") || "（無し）"}\n画面: ${(await A.page.locator("main").innerText()).slice(0, 300)}\nサーバー: ${logs}\n${e.message}`);
    }
    check("1", "Stripe の決済ページへ移った", /checkout\.stripe\.com/.test(A.page.url()), new URL(A.page.url()).host);
    const p = await purchaseOf(buyer.id);
    sessionId = p[0]?.sid ?? null;
    check("1", "billing_purchases に reserved が1行、決済ページの ID が入った", p.length === 1 && p[0].status === "reserved" && /^cs_test_/.test(sessionId ?? ""), `${p.length}行 ${p[0]?.status} ${sessionId?.slice(0, 12)}…`);
    cleanupStripe.sessions.add(sessionId);
    const cus = await one(`select stripe_customer_id c from public.billing_customers where profile_id = $1`, [buyer.id]);
    if (cus) cleanupStripe.customers.add(cus.c);
    const s = await stripeApi("GET", `/checkout/sessions/${sessionId}`);
    check("1", "Stripe 側の決済ページ: 未払い・買い切り・3000・jpy・metadata に購入の ID", s.status === "open" && s.payment_status === "unpaid" && s.mode === "payment" && s.amount_total === 3000 && s.currency === "jpy" && s.metadata?.purchase_id === p[0].id && s.livemode === false, `${s.status}/${s.payment_status}/${s.amount_total}${s.currency}`);

    /* ---------------- 2段目: テストカードで払う ---------------- */
    section("2段目: 3,000円をテストカード（4242…）で払う");
    const pg = A.page;
    await pg.locator("#cardNumber").waitFor({ timeout: 60_000 });
    await pg.locator("#cardNumber").fill("4242424242424242");
    await pg.locator("#cardExpiry").fill("12 / 34");
    await pg.locator("#cardCvc").fill("123");
    if (await pg.locator("#billingName").count()) await pg.locator("#billingName").fill("Billing Test");
    const submit = pg.locator('[data-testid="hosted-payment-submit-button"], button.SubmitButton').first();
    await submit.click();
    await pg.waitForURL(`${BASE}/founder?paid=1**`, { timeout: 120_000 });
    check("2", "支払い後に /founder?paid=1 へ戻った", pg.url().startsWith(`${BASE}/founder?paid=1`));
    const paid = await stripeApi("GET", `/checkout/sessions/${sessionId}`);
    paymentIntent = paid.payment_intent;
    check("2", "Stripe 側で payment_status = paid・3000・jpy", paid.payment_status === "paid" && paid.amount_total === 3000 && paid.currency === "jpy", `${paid.status}/${paid.payment_status}`);
  } else {
    // Stripe を呼ばずに、受け口が作るのと同じ記録を DB の関数で作る
    const r = await svc(`select public.billing_reserve_slot($1, $2)`, [buyer.id, OFFER]);
    const cus = await svc(`select public.billing_upsert_customer($1, $2)`, [buyer.id, `cus_local${Date.now()}`]);
    sessionId = `cs_test_local${Date.now()}`;
    await svc(`select public.billing_attach_checkout($1, $2, $3, now() + interval '30 minutes')`, [r.purchase_id, cus.billing_customer_id, sessionId]);
    paymentIntent = `pi_local${Date.now()}`;
    const p = await purchaseOf(buyer.id);
    check("1", "（代わり）billing_purchases に reserved が1行、決済ページの ID が入った", p.length === 1 && p[0].status === "reserved" && p[0].sid === sessionId);
    check("2", "（代わり）支払いは行わない。Stripe が必要", true, "Stripe へ通信しない形では確かめられない");
  }

  const slotBefore = await offerStatus();

  /* ---------------- 3段目: 知らせが届く ---------------- */
  section("3段目: checkout.session.completed が届く");
  const purchaseA = (await purchaseOf(buyer.id))[0];
  let completedPayload = null;
  if (!STRIPE) {
    completedPayload = localEvent("checkout.session.completed", {
      id: sessionId, object: "checkout.session", mode: "payment", payment_status: "paid", status: "complete",
      amount_total: 3000, currency: "jpy", client_reference_id: purchaseA.id, payment_intent: paymentIntent,
      metadata: { purchase_id: purchaseA.id, profile_id: buyer.id, offer_code: OFFER },
    });
    const r = await postWebhook(completedPayload, signFor(completedPayload, webhookSecret));
    check("3", "受け口が 200 を返した", r.status === 200, JSON.stringify(r.body));
  }
  const evs = await waitUntil("完了の知らせの記録", async () => {
    const e = await all(`select stripe_event_id id, event_type type, api_version, livemode, processed_at from public.billing_webhook_events where object_id = $1 and event_type = 'checkout.session.completed'`, [sessionId]);
    return e.length > 0 && e.every((x) => x.processed_at) ? e : null;
  }, { timeoutMs: 90_000 });
  check("3", "billing_webhook_events に checkout.session.completed が1行（処理済み）", evs.length === 1, `${evs.length}行`);
  check("3", `api_version が ${API_VERSION}`, evs[0].api_version === API_VERSION, String(evs[0].api_version));
  check("3", "livemode = false", evs[0].livemode === false);

  /* ---------------- 4段目: 番号と権限 ---------------- */
  section("4段目: Founder 番号と権限が付く");
  const pA = (await purchaseOf(buyer.id))[0];
  check("4", "購入が paid・番号 1", pA.status === "paid" && pA.founder_number === 1, `${pA.status} #${pA.founder_number}`);
  if (STRIPE) check("4", "支払いの ID（pi_）が記録された", pA.pi === paymentIntent && /^pi_/.test(pA.pi ?? ""));
  const entA = await entitlementsOf(buyer.id);
  check("4", "権限は founding_creator と beta_access の2本（取り消しなし）", entA.length === 2 && entA[0].k === "beta_access" && entA[1].k === "founding_creator" && entA.every((e) => !e.revoked_at), JSON.stringify(entA.map((e) => e.k)));
  const slotAfterPay = await offerStatus();
  check("4", "残り枠は 29（予約の時点から変わらない）", slotAfterPay.used === 1 && slotAfterPay.remaining === 29 && slotBefore.remaining === 29, `${slotBefore.remaining} → ${slotAfterPay.remaining}`);
  if (STRIPE) {
    await A.page.goto(`${BASE}/founder`);
    await A.page.getByText("Founding Creator #001").waitFor({ timeout: 30_000 });
    check("4", "/founder に「Founding Creator #001」が出る", true);
  }

  /* ---------------- 二重処理 ---------------- */
  section("二重処理: 同じ知らせ・同じ決済ページ・買い終えた人");
  // stripe モードでは、Stripe に記録された同じ知らせ（同じ event ID）を取り寄せ、署名し直して送る（Stripe の再送と同じ形）
  const dupBase = STRIPE ? JSON.stringify(await stripeApi("GET", `/events/${evs[0].id}`)) : completedPayload;
  if (dupBase) {
    const again = await postWebhook(dupBase, signFor(dupBase, webhookSecret));
    check("二重", "同じ event ID の再送は duplicate として受け取り切る", again.status === 200 && again.body.duplicate === true, JSON.stringify(again.body));
  }
  // 別の event ID で、同じ決済ページの完了が来た（Stripe の再送とは別の、重複した知らせ）
  const sameSession = localEvent("checkout.session.completed", {
    id: sessionId, object: "checkout.session", mode: "payment", payment_status: "paid", status: "complete",
    amount_total: 3000, currency: "jpy", client_reference_id: purchaseA.id, payment_intent: pA.pi ?? paymentIntent,
    metadata: { purchase_id: purchaseA.id, profile_id: buyer.id, offer_code: OFFER },
  });
  const sameRes = await postWebhook(sameSession, signFor(sameSession, webhookSecret));
  check("二重", "同じ決済ページの完了が別の event ID で来ても、番号は増えない（already_granted）", sameRes.status === 200 && /already_granted #1/.test(sameRes.body.note ?? ""), JSON.stringify(sameRes.body));
  const afterDup = await counts();
  const entDup = await entitlementsOf(buyer.id);
  check("二重", "購入1行・権限2本のまま", (await purchaseOf(buyer.id)).length === 1 && entDup.length === 2, JSON.stringify(afterDup));
  const rebuy = await postCheckoutAs(A.ctx);
  check("二重", "買い終えた人が受け口を叩いても買えない", STRIPE ? rebuy.status === 409 && rebuy.body.code === "ALREADY_OWNED" : rebuy.status === 503, `${rebuy.status} ${rebuy.body.error ?? ""}`);

  /* ---------------- 5段目: 公開設定 ---------------- */
  section("5段目: 公開設定を切り替える");
  await A.page.goto(`${BASE}/founder`);
  await A.page.locator('[data-founder-visibility="to-public"]').click();
  await A.page.waitForURL(/notice=/, { timeout: 30_000 });
  const guest = await browser.newContext();
  const gp = await guest.newPage();
  await gp.goto(`${BASE}/founder/members`);
  let membersText = await gp.locator("main").innerText();
  check("5", "表示名を出すと、一覧に #001 と名前が出る", membersText.includes("#001") && membersText.includes(buyer.name), membersText.replace(/\s+/g, " ").slice(0, 120));
  await A.page.goto(`${BASE}/founder`);
  await A.page.locator('[data-founder-visibility="to-private"]').click();
  await A.page.waitForURL(/notice=/, { timeout: 30_000 });
  await gp.goto(`${BASE}/founder/members`);
  membersText = await gp.locator("main").innerText();
  check("5", "戻すと「匿名希望」になり、名前は出ない", membersText.includes("匿名希望") && !membersText.includes(buyer.name));

  /* ---------------- 6段目: 全額返金 ---------------- */
  section("6段目: 全額返金する");
  let refundId = null;
  if (STRIPE) {
    const refund = await stripeApi("POST", "/refunds", { payment_intent: pA.pi });
    refundId = refund.id;
    // Refund の物には livemode が無い。テストモードであることは 0 段目の balance で確かめてある
    check("6", "Stripe で全額返金を作った", /^re_/.test(refundId) && refund.amount === 3000 && refund.currency === "jpy", `${refund.status} ${refund.amount}${refund.currency}`);
  } else {
    refundId = `re_local${Date.now()}`;
    const created = localEvent("refund.created", { id: refundId, object: "refund", payment_intent: pA.pi ?? paymentIntent, status: "pending", amount: 3000, currency: "jpy" });
    const r1 = await postWebhook(created, signFor(created, webhookSecret));
    check("6", "（代わり）refund.created（pending）を受け取った", r1.status === 200, JSON.stringify(r1.body));
    const mid = (await purchaseOf(buyer.id))[0];
    // D201（2026-09-17 改定）: 途中で refund_pending を通ることがある。通ったときは権限を残す
    check("6", "返金が始まっただけの間は refund_pending（権限は残る）", mid.status === "refund_pending" && (await entitlementsOf(buyer.id)).every((e) => !e.revoked_at), mid.status);
    const updated = localEvent("refund.updated", { id: refundId, object: "refund", payment_intent: pA.pi ?? paymentIntent, status: "succeeded", amount: 3000, currency: "jpy" });
    const r2 = await postWebhook(updated, signFor(updated, webhookSecret));
    check("6", "（代わり）refund.updated（succeeded）を受け取った", r2.status === 200, JSON.stringify(r2.body));
    const dupRefund = await postWebhook(updated, signFor(updated, webhookSecret));
    check("6", "同じ返金の知らせの再送は duplicate", dupRefund.status === 200 && dupRefund.body.duplicate === true);
    const updated2 = localEvent("refund.updated", { id: refundId, object: "refund", payment_intent: pA.pi ?? paymentIntent, status: "succeeded", amount: 3000, currency: "jpy" });
    const r3 = await postWebhook(updated2, signFor(updated2, webhookSecret));
    check("6", "別の event ID で同じ返金の成立が来ても already_refunded", r3.status === 200 && /already_refunded/.test(r3.body.note ?? ""), JSON.stringify(r3.body));
  }
  const refunded = await waitUntil("返金の反映", async () => {
    const p = (await purchaseOf(buyer.id))[0];
    return p.status === "refunded" ? p : null;
  }, { timeoutMs: 120_000 });
  check("6", "購入が refunded・返金の ID が記録された", refunded.status === "refunded" && refunded.rid === refundId && refunded.refunded_at, refunded.status);
  if (STRIPE) await sleep(15_000); // refund.updated が遅れて届く場合に備えて待ってから数える
  const refundEvents = await all(`select event_type from public.billing_webhook_events where event_type like 'refund.%'`);
  check("6", "返金の知らせを1件以上受け取った", refundEvents.some((e) => e.event_type === "refund.created"), refundEvents.map((e) => e.event_type).join(","));
  // D201（2026-09-17 改定）: 途中の refund_pending は必須ではない。通った経路は事実として残すだけ
  console.log(`    （返金の知らせの順: ${refundEvents.map((e) => e.event_type).join(" → ")}）`);
  const entR = await entitlementsOf(buyer.id);
  check("6", "権限2本とも取り消された（行は残る）", entR.length === 2 && entR.every((e) => e.revoked_at), JSON.stringify(entR.map((e) => Boolean(e.revoked_at))));

  /* ---------------- 7段目: 欠番 ---------------- */
  section("7段目: 欠番になる");
  await gp.goto(`${BASE}/founder/members`);
  membersText = await gp.locator("main").innerText();
  check("7", "一覧で #001 が「欠番」", /#001[\s\S]{0,20}欠番/.test(membersText), membersText.replace(/\s+/g, " ").slice(0, 120));
  check("7", "返金した番号は購入の行に残る（消さない）", refunded.founder_number === 1);

  /* ---------------- 8段目: 枠が戻る ---------------- */
  section("8段目: 枠が戻り、同じ人がもう一度買える");
  const slotAfterRefund = await offerStatus();
  check("8", "used が1つ減り、remaining が1つ増えた", slotAfterRefund.used === slotAfterPay.used - 1 && slotAfterRefund.remaining === slotAfterPay.remaining + 1, `used ${slotAfterPay.used}→${slotAfterRefund.used} / remaining ${slotAfterPay.remaining}→${slotAfterRefund.remaining}`);
  if (STRIPE) {
    const re = await postCheckoutAs(A.ctx);
    check("8", "同じ人がもう一度、決済ページを作れる", re.status === 200 && /checkout\.stripe\.com/.test(re.body.url ?? ""), String(re.status));
    const rows = await purchaseOf(buyer.id);
    const live = rows.find((r) => r.status === "reserved");
    if (live?.sid) cleanupStripe.sessions.add(live.sid);
    check("8", "新しい購入の行が reserved（返金した行はそのまま）", rows.length === 2 && rows[0].status === "refunded" && live, rows.map((r) => r.status).join(","));
  } else {
    const r = await svc(`select public.billing_reserve_slot($1, $2)`, [buyer.id, OFFER]);
    check("8", "（代わり）同じ人がもう一度、枠を押さえられる", r.result === "reserved", r.result);
  }

  /* ---------------- 番号の再利用なし（2人目） ---------------- */
  section("番号の再利用なし: 2人目が買う");
  let sessionB;
  if (STRIPE) {
    const B = await signIn(buyerB.email);
    const res = await postCheckoutAs(B.ctx);
    check("番号", "2人目の決済ページを作れた", res.status === 200, String(res.status));
    sessionB = (await purchaseOf(buyerB.id))[0].sid;
    cleanupStripe.sessions.add(sessionB);
    const cusB = await one(`select stripe_customer_id c from public.billing_customers where profile_id = $1`, [buyerB.id]);
    if (cusB) cleanupStripe.customers.add(cusB.c);
    await B.page.goto(res.body.url);
    await B.page.locator("#cardNumber").waitFor({ timeout: 60_000 });
    await B.page.locator("#cardNumber").fill("4242424242424242");
    await B.page.locator("#cardExpiry").fill("12 / 34");
    await B.page.locator("#cardCvc").fill("123");
    if (await B.page.locator("#billingName").count()) await B.page.locator("#billingName").fill("Billing Test B");
    await B.page.locator('[data-testid="hosted-payment-submit-button"], button.SubmitButton').first().click();
    await B.page.waitForURL(`${BASE}/founder?paid=1**`, { timeout: 120_000 });
  } else {
    const r = await svc(`select public.billing_reserve_slot($1, $2)`, [buyerB.id, OFFER]);
    const cus = await svc(`select public.billing_upsert_customer($1, $2)`, [buyerB.id, `cus_localb${Date.now()}`]);
    sessionB = `cs_test_localb${Date.now()}`;
    await svc(`select public.billing_attach_checkout($1, $2, $3, now() + interval '30 minutes')`, [r.purchase_id, cus.billing_customer_id, sessionB]);
    const ev = localEvent("checkout.session.completed", {
      id: sessionB, object: "checkout.session", mode: "payment", payment_status: "paid", status: "complete",
      amount_total: 3000, currency: "jpy", client_reference_id: r.purchase_id, payment_intent: `pi_localb${Date.now()}`,
      metadata: { purchase_id: r.purchase_id, profile_id: buyerB.id, offer_code: OFFER },
    });
    await postWebhook(ev, signFor(ev, webhookSecret));
  }
  const pB = await waitUntil("2人目の確定", async () => {
    const p = (await purchaseOf(buyerB.id))[0];
    return p?.status === "paid" ? p : null;
  }, { timeoutMs: 90_000 });
  check("番号", "2人目の番号は #002（#001 を付け直さない）", pB.founder_number === 2, `#${pB.founder_number}`);
  const numbers = await all(`select founder_number n, count(*)::int c from public.billing_purchases where founder_number is not null group by 1 having count(*) > 1`);
  check("番号", "番号の重複は0", numbers.length === 0);

  /* ---------------- 不正な知らせ ---------------- */
  section("不正な知らせ（本物の署名の鍵で動いている受け口へ）");
  const fake = localEvent("checkout.session.completed", {
    id: sessionB, object: "checkout.session", mode: "payment", payment_status: "paid", amount_total: 3000, currency: "jpy",
    metadata: { purchase_id: pB.id, offer_code: OFFER },
  });
  const eventsBefore = (await counts()).events;
  const bad = [
    ["署名なし", await postWebhook(fake, null), /SIGNATURE_MISSING/],
    ["違う鍵の署名", await postWebhook(fake, signFor(fake, "whsec_not_the_real_one")), /SIGNATURE_INVALID/],
    ["古すぎる署名（10分前）", await postWebhook(fake, signFor(fake, webhookSecret, Math.floor(Date.now() / 1000) - 600)), /SIGNATURE_TOO_OLD/],
    ["本文の改変（署名のあとで金額を書き換え）", await postWebhook(fake.replace('"amount_total":3000', '"amount_total":1'), signFor(fake, webhookSecret)), /SIGNATURE_INVALID/],
    ["形の壊れた知らせ（正しい署名・JSON でない）", await postWebhook("not-json", signFor("not-json", webhookSecret)), /EVENT_MALFORMED/],
  ];
  for (const [label, r, re] of bad) check("不正", `${label} → 400`, r.status === 400 && re.test(r.body.error ?? ""), `${r.status} ${r.body.error ?? ""}`);
  check("不正", "不正な知らせは1件も記録されない", (await counts()).events === eventsBefore);

  /* ---------------- 失敗系: 突き合わせが合わない知らせ ---------------- */
  section("失敗系: 金額・通貨・商品・売り方・支払い状態が合わない知らせ");
  const buyerC = await makeBuyer("c");
  const rC = await svc(`select public.billing_reserve_slot($1, $2)`, [buyerC.id, OFFER]);
  const cusC = await svc(`select public.billing_upsert_customer($1, $2)`, [buyerC.id, `cus_localc${Date.now()}`]);
  const sessionC = `cs_test_localc${Date.now()}`;
  await svc(`select public.billing_attach_checkout($1, $2, $3, now() + interval '30 minutes')`, [rC.purchase_id, cusC.billing_customer_id, sessionC]);
  const base = { id: sessionC, object: "checkout.session", mode: "payment", payment_status: "paid", amount_total: 3000, currency: "jpy", client_reference_id: rC.purchase_id, payment_intent: `pi_localc${Date.now()}`, metadata: { purchase_id: rC.purchase_id, profile_id: buyerC.id, offer_code: OFFER } };
  const variants = [
    ["金額が違う（1円）", { ...base, amount_total: 1 }, 500, /AMOUNT_MISMATCH/],
    ["通貨が違う（usd）", { ...base, currency: "usd" }, 500, /CURRENCY_MISMATCH/],
    ["商品が違う", { ...base, metadata: { ...base.metadata, offer_code: "something_else" } }, 500, /OFFER_MISMATCH/],
    ["売り方が違う（subscription）", { ...base, mode: "subscription" }, 500, /MODE_MISMATCH/],
    ["決済ページの ID が違う", { ...base, id: "cs_test_other" }, 500, /SESSION_MISMATCH/],
    ["まだ払われていない（unpaid）", { ...base, payment_status: "unpaid" }, 200, /まだ支払いが確定していません/],
  ];
  for (const [label, obj, status, re] of variants) {
    const ev = localEvent("checkout.session.completed", obj);
    const r = await postWebhook(ev, signFor(ev, webhookSecret));
    const text = `${r.body.error ?? ""}${r.body.note ?? ""}`;
    check("失敗系", `${label} → ${status}、権限を付けない`, r.status === status && re.test(text) && (await entitlementsOf(buyerC.id)).length === 0 && (await purchaseOf(buyerC.id))[0].status === "reserved", `${r.status} ${text.slice(0, 60)}`);
  }
  // 「決済ページの ID が違う」知らせは、対象の ID も違う（cs_test_other）ので両方を数える
  const failedEv = await one(`select count(*)::int n from public.billing_webhook_events where object_id in ($1, 'cs_test_other') and processed_at is null`, [sessionC]);
  check("失敗系", "処理に失敗した知らせは processed_at が空のまま残る（Stripe の再送で処理し直せる）", failedEv.n === 5, `${failedEv.n} 件`);
  const expired = localEvent("checkout.session.expired", { id: sessionC, object: "checkout.session", status: "expired" });
  const usedBeforeExpire = (await offerStatus()).used;
  const rx = await postWebhook(expired, signFor(expired, webhookSecret));
  check("失敗系", "決済ページの失効で予約が expired になり、枠が戻る", rx.status === 200 && (await purchaseOf(buyerC.id))[0].status === "expired" && (await offerStatus()).used === usedBeforeExpire - 1, JSON.stringify(rx.body));

  /* ---------------- 連打と枠の競合（受け口ごと） ---------------- */
  section("連打と枠の競合（受け口を同時に叩く）");
  if (STRIPE) {
    // Stripe の英語のエラー文・内部の合図が、利用者向けの本文に出ていないか
    const LEAK = /STRIPE_ERROR|idempoten|in-progress|another .*request|Keys for idempotent|想定外の失敗/i;
    const leakFree = (text) => !LEAK.test(text);

    // 【API】同じ人が同時に3回押す。重なりが起きるまで、別の人で最大5回やり直す
    let conflictSeen = null;
    for (let attempt = 1; attempt <= 5 && !conflictSeen; attempt += 1) {
      const who = await makeBuyer(`d${attempt}`);
      const D = await signIn(who.email);
      const answers = await Promise.all([postCheckoutAs(D.ctx), postCheckoutAs(D.ctx), postCheckoutAs(D.ctx)]);
      const rowsD = await purchaseOf(who.id);
      check("連打", `（${attempt}回目）同じ人が同時に3回押しても、購入の行は1つ`, rowsD.length === 1, `${rowsD.length}行 / 応答 ${answers.map((a) => a.status).join("・")}`);
      check("連打", `（${attempt}回目）少なくとも1回は決済ページの URL が返る`, answers.some((a) => a.status === 200 && a.body.url));
      const others = answers.filter((a) => !(a.status === 200 && a.body.url));
      for (const a of others) {
        check("連打", `（${attempt}回目）重なった応答は 409・CHECKOUT_BUSY・日本語の案内だけ`, a.status === 409 && a.body.code === "CHECKOUT_BUSY" && a.body.retry === true && /処理が重なりました/.test(a.body.error ?? "") && leakFree(JSON.stringify(a.body)), `${a.status} ${JSON.stringify(a.body).slice(0, 160)}`);
      }
      if (others.length > 0) {
        conflictSeen = { who, D };
        const again = await postCheckoutAs(D.ctx);
        check("連打", "重なったあとにもう一度押すと、同じ決済ページが返る（reused）", again.status === 200 && again.body.reused === true, JSON.stringify({ status: again.status, reused: again.body.reused }));
        const serverLog = app.logs.join("");
        check("連打", "Stripe の元のエラーはサーバーの記録にだけ残る", /\[billing\/checkout\] 要求が重なりました（Stripe (409|400) idempotency_/.test(serverLog));
      }
    }
    check("連打", "受け口の重なりを5回以内に再現できた（再現できないと、上の判定は空振り）", Boolean(conflictSeen));

    // 【画面】購入ボタンを押すのと同時に、同じ人の要求を裏で2本送る。ボタン側が重なったときの表示を見る
    let uiSeen = false;
    for (let attempt = 1; attempt <= 6 && !uiSeen; attempt += 1) {
      const who = await makeBuyer(`u${attempt}`);
      const U = await signIn(who.email);
      await U.page.goto(`${BASE}/founder`);
      const btn = U.page.getByRole("button", { name: "Founding Creator を購入する" });
      const buttonAnswer = U.page.waitForResponse((r) => new URL(r.url()).pathname === "/api/billing/checkout", { timeout: 60_000 });
      await Promise.all([btn.click(), postCheckoutAs(U.ctx), postCheckoutAs(U.ctx)]);
      const res = await buttonAnswer;
      if (res.status() !== 409) continue;
      uiSeen = true;
      await U.page.getByText("処理が重なりました").waitFor({ timeout: 30_000 });
      const shown = await U.page.locator("main").innerText();
      check("連打", "画面: ボタン側が重なると「処理が重なりました。…もう一度お試しください。」が出る", /処理が重なりました/.test(shown) && /もう一度お試しください/.test(shown));
      check("連打", "画面: Stripe の英語のエラー文も内部の合図も出ていない", leakFree(shown), shown.replace(/\s+/g, " ").slice(0, 160));
      await btn.click();
      await U.page.waitForURL(/checkout\.stripe\.com/, { timeout: 60_000 });
      check("連打", "画面: もう一度押すと決済ページへ移る", /checkout\.stripe\.com/.test(U.page.url()));
      check("連打", "画面: この人の購入の行は1つ", (await purchaseOf(who.id)).length === 1);
    }
    check("連打", "画面でボタン側の重なりを6回以内に再現できた", uiSeen);

    // 残り1枠を作り、2人が同時に押す
    const used = (await offerStatus()).used;
    await db.query(`update public.billing_offers set sales_cap = $2 where code = $1`, [OFFER, used + 1]);
    const E = await signIn((await makeBuyer("e")).email);
    const F = await signIn((await makeBuyer("f")).email);
    const [e1, f1] = await Promise.all([postCheckoutAs(E.ctx), postCheckoutAs(F.ctx)]);
    const ok = [e1, f1].filter((r) => r.status === 200 && r.body.url);
    const soldOut = [e1, f1].filter((r) => r.status === 409 && /販売枠が埋まりました/.test(r.body.error ?? ""));
    for (const r of await all(`select stripe_checkout_session_id sid from public.billing_purchases where stripe_checkout_session_id is not null`)) cleanupStripe.sessions.add(r.sid);
    for (const r of await all(`select stripe_customer_id c from public.billing_customers`)) cleanupStripe.customers.add(r.c);
    check("競合", "残り1枠に2人が同時に来ると、通るのは1人・もう1人は売り切れ", ok.length === 1 && soldOut.length === 1, `${e1.status} / ${f1.status}`);
    const st = await offerStatus();
    check("競合", "枠を超えていない（used ≦ sales_cap）", st.used <= st.sales_cap, `${st.used} / ${st.sales_cap}`);
  } else {
    check("連打", "（代わり）受け口の連打は Stripe が要る。DB 側は test:db の W4・test:db:concurrent の C5 が見る", true);
    check("競合", "（代わり）受け口の競合は Stripe が要る。DB 側は test:db:concurrent の C2・C3 が見る", true);
  }
} catch (e) {
  exitCode = 1;
  check("例外", "最後まで進んだ", false, String(e.stack ?? e).slice(0, 1200));
} finally {
  if (STRIPE) {
    section("片づけ（Stripe のテストモード）");
    // 途中で落ちても、DB に記録された決済ページと顧客はすべて片づけの対象に入れる
    try {
      for (const r of await all(`select stripe_checkout_session_id sid from public.billing_purchases where stripe_checkout_session_id is not null`)) cleanupStripe.sessions.add(r.sid);
      for (const r of await all(`select stripe_customer_id c from public.billing_customers`)) cleanupStripe.customers.add(r.c);
    } catch { /* DB が読めなければ、集めた分だけ片づける */ }
    let expiredN = 0;
    for (const sid of [...cleanupStripe.sessions].filter((x) => x && !x.includes("_local"))) {
      try {
        const s = await stripeApi("GET", `/checkout/sessions/${sid}`);
        if (s.status === "open") { await stripeApi("POST", `/checkout/sessions/${sid}/expire`); expiredN += 1; }
      } catch (e) { console.log(`    （決済ページ ${sid.slice(0, 14)}… を失効できませんでした: ${e.message.slice(0, 80)}）`); }
    }
    let deletedN = 0;
    for (const cus of [...cleanupStripe.customers].filter((x) => x && !x.startsWith("cus_local"))) {
      try { await stripeApi("DELETE", `/customers/${cus}`); deletedN += 1; } catch { /* 既に消えている */ }
    }
    console.log(`  開いたままの決済ページを失効: ${expiredN} 件 / 顧客を削除: ${deletedN} 件`);
    console.log("  支払い・返金・知らせは、テストモードの履歴として Stripe に残る（削除できない）");
    listener?.kill("SIGTERM");
  }
  await browser.close().catch(() => {});
  await app.close().catch(() => {});
  lock();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n合計 ${results.length} 件 / 合格 ${results.length - failed.length} 件 / 不合格 ${failed.length} 件（モード: ${MODE}）`);
process.exit(failed.length > 0 || exitCode ? 1 : 0);
