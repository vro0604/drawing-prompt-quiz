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
  rawAuthError,
  registerConcurrent,
  isAutoConfirm,
  section,
  session,
  submitWork,
  textOf,
  fixtureSession,
} from "./_smoke-http.mjs";

// 本番は Confirm email が **ON**。ON のときは
// 「確認メールを送ったところで止まる」のが正しい姿なので、
// **OFF を要求せず、設定に合わせて期待値を変える。**
const autoConfirm = await isAutoConfirm();

console.log(
  autoConfirm
    ? "  Confirm email: OFF（登録はその場で完了する設定）"
    : "  Confirm email: ON（本番と同じ。昇格は確認メールで止まる）",
);

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

/** 失敗したページから、原因が分かる部分を短く取り出す */
function whyFailed(html) {
  const t = textOf(html);
  const m = /(登録できませんでした[^。]*。|うまく処理できませんでした[^。]*。|New password[^.]*\.|same_password)/.exec(t);
  return m ? m[0].slice(0, 120) : "（該当箇所なし）";
}

/** 登録の失敗表示。英語の生エラーが出ていないことも見る */
function registerFailed(html) {
  const t = textOf(html);
  return (
    /登録できませんでした/.test(t) ||
    /New password should be different/i.test(t) ||
    /same_password/i.test(t) ||
    /うまく処理できませんでした/.test(t)
  );
}

let promotedWorkId;
{
  // **同時に2本**送る（Enter とクリックが重なった状態）。
  // 以前はここで2本目が same_password になり、登録できなかった。
  const { pages } = await registerConcurrent(guest, `anon${stamp}`, 2);

  must(
    pages.every((p) => !registerFailed(p.html)),
    "同時2本でも失敗表示が出ない",
    pages.map((p) => (registerFailed(p.html) ? whyFailed(p.html) : "OK")).join(" / "),
  );

  // 送信枠切れ（email rate limit exceeded）も含めて、英語をそのまま出さない
  must(
    pages.every((p) => rawAuthError(p.html) === null),
    "Supabase の生エラーが画面に出ていない（D89）",
    pages.map((p) => rawAuthError(p.html) ?? "OK").join(" / "),
  );

  const page = pages[pages.length - 1];
  const text = pages.map((p) => textOf(p.html)).join(" ");

  if (autoConfirm) {
    must(
      /登録ユーザーとしてサインインしています/.test(textOf(page.html)),
      "登録ユーザーになった",
    );
  } else {
    // 確認メールが要る設定。ここで止まるのが正しい
    must(
      /確認メール/.test(text),
      "確認メールの案内が出る",
    );
    must(
      /ゲストとして/.test(textOf(page.html)),
      "確認が済むまではゲストのまま",
    );
  }

  must(
    accountUserId(page.html) === guestId,
    "昇格しても uid が変わらない",
    `${guestId} → ${accountUserId(page.html)}`,
  );

  if (autoConfirm) {
    // ゲストのときに引いたお題で、そのまま投稿できる
    const posted = await submitWork(
      guest,
      drawn.promptId,
      { title: `昇格して投稿${stamp}`, division: "original" },
      makePng(80, 60),
    );
    promotedWorkId = /^\/works\/([0-9a-f-]{36})/.exec(posted.path)?.[1];
    must(!!promotedWorkId, "ゲストのときのお題でそのまま投稿できた", posted.path);
  } else {
    // 確認が済んでいないので投稿はできない。
    // 代わりに、回答の的になる作品を固定利用者で用意する
    const owner = await fixtureSession("anon-work-owner");
    const ownerPrompt = await drawPrompt(owner, "standard");
    const posted = await submitWork(
      owner,
      ownerPrompt.promptId,
      { title: `回答の的${stamp}`, division: "original" },
      makePng(80, 60),
    );
    promotedWorkId = /^\/works\/([0-9a-f-]{36})/.exec(posted.path)?.[1];
    must(!!promotedWorkId, "回答の的になる作品を用意した", posted.path);
    drawn.answers = ownerPrompt.answers;
  }
}

// ── 3-b. 5連打でもメールは増えず、失敗表示も出ない ────────
section("3-b. 登録を同時に5本送っても失敗しない");

{
  const rapid = session("rapid");
  await drawPrompt(rapid, "easy");
  const before = accountUserId((await rapid.get("/account")).html);
  must(!!before, "ゲストとして発行された");

  const { pages } = await registerConcurrent(rapid, `rapid${stamp}`, 5);

  must(
    pages.every((p) => !registerFailed(p.html)),
    "同時5本でも失敗表示が出ない",
    pages.map((p) => (registerFailed(p.html) ? whyFailed(p.html) : "OK")).join(" / "),
  );

  // 5連打は送信枠（内蔵メールは1時間に2通）に当たりやすい。
  // 当たっても英語は出さず、日本語で「時間をおいて」と伝える
  must(
    pages.every((p) => rawAuthError(p.html) === null),
    "Supabase の生エラーが画面に出ていない（D89）",
    pages.map((p) => rawAuthError(p.html) ?? "OK").join(" / "),
  );

  const after = (await rapid.get("/account")).html;
  if (autoConfirm) {
    must(
      /登録ユーザーとしてサインインしています/.test(textOf(after)),
      "5連打でも登録は1回ぶんとして完了する",
    );
  } else {
    // 何が出たかを1本ずつ言い分ける。
    // **「送りました以外」でひとまとめにすると、送信枠切れを取りこぼす。**
    const outcomes = pages.map((p) => {
      const t = textOf(p.html);
      if (/確認メールを送りました/.test(t)) return "送信";
      if (/確認メールは送信済み/.test(t)) return "送信済み";
      if (/登録は完了しています/.test(t)) return "完了済み";
      if (/送信上限に達しました/.test(t)) return "上限";
      // 何が出たか分からないときは、判断できるだけの本文を残す
      return `不明(${(t.match(/(いまの状態|アカウント)([\s\S]{0,60})/) ?? ["", "", ""])[2].trim()})`;
    });

    must(
      outcomes.every((o) => !o.startsWith("不明")),
      "5本とも、送信・送信済み・上限のどれかに落ちる",
      outcomes.join(" / "),
    );
    must(
      outcomes.filter((o) => o === "送信").length <= 1,
      "「送りました」は多くても1回（残りは送信済みか上限）",
      outcomes.join(" / "),
    );
  }
  must(accountUserId(after) === before, "5連打でも uid が変わらない");
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
