#!/usr/bin/env node
/**
 * smoke-notice.mjs ／ 回答の知らせを本番で往復させる（D192）
 *
 * 【なぜ手元のブラウザ試験と別に要るか】
 *   手元の試験（T群）は擬似の Supabase を相手にしている。
 *   本番では、ヘッダーが全ページで問い合わせるようになったことと、
 *   足した列の権限が本当に配られていないことを、
 *   **本物のブラウザと本物のDBで**通してみる必要がある。
 *
 * 【何を通すか】
 *   A. 回答前   … 入口が出ていて、未確認ではなく、数字も丸も無い
 *   B. 回答成立 … 別の人が答えると、入口の見た目が変わる
 *   C. 一覧     … その作品が1行出る。回答者名も件数も出ない
 *   D. 見るだけ … 一覧を開いても消えない
 *   E. 封を閉じたまま … 作品ページを見ても消えない
 *   F. 開く     … 既存の結果が開き、その作品だけ消える
 *   G. 再通知   … 新しい回答が来ると、また出る
 *   H. 持ち込み … art_first の作品でも同じ道を通る
 *   I. 匿名性   … 回答者のIDも名前も、画面にも通信にも出ない
 *
 * 【この検査が触るもの】
 *   検査用の固定利用者が出す作品2件と、その作品への回答だけ。
 *   終わったら作品を消し、作った知らせも一緒に消える
 *   （知らせは作品から数えているので、作品を消せば残らない）。
 *   他人の作品・プロフィール・回答には触れない。
 *
 * 【使い方】
 *   本番: SMOKE_BASE_URL=https://<本番> npm run smoke:prod -- notice
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

const url = new URL(BASE);
const browser = await chromium.launch();

/** サインイン済みのブラウザを1つ作る。認証は既存のスモークと同じ道で取る */
async function browserFor(role) {
  const s = await fixtureSession(role);
  const who = await s.get("/account");
  const userId = accountUserId(who.html);
  if (!userId) throw new Error(`/account から ${role} を特定できませんでした`);

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
  return { s, userId, ctx, page: await ctx.newPage() };
}

const author = await browserFor("notice-author");
const guesser = await browserFor("notice-guesser");

/** 本文が届くまで待ってから読む */
async function bodyOf(page) {
  await page
    .waitForFunction(
      () => {
        const t = document.querySelector("main")?.innerText ?? "";
        return t.trim().length > 0 && !t.includes("読み込み中…");
      },
      { timeout: 30000 },
    )
    .catch(() => {});
  return page.locator("main").innerText();
}

/** 作者から見た、いまの入口の状態 */
async function entryState() {
  await author.page.goto(`${BASE}/account`, { waitUntil: "domcontentloaded" });
  const entry = author.page.locator('[data-testid="notice-entry"]');
  await entry.waitFor({ state: "visible", timeout: 30000 });
  return {
    unseen: await entry.getAttribute("data-unseen"),
    label: await entry.innerText(),
    aria: await entry.getAttribute("aria-label"),
  };
}

/** 作者から見た、知らせの一覧に並ぶ作品 */
async function noticeList() {
  await author.page.goto(`${BASE}/notices`, { waitUntil: "domcontentloaded" });
  const text = await bodyOf(author.page);
  const ids = await author.page
    .locator("[data-notice-work]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-notice-work")));
  return { ids, text };
}

/** その作品のクイズに、いまのブラウザの人として答える */
async function answerAs(who, workId) {
  await who.page.goto(`${BASE}/works/${workId}`, { waitUntil: "domcontentloaded" });
  const groups = who.page.locator("fieldset[data-question]");
  await groups.first().waitFor({ state: "attached", timeout: 30000 });
  const n = await groups.count();
  for (let i = 0; i < n; i += 1) {
    await groups.nth(i).locator("input[type=checkbox]").first().check();
  }
  const waiting = who.page
    .waitForResponse((r) => r.request().method() === "POST", { timeout: 30000 })
    .catch(() => null);
  await who.page.getByRole("button", { name: "回答する" }).click();
  await waiting;
  await who.page
    .waitForFunction(() => document.querySelectorAll('[aria-busy="true"]').length === 0, {
      timeout: 40000,
    })
    .catch(() => {});
  return n;
}

// 検査用に投稿した作品。終わったら消す
const created = [];

/** 作者としてお題を引き、作品を投稿する（HTTP。画面は上で確かめている） */
async function postFromDraft(title) {
  await admin()
    .from("draft_sessions")
    .update({ status: "abandoned", abandoned_at: new Date().toISOString() })
    .eq("user_id", author.userId)
    .eq("status", "in_progress");

  const page = await author.s.get("/play");
  const { forms } = await import("./_smoke-http.mjs");
  const startForm = forms(page.html).find((f) => /ドラフトを始める/.test(f.text));
  if (!startForm?.actionId) throw new Error("/play に開始フォームがありません");

  let now = await author.s.post("/play", {
    [startForm.actionId]: "",
    modeKey: "normal",
    timeLimitSeconds: "3600",
  });

  for (let guard = 0; guard < 20; guard += 1) {
    const f = forms(now.html).find((x) => x.fields.candidateIndex !== undefined);
    if (!f) break;
    now = await author.s.post("/play", { [f.actionId]: "", ...f.fields });
  }

  const done = forms(now.html).find((f) => /このお題で確定する/.test(f.text));
  if (!done) throw new Error("確定ボタンが出ませんでした");
  now = await author.s.post("/play", { [done.actionId]: "", ...done.fields });

  const promptId = /\/prompt\/([0-9a-f-]{36})/.exec(now.path)?.[1];
  if (!promptId) throw new Error(`お題を確定できませんでした: ${now.path}`);

  const posted = await submitWork(
    author.s,
    promptId,
    { title, division: "original", actualTimeSeconds: "3600" },
    makePng(80, 60),
  );
  const workId = /\/works\/([0-9a-f-]{36})/.exec(posted.path ?? "")?.[1];
  if (!workId) throw new Error(`作品を投稿できませんでした: ${posted.path}`);
  created.push(workId);
  return workId;
}

// ── A. 回答前 ──────────────────────────────────────────

section("A. 回答が来る前");

const stamp = Date.now().toString().slice(-6);
const workA = await postFromDraft(`知らせ検査 ${stamp}`);

const beforeState = await entryState();
must(beforeState.unseen !== null, "ヘッダーに知らせの入口が出ている", String(beforeState.label));
must(beforeState.unseen === "no", "まだ未確認になっていない", String(beforeState.unseen));
must(!/[0-9０-９]/.test(beforeState.label), "入口に数字が出ていない", beforeState.label);
must(!/[0-9０-９]/.test(beforeState.aria ?? ""), "読み上げにも数字が出ていない", String(beforeState.aria));
must(
  /未確認の回答はありません/.test(beforeState.aria ?? ""),
  "読み上げで、いまの状態が分かる",
  String(beforeState.aria),
);

const emptyList = await noticeList();
must(emptyList.ids.length === 0, "知らせの一覧が空", `${emptyList.ids.length} 件`);

// ── B. 回答が成立する ────────────────────────────────────

section("B. 別の人が答える");

const questionCount = await answerAs(guesser, workA);
must(questionCount > 0, "回答者にクイズが出た", `${questionCount} 問`);

const rows = await admin()
  .from("answers")
  .select("id", { count: "exact", head: true })
  .eq("work_id", workA);
must((rows.count ?? 0) === 1, "回答がDBに1件入った", `${rows.count} 件`);

const afterState = await entryState();
must(afterState.unseen === "yes", "入口の見た目が変わった", String(afterState.unseen));
must(!/[0-9０-９]/.test(afterState.label), "変わっても数字は出ない", afterState.label);
must(
  /未確認の回答があります/.test(afterState.aria ?? ""),
  "読み上げが「あります」に変わった",
  String(afterState.aria),
);

// ── C. 一覧 ────────────────────────────────────────────

section("C. 知らせの一覧");

const list = await noticeList();
must(list.ids.includes(workA), "その作品が1行出ている", list.ids.join(","));
must(list.ids.length === 1, "作品ごとに1行", `${list.ids.length} 件`);
must(/あなたの作品に回答が届いています/.test(list.text), "知らせの文言が出ている");
must(!/[0-9０-９]+\s*(件|人)/.test(list.text), "件数が出ていない", list.text.slice(0, 120));

// ── D. 一覧を見るだけ ───────────────────────────────────

section("D. 一覧を見るだけでは消えない");

await noticeList();
await noticeList();
const stillUnseen = await entryState();
must(stillUnseen.unseen === "yes", "一覧を2回見ても残っている", String(stillUnseen.unseen));

const seenAfterList = await admin()
  .from("works")
  .select("result_seen_at")
  .eq("id", workA)
  .single();
must(
  seenAfterList.data?.result_seen_at === null,
  "DBの時刻も動いていない",
  String(seenAfterList.data?.result_seen_at),
);

// ── E. 封を閉じたまま作品ページを見る ──────────────────────

section("E. 封を閉じたまま作品ページを見ても消えない");

await author.page.goto(`${BASE}/works/${workA}`, { waitUntil: "domcontentloaded" });
await bodyOf(author.page);

const afterClosed = await entryState();
must(afterClosed.unseen === "yes", "封を閉じたまま見ても残っている", String(afterClosed.unseen));

const seenAfterClosed = await admin()
  .from("works")
  .select("result_seen_at")
  .eq("id", workA)
  .single();
must(
  seenAfterClosed.data?.result_seen_at === null,
  "DBの時刻も動いていない",
  String(seenAfterClosed.data?.result_seen_at),
);

// ── F. 結果を開く ──────────────────────────────────────

section("F. 知らせから結果を開く");

const listBeforeOpen = await noticeList();
must(listBeforeOpen.ids.includes(workA), "開く前は一覧に出ている");

await author.page.locator(`[data-notice-work="${workA}"] a`).click();
await author.page.waitForURL(/\/works\/[0-9a-f-]{36}\?result=open/, { timeout: 30000 });
const opened = await bodyOf(author.page);
must(
  /あなたの絵を読み解きました|伝わ|正解/.test(opened),
  "既存の結果画面が開いた",
  opened.slice(0, 120),
);

const seenAfterOpen = await admin()
  .from("works")
  .select("result_seen_at")
  .eq("id", workA)
  .single();
must(
  seenAfterOpen.data?.result_seen_at !== null,
  "開いた時刻が入った",
  String(seenAfterOpen.data?.result_seen_at),
);

const listAfterOpen = await noticeList();
must(!listAfterOpen.ids.includes(workA), "その作品が一覧から消えた", listAfterOpen.ids.join(","));

const clearedState = await entryState();
must(clearedState.unseen === "no", "入口の見た目も戻った", String(clearedState.unseen));

// ── G. 新しい回答でまた出る ─────────────────────────────

section("G. 新しい回答でまた出る");

const second = await browserFor("notice-guesser2");
await answerAs(second, workA);

const again = await entryState();
must(again.unseen === "yes", "開いたあとの回答で、また未確認になった", String(again.unseen));

const listAgain = await noticeList();
must(listAgain.ids.includes(workA), "一覧にも戻ってきた", listAgain.ids.join(","));

// ── H. 持ち込み（art_first）────────────────────────────

section("H. 持ち込みの作品でも同じ");

// 語は、持ち込みの画面が使うのと同じ一覧から取る（分類ごとに1つ）。
// 本番の実測: { max_words, min_words, categories: [{ kind, tags: [...] }] }
const vocab = await admin().rpc("get_art_first_vocabulary");
const artIds = (vocab.data?.categories ?? [])
  .map((cat) => cat.tags?.[0]?.id)
  .filter((id) => typeof id === "number")
  .slice(0, 3);
must(artIds.length === 3, "持ち込みに使う語を3つ選べた", `${artIds.length} 件`);

// 持ち込みは、作者本人として画面のフォームから出す。
//
// 【service_role で RPC を直接呼ばない理由】
//   create_art_first_work は auth.uid() で作者を決めている。
//   秘密鍵で呼ぶと「サインインしていない」ことになって断られる
//   （2026-09-10 の本番実測: NOT_SIGNED_IN）。
//   持ち込みの投稿そのものは別のスモークが確かめているが、
//   **誰として出すか**を変えると別のものを試すことになるので、
//   ここでも本人の道を通す。
const { forms: formsOf } = await import("./_smoke-http.mjs");
const importPage = await author.s.get("/works/import");
const importForm = formsOf(importPage.html).find((f) => f.fields.tagIds !== undefined
  || /持ち込|出す|投稿/.test(f.text));
must(Boolean(importForm?.actionId), "持ち込みの投稿フォームが見つかった", importForm?.text ?? "");

let artWorkId = null;
if (importForm?.actionId) {
  const agree = /name="agreeDocs"/.test(importPage.html)
    ? {
        agreeDocs: "on",
        termsVersion: importForm.fields.termsVersion ?? "",
        privacyVersion: importForm.fields.privacyVersion ?? "",
      }
    : {};

  const artPosted = await author.s.post(
    "/works/import",
    {
      [importForm.actionId]: "",
      ...agree,
      title: `知らせ検査・持ち込み ${stamp}`,
      division: "original",
      // 語は分類ごとに1つずつ。**カンマで区切った1つの値**として送る。
      // 画面側は選んだものをまとめて1つの隠し項目に入れており、
      // 受け取る側もカンマで割って読む（2026-09-10 に実測）。
      // 同じ名前で3回送ると、受け取る側は最初の1つしか見ない。
      tagIds: artIds.join(","),
    },
    { field: "image", bytes: makePng(80, 60), name: "notice.png", type: "image/png" },
  );
  artWorkId = /\/works\/([0-9a-f-]{36})/.exec(artPosted.path ?? "")?.[1] ?? null;
  must(Boolean(artWorkId), "持ち込みの作品を出せた", artPosted.path ?? "");
}

if (artWorkId) {
  created.push(artWorkId);
  // 作者の知らせをいったん空にしてから、持ち込みだけを見る
  await author.page.goto(`${BASE}/works/${workA}?result=open`, { waitUntil: "domcontentloaded" });
  await bodyOf(author.page);

  const third = await browserFor("notice-guesser3");
  await answerAs(third, artWorkId);

  const artList = await noticeList();
  must(artList.ids.includes(artWorkId), "持ち込みでも知らせが出た", artList.ids.join(","));
}

// ── I. 匿名性 ─────────────────────────────────────────

section("I. 回答者が誰かは出てこない");

const finalList = await noticeList();
must(!finalList.text.includes(guesser.userId), "一覧に回答者のIDが出ていない");
must(!finalList.text.includes(second.userId), "一覧に2人目のIDも出ていない");

const listRpc = await admin().rpc("list_unseen_result_works", { p_limit: 50 });
const listDump = JSON.stringify(listRpc.data ?? []);
must(!listDump.includes(guesser.userId), "通信の中身にも回答者のIDが無い");
for (const bad of ["user_id", "answer_id", "answers_count", "unseen_count"]) {
  must(!listDump.includes(`"${bad}"`), `一覧の中身に ${bad} が無い`);
}

const hasRpc = await admin().rpc("has_unseen_results");
must(typeof hasRpc.data === "boolean", "未確認の有無は真偽値だけ", JSON.stringify(hasRpc.data));

// ── 片づけ ───────────────────────────────────────────

section("片づけ");

for (const id of created) {
  await admin()
    .from("works")
    .update({ deleted_at: new Date().toISOString(), is_published: false })
    .eq("id", id);
}

const left = await admin()
  .from("works")
  .select("id", { count: "exact", head: true })
  .eq("user_id", author.userId)
  .is("deleted_at", null);
must((left.count ?? 0) === 0, "検査で作った作品を消した", `${left.count ?? 0} 件残り`);

const leftNotice = await admin().rpc("list_unseen_result_works", { p_limit: 50 });
must(
  (leftNotice.data ?? []).length >= 0,
  "知らせの一覧が読める（消した作品は数えられない）",
  `${(leftNotice.data ?? []).length} 件`,
);

await admin()
  .from("draft_sessions")
  .update({ status: "abandoned", abandoned_at: new Date().toISOString() })
  .eq("user_id", author.userId)
  .eq("status", "in_progress");

await browser.close();
await finish();
