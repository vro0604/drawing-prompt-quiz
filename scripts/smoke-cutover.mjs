#!/usr/bin/env node
/**
 * smoke-cutover.mjs ／ 本番切り替えのあと、中心の動線だけを一周する
 *
 * 【なぜ既存のスモークを流さないのか】
 *   既存の11本は合わせて作品を10件以上つくる。今回の本番確認では
 *   作ってよいデータが docs/prod-runbook.md で決まっている
 *   （お題1・作品1・回答2・返歌1・保存枠・匿名1人・登録2人）。
 *   その枠に収まる形で、確かめたい動きだけを1本にまとめたのがこれ。
 *
 * 【作るもの（すべて後片づけする）】
 *   登録利用者2人（固定。メールは dpq-smoke- で始まる）
 *   匿名利用者1人 ／ お題1件 ／ 作品1件 ／ 回答2件 ／ 返歌1件 ／ 保存枠2件
 *
 * 【使い方】
 *   SMOKE_BASE_URL=https://<本番> npm run smoke:prod -- cutover
 */

import { writeFileSync, mkdirSync } from "node:fs";
import {
  BASE,
  accountUserId,
  answerWork,
  clean,
  drawPrompt,
  finish,
  forms,
  makePng,
  must,
  parseQuiz,
  section,
  session,
  fixtureSession,
  submitWork,
  textOf,
  textOutsideQuiz,
  workImageUrl,
} from "./_smoke-http.mjs";

const ids = { base: BASE, startedAt: new Date().toISOString() };
const record = (k, v) => {
  ids[k] = v;
  console.log(`      [控え] ${k} = ${JSON.stringify(v)}`);
};

console.log(`\n接続先: ${BASE}`);

// ── 道具 ───────────────────────────────────────────────

/** ボタンの文字で form を探す */
function formByText(html, re) {
  return forms(html).find((f) => re.test(f.text));
}

/** /api/challenge を素で叩く（帯が読むのと同じ窓口） */
async function challenge(s) {
  const res = await fetch(`${BASE}/api/challenge`, {
    headers: { cookie: Object.entries(s.cookies()).map(([k, v]) => `${k}=${v}`).join("; ") },
  });
  return { status: res.status, body: await res.json() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ══════════════════════════════════════════════════════
// 1. 作者（登録1人目）— お題を引く
// ══════════════════════════════════════════════════════

section("1. 作者がお題を引く（2段抽選・モーフ・状態・カラー）");

const author = await fixtureSession("cutover-author");
const authorId = accountUserId((await author.get("/account")).html);
must(!!authorId, "作者の uid が取れている", authorId ?? "");
record("authorUserId", authorId);

// 制作時間 10分。更新できるようになるのは残り 0.25T＝150秒（＝450秒後）。
const prompt = await drawPrompt(author, "normal", "600");
record("promptId", prompt.promptId);
must(!!prompt.promptId, "お題が確定した", prompt.promptId);

const promptPage = await author.get(`/prompt/${prompt.promptId}`);
const promptHtml = clean(promptPage.html);
const slotKeys = [...promptHtml.matchAll(/data-prompt-card="([^"]*)"/g)].map((m) => m[1]);
// 枠のキーは draw_categories の category_key に連番が付いた形（morph_1 など）。
// 「状態」は8つの分類に分かれていて、どれが引かれるかは抽選で決まる。
const STATE_KEYS = ["emotion", "action", "body_state", "change",
  "environment", "relation", "property", "social_state"];
const kindOf = (k) => {
  const base = k.replace(/_\d+$/, "");
  if (base === "morph") return "morph";
  if (base === "color") return "color";
  if (STATE_KEYS.includes(base)) return "state";
  return "other";
};
const morphs = slotKeys.filter((k) => kindOf(k) === "morph");
const states = slotKeys.filter((k) => kindOf(k) === "state");
const colors = slotKeys.filter((k) => kindOf(k) === "color");
const others = slotKeys.filter((k) => kindOf(k) === "other");

must(morphs.length >= 1, "モーフが最低1個入っている", `${morphs.length}個`);
must(others.length === 0, "モーフ・状態・カラー以外の枠が混ざっていない", others.join(" "));
// 呼び名が枠のキーと食い違っていないか（「正しく表示される」の実体）
{
  const pairs = [...promptHtml.matchAll(
    /data-prompt-card="([^"]*)"[^>]*data-slot-label="([^"]*)"/g)];
  const bad = pairs.filter(([, key, label]) => !label || label.trim() === "");
  must(pairs.length === slotKeys.length && bad.length === 0,
    "引かれた枠すべてに呼び名が出ている",
    pairs.map(([, k, l]) => `${k}=${l}`).join(" "));
}
must(states.length >= 1, "状態が1つ以上出ている", states.join(" ") || "（この抽選では出なかった）");
if (colors.length >= 1) {
  must(true, "カラーが出ている", colors.join(" "));
} else {
  must(true, "カラーはこの抽選では引かれなかった（候補データ不足ではなく抽選の結果）", "0個");
  ids.colorNotDrawn = true;
}
record("promptSlots", slotKeys);
record("promptWordCount", prompt.answers.size);

// ══════════════════════════════════════════════════════
// 2. 制作タイマー
// ══════════════════════════════════════════════════════

section("2. 制作タイマー（開始・全ページ・延長）");

must(/data-timer=""/.test(promptHtml), "お題ページに制作タイマーが出ている");
const leftAtStart = Number(/data-seconds-left="(-?\d+)"/.exec(promptHtml)?.[1] ?? NaN);
must(Number.isFinite(leftAtStart) && leftAtStart > 0 && leftAtStart <= 600,
  "残り秒数が 10分の枠の中にある", String(leftAtStart));

const c1 = await challenge(author);
must(c1.status === 200 && !!c1.body.challenge, "/api/challenge が挑戦を返す",
  c1.body.error ?? "");
const kind = c1.body.challenge?.kind;
record("challengeKind", kind ?? null);

// 別のページを開いてから、同じ窓口をもう一度叩く。
// 帯はどのページでも同じ窓口を読むので、これが「全ページで続く」の実体。
for (const path of ["/", "/works", "/rankings"]) {
  const r = await author.get(path);
  must(r.status === 200, `作者が ${path} を開ける`, String(r.status));
}
await sleep(2000);
const c2 = await challenge(author);
const elapsed1 = c1.body.challenge?.elapsed_seconds ?? -1;
const elapsed2 = c2.body.challenge?.elapsed_seconds ?? -1;
must(elapsed2 >= elapsed1 + 1,
  "別ページを回ったあとも同じ挑戦の経過が進んでいる", `${elapsed1}→${elapsed2}`);

// 延長できるようになるまで待つ（残り 150 秒＝開始から約 450 秒）
section("2-b. 制作時間を延ばす（更新可能になるまで待つ）");
let renewable = false;
for (let i = 0; i < 40; i += 1) {
  const p = clean((await author.get(`/prompt/${prompt.promptId}`)).html);
  if (/data-can-renew="1"/.test(p)) { renewable = true; break; }
  const left = /data-seconds-left="(-?\d+)"/.exec(p)?.[1] ?? "?";
  if (i % 4 === 0) console.log(`      待っています… 残り ${left} 秒`);
  await sleep(15000);
}
must(renewable, "更新できる時間帯に入った");

let renewed = false;
if (renewable) {
  const page = await author.get(`/prompt/${prompt.promptId}`);
  const f = formByText(page.html, /制作時間を延ばす/);
  if (f?.actionId) {
    const after = await author.post(`/prompt/${prompt.promptId}`, { [f.actionId]: "", ...f.fields });
    const html = clean(after.html);
    const left = Number(/data-seconds-left="(-?\d+)"/.exec(html)?.[1] ?? NaN);
    renewed = /1 回延長/.test(textOf(after.html)) || left > leftAtStart * 0.25;
    must(renewed, "制作時間を延長できた", `残り ${left} 秒`);
  } else {
    must(false, "延長ボタンが見つかった");
  }
}

// ══════════════════════════════════════════════════════
// 3. 作品を投稿する
// ══════════════════════════════════════════════════════

section("3. 作品を投稿する（オリジナル部門）");

const posted = await submitWork(
  author,
  prompt.promptId,
  { title: "本番切替の確認・削除予定", division: "original", actualTimeSeconds: "600" },
  makePng(120, 80),
);
const workId = /^\/works\/([0-9a-f-]{36})/.exec(posted.path)?.[1];
must(!!workId, "投稿後に作品ページへ移動した", posted.path);
record("workId", workId ?? null);

if (!workId) {
  console.log("\n作品が作れなかったので、この先は確かめられません。");
  writeIds();
  await finish();
}

{
  const outside = textOutsideQuiz(posted.html);
  const leaked = prompt.answerLabels.filter((a) => a && outside.includes(a));
  must(leaked.length === 0, "作品ページの、出題の外に答えが出ていない", leaked.join(" "));
}

// 画像が Storage の公開URLから取れる
{
  const url = workImageUrl(authorId, workId);
  const res = await fetch(url);
  must(res.ok, "Storage の画像が公開URLから取れる", `${res.status} ${url.split("/object/")[1]}`);
}

// ══════════════════════════════════════════════════════
// 4. フレーバーテキスト（作者の言葉）
// ══════════════════════════════════════════════════════

section("4. フレーバーテキストを作る");

{
  const page = await author.get(`/works/${workId}`);
  const f = formByText(page.html, /この文章にする/);
  if (f?.actionId) {
    const pairs = [...clean(page.html).matchAll(
      /name="vocabId" value="(\d+)"[^>]*\/>\s*([^<]{1,16})</g)];
    must(pairs.length > 0, "使える語が出ている", `${pairs.length}語`);
    const chosen = pairs.slice(0, 2);
    const after = await author.post(`/works/${workId}`, {
      [f.actionId]: "", workId, vocabId: chosen.map((m) => m[1]),
    });
    // 保存できたかは、保存後にだけ出る「いまの文章」の欄で見る。
    // 「作者の言葉を付ける」は保存前から出ている見出しなので手がかりにしない。
    const saved = /いまの文章/.test(textOf(after.html));
    must(saved, "作者の言葉を付けられた", after.path);
    record("flavorWords", chosen.map((m) => m[2].trim()));
  } else {
    must(false, "フレーバーテキストの入力欄が出ている");
  }
}

// ══════════════════════════════════════════════════════
// 5. ゲスト（匿名）の動線
// ══════════════════════════════════════════════════════

section("5. ゲスト（匿名）が開いて答える");

const guest = session("cutover-guest");
{
  const page = await guest.get(`/works/${workId}`);
  must(page.status === 200, "サインインせずに作品を開ける", String(page.status));

  const quiz = parseQuiz(page.html);
  must(quiz.length === prompt.answers.size,
    "全語がクイズとして出題される（3問固定ではない）",
    `出題 ${quiz.length}問 / お題の語 ${prompt.answers.size}語`);

  // 答える前に正解が漏れていない
  const outside = textOutsideQuiz(page.html);
  const leaked = prompt.answerLabels.filter((a) => a && outside.includes(a));
  must(leaked.length === 0, "回答前に正解が漏れていない", leaked.join(" "));

  // ヒント（作者の言葉）。**ゲストは開けない**のが仕様なので、
  // 案内は出るが入口は出ない、を確かめる。開くほうは登録2人目で見る。
  must(/作者からの言葉があります/.test(textOf(page.html)), "作者の言葉があることは分かる");
  must(!formByText(page.html, /ヒントとして開く/),
    "ゲストにはヒントを開く入口が出ない（登録者だけ）");
}

// ビタ当て（1つ選ぶ）で回答
{
  const res = await guest.get(`/works/${workId}`);
  const quiz = parseQuiz(res.html);
  const f = formByText(res.html, /回答する/);
  must(!!f?.actionId, "ゲストに回答フォームが出ている");
  const fields = { [f.actionId]: "", workId };
  for (const q of quiz) {
    const correct = prompt.answers.get(q.slotKey);
    fields[q.name] = (q.choices.find((c) => c.label === correct) ?? q.choices[0]).tagId;
  }
  const after = await guest.post(`/works/${workId}`, fields);
  const t = textOf(after.html);
  must(/伝わ|的中|正解|結果/.test(t), "回答結果が出た");
  must(!!formByText(after.html, /次の作品に答える/), "回答後に次の作品へ進む入口がある");
  ids.guestAnswered = true;

  // 一時持ち出し（いまの流れの中だけ）は使えて、永続保存はできない
  const carry = formByText(after.html, /選んだ要素を1つの保存枠にする/);
  must(!!carry?.actionId, "回答後に持ち出しの入口が出る");
  if (carry?.actionId) {
    const tagIds = [...clean(after.html).matchAll(/name="tagId" value="(\d+)"/g)].map((m) => m[1]);
    const done = await guest.post(`/works/${workId}`, {
      [carry.actionId]: "", workId, tagId: tagIds.slice(0, 1),
    });
    const dt = textOf(done.html);
    must(/いまの流れの中だけ|持ち出/.test(dt), "ゲストが一時持ち出しを使えた");
    must(!/別の日に開いても残ります/.test(dt), "ゲストには永続保存の案内が出ない");
  }

  const guestId = accountUserId((await guest.get("/account")).html);
  record("guestUserId", guestId ?? null);

  // 「未回答のみ」は匿名IDを持ってから効く
  const list = await guest.get("/works?unanswered=1");
  must(/data-unanswered-filter="on"/.test(clean(list.html)),
    "匿名IDを取ったあと「未回答のみ」が使える");
  must(!new RegExp(workId).test(list.html),
    "答えた作品が「未回答のみ」から消える");

  const plain = await guest.get("/works");
  must(new RegExp(workId).test(plain.html) || /公開されている作品/.test(textOf(plain.html)),
    "「未回答のみ」を外すと一覧に戻る");
}

// ══════════════════════════════════════════════════════
// 6. 登録2人目 — 2択当て・返歌・保存枠
// ══════════════════════════════════════════════════════

section("6. 登録2人目が2択当てで答え、返歌と保存枠を作る");

const answerer = await fixtureSession("cutover-answerer");
const answererId = accountUserId((await answerer.get("/account")).html);
record("answererUserId", answererId ?? null);

{
  // 先にヒントを開く。ゲストは開いていないので、作者からは
  // 「読んだ人 1・読まなかった人 1」に分かれて見えるはず。
  const before = await answerer.get(`/works/${workId}`);
  const hint = formByText(before.html, /ヒントとして開く/);
  must(!!hint?.actionId, "登録者にはヒントを開く入口が出る");
  if (hint?.actionId) {
    const opened = await answerer.post(`/works/${workId}`, { [hint.actionId]: "", workId });
    must(/作者の言葉/.test(textOf(opened.html)), "ヒントが開いた");
    ids.hintOpenedByAnswerer = true;
  }

  const res = await answerer.get(`/works/${workId}`);
  const quiz = parseQuiz(res.html);
  const f = formByText(res.html, /回答する/);
  must(!!f?.actionId, "2人目に回答フォームが出ている");
  const fields = { [f.actionId]: "", workId };
  for (const q of quiz) {
    const correct = prompt.answers.get(q.slotKey);
    const right = q.choices.find((c) => c.label === correct) ?? q.choices[0];
    const other = q.choices.find((c) => c.tagId !== right.tagId) ?? right;
    // 2つ選ぶ＝2択当て
    fields[q.name] = [right.tagId, other.tagId];
  }
  const after = await answerer.post(`/works/${workId}`, fields);
  must(/2択|的中|伝わ|結果/.test(textOf(after.html)), "2択当てで回答できた");
  ids.answererAnswered = true;

  // 返歌。入力欄は「返歌を作る」を押してから出る（?reply=open）
  must(/返歌/.test(textOf(after.html)), "回答後に返歌の欄が出る");
  const replyPage = await answerer.get(`/works/${workId}?reply=open`);
  const reply = formByText(replyPage.html, /返歌を送る/);
  must(!!reply?.actionId, "返歌の入力欄を開ける");
  if (reply?.actionId) {
    const tokens = [...clean(replyPage.html).matchAll(/name="token" value="([^"]*)"/g)].map((m) => m[1]);
    must(tokens.length > 0, "返歌に使える語が出ている", `${tokens.length}語`);
    const sent = await answerer.post(`/works/${workId}`, {
      [reply.actionId]: "", workId, token: tokens.slice(0, 2),
    });
    must(/返歌/.test(textOf(sent.html)), "返歌を送れた");
    ids.flavorReply = true;
  }

  // 他者のお題由来の保存枠
  const page2 = await answerer.get(`/works/${workId}`);
  const carry = formByText(page2.html, /選んだ要素を1つの保存枠にする/);
  must(!!carry?.actionId, "他者の作品から持ち出す入口が出る");
  if (carry?.actionId) {
    const tagIds = [...clean(page2.html).matchAll(/name="tagId" value="(\d+)"/g)].map((m) => m[1]);
    await answerer.post(`/works/${workId}`, {
      [carry.actionId]: "", workId, tagId: tagIds.slice(0, 2),
    });
    const play = await answerer.get("/play");
    const pt = textOf(play.html);
    must(/他の人のお題から|他者/.test(pt), "他者のお題由来の枠として出所が残っている");
    const slots = [...clean(play.html).matchAll(/name="carrySlotId" value="(\d+)"/g)].map((m) => m[1]);
    must(slots.length >= 1, "保存枠が1つできた", `${slots.length}枠`);
    record("answererCarrySlotIds", slots);
  }
}

// ══════════════════════════════════════════════════════
// 6-b. ヒントを読んだ人と読まなかった人が分かれる
// ══════════════════════════════════════════════════════

section("6-b. ヒントの使用有無が分かれて記録される");

{
  const page = await author.get(`/works/${workId}`);
  const t = textOf(page.html);
  must(/文章を読んだ人と、読まなかった人/.test(t),
    "作者の画面に、読んだ人と読まなかった人の欄が出る");
}

// ══════════════════════════════════════════════════════
// 7. 自分のお題由来の保存枠
// ══════════════════════════════════════════════════════

section("7. 作者が自分のお題から保存枠を作る");

{
  const page = await author.get(`/prompt/${prompt.promptId}`);
  const f = formByText(page.html, /選んだ要素を持ち出す/);
  must(!!f?.actionId, "自分のお題に持ち出しの入口が出る");
  if (f?.actionId) {
    const tagIds = [...clean(page.html).matchAll(/name="tagId" value="(\d+)"/g)].map((m) => m[1]);
    await author.post(`/prompt/${prompt.promptId}`, {
      [f.actionId]: "", promptId: prompt.promptId, tagId: tagIds.slice(0, 2),
    });
    const play = await author.get("/play");
    must(/自分のお題から/.test(textOf(play.html)), "自分のお題由来の枠として出所が残っている");
    const slots = [...clean(play.html).matchAll(/name="carrySlotId" value="(\d+)"/g)].map((m) => m[1]);
    record("authorCarrySlotIds", slots);
  }
}

// ══════════════════════════════════════════════════════
// 8. 回答後の循環（D169）
// ══════════════════════════════════════════════════════

section("8. 回答後に次の作品へ進む（D169）");

{
  const res = await answerer.get(`/works/${workId}`);
  const f = formByText(res.html, /次の作品に答える/);
  if (f?.actionId) {
    const after = await answerer.post(`/works/${workId}`, { [f.actionId]: "", workId });
    const nextId = /^\/works\/([0-9a-f-]{36})/.exec(after.path)?.[1];
    if (nextId && nextId !== workId) {
      must(true, "次の作品へ進めた", nextId);
      record("nextWorkId", nextId);
    } else {
      must(true, "次の候補が無いので進まなかった（候補データ不足）", after.path);
      ids.nextWorkShortage = true;
    }
  } else {
    must(false, "次の作品の入口が出ている");
  }
}

// ══════════════════════════════════════════════════════
// 9. 共有と OGP
// ══════════════════════════════════════════════════════

section("9. 共有URLと OGP");

{
  const anon = session("cutover-share-viewer");
  const page = await anon.get(`/works/${workId}`);
  must(page.status === 200, "共有URLを未ログインで開ける", String(page.status));
  const outside = textOutsideQuiz(page.html);
  const leaked = prompt.answerLabels.filter((a) => a && outside.includes(a));
  must(leaked.length === 0, "共有先で回答前に正解が漏れない", leaked.join(" "));

  const head = clean(page.html);
  const ogDesc = /property="og:description" content="([^"]*)"/.exec(head)?.[1] ?? "";
  const words = ids.flavorWords ?? [];
  const inOg = words.filter((w) => w && ogDesc.includes(w));
  must(inOg.length === 0, "フレーバーの語が OGP の説明に載っていない",
    `${ogDesc.slice(0, 60)}｜選んだ語 ${words.join(" ")}`);

  const og = await fetch(`${BASE}/works/${workId}/opengraph-image`);
  must(og.ok && (og.headers.get("content-type") ?? "").includes("image"),
    "OGP画像が生成される", `${og.status} ${og.headers.get("content-type") ?? ""}`);
}

// ══════════════════════════════════════════════════════
// 10. 後片づけ
// ══════════════════════════════════════════════════════

section("10. 後片づけ（作ったものだけを消す）");

async function removeSlots(s, who) {
  for (let i = 0; i < 6; i += 1) {
    const play = await s.get("/play");
    const f = forms(play.html).find((x) => x.fields.carrySlotId !== undefined);
    if (!f?.actionId) break;
    await s.post("/play", { [f.actionId]: "", ...f.fields });
  }
  const left = [...clean((await s.get("/play")).html).matchAll(/name="carrySlotId" value="(\d+)"/g)];
  must(left.length === 0, `${who}の保存枠を消した`, `残り ${left.length}`);
}

await removeSlots(answerer, "2人目");
await removeSlots(author, "作者");

function writeIds() {
  try {
    mkdirSync(".test-logs", { recursive: true });
    writeFileSync(".test-logs/cutover-ids.json", JSON.stringify(ids, null, 2) + "\n");
    console.log("\n控えを .test-logs/cutover-ids.json に書きました。");
  } catch (e) {
    console.log("控えを書けませんでした:", e.message);
  }
}

console.log("\n=== 作ったもの（片づけ前の控え）===");
console.log(JSON.stringify(ids, null, 2));
writeIds();

// finish() が、この実行で作った作品を画面の削除から消す
await finish();
