#!/usr/bin/env node
/**
 * smoke-sub-directive.mjs ／ サブ指令を本番で往復させる（D193）
 *
 * 【なぜ手元のブラウザ試験と別に要るか】
 *   手元の試験（S2群・S3群）は擬似の Supabase を相手にしている。
 *   本番では次の2つを、本物のブラウザと本物のDBで通す必要がある。
 *
 *   1. カードを決めると、サーバーだけが持つ鍵で別の窓口へ書きに行く経路が
 *      本当に通ること（手元では鍵も窓口も擬似のもの）
 *   2. その窓口が、本物の利用者の証明書では**呼べない**こと
 *
 * 【何を通すか】
 *   A. 通常     … お題を引いて確定できる
 *   B. 対象語   … 対応表にある語を引くと、盤面にサブ指令が出る
 *   C. 確定     … 確定したお題に同じものが出る
 *   D. 読み直し … 再読み込みしても同じ
 *   E. 引き直し … 引き直すと、いまの世代に古い値が残らない
 *   F. なし     … サブ指令が付かない枠でも正常に進む
 *   G. 回答者   … 回答者の画面にも通信にも出ない
 *   H. 出題     … 問数が変わらず、選択肢にも出ず、正解判定も動く
 *   I. 持ち込み … サブ指令が付かない。画面にも欄が無い
 *   J. 改ざん   … 本物の証明書で偽の鍵を保存できない
 *
 * 【この検査が触るもの】
 *   検査用の固定利用者が出す作品とお題、そのドラフト、その作品への回答だけ。
 *   終わったら、この実行が作った作品・お題・ドラフトを ID で名指しして消す
 *   （回答は作品と一緒に消える）。作者名でまとめて消すことはしない。
 *   他人の作品・プロフィール・回答には触れない。
 *
 * 【割合は数えない】
 *   付くのは70%だが、ここで何百回も引いて割合を確かめない。
 *   「付く」経路と「付かない」経路の両方が正常に進むことだけを見る。
 *   70/30 そのものは、乱数を固定して手元の S3 群で確かめている。
 *
 * 【使い方】
 *   本番: SMOKE_BASE_URL=https://<本番> npm run smoke:prod -- sub-directive
 */

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

import {
  BASE,
  accountUserId,
  finish,
  fixtureSession,
  forms,
  makePng,
  must,
  parseQuiz,
  section,
  submitWork,
  targetEnv,
} from "./_smoke-http.mjs";
import {
  cleanupRunRows,
  createRunLedger,
  describeCleanup,
  supabaseRemover,
} from "./_smoke-own-rows.mjs";

import { SUB_DIRECTIVES, subDirectiveLabel } from "../src/features/modifier/types.ts";

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

/** この実行が作った作品・お題・ドラフトの ID。後片づけはここに積んだものだけを消す */
const run = createRunLedger();

/** 対応表にある正式な語（24語）。**ここで書き写さない。**表そのものから作る */
const COVERED = new Set(SUB_DIRECTIVES.flatMap((d) => d.forTagLabels));
/** 対応表にある表示文ぜんぶ。回答者の画面へ出ていないことを見るのに使う */
const ALL_LABELS = SUB_DIRECTIVES.map((d) => d.label);

const url = new URL(BASE);
const browser = await chromium.launch();

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

const author = await browserFor("subdir-author");
const guesser = await browserFor("subdir-guesser");

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

/** 押してから、画面が落ち着くまで待つ */
async function press(locator) {
  const started = Date.now();
  await locator.click();
  await author.page
    .waitForFunction(() => document.querySelectorAll('[aria-busy="true"]').length === 0, {
      timeout: 40000,
    })
    .catch(() => {});
  await bodyOf(author.page);
  return Date.now() - started;
}

/**
 * カードを1枚引くのにかかった時間。2往復になったことの影響を見る。
 *
 * P0 で「めくる → これに決める」の2段が無くなり、**伏せカードを1回押すと
 * その枠が決まる**ようになった。決める操作はこの1押しなので、ここを測る。
 * 以前は「これに決める」を押した時間を測っていて、そのボタンが消えたあと
 * 1回も測れず、検査だけが落ちていた（2026-09-10 の実測）。
 */
const chooseTimes = [];

/** 進行中のドラフトを片づけてから、新しく1つ始める */
async function startFreshDraft() {
  await admin()
    .from("draft_sessions")
    .update({ status: "abandoned", abandoned_at: new Date().toISOString() })
    .eq("user_id", author.userId)
    .eq("status", "in_progress");

  await author.page.goto(`${BASE}/play`, { waitUntil: "domcontentloaded" });
  await author.page.waitForSelector("select[name=timeLimitSeconds]", { timeout: 30000 });
  await author.page.selectOption("select[name=timeLimitSeconds]", "3600");
  await author.page.getByRole("button", { name: "ドラフトを始める" }).click();
  await author.page.waitForSelector("button[data-card=hidden]", { timeout: 40000 });

  // いま始めたドラフトを帳面に積む（直前に進行中のものは全部止めてあるので、これ1つ）
  const started = await currentSession();
  if (started) run.add("draft_sessions", started.id);
}

/**
 * 盤面を最後まで進める。
 *
 * P0 以後、押せるのは伏せカードだけ。**1回押すとその枠が決まる。**
 * 引く前にどれになるかは選べないので、seekCovered は「どの枠から先に
 * 引くか」を変えるだけになった。対応表の語に当たるかどうかは運で、
 * 当たったかどうかは引いたあとに盤面を読んで確かめる。
 */
async function playBoard({ seekCovered } = {}) {
  void seekCovered;
  for (let guard = 0; guard < 60; guard += 1) {
    const hidden = author.page.locator("button[data-card=hidden]:not([disabled])");
    if ((await hidden.count()) === 0) break;
    chooseTimes.push(await press(hidden.first()));
  }
}

/** いま盤面に出ているサブ指令（枠 → 表示文） */
async function boardDirectives() {
  const pairs = await author.page
    .locator('[data-testid="board-sub-directive"]')
    .evaluateAll((els) =>
      els.map((e) => [
        e.getAttribute("data-sub-directive-for"),
        e.innerText.replace(/^└\s*/, "").trim(),
      ]),
    );
  return Object.fromEntries(pairs);
}

/** 確定したお題に出ているサブ指令（枠 → 表示文） */
async function promptDirectives() {
  const pairs = await author.page
    .locator('[data-testid="prompt-sub-directive"]')
    .evaluateAll((els) =>
      els.map((e) => [
        e.getAttribute("data-sub-directive-for"),
        e.innerText.replace(/^└\s*/, "").trim(),
      ]),
    );
  return Object.fromEntries(pairs);
}

/**
 * 対応表の語を引き当てて、サブ指令が出るまでやり直す。
 *
 * 【なぜ何度もやり直すのか】
 *   P0 以後、引く前にどのカードになるかは選べない。対応表にあるのは
 *   語彙のうち24語で、当たっても付くのは7割。**1回のドラフトで当たる
 *   保証は無い。**だから当たるまで引き直す。
 *
 * 【回数の決め方】
 *   1回のドラフトで3〜4枠を引くので、25回で75〜100枚。
 *   以前は10回で、10回とも外れて検査だけが落ちたことがある
 *   （2026-09-10 の実測。同じ日の別の実行では4回目で当たっていた）。
 *   割合そのものは手元の S3 群が乱数を固定して見ているので、
 *   ここは「当たれば出る」ことだけを見る。
 */
async function drawUntilDirective(tries = 25) {
  let drawn = 0;
  for (let i = 0; i < tries; i += 1) {
    await startFreshDraft();
    const before = chooseTimes.length;
    await playBoard();
    drawn += chooseTimes.length - before;
    const found = await boardDirectives();
    if (Object.keys(found).length > 0) return { attempt: i + 1, drawn, found };
  }
  return { attempt: tries, drawn, found: {} };
}

/** いま進行中のドラフトの id と世代 */
async function currentSession() {
  const { data } = await admin()
    .from("draft_sessions")
    .select("id,current_generation")
    .eq("user_id", author.userId)
    .eq("status", "in_progress")
    .limit(1);
  return data?.[0] ?? null;
}

const stamp = Date.now().toString().slice(-6);

// ── A / F. 通常のお題 ───────────────────────────────────

section("A. 通常のお題を引いて確定できる（F. 付かない枠でも進む）");

await startFreshDraft();
await playBoard({ seekCovered: false });

const plainBoard = await boardDirectives();
const confirm = author.page.getByRole("button", { name: "このお題で確定する" });
must(await confirm.isVisible(), "確定ボタンが出た");
await press(confirm);
await author.page.waitForURL("**/prompt/**", { timeout: 40000 });

const plainPromptId = /\/prompt\/([0-9a-f-]{36})/.exec(author.page.url())?.[1] ?? null;
must(Boolean(plainPromptId), "お題を確定できた", author.page.url());
run.add("prompts", plainPromptId);

const plainCards = await author.page.locator("[data-prompt-card]").count();
must(plainCards >= 3, "正式な語がそろって出ている", `${plainCards} 語`);

// 付かない枠が1つでもあること（＝「なし」でも壊れない）。
// 語をえり好みせずに引いているので、対応表に無い語が必ず混ざる。
const plainRows = await admin()
  .from("prompt_cards")
  .select("card_slot_key,sub_directive_key,tag_id")
  .eq("prompt_id", plainPromptId);
const withoutDirective = (plainRows.data ?? []).filter((r) => r.sub_directive_key === null);
must(
  withoutDirective.length > 0,
  "サブ指令が付かない枠があっても、お題は成立している",
  `${withoutDirective.length} / ${plainRows.data?.length} 枠が「なし」`,
);
must(
  Object.keys(plainBoard).length <= plainCards,
  "盤面に出たサブ指令は枠数を超えない",
  `${Object.keys(plainBoard).length} 件`,
);

// ── E. 引き直し ────────────────────────────────────────

section("E. 引き直すと、いまの世代に古いサブ指令が残らない");

const rerollDraw = await drawUntilDirective();
must(
  Object.keys(rerollDraw.found).length > 0,
  "対応表の語を引いて、盤面にサブ指令が出た",
  `${rerollDraw.attempt} 回目 / ${JSON.stringify(rerollDraw.found)}`,
);

const beforeReroll = await currentSession();
const rerollButton = author.page.getByRole("button", { name: /引き直す/ });
if (Object.keys(rerollDraw.found).length > 0 && (await rerollButton.count()) > 0) {
  await press(rerollButton.first());

  const afterBoard = await boardDirectives();
  must(Object.keys(afterBoard).length === 0, "引き直した盤面にサブ指令が出ていない",
    JSON.stringify(afterBoard));

  const after = await currentSession();
  must(
    after !== null && after.current_generation > (beforeReroll?.current_generation ?? 0),
    "世代が1つ進んだ",
    `${beforeReroll?.current_generation} → ${after?.current_generation}`,
  );

  if (after) {
    const { data } = await admin()
      .from("draft_session_slots")
      .select("card_slot_key,sub_directive_key")
      .eq("session_id", after.id)
      .eq("generation", after.current_generation);
    const carried = (data ?? []).filter((r) => r.sub_directive_key !== null);
    must(carried.length === 0, "新しい世代へ持ち越されていない", `${carried.length} 件`);
  }
}

// ── B / C / D. 表示 ────────────────────────────────────

section("B. 対応表の語を引くと、盤面にサブ指令が出る");

const draw = await drawUntilDirective();
const onBoard = draw.found;
must(Object.keys(onBoard).length > 0, "盤面にサブ指令が出た",
  `${draw.attempt} 回目 / ${draw.drawn} 枚引いた / ${JSON.stringify(onBoard)}`);

// 出ているのが対応表の表示文であること（鍵がそのまま出ていない）
for (const [slot, text] of Object.entries(onBoard)) {
  must(ALL_LABELS.includes(text), `${slot} の文言が対応表のもの`, text);
  must(!/^[a-z0-9_]+$/.test(text), `${slot} に鍵がそのまま出ていない`, text);
}

// どの語に付いたのかを、DB から突き合わせる
const liveSession = await currentSession();
let confirmedPairs = [];
if (liveSession) {
  const { data } = await admin()
    .from("draft_session_slots")
    .select("card_slot_key,sub_directive_key")
    .eq("session_id", liveSession.id)
    .eq("generation", liveSession.current_generation)
    .not("sub_directive_key", "is", null);
  const cand = await admin()
    .from("draft_candidates")
    .select("card_slot_key,tag_id")
    .eq("session_id", liveSession.id)
    .eq("generation", liveSession.current_generation)
    .eq("is_chosen", true);
  const tagIds = (cand.data ?? []).map((c) => c.tag_id);
  const tags = await admin().from("tags").select("id,label").in("id", tagIds);
  const labelOf = new Map((tags.data ?? []).map((t) => [t.id, t.label]));
  const slotTag = new Map((cand.data ?? []).map((c) => [c.card_slot_key, labelOf.get(c.tag_id)]));

  confirmedPairs = (data ?? []).map((r) => ({
    slot: r.card_slot_key,
    tag: slotTag.get(r.card_slot_key),
    key: r.sub_directive_key,
    label: subDirectiveLabel(r.sub_directive_key),
  }));

  for (const p of confirmedPairs) {
    must(COVERED.has(p.tag), `「${p.tag}」は対応表にある語`, p.tag ?? "");
    must(
      SUB_DIRECTIVES.some((d) => d.key === p.key && d.forTagLabels.includes(p.tag)),
      `「${p.tag}」に付いたのは、その語の候補`,
      `${p.key}（${p.label}）`,
    );
  }
}

section("C. 確定すると、同じサブ指令が作者のお題に出る");

const confirm2 = author.page.getByRole("button", { name: "このお題で確定する" });
await press(confirm2);
await author.page.waitForURL("**/prompt/**", { timeout: 40000 });
const promptId = /\/prompt\/([0-9a-f-]{36})/.exec(author.page.url())?.[1] ?? null;
must(Boolean(promptId), "お題を確定できた", author.page.url());
run.add("prompts", promptId);

const onPrompt = await promptDirectives();
for (const [slot, text] of Object.entries(onBoard)) {
  must(onPrompt[slot] === text, `${slot} が盤面と同じ`, `盤面「${text}」／お題「${onPrompt[slot]}」`);
}
const notes = await author.page.locator('[data-testid="sub-directive-note"]').count();
must(notes === 1, "断り書きが1度だけ出ている", `${notes} 件`);

section("D. 読み込み直しても同じ");

await author.page.reload({ waitUntil: "domcontentloaded" });
await bodyOf(author.page);
const again = await promptDirectives();
for (const [slot, text] of Object.entries(onPrompt)) {
  must(again[slot] === text, `${slot} が読み込み直しても同じ`, `${again[slot]}`);
}

// ── G / H. 回答者と出題 ─────────────────────────────────

section("G. 回答者にはサブ指令が出ない ／ H. 出題は変わらない");

const { forms: formsOf } = await import("./_smoke-http.mjs");

// 作品の投稿は、他のスモークと同じ道を通す（同意欄の有無も向こうが見る）
const posted = await submitWork(
  author.s,
  promptId,
  { title: `サブ指令検査 ${stamp}`, division: "original", actualTimeSeconds: "3600" },
  makePng(80, 60),
);
const workId = /\/works\/([0-9a-f-]{36})/.exec(posted.path ?? "")?.[1] ?? null;
must(Boolean(workId), "作品を投稿できた", String(workId));
run.add("works", workId);

/** 回答者が出した回答。作品と一緒に消えたことを、後片づけで ID で確かめる */
let answerId = null;

let seenKeys = [];
if (workId) {
  // 回答者の窓が受け取った通信を、ぜんぶ覗いておく
  const bodies = [];
  guesser.page.on("response", async (r) => {
    try {
      const ct = r.headers()["content-type"] ?? "";
      if (/json|html|text/.test(ct)) bodies.push(await r.text());
    } catch {
      /* 読めない応答は飛ばす */
    }
  });

  await guesser.page.goto(`${BASE}/works/${workId}`, { waitUntil: "domcontentloaded" });

  // **同意の関門で止まっていないこと（P5）。**
  // 止まっていると出題の枠が1つも無く、下の待ち合わせが時間切れで落ちる。
  // 落ちると後片づけまで届かず、本番に検査用の作品が残る。
  // 2026-09-10 の本番切り替えで実際にそうなった。先に見て、先に言う。
  must(
    (await guesser.page.locator("[data-consent-gate]").count()) === 0,
    "回答者が同意の関門で止まっていない",
    guesser.page.url(),
  );

  // 出題の数は、**ブラウザの見た目からは数えない。**
  //
  // P1 で回答の画面が1セクションずつ進む形になった（_answer.tsx）。
  // JavaScript が動くときに見えているのは、いま開いている1セクションだけ。
  // 全部を並べる古い形（QuizForm）は <noscript> の中にあり、
  // ブラウザはその中身を要素として読まない。だから
  // `fieldset[data-question]` を数えると 0 問になる。
  // 2026-09-10 に、この 0 を「出題が壊れた」と読み違えた。
  //
  // 数がそろっているのは、通信で受け取った HTML のほう。同じ人の Cookie で読む。
  const guessRaw = await guesser.s.get(`/works/${workId}`);
  const guessQuiz = parseQuiz(guessRaw.html);
  const questionCount = guessQuiz.length;

  // いま画面に出ている段の総数。上の数と食い違えば、どちらかが違う
  const sectionTotal = Number(
    (await guesser.page
      .locator("[data-section-total]")
      .first()
      .getAttribute("data-section-total")
      .catch(() => null)) ?? 0,
  );

  const eligible = await admin()
    .rpc("get_work_quiz", { p_work_id: workId })
    .then((r) => (r.data?.questions ?? []).length)
    .catch(() => null);

  const cardRows = await admin()
    .from("prompt_cards")
    .select("card_slot_key,sub_directive_key")
    .eq("prompt_id", promptId);
  const withKey = (cardRows.data ?? []).filter((r) => r.sub_directive_key !== null);
  seenKeys = withKey.map((r) => r.sub_directive_key);

  must(withKey.length > 0, "確定したお題にサブ指令が入っている", `${withKey.length} 件`);
  must(questionCount > 0, "回答者にクイズが出た", `${questionCount} 問`);
  must(sectionTotal === questionCount, "画面に出ている段数と、出題数が同じ",
    `画面 ${sectionTotal} 段 / 出題 ${questionCount} 問`);
  if (eligible !== null) {
    must(questionCount === eligible, "問数がDB側と一致", `画面 ${questionCount} / DB ${eligible}`);
  }

  const guessBody = await guesser.page.locator("main").innerText();
  const guessHtml = await guesser.page.content();
  for (const key of seenKeys) {
    must(!guessHtml.includes(key), "回答者の画面に鍵が出ていない", key);
  }
  const leakedLabels = ALL_LABELS.filter((l) => guessBody.includes(l));
  must(leakedLabels.length === 0, "回答者の画面に表示文が1つも出ていない", leakedLabels.join(","));
  must(!/sub_directive/.test(guessHtml), "回答者の画面に列の名前が出ていない");

  // 答えて、採点が動くこと。
  //
  // **押し方はここの本題ではない。**新しい画面は「長押しで確定して次の段へ」
  // という指の操作で、それを機械に真似させると、押し方が変わるたびに
  // サブ指令の検査が落ちる。答え方そのものは smoke:cutover と手元の
  // ブラウザ試験が見ている。ここは通信で1回答えて、
  // **答えたあとの画面と通信に漏れが無いか**へ進む。
  const answerForm = forms(guessRaw.html).find((f) => /回答する/.test(f.text));
  must(!!answerForm?.actionId, "回答の口がある");
  if (answerForm?.actionId) {
    const fields = { [answerForm.actionId]: "", workId };
    for (const q of guessQuiz) fields[q.name] = q.choices[0].tagId;
    await guesser.s.post(`/works/${workId}`, fields);
  }

  // 答えたあとの画面を、ブラウザでもう一度開き直す（通信も拾い直す）
  await guesser.page.reload({ waitUntil: "domcontentloaded" });
  await guesser.page
    .waitForFunction(() => document.querySelectorAll('[aria-busy="true"]').length === 0, {
      timeout: 40000,
    })
    .catch(() => {});

  const answered = await admin()
    .from("answers")
    .select("id,correct_count", { count: "exact" })
    .eq("work_id", workId);
  must((answered.count ?? 0) === 1, "回答がDBに1件入った", `${answered.count} 件`);
  answerId = answered.data?.[0]?.id ?? null;
  must(
    answered.data?.[0]?.correct_count !== null && answered.data?.[0]?.correct_count !== undefined,
    "正解数が付いている（採点が動いた）",
    String(answered.data?.[0]?.correct_count),
  );

  const afterHtml = await guesser.page.content();
  const leakedAfter = [...seenKeys, ...ALL_LABELS].filter((v) => afterHtml.includes(v));
  must(leakedAfter.length === 0, "答えたあとの画面にも出ていない", leakedAfter.join(","));

  const leakedWire = bodies.filter((b) =>
    seenKeys.some((k) => b.includes(k)) || b.includes("sub_directive"),
  );
  must(leakedWire.length === 0, "回答者の通信にも出ていない", `${leakedWire.length} 本`);
}

// ── I. 持ち込み ────────────────────────────────────────

section("I. 持ち込み（art_first）には付かない");

const importPage = await author.s.get("/works/import");
must(
  !/sub-directive|sub_directive/.test(importPage.html),
  "持ち込みの画面にサブ指令の欄が無い",
);

const vocab = await admin().rpc("get_art_first_vocabulary");
const artIds = (vocab.data?.categories ?? [])
  .map((cat) => cat.tags?.[0]?.id)
  .filter((id) => typeof id === "number")
  .slice(0, 3);
must(artIds.length === 3, "持ち込みに使う語を3つ選べた", `${artIds.length} 件`);

const importForm = formsOf(importPage.html).find((f) => f.fields.tagIds !== undefined);
let artWorkId = null;
if (importForm?.actionId && artIds.length === 3) {
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
      title: `サブ指令検査・持ち込み ${stamp}`,
      division: "original",
      tagIds: artIds.join(","),
    },
    { field: "image", bytes: makePng(80, 60), name: "subdir-art.png", type: "image/png" },
  );
  artWorkId = /\/works\/([0-9a-f-]{36})/.exec(artPosted.path ?? "")?.[1] ?? null;
  must(Boolean(artWorkId), "持ち込みの作品を出せた", artPosted.path ?? "");
}

if (artWorkId) {
  run.add("works", artWorkId);
  const w = await admin().from("works").select("prompt_id").eq("id", artWorkId).single();
  // 持ち込みは、作品と同時にお題が1件できる。そのお題も帳面に積む
  run.add("prompts", w.data?.prompt_id);
  must(Boolean(w.data?.prompt_id), "持ち込みのお題を特定できた", w.error?.message ?? "");
  const artCards = await admin()
    .from("prompt_cards")
    .select("card_slot_key,sub_directive_key")
    .eq("prompt_id", w.data?.prompt_id);
  const filled = (artCards.data ?? []).filter((r) => r.sub_directive_key !== null);
  must((artCards.data ?? []).length > 0, "持ち込みのカードがある", `${artCards.data?.length} 枚`);
  must(filled.length === 0, "持ち込みのカードは1枚も付いていない", `${filled.length} 件`);
}

// ── J. 改ざん ──────────────────────────────────────────

section("J. 本物の証明書では、偽の鍵を保存できない");

// ここは**本物の攻撃と同じ道**を通る。
// ブラウザの中にある証明書は取り出せるので、それと同じものを
// 合言葉から取り直し、REST の窓口を直接叩く。
const { ensureFixtureUser } = await import("./_smoke-users.mjs");
const authorUser = await ensureFixtureUser("subdir-author");

const tokenRes = await fetch(
  `${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/token?grant_type=password`,
  {
    method: "POST",
    headers: {
      apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: authorUser.email, password: authorUser.password }),
  },
);
const token = (await tokenRes.json())?.access_token ?? null;
must(Boolean(token), "利用者の証明書を取り出せた（攻撃側の前提）");

// 攻撃の的にする、進行中のドラフトを1つ用意する
await startFreshDraft();
await playBoard({ seekCovered: false });
const target = await currentSession();
must(Boolean(target), "的にするドラフトがある", String(target?.id));

let targetSlot = null;
let targetTag = null;
if (target) {
  const { data } = await admin()
    .from("draft_candidates")
    .select("card_slot_key,tag_id")
    .eq("session_id", target.id)
    .eq("generation", target.current_generation)
    .eq("is_chosen", true)
    .limit(1);
  targetSlot = data?.[0]?.card_slot_key ?? null;
  targetTag = data?.[0]?.tag_id ?? null;
}

async function asUser(path, init) {
  return fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

if (token && target && targetSlot) {
  // 1つめ。書く窓口を、自分の正しいドラフトあてに、自分で呼ぶ
  const rpcRes = await asUser("/rest/v1/rpc/set_draft_slot_sub_directive", {
    method: "POST",
    body: JSON.stringify({
      p_user_id: author.userId,
      p_session_id: target.id,
      p_generation: target.current_generation,
      p_card_slot_key: targetSlot,
      p_tag_id: targetTag,
      p_sub_directive_key: "fake_modifier",
    }),
  });
  const rpcText = await rpcRes.text();
  must(rpcRes.status >= 400, "書く窓口を利用者として呼べない", `${rpcRes.status} ${rpcText.slice(0, 90)}`);

  // 2つめ。表そのものへ直接書く
  const patchRes = await asUser(
    `/rest/v1/draft_session_slots?session_id=eq.${target.id}&card_slot_key=eq.${targetSlot}`,
    { method: "PATCH", body: JSON.stringify({ sub_directive_key: "fake_modifier" }) },
  );
  const patchText = await patchRes.text();
  must(
    patchRes.status >= 400 || patchText === "" || patchText === "[]",
    "表へ直接書けない",
    `${patchRes.status} ${patchText.slice(0, 90)}`,
  );

  // 3つめ。昔あった「カードを決めながら渡す」形
  const oldRes = await asUser("/rest/v1/rpc/choose_card", {
    method: "POST",
    body: JSON.stringify({
      p_session_id: target.id,
      p_card_slot_key: targetSlot,
      p_candidate_index: 0,
      p_sub_directive_key: "fake_modifier",
    }),
  });
  const oldText = await oldRes.text();
  must(oldRes.status >= 400, "4引数の窓口は存在しない", `${oldRes.status} ${oldText.slice(0, 90)}`);

  // 結果。1件も入っていないこと
  const { data: forged } = await admin()
    .from("draft_session_slots")
    .select("card_slot_key,sub_directive_key")
    .eq("session_id", target.id)
    .eq("sub_directive_key", "fake_modifier");
  must((forged ?? []).length === 0, "偽の鍵が1件も入っていない", `${forged?.length} 件`);
}

// ── 7. 速さ ────────────────────────────────────────────

section("速さ（カードを1枚引く操作。2往復になったことの影響）");

if (chooseTimes.length > 0) {
  const sorted = [...chooseTimes].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const max = sorted[sorted.length - 1];
  console.log(`  中央値 ${median}ms ／ 最大 ${max}ms ／ ${chooseTimes.length} 回`);
  must(max < 15000, "引く操作が待たされていない", `最大 ${max}ms`);
} else {
  must(false, "引く操作の時間を測れなかった（伏せカードを1回も押していない）");
}

// ── 後片づけ ──────────────────────────────────────────

section("後片づけ");

// 【この実行が作った行だけを、ID で名指しして消す】
//   以前はお題を「この作者のもの全部」で消していた。同じ作者の古いお題に
//   作品の行が残っていると外部キーに断られ、1文まるごと失敗して今回のお題も
//   残った。しかも結果を見ずに合格と数えていた（2026-09-10 の本番で6件残った）。
//   いまは帳面の ID だけを消し、1件でも消えなければ理由と ID を出して不合格にする。
const CLEANUP_LABEL = {
  works: "検査で出した作品を消した",
  prompts: "検査で確定したお題を消した",
  draft_sessions: "検査で作ったドラフトを消した",
};
for (const r of await cleanupRunRows(run, supabaseRemover(admin()))) {
  must(r.ok, CLEANUP_LABEL[r.table], describeCleanup(r));
}

// 回答は作品と一緒に消える（answers.work_id は on delete cascade）。消えたことを ID で見る
if (answerId) {
  const left = await admin()
    .from("answers")
    .select("id", { count: "exact", head: true })
    .eq("id", answerId);
  must(
    !left.error && left.count === 0,
    "検査の回答が作品と一緒に消えた",
    left.error ? left.error.message : `${left.count} 件残り`,
  );
}

// 回答の集計は、作品を消しても減らない（作品の削除は集計を触らない）。
// **残すと DB verify の A20・A22 が落ちる。**答えた人のぶんだけ戻す。
const stillAnswered = await admin()
  .from("answers")
  .select("id", { count: "exact", head: true })
  .eq("user_id", guesser.userId);
if ((stillAnswered.count ?? 0) === 0) {
  await admin().from("user_slot_stats").delete().eq("user_id", guesser.userId);
  await admin().from("user_stats").delete().eq("user_id", guesser.userId);
  must(true, "回答の集計を戻した（回答が0件になったため）");
} else {
  must(false, "回答が残っているので集計を戻せない", `${stillAnswered.count} 件`);
}

await browser.close();
await finish();
