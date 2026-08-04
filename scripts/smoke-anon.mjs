#!/usr/bin/env node
/**
 * smoke-anon.mjs ／ ゲストのまま遊べることを確かめる
 *
 * ============================================================================
 * 【この検査だけが匿名サインインを使う】
 * ============================================================================
 *
 *   「登録しなくても遊べる」はこのサービスの入口そのもの（spec 11-1）で、
 *   検査をやめるわけにはいかない。
 *
 *   ただし匿名サインインには **1時間30回・IPアドレス単位**の上限がある。
 *   以前は検査のたびに何人もゲストを作っていたため、続けて回すと上限に当たり、
 *   **本題と関係のない項目が次々に失敗していた**（D83）。
 *
 *   そこで「ゲストであること」を確かめる場所をこの1本に集めた。
 *   ほかの検査は固定の検査用利用者を使い、外の上限に振り回されない。
 *
 *   **ここで使うゲストは2人だけ。**
 *
 * ============================================================================
 * 【確かめること】
 * ============================================================================
 *
 *   ゲストにできること
 *     ・お題を引く
 *     ・クイズに答える
 *     ・作品を通報する
 *
 *   ゲストにできないこと
 *     ・作品を投稿する（spec C3 / D27-1）
 *     ・いいね・お気に入り（D7）
 *     ・ID（handle）を決める
 *
 *   そして
 *     ・**ページを開いただけではゲストが発行されない**（spec 11-1）
 *     ・**昇格しても uid が変わらず、引いたお題を引き継げる**（spec 11-2）
 *
 * 【前提】
 *   ・別のターミナルで npm run dev を動かしておくこと
 *   ・Supabase の Authentication → Email で Confirm email が OFF であること
 *
 * 【残るデータ】
 *   ゲスト2人と、その1人が昇格した登録ユーザー1人。作った作品は片づける。
 *
 * 【使い方】
 *   npm run smoke:anon
 */

import {
  accountUserId,
  answerWork,
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
  fixtureSession,
} from "./_smoke-http.mjs";

await requireAutoConfirm();

const stamp = `${process.pid}${Math.floor(Math.random() * 1000)}`.slice(-8);

// ── 0. 見ているだけではゲストを作らない ───────────────────
section("0. ページを開いただけではゲストを発行しない（spec 11-1）");
{
  const looker = session("looker");

  for (const path of ["/", "/works", "/rankings", "/play"]) {
    const res = await looker.get(path);
    must(res.status === 200, `${path} が開ける`, `実際 ${res.status}`);
  }

  const page = await looker.get("/account");
  must(
    !/ゲストとして遊んでいます|登録ユーザーとしてサインインしています/.test(textOf(page.html)),
    "4ページ見て回ってもゲストは発行されていない",
  );
  must(
    accountUserId(page.html) === null || accountUserId(page.html) === undefined,
    "uid がまだ無い",
    String(accountUserId(page.html)),
  );
}

// ── 1. 書き込んだ瞬間にゲストになる ───────────────────────
section("1. お題を引くとゲストとして発行される");

const guest = session("guest");
const drawn = await drawPrompt(guest, "standard");
const guestId = accountUserId((await guest.get("/account")).html);

must(!!guestId, "お題を引いた時点でゲストになった", guestId ?? "(無し)");
must(drawn.answerLabels.length > 0, "ゲストのままお題を引けた", `${drawn.answers.size}枠`);

{
  const page = await guest.get("/account");
  must(/ゲストとして遊んでいます/.test(textOf(page.html)), "ゲストとして認識されている");
  must(
    !/プロフィールを保存する/.test(page.html),
    "ゲストには ID や表示名の設定欄が出ない（001 の設計）",
  );
}

// ── 2. ゲストは投稿できない ───────────────────────────────
section("2. ゲストは作品を投稿できない（spec C3 / D27-1）");
{
  const page = await guest.get(`/works/new?promptId=${drawn.promptId}`);
  must(
    /投稿にはアカウント登録が必要です/.test(textOf(page.html)),
    "投稿フォームではなく登録の案内が出る",
  );
  must(!/<input[^>]*type="file"/.test(page.html), "画像の入力欄が無い");
}

// ── 3. 昇格しても uid が変わらず、お題を引き継げる ────────
section("3. ゲストから昇格しても uid とお題が引き継がれる（spec 11-2）");

let promotedWorkId;
{
  const { page } = await register(guest, `anon${stamp}`);
  must(
    /登録ユーザーとしてサインインしています/.test(textOf(page.html)),
    "登録ユーザーになった",
  );
  must(
    accountUserId(page.html) === guestId,
    "昇格しても uid が変わらない",
    `${guestId} → ${accountUserId(page.html)}`,
  );

  // ゲストのときに引いたお題で、そのまま投稿できる
  const posted = await submitWork(
    guest,
    drawn.promptId,
    { title: `昇格して投稿${stamp}`, division: "original" },
    makePng(80, 60),
  );
  promotedWorkId = /^\/works\/([0-9a-f-]{36})/.exec(posted.path)?.[1];
  must(!!promotedWorkId, "ゲストのときのお題でそのまま投稿できた", posted.path);
}

// ── 4. 別のゲストは、答えられるが いいねはできない ────────
section("4. ゲストは回答できる。いいね・お気に入りはできない（D7）");

const player = session("player");
{
  // まず回答する。**ここでこのゲストが発行される**
  const result = await answerWork(player, promotedWorkId, drawn.answers, { correct: true });
  must(/あなたの回答/.test(textOf(result.html)), "ゲストのまま回答できた");

  const playerId = accountUserId((await player.get("/account")).html);
  must(!!playerId, "回答した時点でゲストになった", playerId ?? "(無し)");

  const res = await player.get(`/works/${promotedWorkId}`);
  must(
    /いいねと保存にはアカウント登録が必要です/.test(textOf(res.html)),
    "いいねと保存には登録が必要だと案内が出る",
  );
  must(
    !forms(res.html).some((f) => /^いいね \d+$/.test(f.text.trim())),
    "ゲストの画面にいいねボタンが無い",
  );
}

// ── 5. ゲストのまま通報できる（spec 8-4）──────────────────
section("5. ゲストのまま通報できる");
{
  // 通報の的は、固定の検査用利用者に用意させる。
  // ゲストは自分の作品も通報できるが、他人の作品を通報する形にそろえたい。
  const owner = await fixtureSession("anon-target-owner");
  const prompt = await drawPrompt(owner, "easy");
  const posted = await submitWork(
    owner,
    prompt.promptId,
    { title: `通報される作品${stamp}`, division: "original" },
    makePng(60, 40),
  );
  const targetId = /^\/works\/([0-9a-f-]{36})/.exec(posted.path)?.[1];
  must(!!targetId, "通報の的を用意した", posted.path);

  const page = await player.get(`/works/${targetId}/report`);
  must(page.status === 200, "ゲストでも通報フォームが開ける", `実際 ${page.status}`);

  const form = forms(page.html).find((f) => /報告する/.test(f.text));
  must(!!form?.actionId, "通報フォームがある");

  if (form?.actionId) {
    const captchaOn = /class="cf-turnstile"/.test(page.html);
    const sent = await player.post(`/works/${targetId}/report`, {
      [form.actionId]: "",
      ...form.fields,
      reason: "spam",
      detail: "ゲストからの通報（検査）。",
      ...(captchaOn ? { "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX" } : {}),
    });
    must(
      /報告を受け付けました/.test(textOf(sent.html)),
      "ゲストのまま通報できた",
      /報告を受け付けました/.test(textOf(sent.html))
        ? ""
        : `断られた理由: ${textOf(sent.html).slice(0, 140)}`,
    );
  }
}

await finish();
