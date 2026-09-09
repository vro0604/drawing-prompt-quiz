#!/usr/bin/env node
/**
 * smoke-shape-assist.mjs ／ 形状アシストを本番で往復させる（D191）
 *
 * 【なぜ手元のブラウザ試験と別に要るか】
 *   手元の試験（U群）は擬似の Supabase を相手にしている。
 *   本番の `start_draft` は引数が4つに増えたばかりで、
 *   本物のDBが新しい引数を受け取るかは本番でしか分からない。
 *   ここでは本物のブラウザ（Chromium）を本番の画面へ向け、
 *   人が押すのと同じ順で押す。
 *
 * 【何を通すか】
 *   A. 使わない   … 形状アシストが1つも出ない。お題は従来どおり
 *   B. ランダム   … 候補のどれか1つに決まり、引き直しても変わらない
 *   C. 自分で選ぶ … 選んだものが盤面と確定したお題に出る
 *   D. 非干渉     … 正式な語数・クイズの問数が増えない。
 *                    回答者へ渡る中身に出ない。持ち込みには欄そのものが無い
 *
 * 【候補一覧を書き写していない理由】
 *   一覧は画面から読む。スクリプト側に書き写すと、
 *   画面が変わっても検査は自分の写しを見て通ってしまう。
 *
 * 【この検査が触るもの】
 *   検査用の固定利用者のドラフト・お題と、その人が出す作品2件だけ。
 *   作品は回答者の画面を実際に見るために出す。終わったら
 *   投稿した作品を消し、未完了のドラフトも片づける。
 *   他人のドラフト・作品・プロフィールは読み書きしない。
 *
 * 【使い方】
 *   本番: SMOKE_BASE_URL=https://<本番> npm run smoke:prod -- shape-assist
 */

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

import {
  BASE,
  accountUserId,
  finish,
  fixtureSession,
  makePng,
  must,
  section,
  submitWork,
  targetEnv,
} from "./_smoke-http.mjs";

const env = targetEnv();

/** service_role のクライアント。DB側の実測と後片づけにだけ使う */
function admin() {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = env.SUPABASE_SECRET_KEY;
  if (!url || !secret) {
    throw new Error("接続先と秘密鍵がありません（本番へ向けるなら npm run smoke:prod）。");
  }
  return createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false } });
}

// ── サインイン済みのブラウザを1つ用意する ──────────────────────
//
// 認証は既存のスモークと同じ道（fixtureSession）で取り、
// そのときの Cookie を本物のブラウザへ移す。
// ブラウザ側でメールとパスワードを打ち直さないのは、
// 認証そのものは別のスモークが確かめているため。

const s = await fixtureSession("shape");
const who = await s.get("/account");
const USER_ID = accountUserId(who.html);
if (!USER_ID) throw new Error("/account から検査用の利用者を特定できませんでした");

const url = new URL(BASE);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addCookies(
  Object.entries(s.cookies()).map(([name, value]) => ({
    name,
    value,
    domain: url.hostname,
    path: "/",
    httpOnly: false,
    secure: url.protocol === "https:",
    sameSite: "Lax",
  })),
);
const page = await ctx.newPage();

/** この人の進行中ドラフトだけを片づける。他人のものには触らない */
async function clearMyDraft() {
  await admin()
    .from("draft_sessions")
    .update({ status: "abandoned", abandoned_at: new Date().toISOString() })
    .eq("user_id", USER_ID)
    .eq("status", "in_progress");
}

/**
 * 始める前のフォームを開いて、形状アシストを指定して1つ引く。
 * mode は "none" / "random" / "pick"。pick のときだけ key を渡す。
 */
async function startDraft(mode, key) {
  await clearMyDraft();
  await page.goto(`${BASE}/play`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="shape-assist"]').waitFor({ state: "visible", timeout: 30000 });
  await page.check(`input[name=shapeAssistMode][value="${mode}"]`);
  if (key) await page.check(`input[name=shapeAssistKey][value="${key}"]`);
  await page.getByRole("button", { name: "ドラフトを始める" }).click();
  await page.waitForSelector("button[data-card=hidden]", { timeout: 40000 });
  await settled();
}

/** 盤面に出ている形状アシストの表示（無ければ null） */
async function boardAssist() {
  const el = page.locator('[data-testid="board-shape-assist"]');
  if ((await el.count()) === 0) return null;
  return (await el.innerText()).replace(/^形状アシスト\s*/, "").trim();
}

/**
 * ボタンを押して、サーバーからの返事と描き直しが済むまで待つ。
 *
 * この画面は Server Action で動く。押した直後は前の内容がまだ出ているので、
 * すぐ次を読むと1手前の画面を見てしまう。
 * 手元のブラウザ試験（submitAndSettle）と同じ待ち方にそろえてある。
 */
async function pressAndSettle(locator) {
  const waiting = page
    .waitForResponse((r) => r.request().method() === "POST", { timeout: 30000 })
    .catch(() => null);
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click({ timeout: 30000 });
  await waiting;
  await page.waitForLoadState("networkidle").catch(() => {});
  await settled();
}

/**
 * 押したあとの「決めています…」が消えるまで待つ。
 *
 * 押されたボタンは終わるまで aria-busy が立つ（src/app/_pending.tsx）。
 * 本番はサーバーの往復が手元より遅く、通信が静かになった時点では
 * まだ前の画面のままだった。2026-09-09 の実測では、
 * 4手目で「決めています…」のまま次を読み、押せるものが無くなった。
 *
 * 待ち時間を伸ばして隠しているのではない。
 * **終わったことを示す印そのもの**を見ている。
 */
async function settled() {
  await page
    .waitForFunction(() => document.querySelectorAll('[aria-busy="true"]').length === 0, {
      timeout: 40000,
    })
    .catch(() => {});
  await page.waitForTimeout(500);
}

/** 伏せカードを全部めくって確定し、確定したお題のURLへ進む */
async function completeDraft() {
  for (let i = 0; i < 30; i += 1) {
    const decide = page.locator("button:not([disabled])", { hasText: "これに決める" });
    if ((await decide.count()) > 0) {
      await pressAndSettle(decide.first());
      continue;
    }
    const hidden = page.locator("button[data-card=hidden]:not([disabled])");
    if ((await hidden.count()) === 0) break;
    await pressAndSettle(hidden.first());
  }
  const done = page.getByRole("button", { name: "このお題で確定する" });
  await done.waitFor({ state: "visible", timeout: 30000 });
  await pressAndSettle(done);
  await page.waitForURL(/\/prompt\/[0-9a-f-]{36}/, { timeout: 40000 });
  return /\/prompt\/([0-9a-f-]{36})/.exec(page.url())[1];
}

/**
 * 確定したお題の画面に出ている形状アシストの値（無ければ null）。
 *
 * 値は太字の span だけ。同じ段落には「お題ではありません」という
 * 断り書きが続くので、段落ぜんぶを読むと値と混ざる。
 */
async function promptAssist() {
  const el = page.locator('[data-testid="prompt-shape-assist"] span');
  if ((await el.count()) === 0) return null;
  return (await el.first().innerText()).trim();
}

/**
 * そのお題の正式な語の数と保存先（DBの実測。**読むだけ**）。
 *
 * 出題される問数はここでは数えない。クイズを作る関数は
 * quiz_questions を作り直す（書き込む）ので、検査から呼ばない。
 * 問数は、作品を投稿したあとに回答者の画面で数える。
 */
async function promptFacts(promptId) {
  const db = admin();
  const cards = await db
    .from("prompt_cards")
    .select("id", { count: "exact", head: true })
    .eq("prompt_id", promptId);
  const prompt = await db.from("prompts").select("*").eq("id", promptId).single();
  const draft = await db
    .from("draft_sessions")
    .select("shape_assist_key")
    .eq("id", prompt.data?.draft_session_id)
    .single();
  // そのお題で使われている枠が、正式な枠として登録されているか。
  // 形状アシストの枠が紛れ込んでいれば、ここに現れる。
  const rows = await db.from("prompt_cards").select("card_slot_key").eq("prompt_id", promptId);
  const keys = (rows.data ?? []).map((r) => r.card_slot_key);
  const slots = await db
    .from("card_slots")
    .select("card_slot_key, is_quiz_eligible")
    .in("card_slot_key", keys.length > 0 ? keys : ["(なし)"]);
  const known = new Map((slots.data ?? []).map((r) => [r.card_slot_key, r.is_quiz_eligible]));
  return {
    cardCount: cards.count ?? 0,
    slotKeys: keys,
    unknownSlots: keys.filter((k) => !known.has(k)),
    eligibleCount: keys.filter((k) => known.get(k) === true).length,
    promptKeys: Object.keys(prompt.data ?? {}),
    savedKey: draft.data?.shape_assist_key ?? null,
  };
}

/** 作品を1件投稿して、その作品のIDを返す */
async function postWork(promptId, title) {
  const posted = await submitWork(
    s,
    promptId,
    { title, division: "original", actualTimeSeconds: "3600" },
    makePng(80, 60),
  );
  const id = /\/works\/([0-9a-f-]{36})/.exec(posted.path ?? "")?.[1];
  if (!id) throw new Error(`作品を投稿できませんでした: ${posted.path}`);
  return id;
}

/**
 * 回答者のブラウザでその作品を開き、出題の様子を読む。
 * 開くのは**この作品を作っていない別の人**。
 */
let viewerPage = null;
async function asViewer(workId) {
  if (!viewerPage) {
    const viewerSession = await fixtureSession("shape-viewer");
    const viewerCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await viewerCtx.addCookies(
      Object.entries(viewerSession.cookies()).map(([name, value]) => ({
        name,
        value,
        domain: url.hostname,
        path: "/",
        httpOnly: false,
        secure: url.protocol === "https:",
        sameSite: "Lax",
      })),
    );
    viewerPage = await viewerCtx.newPage();
  }
  await viewerPage.goto(`${BASE}/works/${workId}`, { waitUntil: "domcontentloaded" });
  await viewerPage
    .waitForFunction(
      () => {
        const t = document.querySelector("main")?.innerText ?? "";
        return t.trim().length > 0 && !t.includes("読み込み中…");
      },
      { timeout: 30000 },
    )
    .catch(() => {});
  return {
    questionCount: await viewerPage.locator("fieldset[data-question]").count(),
    choices: await viewerPage
      .locator("input[data-choice-label]")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-choice-label"))),
    text: await viewerPage.locator("body").innerText(),
    assistCount: await viewerPage.locator('[data-testid="prompt-shape-assist"]').count(),
  };
}


/** 本文のどこに出たかを、前後の文とともに返す（合格なら空文字） */
function whereIs(text, word) {
  const i = text.indexOf(word);
  if (i < 0) return "";
  return "…" + text.slice(Math.max(0, i - 140), i + 140).replace(/\s+/g, " ") + "…";
}

// ── A. 使わない ────────────────────────────────────────

section("A. 使わない");

await startDraft("none");
must((await boardAssist()) === null, "盤面に形状アシストが出ない");

const idA = await completeDraft();
must((await promptAssist()) === null, "確定したお題にも出ない");

const factsA = await promptFacts(idA);
must(factsA.cardCount > 0, "正式な語が並んでいる", `${factsA.cardCount} 語`);
must(factsA.savedKey === null, "DBにも何も入っていない", String(factsA.savedKey));

const workA = await postWork(idA, `かたち検査A ${Date.now().toString().slice(-6)}`);
const viewA = await asViewer(workA);
must(viewA.questionCount > 0, "回答者にクイズが出ている", `${viewA.questionCount} 問`);
must(
  viewA.questionCount === factsA.eligibleCount,
  "出題数が、そのお題の出題対象の枠数とぴったり同じ",
  `${viewA.questionCount} 問 / 枠 ${factsA.eligibleCount}`,
);
must(factsA.unknownSlots.length === 0, "正式でない枠が混ざっていない", factsA.unknownSlots.join(","));
must(!viewA.text.includes("形状アシスト"), "回答者の画面に「形状アシスト」の文字が出ない", whereIs(viewA.text, "形状アシスト"));

// ── B. ランダム ────────────────────────────────────────

section("B. ランダム");

// 候補の一覧は画面から読む（スクリプトに書き写さない）
await clearMyDraft();
await page.goto(`${BASE}/play`, { waitUntil: "domcontentloaded" });
await page.locator('[data-testid="shape-assist"]').waitFor({ state: "visible", timeout: 30000 });
const choices = await page
  .locator('[data-testid="shape-assist-choices"] input[name=shapeAssistKey]')
  .evaluateAll((els) => els.map((e) => e.value));
const labels = await page
  .locator('[data-testid="shape-assist-choices"] label')
  .evaluateAll((els) => els.map((e) => e.innerText.trim()));
must(choices.length >= 2, "候補が画面に並んでいる", `${choices.length} 件`);

await startDraft("random");
const bBoard = await boardAssist();
must(bBoard !== null, "盤面に1つ出る", String(bBoard));
must(labels.includes(bBoard), "出たものは画面の候補のどれか", `${bBoard}`);

const reroll = page.getByRole("button", { name: /全部引き直す/ });
must((await reroll.count()) > 0, "引き直しのボタンが出ている");
if ((await reroll.count()) > 0) {
  await pressAndSettle(reroll.first());
  await page.waitForSelector("button[data-card=hidden]", { timeout: 40000 });
  const after = await boardAssist();
  must(after === bBoard, "引き直しても同じものが残る", `${bBoard} → ${after}`);
}

await completeDraft();
const bPrompt = await promptAssist();
must(bPrompt === bBoard, "確定したお題にも同じものが出る", `${bBoard} → ${bPrompt}`);

// ── C. 自分で選ぶ ──────────────────────────────────────

section("C. 自分で選ぶ");

// 画面から読んだ候補のうち、ランダムで出たものとは別のものを選ぶ
const pickedIndex = labels.indexOf(bBoard) === 0 ? 1 : 0;
const pickedKey = choices[pickedIndex];
const pickedLabel = labels[pickedIndex];

await startDraft("pick", pickedKey);
const cBoard = await boardAssist();
must(cBoard === pickedLabel, "選んだものが盤面に出る", `${pickedLabel} → ${cBoard}`);

const idC = await completeDraft();
const cPrompt = await promptAssist();
must(cPrompt === pickedLabel, "確定したお題にも同じものが出る", `${pickedLabel} → ${cPrompt}`);

const factsC = await promptFacts(idC);
must(factsC.savedKey === pickedKey, "DBのドラフトに、選んだ値が入っている", `${factsC.savedKey}`);
must(
  !factsC.promptKeys.includes("shape_assist_key"),
  "お題そのものには入っていない（ドラフト側だけが持つ）",
  factsC.promptKeys.join(","),
);

// ── D. 非干渉 ─────────────────────────────────────────

section("D. 非干渉");

// 語の顔ぶれは抽選で決まるので、2つのお題の語数を突き合わせても意味がない
// （2026-09-09 の実測: 使わない側 4 語、選んだ側 3 語。どちらも正式な枠だけ）。
// 見るべきは「そのお題の中で辻褄が合っているか」。
must(
  factsC.unknownSlots.length === 0,
  "正式でない枠が混ざっていない",
  `枠 [${factsC.slotKeys.join(" ")}]`,
);

// 回答者の画面に出ないこと。
// **作品を実際に投稿して、別の人のブラウザで開いて確かめる。**
// 投稿した作品は finish() が消す。
const workC = await postWork(idC, `かたち検査C ${Date.now().toString().slice(-6)}`);
const viewC = await asViewer(workC);

must(
  viewC.questionCount === factsC.eligibleCount,
  "形状アシストのぶん、出題が1問も増えていない",
  `${viewC.questionCount} 問 / 出題対象の枠 ${factsC.eligibleCount}`,
);
must(!viewC.text.includes("形状アシスト"), "回答者の画面に「形状アシスト」の文字が出ない", whereIs(viewC.text, "形状アシスト"));
must(viewC.assistCount === 0, "回答者の画面に形状アシストの欄が無い");
must(
  !viewC.choices.includes(pickedLabel),
  "クイズの選択肢に、選んだ語が出ない",
  `${pickedLabel} / 選択肢 ${viewC.choices.length} 件`,
);

// 選んだ語そのものが本文に漏れていないか。
// 正式なタグに同じ語があると区別できないので、そのときは語での判定をしない。
const sameNamedTag = await admin().from("tags").select("id").eq("label", pickedLabel).limit(1);
if ((sameNamedTag.data ?? []).length === 0) {
  must(!viewC.text.includes(pickedLabel), "回答者の画面に、選んだ語そのものが出ない", pickedLabel);
} else {
  must(true, `「${pickedLabel}」は正式なタグにもある語なので、語での判定は行わない`);
}

// 持ち込み（art_first）には欄そのものが無い
await page.goto(`${BASE}/works/import`, { waitUntil: "domcontentloaded" });
must(
  (await page.locator('[data-testid="shape-assist"]').count()) === 0,
  "持ち込みの画面に形状アシストの欄が無い",
);
must(
  (await page.locator("input[name=shapeAssistMode]").count()) === 0,
  "持ち込みの画面に形状アシストの操作が無い",
);

// ── 片づけ ───────────────────────────────────────────

section("片づけ");

await clearMyDraft();
const left = await admin()
  .from("draft_sessions")
  .select("id", { count: "exact", head: true })
  .eq("user_id", USER_ID)
  .eq("status", "in_progress");
must((left.count ?? 0) === 0, "進行中のドラフトを残していない", `${left.count ?? 0} 件`);

await browser.close();
await finish();
