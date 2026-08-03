#!/usr/bin/env node
/**
 * smoke-social.mjs ／ プロフィール設定といいね・保存を、ブラウザと同じ道筋で通す
 *
 * 表示名と ID を決める → 一覧の投稿者名が変わる → いいね・保存を押す →
 * 件数が増える → もう一度押すと戻る、までを実際に動かす。
 *
 * 【いちばん大事な確認】
 *   1. ゲストのままでは ID を取れず、いいねも押せない（D7 / 001 の設計）
 *   2. 使われている ID は取れない（早い者勝ち）
 *   3. 表示名が作品一覧と作品ページに反映される
 *   4. いいねの件数が実際の操作と一致する（トリガーの同期。D24）
 *
 * 【前提】
 *   ・別のターミナルで npm run dev を動かしておくこと
 *   ・Supabase の Authentication → Email で Confirm email が OFF であること
 *
 * 【残るデータ】
 *   **消えない。** 登録ユーザー2人と、その作品・いいね・保存が残る。
 *
 * 【使い方】
 *   npm run smoke:social
 */

import {
  drawPrompt,
  finish,
  forms,
  makePng,
  must,
  register,
  requireAutoConfirm,
  section,
  session,
  submitWork,
  textOf,
} from "./_smoke-http.mjs";

await requireAutoConfirm();

/** プロフィールの保存フォームを送る */
async function saveProfile(s, fields) {
  const page = await s.get("/account");
  const form = forms(page.html).find((f) => /プロフィールを保存する/.test(f.text));
  if (!form?.actionId) throw new Error("/account にプロフィールのフォームが見つかりません");

  return s.post("/account", { [form.actionId]: "", ...fields });
}

/** 作品ページのいいね／保存ボタンを押す */
async function pressReaction(s, workId, label) {
  const page = await s.get(`/works/${workId}`);
  const form = forms(page.html).find((f) => new RegExp(label).test(f.text));
  if (!form?.actionId) throw new Error(`「${label}」のボタンが見つかりません`);

  return s.post(`/works/${workId}`, { [form.actionId]: "", ...form.fields });
}

/** 作品ページから「いいね N」「保存 N」の数を読む */
function reactionCounts(html) {
  const t = textOf(html);
  return {
    likes: Number.parseInt(/いいね済み (\d+)|いいね (\d+)/.exec(t)?.slice(1).find(Boolean) ?? "-1", 10),
    saves: Number.parseInt(/保存済み (\d+)|保存 (\d+)/.exec(t)?.slice(1).find(Boolean) ?? "-1", 10),
  };
}

const artist = session("artist");   // 作品を投稿する側
const fan = session("fan");         // いいねを押す側
const guest = session("guest");     // ゲストのまま
const visitor = session("visitor"); // 未サインイン

const stamp = `${process.pid}${Math.floor(Math.random() * 1000)}`.slice(-8);
const artistHandle = `smoke-a${stamp}`;
const artistName = `スモーク絵師${stamp}`;

// ── 1. ゲストはプロフィールを設定できない ────────────────
section("1. ゲストは ID を取れない（001 の設計）");
{
  await drawPrompt(guest, "easy"); // ゲストとして発行させる
  const page = await guest.get("/account");

  must(
    /ゲストとして遊んでいます/.test(textOf(page.html)),
    "ゲストとして認識されている",
  );
  must(
    !/プロフィールを保存する/.test(page.html),
    "ゲストにはプロフィールの設定欄が出ない",
  );
}

// ── 2. 登録して表示名と ID を決める ───────────────────────
section("2. 表示名と ID を決める");

await register(artist, "artist");
{
  const page = await saveProfile(artist, {
    handle: artistHandle,
    displayName: artistName,
    bio: "スモークテストのプロフィールです。",
    link_x: "https://x.com/example",
  });
  const t = textOf(page.html);

  must(/プロフィールを更新しました/.test(t), "更新できた");
  must(new RegExp(artistHandle).test(page.html), "ID が保存されている");
  must(new RegExp(artistName).test(page.html), "表示名が保存されている");
  must(/スモークテストのプロフィールです/.test(page.html), "自己紹介が保存されている");
  must(/https:\/\/x\.com\/example/.test(page.html), "外部リンクが保存されている");
}

// ── 3. 形式と重複を断る ──────────────────────────────────
section("3. ID の形式と重複を断る");
{
  const bad = await saveProfile(artist, { handle: "A" });
  must(/3〜20字|使えません|ID は/.test(textOf(bad.html)), "短すぎる／大文字の ID は断られる");

  // 直後にプロフィールが壊れていないこと
  const after = await artist.get("/account");
  must(new RegExp(artistHandle).test(after.html), "断られても元の ID は残っている");
}

await register(fan, "fan");
{
  const taken = await saveProfile(fan, { handle: artistHandle });
  must(
    /すでに使われています/.test(textOf(taken.html)),
    "他の人が使っている ID は取れない",
  );

  const ok = await saveProfile(fan, {
    handle: `smoke-f${stamp}`,
    displayName: `スモーク読者${stamp}`,
  });
  must(/プロフィールを更新しました/.test(textOf(ok.html)), "別の ID なら取れる");
}

// ── 4. 表示名が作品に反映される ──────────────────────────
section("4. 表示名が作品一覧と作品ページに出る");

const prompt = await drawPrompt(artist, "easy");
let page = await submitWork(
  artist,
  prompt.promptId,
  { title: `スモーク・反応対象${stamp}`, division: "original" },
  makePng(80, 60),
);
const workId = /^\/works\/([0-9a-f-]{36})/.exec(page.path)?.[1];

must(!!workId, "作品を投稿した", page.path);
must(new RegExp(artistName).test(page.html), "作品ページに表示名が出る");
must(new RegExp(`@${artistHandle}`).test(page.html), "作品ページに ID が出る");
must(!/ゲスト/.test(textOf(page.html)), "「ゲスト」表示が消えている");

{
  const list = await visitor.get("/works");
  must(new RegExp(artistName).test(list.html), "一覧にも表示名が出る");
}

// ── 5. ゲスト・未サインインはいいねを押せない ─────────────
section("5. いいね・保存は登録ユーザーだけ（D7 / spec 10）");

for (const [s, label] of [
  [visitor, "未サインインの訪問者"],
  [guest, "ゲスト"],
]) {
  const res = await s.get(`/works/${workId}`);
  must(
    /いいねと保存にはアカウント登録が必要です/.test(textOf(res.html)),
    `${label} には登録の案内が出る`,
  );
  must(
    !forms(res.html).some((f) => /^いいね \d+$/.test(f.text.trim())),
    `${label} の画面にいいねボタンが無い`,
  );
}

// ── 6. いいね・保存を押す ────────────────────────────────
section("6. いいね・保存の件数が操作と一致する");
{
  const before = reactionCounts((await fan.get(`/works/${workId}`)).html);
  must(before.likes === 0 && before.saves === 0, "押す前は 0 件", JSON.stringify(before));

  let res = await pressReaction(fan, workId, "いいね");
  let counts = reactionCounts(res.html);
  must(counts.likes === 1, "いいねが 1 件になった", `${counts.likes}`);
  must(/いいね済み/.test(textOf(res.html)), "押した状態の表示になった");

  res = await pressReaction(fan, workId, "保存");
  counts = reactionCounts(res.html);
  must(counts.saves === 1, "保存が 1 件になった", `${counts.saves}`);
  must(/保存済み/.test(textOf(res.html)), "保存済みの表示になった");

  // 一覧にも反映される
  const list = await visitor.get("/works");
  must(
    new RegExp(`スモーク・反応対象${stamp}[\\s\\S]{0,200}いいね 1`).test(textOf(list.html)),
    "一覧のいいね数も 1 になった",
  );

  // もう一度押すと戻る
  res = await pressReaction(fan, workId, "いいね済み");
  counts = reactionCounts(res.html);
  must(counts.likes === 0, "もう一度押すと 0 件に戻る", `${counts.likes}`);
  must(!/いいね済み/.test(textOf(res.html)), "押していない表示に戻った");

  res = await pressReaction(fan, workId, "保存済み");
  counts = reactionCounts(res.html);
  must(counts.saves === 0, "保存も戻る", `${counts.saves}`);
}

// ── 7. 作者は自分の作品にいいねできる ────────────────────
section("7. 自作へのいいねは禁じない（回答とは違う。D28 は回答だけ）");
{
  const res = await pressReaction(artist, workId, "いいね");
  const counts = reactionCounts(res.html);
  must(counts.likes === 1, "作者が自作にいいねできる", `${counts.likes}`);
}

finish();
