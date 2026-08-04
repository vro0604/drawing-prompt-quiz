#!/usr/bin/env node
/**
 * smoke-report.mjs ／ 旧IDの保護・共有カード・通報・非公開化・削除を通す
 *
 * 【いちばん大事な確認】
 *   1. **手放した ID を他人が取れない**（P5）。旧ID の URL はいまのページへ移る
 *   2. **共有カードにお題の答えが入っていない**。下書きのタイトルも出ない
 *   3. **削除の確認画面でタイトルを間違えると消えない**
 *   4. 削除した作品が一覧・ランキング・他人のお気に入りから消える
 *   5. 削除しても回答・いいね・お気に入り・通報が壊れない
 *
 * 【この検査が消すもの】
 *   **この検査が作った作品1件だけ。** 既存の作品には一切触れない。
 *   削除するのは「削除される作品」という題名で新しく投稿したものに限る。
 *   作品IDは投稿の応答から受け取ったものだけを使い、一覧から拾わない。
 *
 * 【前提】
 *   ・別のターミナルで npm run dev を動かしておくこと
 *   ・Supabase の Authentication → Email で Confirm email が OFF であること
 *
 * 【残るデータ】
 *   使い捨ての登録ユーザー3人と、その作品・回答・いいね・お気に入りが残る。
 *   削除した1件も行としては残る（論理削除）。
 *   **通報だけは片づける**（この実行が作った人の行だけ。D91）。
 *   利用者そのものを消したいときは `npm run smoke:fixtures:purge`。
 *
 * 【使い方】
 *   npm run smoke:report
 */

import { readFileSync } from "node:fs";
import {
  accountUserId,
  answerWork,
  drawPrompt,
  finish,
  forms,
  makePng,
  must,
  section,
  session,
  throwawaySession,
  submitWork,
  textOf,
  workImageUrl,
} from "./_smoke-http.mjs";

const stamp = `${process.pid}${Math.floor(Math.random() * 1000)}`.slice(-8);

/** /account のフォームを送る（ボタンの文字で選ぶ） */
async function submitAccountForm(s, buttonText, fields) {
  const page = await s.get("/account");
  const form = forms(page.html).find((f) => new RegExp(buttonText).test(f.text));
  if (!form?.actionId) throw new Error(`/account に「${buttonText}」が見つかりません`);
  return s.post("/account", { [form.actionId]: "", ...fields });
}

/** 指定のページのフォームを送る */
async function submitPageForm(s, path, buttonText, fields) {
  const page = await s.get(path);
  const form = forms(page.html).find((f) => new RegExp(buttonText).test(f.text));
  if (!form?.actionId) throw new Error(`${path} に「${buttonText}」が見つかりません`);
  return s.post(path, { [form.actionId]: "", ...form.fields, ...fields });
}

/** 投稿して作品IDを返す */
async function post(s, promptId, title, extra) {
  const page = await submitWork(s, promptId, { title, ...extra }, makePng(80, 60));
  const id = /^\/works\/([0-9a-f-]{36})/.exec(page.path)?.[1];
  if (!id) throw new Error(`投稿に失敗しました（${title}）: ${page.path}`);
  return id;
}

/** .env.local から値を読む（比べるためだけに使い、表示はしない） */
function envValue(name) {
  try {
    const text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    return new RegExp("^" + name + "=(.*)$", "m").exec(text)?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

/**
 * CAPTCHA の確認の値。
 *
 * ブラウザを動かさないので widget からトークンを受け取れない。
 * 開発の「常に通る」テスト鍵は、どんな値でも success を返すので、
 * 決まった文字列を渡して検証の道筋だけ通す。
 *
 * **本番の鍵ではこの値は通らない。**検証を飛ばしているのではなく、
 * テスト鍵がそう振る舞うだけ。
 */
function captchaToken(enabled) {
  return enabled ? { "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX" } : {};
}

/** <head> の meta を読む */
function metaOf(html) {
  const out = {};
  for (const m of html.matchAll(/<meta[^>]+>/g)) {
    const key =
      /property="([^"]+)"/.exec(m[0])?.[1] ?? /name="([^"]+)"/.exec(m[0])?.[1];
    const value = /content="([^"]*)"/.exec(m[0])?.[1];
    if (key) out[key] = value ?? "";
  }
  const canonical = /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/.exec(html)?.[1];
  if (canonical) out.canonical = canonical;
  return out;
}

// **ゲストは作らない。**「ゲストのまま通報できる」は smoke:anon が持つ。
// ここの本題は旧IDの保護・共有カード・削除で、通報はその一部でしかない。
// ゲストで回すと匿名サインインの上限に当たる（D83）。
//
// 【artist と fan は使い回せない】
//   この検査は ID（handle）を決めて、変えて、他人が取れないことを見る。
//   ID の変更は**30日に1回**までなので、同じ人を使い回すと
//   2回目の実行で必ず落ちる（実際に落ちた）。
//   毎回まっさらな人が要るので、Admin API で使い捨てを作る。
//   匿名サインインの枠は使わない。
const { session: artist } = await throwawaySession("report-artist");
const { session: fan } = await throwawaySession("report-fan");

// 【通報する人も使い回せない】
//   通報には「同じ作品に1回」のほかに、**24時間に10件まで**の上限がある
//   （create_report）。固定の人を使い回すと通報が積み上がり、
//   何度か回したところで枠を使い切って、**時間が経つまで通らない検査**に
//   なっていた（D91。実際に落ちた）。
//
//   使い捨ての人なら、直近24時間の通報は必ず0件から始まる。
//   本番の上限そのものは変えない。**検査の側を決定的にする。**
//
//   出した通報は finish() が片づける（この実行が作った人の行だけ）。
const { session: reporter } = await throwawaySession("report-reporter");
const visitor = session("visitor"); // 未サインインのまま見るだけ

const firstHandle = `smoke-old${stamp}`;
const nextHandle = `smoke-new${stamp}`;
const artistName = `スモーク削除${stamp}`;

// ── 1. ID を決めて、変える ───────────────────────────────
section("1. ID を変えると、古い ID は他人に渡らない（P5）");


{
  const first = await submitAccountForm(artist, "プロフィールを保存する", {
    handle: firstHandle,
    displayName: artistName,
  });
  must(/プロフィールを更新しました/.test(textOf(first.html)), "最初の ID を決めた");

  // 初回の設定は「変更」ではないので、続けて変えられる
  const changed = await submitAccountForm(artist, "プロフィールを保存する", {
    handle: nextHandle,
  });
  must(/プロフィールを更新しました/.test(textOf(changed.html)), "ID を変更できた");
  must(new RegExp(nextHandle).test(changed.html), "新しい ID が入っている");
}

{
  // 他人は旧IDを取れない
  const taken = await submitAccountForm(fan, "プロフィールを保存する", {
    handle: firstHandle,
    displayName: `スモーク読者${stamp}`,
  });
  must(
    /以前ほかの方が使っていた/.test(textOf(taken.html)),
    "他人が手放した ID は取れない",
  );

  // 別の ID なら取れる
  const ok = await submitAccountForm(fan, "プロフィールを保存する", {
    handle: `smoke-fan${stamp}`,
    displayName: `スモーク読者${stamp}`,
  });
  must(/プロフィールを更新しました/.test(textOf(ok.html)), "別の ID なら取れる");
}

{
  // 30日以内の2回目は断られる
  const again = await submitAccountForm(artist, "プロフィールを保存する", {
    handle: `smoke-third${stamp}`,
  });
  must(
    /30日に1回/.test(textOf(again.html)),
    "30日以内の2回目の変更は断られる",
  );

  const after = await artist.get("/account");
  must(new RegExp(nextHandle).test(after.html), "断られても ID は変わっていない");
}

// 画像の URL を組み立てるために、投稿者の uid を控えておく
const artistId = accountUserId((await artist.get("/account")).html);

// ── 2. 旧IDの URL がいまのページへ移る ───────────────────
section("2. 旧ID の URL はいまのページへ移る");
{
  const res = await visitor.get(`/u/${firstHandle}`);
  must(res.status === 200, "旧ID の URL を開ける", `実際 ${res.status}`);
  must(res.path === `/u/${nextHandle}`, "いまの ID のページへ移った", res.path);
  must(new RegExp(artistName).test(res.html), "移った先に表示名が出ている");

  // 旧IDは共有カードにも残らない
  const meta = metaOf(res.html);
  must(
    meta.canonical?.endsWith(`/u/${nextHandle}`),
    "canonical がいまの ID を指している",
    meta.canonical,
  );
  must(!new RegExp(firstHandle).test(res.html), "移った先に旧ID が残っていない");

  // 存在しない ID は 404 のまま
  const missing = await visitor.get(`/u/no-such-handle-${stamp}`);
  must(missing.status === 404, "存在しない ID は 404", `実際 ${missing.status}`);
}

// ── 3. 共有カード ────────────────────────────────────────
section("3. 共有カードにお題の答えが入っていない");

const promptA = await drawPrompt(artist, "standard", "1800");
const keepId = await post(artist, promptA.promptId, `残す作品${stamp}`, {
  division: "original",
});

const draftPrompt = await drawPrompt(artist, "easy", "600");
const draftId = await post(artist, draftPrompt.promptId, `下書き作品${stamp}`, {
  division: "original",
  saveAs: "draft",
});

{
  const res = await visitor.get(`/works/${keepId}`);
  const meta = metaOf(res.html);

  must(meta["og:title"] === `残す作品${stamp}`, "共有カードにタイトルが出る", meta["og:title"]);
  must(!!meta["og:image"], "共有カードの画像がある", meta["og:image"]);
  must(
    /\/works\/[0-9a-f-]{36}\/opengraph-image/.test(meta["og:image"] ?? ""),
    "画像の URL が作品ごとに作られている",
    meta["og:image"],
  );

  const head = res.html.slice(0, res.html.indexOf("</head>"));
  const leaked = promptA.answerLabels.filter((label) => head.includes(label));
  must(leaked.length === 0, "共有カードにお題の答えが入っていない", leaked.join(" "));

  // 画像そのものを取ってみる
  const image = await visitor.get(`/works/${keepId}/opengraph-image`);
  must(image.status === 200, "共有カードの画像が生成できる", `実際 ${image.status}`);
}

{
  // 下書きのタイトルは外へ出ない
  const res = await visitor.get(`/works/${draftId}`);
  must(res.status === 404, "他人からは下書きが 404", `実際 ${res.status}`);

  // 本人が開いても、<head> には下書きのタイトルが入らない。
  //
  // og:title 自体は既定の文言（"作品"）で必ず付く。あるかどうかではなく、
  // **下書きのタイトルが入っていないこと**を見る。
  const own = await artist.get(`/works/${draftId}`);
  const head = own.html.slice(0, own.html.indexOf("</head>"));
  const meta = metaOf(own.html);

  must(
    !new RegExp(`下書き作品${stamp}`).test(head),
    "本人が開いても、下書きのタイトルは共有カードに出ない",
    meta["og:title"] ?? "(無し)",
  );
  must(
    meta["og:title"] !== `下書き作品${stamp}`,
    "og:title が既定の文言のままになっている",
    meta["og:title"] ?? "(無し)",
  );
}

// ── 4. 通報 ──────────────────────────────────────────────
section("4. 通報");
{
  const res = await reporter.get(`/works/${keepId}/report`);
  must(res.status === 200, "通報フォームが開ける（未サインインでも）", `実際 ${res.status}`);

  // --- CAPTCHA（P6）---------------------------------------------------
  //
  // 開発では Cloudflare の公式テスト鍵を使う（.env.local）。
  // 鍵が入っていれば widget が出て、検証も実際に走る。
  //
  // **鍵の有無は .env.local から決める。HTML を見て決めてはいけない。**
  // 以前は HTML に widget があるかで判定していたが、その書き方だと
  // 通報ページがたまたま開けなかったとき（404 など）に
  // 「CAPTCHA は無効」と読み替えて、検査を丸ごと飛ばしてしまう。
  // **失敗が成功に化ける**ので、判定の根拠を画面の外に置く。
  const captchaOn = envValue("NEXT_PUBLIC_TURNSTILE_SITE_KEY") !== "";

  if (captchaOn) {
    must(
      /class="cf-turnstile"/.test(res.html),
      "鍵があるので widget が出ている",
      res.status === 200 ? "" : `ページが開けていません（${res.status}）`,
    );
    must(
      /data-action="report"/.test(res.html),
      "widget に action が付いている（トークンの使い回しを防ぐ）",
    );
    // **秘密鍵そのものと突き合わせる。**
    // 「0 が続く文字列」で見ると、HTML に出て当然のサイト鍵まで
    // 引っかかって、検査が意味を失う（実際に一度そうなった）。
    const secret = envValue("TURNSTILE_SECRET_KEY");
    must(
      secret !== "" && !res.html.includes(secret),
      "秘密鍵が HTML に出ていない",
      secret === "" ? "秘密鍵が読めませんでした" : "",
    );
    must(
      res.html.includes(envValue("NEXT_PUBLIC_TURNSTILE_SITE_KEY")),
      "サイト鍵は HTML に出ている（widget に必要）",
    );

    // 確認の値を付けずに送ると断られる。**ここが素通しだと意味が無い。**
    const noToken = await submitPageForm(reporter, `/works/${keepId}/report`, "報告する", {
      reason: "spam",
      detail: "確認なしの通報。",
    });
    must(
      /確認が完了していません|確認に失敗/.test(textOf(noToken.html)),
      "確認の値が無いと通報できない",
    );
  } else {
    must(true, "CAPTCHA は無効（鍵が未設定の開発環境）");
  }

  const sent = await submitPageForm(reporter, `/works/${keepId}/report`, "報告する", {
    reason: "spam",
    detail: "スモークテストの通報です。",
    ...captchaToken(captchaOn),
  });
  // **失敗したら断られた理由をそのまま出す。**
  // 「通らなかった」だけでは、CAPTCHA・レート制限・通信失敗の
  // どれなのか分からず、一時的な失敗として片づけられてしまう。
  must(
    /報告を受け付けました/.test(textOf(sent.html)),
    "通報を受け付けた",
    /報告を受け付けました/.test(textOf(sent.html))
      ? ""
      : `断られた理由: ${textOf(sent.html).slice(0, 160)}`,
  );

  // 同じ作品への2回目は断られる
  const twice = await submitPageForm(reporter, `/works/${keepId}/report`, "報告する", {
    reason: "spam",
    detail: "2回目。",
     ...captchaToken(captchaOn),
  });
  must(/すでに報告済み/.test(textOf(twice.html)), "同じ作品への2回目は断られる");

  // 「その他」は内容が必須
  const noDetail = await submitPageForm(fan, `/works/${keepId}/report`, "報告する", {
    reason: "other",
    detail: "",
     ...captchaToken(captchaOn),
  });
  must(
    /内容を書いてください/.test(textOf(noDetail.html)),
    "「その他」で内容が無いと断られる",
  );

  // 下書きの通報フォームは開けない（存在を確かめる経路にしない）
  const draftReport = await visitor.get(`/works/${draftId}/report`);
  must(draftReport.status === 404, "下書きの通報フォームは 404", `実際 ${draftReport.status}`);
}

// ── 5. 非公開化は画像を消さない ──────────────────────────
section("5. 非公開にしても画像は残り、公開に戻せる");
{
  const imageUrl = workImageUrl(artistId, keepId);

  // まず、公開中のいまは本当に取れることを確かめる。
  // ここが 200 でないと、あとの「消えている」が
  // 「URL を間違えている」と区別できない
  const before = await fetch(imageUrl);
  must(before.status === 200, "公開中の画像は取れる", `実際 ${before.status}`);

  await submitPageForm(artist, `/works/${keepId}`, "下書きに戻す", {});

  const gone = await visitor.get(`/works/${keepId}`);
  must(gone.status === 404, "他人からは見えなくなった", `実際 ${gone.status}`);

  const stillThere = await fetch(imageUrl);
  must(stillThere.status === 200, "非公開にしても画像は消えていない", `実際 ${stillThere.status}`);

  await submitPageForm(artist, `/works/${keepId}`, "公開する", {});
  const back = await visitor.get(`/works/${keepId}`);
  must(back.status === 200, "公開に戻せた", `実際 ${back.status}`);
}

// ── 6. 削除する作品を用意して、参照を作る ────────────────
section("6. 削除する作品を用意する（回答・いいね・お気に入り・通報を付ける）");

const doomedPrompt = await drawPrompt(artist, "standard", "3600");
const doomedId = await post(artist, doomedPrompt.promptId, `削除される作品${stamp}`, {
  division: "original",
});

{
  await answerWork(fan, doomedId, doomedPrompt.answers, { correct: true });
  await submitPageForm(fan, `/works/${doomedId}`, "いいね", {});
  await submitPageForm(fan, `/works/${doomedId}`, "保存", {});
  await submitPageForm(fan, `/works/${doomedId}/report`, "報告する", {
    ...captchaToken(true),
    reason: "spam",
    detail: "削除の検査用。",
  });

  const res = await fan.get(`/works/${doomedId}`);
  const t = textOf(res.html);
  must(/いいね済み/.test(t), "いいねが付いた");
  must(/保存済み/.test(t), "お気に入りに入った");
  must(/あなたの回答/.test(t), "回答が残っている");
}

// ── 7. 確認画面。タイトルを間違えると消えない ────────────
section("7. 削除の確認画面（タイトルの再入力）");
{
  const res = await artist.get(`/works/${doomedId}/delete`);
  const t = textOf(res.html);

  must(res.status === 200, "確認画面が開ける", `実際 ${res.status}`);
  must(new RegExp(`削除される作品${stamp}`).test(t), "消す対象が出ている");
  must(/元に戻せません/.test(t), "戻せないことが書かれている");
  must(/消えないもの/.test(t), "残るものも書かれている");

  // 他人は開けない
  const other = await fan.get(`/works/${doomedId}/delete`);
  must(other.status === 404, "他人は確認画面を開けない", `実際 ${other.status}`);

  // タイトルが違うと消えない
  const wrong = await submitPageForm(artist, `/works/${doomedId}/delete`, "この作品を削除する", {
    confirmTitle: "ちがうタイトル",
  });
  must(/一致しません/.test(textOf(wrong.html)), "タイトルが違うと断られる");

  const alive = await visitor.get(`/works/${doomedId}`);
  must(alive.status === 200, "断られたあとも作品は生きている", `実際 ${alive.status}`);
}

// ── 8. 削除する ─────────────────────────────────────────
section("8. 削除する（この検査が作った1件だけ）");
{
  const imageUrl = workImageUrl(artistId, doomedId);

  // 消す前に取れることを確かめておく。これが無いと、
  // あとの 404 が「消えた」のか「最初から取れない URL」なのか分からない
  const before = await fetch(imageUrl);
  must(before.status === 200, "削除前は画像が取れる", `実際 ${before.status}`);

  const done = await submitPageForm(artist, `/works/${doomedId}/delete`, "この作品を削除する", {
    confirmTitle: `削除される作品${stamp}`,
  });
  must(/作品を削除しました/.test(textOf(done.html)), "削除できた");

  // 他人からは見えない
  const gone = await visitor.get(`/works/${doomedId}`);
  must(gone.status === 404, "他人からは 404", `実際 ${gone.status}`);

  // 一覧・ランキングから消える
  const list = await visitor.get("/works");
  must(
    !new RegExp(`削除される作品${stamp}`).test(list.html),
    "作品一覧から消えた",
  );

  const ranking = await visitor.get("/rankings");
  must(
    !new RegExp(`削除される作品${stamp}`).test(ranking.html),
    "ランキングから消えた",
  );

  // 画像も消えている。
  //
  // 【クエリを足して確かめる理由】
  //   Storage の公開URLは CDN を通る。上で削除前に1回取っているので、
  //   **同じ URL は最大1時間、キャッシュから配られ続ける**（実測で
  //   cf-cache: HIT が返る）。ファイルが消えていても 200 になるので、
  //   同じ URL のままでは「消えたこと」を確かめられない。
  //   クエリを変えるとキャッシュの鍵が変わり、実体を見に行く。
  const cached = await fetch(imageUrl);
  const fresh = await fetch(`${imageUrl}?nocache=${stamp}`);

  must(fresh.status !== 200, "画像の実体が消えている", `実際 ${fresh.status}`);
  must(
    cached.status === 200,
    "（参考）同じURLはしばらくキャッシュから配られる",
    `実際 ${cached.status}`,
  );

  // 共有カードも作らない
  const meta = metaOf(gone.html);
  must(
    !new RegExp(`削除される作品${stamp}`).test(JSON.stringify(meta)),
    "共有カードに削除済みのタイトルが出ない",
  );

  // 本人には削除済みと分かる
  const own = await artist.get(`/works/${doomedId}`);
  must(/削除済み/.test(textOf(own.html)), "本人には削除済みと出る");

  // 二度目の削除画面は「すでに削除済み」
  const again = await artist.get(`/works/${doomedId}/delete`);
  must(/すでに削除されています/.test(textOf(again.html)), "二度目は削除済みと出る");
}

// ── 9. 削除しても参照が壊れない ─────────────────────────
section("9. 削除しても回答・いいね・お気に入り・通報が壊れない");
{
  // お気に入り: 他人からは消え、本人の一覧には状態つきで残る
  const mine = await fan.get("/saves");
  const t = textOf(mine.html);
  must(mine.status === 200, "お気に入り一覧が開ける", `実際 ${mine.status}`);
  must(new RegExp(`削除される作品${stamp}`).test(t), "本人の一覧には残っている");
  must(/削除済み/.test(t), "「削除済み」と出ている");

  // プロフィールの回答履歴（本人）
  const account = await fan.get("/account");
  must(account.status === 200, "アカウント画面が壊れていない", `実際 ${account.status}`);

  // 作者のプロフィールが開ける（集計から公開作品だけが数えられている）
  const profile = await visitor.get(`/u/${nextHandle}`);
  must(profile.status === 200, "作者のプロフィールが開ける", `実際 ${profile.status}`);
  must(
    !new RegExp(`削除される作品${stamp}`).test(profile.html),
    "プロフィールの作品一覧からも消えた",
  );
  must(
    new RegExp(`残す作品${stamp}`).test(profile.html),
    "削除していない作品は残っている",
  );
}

await finish();
