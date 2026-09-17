#!/usr/bin/env node
/**
 * smoke-journey.mjs ／ 本番を、利用者と同じ画面操作で1周する（公開前の再監査）
 *
 * 【なぜ要るか】
 *   ほかのスモークは通信（HTML と POST）で確かめる。サーバーの判断は見られるが、
 *   「本物のブラウザで、ボタンを押して、次の画面へ進めるか」は見ていない。
 *   手元のブラウザ試験（test:e2e）は画面を見るが、相手は手元の DB で、
 *   本番の認証・画像の置き場・CAPTCHA は通らない。
 *   この2つの隙間を、本番に対して1回だけ埋める。
 *
 * 【何を通すか】
 *   作者（登録者・PC幅）: 確認リンク → 同意 → ID を決める → お題を引く → 確定 →
 *                          投稿 → 自分の作品の表示 → 共有の面
 *   ゲスト（スマホ幅）   : 共有 URL を開く → 長押しで回答 → 結果 → 次の作品
 *   登録者B（スマホ幅）  : 回答 → 保存 → お気に入り → 通報の画面 → 回答の履歴
 *   作者                 : 結果を開く → 知らせ → プロフィール → 削除 → サインアウト
 *
 * 【本番に何を残すか】＝ 何も残さない（2026-09-18 に作り直した）
 *   この一周は、登録者2人・ゲスト1人・作品1件・お題1件・回答2件・利用の記録・
 *   同意の記録を本番に作る。**作った物はすべて、この実行が自分で消す。**
 *
 *   以前はゲストだけが消せなかった。ゲストはサーバー側が勝手に作るので、
 *   スモークは自分が誰を作ったのか知らず、既存の片づけはメールの形で
 *   見分けるため匿名ゲストに当たらなかった。掃除 Cron は拾うが30日後で、
 *   その間ずっと本番の利用者数と初回利用ファネル（D209）に混ざっていた。
 *   実測: 2026-09-17 の2回でゲストが2人残った。
 *
 *   いまは ID を作られたその場で2つの経路から拾う（scripts/_smoke-actors.mjs）。
 *   片づけは finally で行うので、途中で失敗しても走る。
 *   消し終えたあと件数を数え直し、**開始前と1件でも違えば不合格にする**
 *   （scripts/_smoke-baseline.mjs）。
 *
 * 【使い方】
 *   SMOKE_BASE_URL=https://<本番> npm run smoke:prod -- journey
 *
 *   JOURNEY_FAIL_AFTER=guest|next-work … その地点でわざと止める（片づけの故障試験）
 */

import { mkdirSync } from "node:fs";
import { chromium, devices } from "playwright";
import { createClient } from "@supabase/supabase-js";

import {
  BASE,
  finish,
  generateSignupConfirm,
  makePng,
  must,
  section,
  targetEnv,
  throwawaySession,
} from "./_smoke-http.mjs";
import {
  actorFromCookies,
  cleanupActors,
  cleanupFailed,
  createActorLedger,
  describeActor,
  maskId,
  supabaseActorRemover,
} from "./_smoke-actors.mjs";
import {
  cleanupRunRows,
  createRunLedger,
  describeCleanup,
  supabaseRemover,
} from "./_smoke-own-rows.mjs";
import {
  describeBaselineRow,
  diffBaseline,
  baselineDrift,
  takeBaseline,
} from "./_smoke-baseline.mjs";

const SHOTS = process.env.JOURNEY_SHOTS ?? "/tmp/dpq-journey";
mkdirSync(SHOTS, { recursive: true });

const env = targetEnv();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * この実行で作った人。**最後にこの ID だけを消す。**
 * 入るのは「作ったその場で分かった ID」だけで、一覧や時刻から拾った ID は入れない。
 */
const actors = createActorLedger();
/** この実行で作った行（作品・お題・ドラフト）。同じく ID で名指しして消す */
const ownRows = createRunLedger();
const REAL_WORK_IDS = new Set();

/** 開始前の件数。片づけたあと、ここへ戻ったかを数えて確かめる */
let baselineBefore = null;

/** 片づけの故障試験。指定した地点でわざと止める */
const FAIL_AFTER = process.env.JOURNEY_FAIL_AFTER ?? "";
function failIfAsked(point) {
  if (FAIL_AFTER !== point) return;
  throw new Error(`[故障試験] ${point} の直後で意図的に止めました（JOURNEY_FAIL_AFTER）`);
}

/**
 * ゲストの ID を、作られたその場で拾う。**2つの独立した経路を両方使う。**
 *
 *   経路1 … ブラウザの入れ物のセッション Cookie を復号して sub を読む
 *   経路2 … **この実行が作った作品**への回答行の user_id を読む
 *
 * どちらも「この実行が作った物」しか見ていない。
 * 2つとも取れて食い違ったら、両方を帳面に入れて報告する（消し漏らすより良い）。
 */
async function captureGuest(ctx, ownWorkId) {
  const found = [];

  const fromCookie = actorFromCookies(await ctx.cookies().catch(() => []));
  if (fromCookie?.id) {
    actors.add(fromCookie.id, { role: "ゲスト", anonymous: fromCookie.isAnonymous, how: "Cookie" });
    found.push(`Cookie=${maskId(fromCookie.id)}`);
  }

  if (ownWorkId) {
    const { data } = await admin.from("answers").select("user_id").eq("work_id", ownWorkId);
    for (const row of data ?? []) {
      if (!row.user_id) continue;
      // すでに帳面にいる登録者（作者・登録者B）は、役割を上書きしない
      if (actors.has(row.user_id) && row.user_id !== fromCookie?.id) continue;
      actors.add(row.user_id, { role: "ゲスト", anonymous: true, how: "自分の作品への回答" });
      found.push(`回答行=${maskId(row.user_id)}`);
    }
  }
  // 拾えた ID が本当に匿名かを、認証の口へ聞いて確かめる（登録者を巻き込まないため）
  for (const a of actors.list()) {
    if (a.role !== "ゲスト") continue;
    const { data } = await admin.auth.admin.getUserById(a.id).catch(() => ({ data: null }));
    const anon = data?.user?.is_anonymous ?? null;
    if (anon !== null) a.anonymous = anon;
    must(anon !== false, "拾ったゲストの ID が匿名である", "登録者の ID を拾っていました");
  }

  must(found.length > 0, "ゲストの ID を、作られたその場で拾えた", "どちらの経路でも取れませんでした");
  console.log(`      ゲストの見つけかた: ${found.join(" / ") || "取れず"}`);
  return fromCookie?.id ?? null;
}

// **一周を始める前に数える。**片づけたあと、ここへ戻ったかで片づけを判定する
try {
  baselineBefore = await takeBaseline(admin);
  console.log("");
  console.log("[開始前の件数]");
  for (const [k, v] of Object.entries(baselineBefore)) console.log(`   ${k.padEnd(18)} ${v}`);
} catch (e) {
  must(false, "開始前の件数を数えられた", String(e?.message ?? e).slice(0, 160));
}

const browser = await chromium.launch();
const tag = `${Date.now() % 1e8}`;
/**
 * JOURNEY_LONG=1 のときは、はみ出しを起こしやすい形で1周する:
 * 区切りの無い英数字の長い題名（60字）・長い表示名（30字）・長い ID（20字）・横長の絵。
 */
const LONG = process.env.JOURNEY_LONG === "1";
const problems = [];

function watch(page, who) {
  page.on("pageerror", (e) => problems.push(`[${who}] pageerror ${String(e).slice(0, 160)} @ ${page.url()}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/status of 404/.test(t)) return; // 404 の画面を意図して開くときに出る
    if (/^%c%d font-size:0/.test(t)) return; // Turnstile の iframe が自分で出す行（こちらの画面の失敗ではない）
    problems.push(`[${who}] console ${t.slice(0, 160)} @ ${page.url()}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 500) problems.push(`[${who}] ${r.status()} ${r.request().method()} ${r.url().slice(0, 120)}`);
  });
}

async function shot(page, name) {
  await page.screenshot({ path: `${SHOTS}/${name}.png` }).catch(() => {});
}

async function bodyText(page) {
  await page.waitForLoadState("domcontentloaded");
  await page
    .waitForFunction(() => !(document.querySelector("main")?.innerText ?? "").includes("読み込み中"), null, { timeout: 15000 })
    .catch(() => {});
  return (await page.locator("body").innerText()).replace(/\s+/g, " ");
}

async function layout(page) {
  return page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    brokenImages: [...document.images].filter((i) => i.complete && i.naturalWidth === 0).length,
  }));
}

async function checkLayout(page, label) {
  const l = await layout(page);
  must(l.overflow <= 0, `${label}: 横にはみ出していない`, `はみ出し ${l.overflow}px`);
  must(l.brokenImages === 0, `${label}: 壊れた画像が無い`, `${l.brokenImages}枚`);
}

async function click(page, locator) {
  await locator.scrollIntoViewIfNeeded({ timeout: 10000 }).catch(() => {});
  const waiting = page.waitForResponse((r) => r.request().method() === "POST", { timeout: 30000 }).catch(() => null);
  await locator.click({ timeout: 20000 });
  await waiting;
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(800);
}

/** 長押しで1枚確定する（src/features/quiz/hold.ts の 1.5 秒を本物で使う） */
async function hold(page, locator) {
  await locator.evaluate((n) => n.scrollIntoView({ block: "end", behavior: "instant" }));
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if ((await locator.getAttribute("data-hold-done").catch(() => null)) === "1") break;
    await page.waitForTimeout(50);
  }
  await page.mouse.up();
}

async function answerAll(page, shotName) {
  const flow = page.locator("[data-answer-flow]");
  await flow.waitFor({ state: "visible", timeout: 30000 });
  const total = Number(await page.locator("[data-section]").first().getAttribute("data-section-total"));
  for (let i = 0; i < total; i += 1) {
    const sec = page.locator(`[data-section][data-section-index="${i}"]`);
    await sec.waitFor({ state: "visible", timeout: 20000 });
    if (i === 0 && shotName) await shot(page, shotName);
    await hold(page, sec.locator("[data-answer-card]").first());
    await page.waitForFunction(
      (n) => Number(document.querySelector("[data-answer-flow]")?.getAttribute("data-answered-count") ?? -1) >= n,
      i + 1,
      { timeout: 15000 },
    );
  }
  await page.locator("[data-confirm-stage]").waitFor({ state: "visible", timeout: 15000 });
  await click(page, page.getByRole("button", { name: "回答する" }));
  // **採点の応答が届くまで待つ。**押した直後は「採点しています…」のままで、
  // 読むのが早いと結果が出ていないように見える（本番の1回目で実際にそうなった）
  await page.getByRole("button", { name: "次の作品に答える" }).waitFor({ state: "visible", timeout: 45000 }).catch(() => {});
  return total;
}

async function contextWithCookies(opts, cookies) {
  const ctx = await browser.newContext(opts);
  const host = new URL(BASE).hostname;
  if (cookies) {
    await ctx.addCookies(
      Object.entries(cookies).map(([name, value]) => ({
        name, value, domain: host, path: "/", secure: BASE.startsWith("https"), sameSite: "Lax",
      })),
    );
  }
  return ctx;
}

const PC = { viewport: { width: 1280, height: 900 }, locale: "ja-JP" };
const SP = { ...devices["iPhone 13"], deviceScaleFactor: 1, locale: "ja-JP" };

let workId = null;
let workTitle = null;
let authorHandle = null;
let promptWords = [];

try {
  // 本物の公開作品を控える（次の作品で移っても答えないため）
  {
    const { data } = await admin.from("works").select("id").is("deleted_at", null).eq("is_published", true);
    for (const w of data ?? []) REAL_WORK_IDS.add(w.id);
  }

  // ══════════════════════════════════════════════════════
  section("1. 作者: 確認メールのリンク → 同意 → ID");
  // ══════════════════════════════════════════════════════
  const signup = await generateSignupConfirm(`journey-author`);
  actors.add(signup.userId, { role: "作者", anonymous: false, how: "Admin API" });

  const authorCtx = await browser.newContext(PC);
  const a = await authorCtx.newPage();
  watch(a, "作者");

  // **登録を始めたのとは別の入れ物で開く。**メールを別の端末で開いた場合と同じ（D92）
  await a.goto(`${BASE}/auth/confirm?token_hash=${signup.tokenHash}&type=email`, { waitUntil: "domcontentloaded" });
  let t = await bodyText(a);
  must(!/確認を完了できませんでした/.test(t), "確認リンクを別の入れ物で開いて通る", new URL(a.url()).pathname);

  await a.goto(`${BASE}/works/new`, { waitUntil: "domcontentloaded" });
  t = await bodyText(a);
  must(new URL(a.url()).pathname === "/consent", "未同意の登録者は同意の画面へ送られる", new URL(a.url()).pathname);
  must(/2026-09-09/.test(t), "同意の画面に今の版（2026-09-09）が出る");
  await shot(a, "01-consent-pc");
  const agree = a.locator("input[type=checkbox]");
  if ((await agree.count()) > 0) await agree.first().check();
  await click(a, a.getByRole("button", { name: /同意/ }));
  t = await bodyText(a);
  must(new URL(a.url()).pathname !== "/consent", "同意すると関門が外れる", new URL(a.url()).pathname);

  authorHandle = LONG ? `qa${tag}`.padEnd(20, "x") : `qa${tag}`;
  await a.goto(`${BASE}/account`, { waitUntil: "domcontentloaded" });
  await a.locator("input[name=handle]").fill(authorHandle);
  const dn = a.locator("input[name=displayName]");
  if ((await dn.count()) > 0) await dn.fill(LONG ? `[検査用]${"W".repeat(22)}` : `[検査用]作者${tag}`);
  await click(a, a.getByRole("button", { name: "プロフィールを保存する" }));
  t = await bodyText(a);
  {
    const r = await fetch(`${BASE}/u/${authorHandle}`);
    must(r.status === 200, "ID を決めて保存でき、そのプロフィールが開く", `${r.status}`);
  }

  // ══════════════════════════════════════════════════════
  section("2. 作者: お題を引く → 確定 → 投稿");
  // ══════════════════════════════════════════════════════
  await a.goto(`${BASE}/play`, { waitUntil: "domcontentloaded" });
  await a.locator("select[name=timeLimitSeconds]").waitFor({ state: "visible", timeout: 20000 });
  await a.selectOption("select[name=timeLimitSeconds]", "3600");
  await click(a, a.getByRole("button", { name: "ドラフトを始める" }));
  await a.waitForSelector("button[data-card=hidden]", { timeout: 30000 });
  await shot(a, "02-board-pc");
  must(true, "お題の盤面が出る");

  for (let i = 0; i < 24; i += 1) {
    const buttons = a.locator("button[data-card=hidden]:not([disabled])");
    if ((await buttons.count()) === 0) break;
    const before = await a.locator("[data-board]").first().getAttribute("data-chosen").catch(() => null);
    await click(a, buttons.first());
    for (let w = 0; w < 40; w += 1) {
      const now = await a.locator("[data-board]").first().getAttribute("data-chosen").catch(() => null);
      if (now === null || now !== before) break;
      await a.waitForTimeout(300);
    }
  }
  await click(a, a.getByRole("button", { name: "このお題で確定する" }));
  await a.waitForURL("**/prompt/**", { timeout: 30000 });
  const promptId = /\/prompt\/([0-9a-f-]{36})/.exec(a.url())?.[1];
  must(!!promptId, "お題を確定するとお題の画面へ移る");
  ownRows.add("prompts", promptId);
  {
    // ドラフトの ID は、確定したお題が持っている。**この実行が作ったお題からしか辿らない**
    const { data } = await admin.from("prompts").select("draft_session_id").eq("id", promptId).maybeSingle();
    ownRows.add("draft_sessions", data?.draft_session_id ?? null);
  }
  {
    const { data } = await admin.from("prompt_cards").select("tag_id, tags(label)").eq("prompt_id", promptId);
    promptWords = (data ?? []).map((r) => r.tags?.label).filter(Boolean);
  }
  must(promptWords.length > 0, "お題の語が決まっている", `${promptWords.length}語`);
  await shot(a, "03-prompt-pc");

  await click(a, a.getByRole("link", { name: "このお題で描いた作品を投稿する" }).or(a.getByRole("button", { name: "このお題で描いた作品を投稿する" })));
  await a.waitForURL("**/works/new**", { timeout: 30000 });
  await a.locator("input[name=image]").setInputFiles({ name: "journey.png", mimeType: "image/png", buffer: LONG ? makePng(1600, 400) : makePng(900, 1200) });
  workTitle = LONG ? `[検査用]${tag}${"M".repeat(60 - 5 - tag.length)}` : `[検査用]画面の一周${tag}`;
  await a.locator("input[name=title]").fill(workTitle);
  await shot(a, "04-new-pc");
  await click(a, a.getByRole("button", { name: "公開して投稿する" }));
  await a.waitForURL(/\/works\/[0-9a-f-]{36}/, { timeout: 60000 });
  workId = /\/works\/([0-9a-f-]{36})/.exec(a.url())?.[1];
  must(!!workId, "投稿すると作品ページへ移る");
  ownRows.add("works", workId);
  t = await bodyText(a);
  await shot(a, "05-own-work-pc");
  must(/自分の作品には回答できません/.test(t), "自分の作品には回答できないと出る");
  must(/まだ誰も答えていません/.test(t), "回答0件の作者向けの表示が出る");
  await checkLayout(a, "作者の作品ページ（PC）");

  // ══════════════════════════════════════════════════════
  section("3. 作者: 共有");
  // ══════════════════════════════════════════════════════
  await click(a, a.getByRole("button", { name: "この作品を共有する" }));
  t = await bodyText(a);
  const shareUrlValue = await a.locator("input[readonly]").first().inputValue().catch(() => "");
  must(shareUrlValue.endsWith(`/works/${workId}`), "共有の URL 欄にこの作品の URL が出る", shareUrlValue);
  const xHref = await a.getByRole("link", { name: /X に投稿/ }).getAttribute("href").catch(() => null);
  must(!!xHref, "「X に投稿する」がある");
  const xText = decodeURIComponent(xHref ?? "");
  must(!promptWords.some((w) => xText.includes(w)), "X の投稿文にお題の語が無い");
  await shot(a, "06-share-pc");

  const html = await (await fetch(`${BASE}/works/${workId}`)).text();
  const og = /property="og:image" content="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");
  must(!!og, "作品ページに og:image がある");
  must(/name="twitter:card" content="summary_large_image"/.test(html), "twitter:card が大きい画像のカード");
  if (og) {
    const r = await fetch(og);
    must(r.status === 200 && /image\/png/.test(r.headers.get("content-type") ?? ""), "共有カードの画像が返る", `${r.status}`);
  }
  const head = html.slice(0, html.indexOf("</head>"));
  must(!promptWords.some((w) => head.includes(w)), "共有用の head（タイトル・説明）にお題の語が無い", promptWords.filter((w) => head.includes(w)).join("・"));

  // ══════════════════════════════════════════════════════
  section("4. ゲスト（スマホ幅）: 共有 URL → 回答 → 結果 → 次の作品");
  // ══════════════════════════════════════════════════════
  const guestCtx = await browser.newContext(SP);
  const g = await guestCtx.newPage();
  watch(g, "ゲスト");
  await g.goto(`${BASE}/works/${workId}`, { waitUntil: "domcontentloaded" });
  t = await bodyText(g);
  must(/クイズの回答はゲストのままできます/.test(t), "未ログインでも回答できると出る");
  await checkLayout(g, "作品ページ（スマホ・未ログイン）");
  for (const path of ["/works", "/rankings", `/u/${authorHandle}`]) {
    await g.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
    t = await bodyText(g);
    must(t.includes(workTitle.slice(0, 12)), `${path} にこの作品が出る（スマホ・未ログイン）`);
    await shot(g, `07b${path.replace(/\W+/g, "_")}-sp`);
    await checkLayout(g, `${path}（スマホ・未ログイン）`);
  }
  await g.goto(`${BASE}/works/${workId}`, { waitUntil: "domcontentloaded" });
  const n = await answerAll(g, "07-quiz-sp");
  must(n > 0, "長押しで全セクションに答えて送れる", `${n}問`);

  // **ここでゲストが生まれている。**回答の送信が ensureUserId() を呼ぶため。
  // 作られたその場で ID を拾う。あとから時刻や行動の形で当てない
  await captureGuest(guestCtx, workId);
  failIfAsked("guest");
  t = await bodyText(g);
  await shot(g, "08-result-sp");
  must(/次の作品に答える/.test(t), "回答後に「次の作品に答える」が出る");
  await checkLayout(g, "回答後（スマホ）");
  await g.reload({ waitUntil: "domcontentloaded" });
  t = await bodyText(g);
  must((await g.locator("[data-answer-flow]").count()) === 0, "再読み込みしても、もう一度は答えられない");
  await g.getByRole("button", { name: "次の作品に答える" }).click();
  await g.waitForURL((u) => u.pathname !== `/works/${workId}`, { timeout: 45000 }).catch(() => {});
  await bodyText(g);
  const nextPath = new URL(g.url()).pathname;
  const nextId = /\/works\/([0-9a-f-]{36})/.exec(nextPath)?.[1] ?? null;
  must(nextId !== workId, "次の作品は、いま答えた作品ではない", nextPath);
  console.log(`      次の作品の行き先: ${nextId ? (REAL_WORK_IDS.has(nextId) ? "本物の公開作品（答えない）" : "検査用の作品") : nextPath}`);
  await shot(g, "09-next-sp");
  failIfAsked("next-work");

  // ══════════════════════════════════════════════════════
  section("5. 登録者B（スマホ幅）: 回答 → 保存 → お気に入り → 通報の画面 → 履歴");
  // ══════════════════════════════════════════════════════
  const b = await throwawaySession("journey-b");
  actors.add(b.id, { role: "登録者B", anonymous: false, how: "Admin API" });
  const bCtx = await contextWithCookies(SP, b.session.cookies());
  const bp = await bCtx.newPage();
  watch(bp, "登録者B");
  await bp.goto(`${BASE}/works/${workId}`, { waitUntil: "domcontentloaded" });
  await answerAll(bp, null);
  t = await bodyText(bp);
  must(/次の作品に答える/.test(t), "登録者Bも回答できる");
  await click(bp, bp.getByRole("button", { name: /^保存 \d+/ }));
  await bp.getByRole("button", { name: /^保存済み/ }).waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
  t = await bodyText(bp);
  must(/保存済み/.test(t), "保存すると「保存済み」になる");
  await bp.goto(`${BASE}/saves`, { waitUntil: "domcontentloaded" });
  t = await bodyText(bp);
  must(t.includes(workTitle), "お気に入りに保存した作品が出る");
  await shot(bp, "10-saves-sp");
  await checkLayout(bp, "お気に入り（スマホ）");

  await bp.goto(`${BASE}/works/${workId}/report`, { waitUntil: "domcontentloaded" });
  t = await bodyText(bp);
  must(/どの点が問題ですか/.test(t), "通報の画面が開く");
  const widget = await bp.locator(".cf-turnstile").count();
  must(widget === 1, "通報の画面に人間確認（Turnstile）の枠がある");
  await bp.locator(".cf-turnstile iframe").first().waitFor({ state: "attached", timeout: 15000 }).catch(() => {});
  const iframe = await bp.locator(".cf-turnstile iframe").count();
  console.log(`      Turnstile の iframe: ${iframe}（自動操作では解けないので送信はしない）`);
  await shot(bp, "11-report-sp");
  await checkLayout(bp, "通報の画面（スマホ）");

  const bHandle = `qb${tag}`;
  await bp.goto(`${BASE}/account`, { waitUntil: "domcontentloaded" });
  await bp.locator("input[name=handle]").fill(bHandle);
  await click(bp, bp.getByRole("button", { name: "プロフィールを保存する" }));
  await bp.goto(`${BASE}/u/${bHandle}?tab=answers`, { waitUntil: "domcontentloaded" });
  t = await bodyText(bp);
  must(bp.url().includes(`/u/${bHandle}`), "回答の履歴の画面が開く", new URL(bp.url()).pathname);
  console.log(`      回答の履歴に作品名: ${t.includes(workTitle) ? "出る" : "出ない（非公開設定の既定の可能性）"}`);
  await shot(bp, "12-history-sp");
  await checkLayout(bp, "プロフィール（スマホ）");

  // ══════════════════════════════════════════════════════
  section("6. 作者: 知らせ → 結果 → プロフィール");
  // ══════════════════════════════════════════════════════
  // **結果を開く前に知らせを見る。**作品の結果を開くと、その回答は確認済みになって知らせから消える
  await a.goto(`${BASE}/notices`, { waitUntil: "domcontentloaded" });
  t = await bodyText(a);
  must(t.includes(workTitle), "作者の知らせに、この作品への回答が届いている", t.slice(0, 160));
  await shot(a, "14-notices-pc");
  await a.goto(`${BASE}/works/${workId}`, { waitUntil: "domcontentloaded" });
  t = await bodyText(a);
  must(!/まだ誰も答えていません/.test(t), "回答が届いたあと、0件の表示が消える");
  const openBtn = a.getByRole("button", { name: "開く" }).or(a.getByRole("link", { name: "開く" }));
  if ((await openBtn.count()) > 0) {
    await openBtn.first().click();
    await a.waitForLoadState("domcontentloaded");
    await a.waitForTimeout(1500);
  }
  t = await bodyText(a);
  must(/%|伝達率|人/.test(t), "作者が結果を開ける");
  await shot(a, "13-author-result-pc");


  await a.goto(`${BASE}/u/${authorHandle}`, { waitUntil: "domcontentloaded" });
  t = await bodyText(a);
  must(t.includes(workTitle), "作者のプロフィールに作品が出る");

  // 作者の画面をスマホ幅でも見る
  const aSp = await contextWithCookies(SP, Object.fromEntries((await authorCtx.cookies()).map((c) => [c.name, c.value])));
  const as = await aSp.newPage();
  watch(as, "作者SP");
  for (const [path, name] of [[`/works/${workId}`, "15-own-work-sp"], ["/play", "16-play-sp"], ["/account", "17-account-sp"], [`/u/${authorHandle}`, "18-profile-sp"], ["/notices", "19-notices-sp"]]) {
    await as.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
    await bodyText(as);
    await shot(as, name);
    await checkLayout(as, `${path}（作者・スマホ）`);
  }
  await aSp.close();

  // ══════════════════════════════════════════════════════
  section("7. 作者: 削除 → サインアウト");
  // ══════════════════════════════════════════════════════
  await a.goto(`${BASE}/works/${workId}/delete`, { waitUntil: "domcontentloaded" });
  await a.locator("input[name=confirmTitle]").fill(workTitle);
  await click(a, a.getByRole("button", { name: /削除する/ }).last());
  const del = await admin.from("works").select("deleted_at").eq("id", workId).single();
  must(!!del.data?.deleted_at, "画面から作品を削除できる");
  const gone = await fetch(`${BASE}/works/${workId}`);
  must(gone.status === 404, "削除した作品の URL は 404", `${gone.status}`);
  if (gone.status === 404) workId = null;

  await a.goto(`${BASE}/account`, { waitUntil: "domcontentloaded" });
  await click(a, a.getByRole("button", { name: "サインアウトする" }));
  await a.goto(`${BASE}/account`, { waitUntil: "domcontentloaded" });
  t = await bodyText(a);
  must(/まだサインインしていません/.test(t), "サインアウトできる");

  await bCtx.close();
  await guestCtx.close();
  await authorCtx.close();
} catch (e) {
  must(false, "一周が途中で止まった", String(e?.message ?? e).split("\n")[0].slice(0, 200));
} finally {
  await browser.close();

  // ══════════════════════════════════════════════════════
  section("8. 片づけ: この実行が作った物だけを、ID で名指しして消す");
  // ══════════════════════════════════════════════════════
  //
  // **成功しても、途中で止まっても、必ずここを通る。**
  // 消す相手は帳面（actors / ownRows）に載っている ID だけ。
  // 「最近作られたゲスト」「回答が1件だけの人」のような広い条件では消さない。

  const actorIds = actors.list().map((a) => a.id);

  // ① 画像。**作品の行より先に消す。**行を消すと置き場の手がかりが無くなる
  let imageNote = ownRows.ids("works").length === 0 ? "作品を作っていません" : "";
  for (const id of ownRows.ids("works")) {
    const { data } = await admin.from("works").select("image_path").eq("id", id).maybeSingle();
    const path = data?.image_path;
    if (!path) {
      imageNote = "置き場所が分かりません（作品の行がもうありません）";
      continue;
    }
    const { error } = await admin.storage.from("works").remove([path]);
    imageNote = error ? `失敗: ${error.message}` : "消しました";
    must(!error, "片づけ: 作品の画像を消せた", error?.message ?? "");
  }
  console.log(`   作品の画像: ${imageNote}`);

  // ② 人に結び付く記録。**人より先に消す。**
  // 人を消すと user_id が null になり（on delete set null）、誰のものか辿れなくなる
  for (const table of ["usage_events", "terms_agreements"]) {
    if (actorIds.length === 0) break;
    const { data, error } = await admin.from(table).delete().in("user_id", actorIds).select("id");
    console.log(`   ${table}: ${error ? `失敗 ${error.message}` : `${(data ?? []).length}件`}`);
    must(!error, `片づけ: ${table} をこの実行のぶんだけ消せた`, error?.message ?? "");
  }

  // ③ 作った行。作品 → お題 → ドラフトの順（外部キーの向き）
  const rowReport = await cleanupRunRows(ownRows, supabaseRemover(admin));
  for (const r of rowReport) {
    if (r.expected === 0) continue;
    console.log(`   ${r.table}: ${describeCleanup(r)}`);
    must(r.ok, `片づけ: ${r.table} をこの実行のぶんだけ消せた`, describeCleanup(r));
  }

  // ④ 人。登録者もゲストも同じ扱い。profiles はここで cascade で消える
  const actorReport = await cleanupActors(actors.list(), supabaseActorRemover(admin));
  for (const r of actorReport) console.log(`   ${describeActor(r)}`);
  must(
    !cleanupFailed(actorReport),
    "片づけ: この実行が作った人を全員消せた",
    actorReport.filter((r) => !r.ok).map((r) => `${r.role} ${maskId(r.id)}: ${r.error}`).join(" ／ "),
  );

  // ⑤ 件数が開始前へ戻ったか。**これだけが「残っていない」ことの証拠になる**
  let baselineAfter = null;
  try {
    baselineAfter = await takeBaseline(admin);
  } catch (e) {
    must(false, "片づけ後の件数を数えられた", String(e?.message ?? e).slice(0, 160));
  }

  if (baselineBefore && baselineAfter) {
    const rows = diffBaseline(baselineBefore, baselineAfter);
    console.log("");
    console.log("   [開始前 → 片づけ後]");
    for (const r of rows) console.log(`   ${describeBaselineRow(r)}`);
    const drift = baselineDrift(rows);
    must(
      drift.length === 0,
      "本番の件数が、一周の前とすべて同じに戻った",
      drift.map((r) => `${r.label} ${r.delta > 0 ? "+" : ""}${r.delta}`).join(" ／ "),
    );
  } else {
    must(false, "件数を一周の前後で比べられた", "どちらかを数えられませんでした");
  }

  console.log(`\n画面の記録: ${SHOTS}`);
  console.log(`ブラウザで拾った異常: ${problems.length}件`);
  for (const p of problems.slice(0, 30)) console.log(`   ${p}`);
  must(problems.length === 0, "ブラウザで 5xx・ページの例外・console のエラーが出ていない");
}

await finish();
