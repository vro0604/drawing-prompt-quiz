#!/usr/bin/env node
/**
 * smoke-race.mjs ／ 同時に押されたとき壊れないかを確かめる
 *
 * 【なぜ要るか】
 *   RPC はどれも「いまの状態を見てから書く」形になっている。
 *   見てから書くまでのすき間に同じ操作が並ぶと、
 *   **両方が検査を通り抜けて2件入る**ことがある。
 *
 *   守りは2段ある。
 *     1. RPC の中の事前検査（分かりやすい日本語で断る）
 *     2. 一意索引（すき間に入られても行は増えない）
 *
 *   1 だけでは足りず、2 だけだと利用者に意味の通じない
 *   Postgres のメッセージが出る。**両方あって初めて成立する**ので、
 *   ここでは「行が増えないこと」と「画面に内部の言葉が出ないこと」を
 *   セットで見る。
 *
 * 【この検査が作るもの・消すもの】
 *   登録ユーザー1人と作品1件を新しく作る。**既存の利用者と作品には触れない。**
 *   作った作品は消さずに残す（削除の検査は smoke:report が持っている）。
 *
 * 【前提】
 *   ・別のターミナルで npm run dev を動かしておくこと
 *   ・Supabase の Authentication → Email で Confirm email が OFF であること
 *
 * 【使い方】
 *   npm run smoke:race
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
  fixtureSession,
  submitWork,
  textOf,
} from "./_smoke-http.mjs";

await requireAutoConfirm();

const stamp = `${process.pid}${Math.floor(Math.random() * 1000)}`.slice(-8);

/**
 * 内部の言葉が画面に出ていないか。
 *
 * 二重送信が一意索引に当たると、素の Postgres が
 * 「duplicate key value violates unique constraint "..."」を返す。
 * これがそのまま出ると、利用者に通じないうえ表と制約の名前が漏れる。
 */
function leaksInternals(text) {
  return /duplicate key|violates|constraint|relation |pg_|SQLSTATE|null value in column/i.test(
    text,
  );
}

/** ページのフォームを1回だけ読み、同じ内容を n 回まとめて送る */
async function pressTogether(s, path, buttonText, fields, times) {
  const page = await s.get(path);
  const form = forms(page.html).find((f) => new RegExp(buttonText).test(f.text));
  if (!form?.actionId) throw new Error(`${path} に「${buttonText}」が見つかりません`);

  const body = { [form.actionId]: "", ...form.fields, ...fields };
  // Promise.all で並べる。**順番に送ってはいけない**（すき間が再現しない）
  return Promise.all(Array.from({ length: times }, () => s.post(path, body)));
}

// ── 下ごしらえ ────────────────────────────────────────────
const author = session("author");
await register(author, `race${stamp}`);

// ── 1. 下ごしらえ：ふつうに1件投稿して規約へ同意しておく ──────
section("1. 準備（通常の投稿を1件）");
let workId;
{
  const first = await drawPrompt(author, "easy");
  const page = await submitWork(
    author,
    first.promptId,
    { title: `連打の的${stamp}`, division: "original" },
    makePng(60, 40),
  );
  workId = /^\/works\/([0-9a-f-]{36})/.exec(page.path)?.[1];
  must(typeof workId === "string", "的にする作品を1件作れた", page.path);
}

// ── 2. 投稿ボタンの連打 ────────────────────────────────────
section("2. 投稿ボタンを同時に3回押す");
{
  // 新しいお題を引く。**作品がまだ無いお題**でないと連打の意味が無い
  const second = await drawPrompt(author, "easy");
  const promptId = second.promptId;

  const png = makePng(60, 40);
  const page = await author.get(`/works/new?promptId=${promptId}`);
  const form = forms(page.html).find((f) => /投稿する|公開する/.test(f.text));
  if (!form?.actionId) throw new Error("/works/new に投稿ボタンが見つかりません");

  const fields = {
    [form.actionId]: "",
    ...form.fields,
    promptId,
    title: `同時投稿${stamp}`,
    division: "original",
  };

  // 3つ同時に送る。**お題1つに作品は1件**なので、通るのは1つだけ
  const results = await Promise.all(
    Array.from({ length: 3 }, () =>
      author.post("/works/new", fields, {
        field: "image",
        bytes: png,
        type: "image/png",
        name: "a.png",
      }),
    ),
  );

  const created = results.filter((r) => /^\/works\/[0-9a-f-]{36}$/.test(r.path));
  must(created.length >= 1, "少なくとも1件は投稿できた", `${created.length} 件`);

  // 作品ページへ着いた応答が2件以上あっても、それぞれ別IDなら二重投稿。
  const ids = new Set(created.map((r) => /^\/works\/([0-9a-f-]{36})/.exec(r.path)[1]));
  must(ids.size === 1, "できた作品は1件だけ（お題1つに作品1件）", `作品ID ${ids.size} 種類`);

  const refused = results.filter((r) => !/^\/works\/[0-9a-f-]{36}$/.test(r.path));
  must(
    refused.every((r) => !leaksInternals(textOf(r.html))),
    "断られた側に内部の言葉が出ていない",
    refused.length === 0
      ? "断られた応答は無し"
      : `${refused.length} 件を確認: ${textOf(refused[0].html).slice(0, 80)}`,
  );
}

// ── 3. いいね・お気に入りの連打 ────────────────────────────
section("3. いいね・お気に入りを同時に押す");
{
  // 押すたびに入れ替わる操作なので、同時に4回押した結果が
  // 付いているか外れているかは決まらない。**確かめるのは
  // 「数が実際の行数と合っていること」と「500 にならないこと」。**
  for (const [label, button] of [
    ["いいね", "^いいね|いいね済み"],
    ["お気に入り", "^保存|保存済み"],
  ]) {
    const results = await pressTogether(author, `/works/${workId}`, button, {}, 4);
    must(
      results.every((r) => r.status === 200),
      `${label}を4回同時に押しても 500 にならない`,
      results.map((r) => r.status).join(","),
    );
    must(
      results.every((r) => !leaksInternals(textOf(r.html))),
      `${label}の応答に内部の言葉が出ていない`,
    );
  }

  // 数え直し。トリガーが数えているので、行数と表示が一致するはず。
  // ボタンの文字は状態で変わる（「いいね 0」／「いいね済み 1」）。
  const after = await author.get(`/works/${workId}`);
  const likes = /いいね(?:済み)?\s+(\d+)/.exec(textOf(after.html))?.[1];
  must(likes !== undefined, "いいね数が読み取れる", `いいね ${likes}`);
  must(
    likes === "0" || likes === "1",
    "いいね数が 0 か 1（連打しても増え続けない）",
    `いいね ${likes}`,
  );
}

// ── 4. 回答の二重送信 ──────────────────────────────────────
section("4. 回答を同時に2回送る");
{
  // 別の人として回答する（自作には答えられない）
  const guest = await fixtureSession("race-answerer");
  const page = await guest.get(`/works/${workId}`);
  const form = forms(page.html).find((f) => /回答する/.test(f.text));

  if (!form?.actionId) {
    must(false, "回答フォームが見つかった");
  } else {
    // 出題を読み、各問の最初の選択肢を選ぶ
    const answers = {};
    for (const m of page.html.matchAll(/name="(q_\d+)"\s+value="(\d+)"/g)) {
      if (!(m[1] in answers)) answers[m[1]] = m[2];
    }

    const body = { [form.actionId]: "", ...form.fields, workId, ...answers };
    const results = await Promise.all([
      guest.post(`/works/${workId}`, body),
      guest.post(`/works/${workId}`, body),
    ]);

    must(
      results.every((r) => r.status === 200),
      "同時に2回送っても 500 にならない",
      results.map((r) => r.status).join(","),
    );
    must(
      results.every((r) => !leaksInternals(textOf(r.html))),
      "回答の応答に内部の言葉が出ていない",
    );

    // 2回送っても、記録されるのは1件だけ。
    // **回答は入れ替える操作ではない**ので、2件目は断られるのが正しい。
    // 断り文句が出ているか、または片方が素直に通っているかを見る。
    const texts = results.map((r) => textOf(r.html));
    must(
      texts.some((t) => /あなたの回答/.test(t)),
      "回答は受け付けられた",
    );
    must(
      texts.every((t) => !/duplicate key|unique constraint/i.test(t)),
      "2件目に一意索引のエラーが出ていない",
    );
  }
}

await finish();
