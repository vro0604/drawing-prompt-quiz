#!/usr/bin/env node
/**
 * smoke-profile.mjs ／ 公開プロフィールとお気に入り一覧を、ブラウザと同じ道筋で通す
 *
 * ID を決める → 作品を出す → 他人が保存する → 公開設定を切り替える →
 * 見える／見えないが設定どおりに変わる、までを実際に動かす。
 *
 * 【いちばん大事な確認】
 *   1. show_saved_works が false のとき、**タブも件数も存在も出さない**
 *      「0件」でも「非公開です」でもなく、その人がお気に入りを
 *      使っているかどうかが一切伝わらないこと（spec 12-1）
 *   2. 本人は設定に関わらず常に見られる
 *   3. **お気に入りに入れただけでは、お題の答えが出ない**
 *      回答して初めて出る。ここが破れるとクイズを迂回できる
 *   4. 非公開・削除された作品が他人のお気に入り一覧から消える
 *   5. 予約語の ID を取れない（なりすまし防止。D59）
 *
 * 【前提】
 *   ・別のターミナルで npm run dev を動かしておくこと
 *   ・Supabase の Authentication → Email で Confirm email が OFF であること
 *
 * 【残るデータ】
 *   **消えない。** 登録ユーザー2人と、その作品・お気に入り・回答が残る。
 *
 * 【使い方】
 *   npm run smoke:profile
 */

import {
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
} from "./_smoke-http.mjs";

await requireAutoConfirm();

const stamp = `${process.pid}${Math.floor(Math.random() * 1000)}`.slice(-8);

/** /account のフォームを送る（ボタンの文字で選ぶ） */
async function submitAccountForm(s, buttonText, fields) {
  const page = await s.get("/account");
  const form = forms(page.html).find((f) => new RegExp(buttonText).test(f.text));
  if (!form?.actionId) throw new Error(`/account に「${buttonText}」が見つかりません`);
  return s.post("/account", { [form.actionId]: "", ...fields });
}

/** 作品ページの「保存」を押す */
async function save(s, workId) {
  const page = await s.get(`/works/${workId}`);
  const form = forms(page.html).find((f) => /^保存 \d+$/.test(f.text.trim()));
  if (!form?.actionId) throw new Error(`「保存」のボタンが見つかりません: ${workId}`);
  return s.post(`/works/${workId}`, { [form.actionId]: "", ...form.fields });
}

/** 作品を下書きに戻す */
async function unpublish(s, workId) {
  const page = await s.get(`/works/${workId}`);
  const form = forms(page.html).find((f) => /下書きに戻す/.test(f.text));
  if (!form?.actionId) throw new Error(`「下書きに戻す」が見つかりません: ${workId}`);
  return s.post(`/works/${workId}`, { [form.actionId]: "", ...form.fields });
}

/** ポートフォリオのタブ名を取り出す */
function tabsOf(html) {
  const t = textOf(html);
  return ["オリジナル", "ファンアート", "AI生成", "お気に入り", "回答履歴"].filter((label) =>
    t.includes(label),
  );
}

const artist = session("artist"); // 作品を出す側
const fan = session("fan");       // 保存する側
const visitor = session("visitor"); // 未サインイン

const artistHandle = `smoke-p${stamp}`;
const artistName = `スモーク作家${stamp}`;
const fanHandle = `smoke-q${stamp}`;
const fanName = `スモーク読者${stamp}`;

// ── 1. ID と表示名を決める ───────────────────────────────
section("1. ID を決めると公開プロフィールができる");

await register(artist, "artist");
await register(fan, "fan");

{
  const page = await submitAccountForm(artist, "プロフィールを保存する", {
    handle: artistHandle,
    displayName: artistName,
    bio: "スモークテストの自己紹介です。",
    link_x: "https://x.com/example",
  });
  must(/プロフィールを更新しました/.test(textOf(page.html)), "プロフィールを保存できた");
  must(new RegExp(`/u/${artistHandle}`).test(page.html), "公開プロフィールへの案内が出る");

  await submitAccountForm(fan, "プロフィールを保存する", {
    handle: fanHandle,
    displayName: fanName,
  });
}

// ── 2. 予約語は取れない（D59）───────────────────────────
section("2. なりすましに使える ID を配らない（D59）");
{
  for (const reserved of ["admin", "official", "support", "rankings"]) {
    const page = await submitAccountForm(artist, "プロフィールを保存する", {
      handle: reserved,
    });
    must(
      /その ID は使えません/.test(textOf(page.html)),
      `「${reserved}」は取れない`,
    );
  }

  // 断られても元の ID は残っている
  const after = await artist.get("/account");
  must(new RegExp(artistHandle).test(after.html), "断られても元の ID は残っている");
}

// ── 3. 公開プロフィールが誰にでも見える ─────────────────
section("3. 公開プロフィールは未サインインでも見える");

const promptA = await drawPrompt(artist, "standard", "1800");
let page = await submitWork(
  artist,
  promptA.promptId,
  { title: `プロフィール作品${stamp}`, division: "original", actualTimeSeconds: "3600" },
  makePng(90, 70),
);
const workId = /^\/works\/([0-9a-f-]{36})/.exec(page.path)?.[1];
must(!!workId, "作品を投稿した", page.path);

{
  const res = await visitor.get(`/u/${artistHandle}`);
  const t = textOf(res.html);

  must(res.status === 200, "公開プロフィールが開ける", `実際 ${res.status}`);
  must(t.includes(artistName), "表示名が出ている");
  must(t.includes(`@${artistHandle}`), "ID が出ている");
  must(/スモークテストの自己紹介です/.test(t), "自己紹介が出ている");
  must(/描き手としての記録/.test(t), "描き手の記録が出ている（常に公開）");
  must(new RegExp(`プロフィール作品${stamp}`).test(t), "オリジナルタブに作品が出ている");

  // 存在しない ID と非公開の ID を区別しない（D40）
  const missing = await visitor.get("/u/no-such-handle-xyz");
  must(missing.status === 404, "存在しない ID は 404", `実際 ${missing.status}`);
}

// ── 4. 既定ではお気に入りタブが無い ─────────────────────
section("4. 公開設定は既定で切れている");
{
  const res = await visitor.get(`/u/${fanHandle}`);
  const labels = tabsOf(res.html);

  must(!labels.includes("お気に入り"), "他人にはお気に入りタブが出ない");
  must(!labels.includes("回答履歴"), "他人には回答履歴タブが出ない");
  must(!/回答者としての記録/.test(textOf(res.html)), "回答者の記録も出ない");

  // 直接タブを指定しても中身は出ない
  const forced = await visitor.get(`/u/${fanHandle}?tab=saves`);
  must(
    !/お気に入りに入れた作品はまだありません|保存 20/.test(textOf(forced.html)),
    "タブを直接指定しても、お気に入りの中身は出ない",
  );
}

// ── 5. 保存する ─────────────────────────────────────────
section("5. お気に入りに入れる（本人は常に見られる）");
{
  await save(fan, workId);

  const mine = await fan.get("/saves");
  const t = textOf(mine.html);

  must(mine.status === 200, "自分のお気に入りが開ける", `実際 ${mine.status}`);
  must(new RegExp(`プロフィール作品${stamp}`).test(t), "保存した作品が出ている");
  must(/いまは自分だけが見られます/.test(t), "非公開であることが書かれている");
  must(/公開中/.test(t), "作品の状態が出ている");

  // 本人のポートフォリオには、設定が切れていてもタブが出る
  const own = await fan.get(`/u/${fanHandle}`);
  must(tabsOf(own.html).includes("お気に入り"), "本人にはタブが出る");
  must(/お気に入り（非公開）/.test(textOf(own.html)), "非公開であることが添えられている");
}

// ── 6. お題の答えが漏れていない ─────────────────────────
section("6. 保存しただけでは、お題の答えが出ない");
{
  const mine = await fan.get("/saves");
  const t = textOf(mine.html);

  const leaked = promptA.answerLabels.filter((label) => t.includes(label));
  must(leaked.length === 0, "お気に入り一覧に答えが出ていない", leaked.join(" "));
  must(!/お題/.test(t) || !/お題 /.test(t), "「お題」の見出しごと出ていない");

  // 回答すると出る
  await answerWork(fan, workId, promptA.answers, { correct: true });

  const after = await fan.get("/saves");
  const at = textOf(after.html);
  const shown = promptA.answerLabels.filter((label) => at.includes(label));

  must(shown.length > 0, "回答したあとは答えが出る", `${shown.length}件`);
  must(/お題/.test(at), "「お題」の見出しが出る");
}

// ── 7. 公開に切り替える ─────────────────────────────────
section("7. 公開設定を入れると、他人にも見える");
{
  const saved = await submitAccountForm(fan, "公開設定を保存する", {
    show_saved_works: "on",
  });
  must(/公開設定を更新しました/.test(textOf(saved.html)), "公開設定を保存できた");

  const res = await visitor.get(`/u/${fanHandle}?tab=saves`);
  const t = textOf(res.html);

  must(tabsOf(res.html).includes("お気に入り"), "他人にもタブが出るようになった");
  must(new RegExp(`プロフィール作品${stamp}`).test(t), "保存した作品が出ている");

  // 回答していない訪問者には答えが出ない
  const leaked = promptA.answerLabels.filter((label) => t.includes(label));
  must(leaked.length === 0, "回答していない人には答えが出ない", leaked.join(" "));

  // 状態は他人には出さない（他人には公開中しか来ない）
  must(!/現在非公開|削除済み/.test(t), "他人の一覧に状態が出ていない");
}

// ── 8. 作者が非公開にすると、他人の一覧から消える ────────
section("8. 非公開になった作品は他人のお気に入りから消える");
{
  await unpublish(artist, workId);

  const other = await visitor.get(`/u/${fanHandle}?tab=saves`);
  must(
    !new RegExp(`プロフィール作品${stamp}`).test(textOf(other.html)),
    "他人の一覧から消えた",
  );

  const mine = await fan.get("/saves");
  const t = textOf(mine.html);
  must(new RegExp(`プロフィール作品${stamp}`).test(t), "本人の一覧には残っている");
  must(/現在非公開/.test(t), "「現在非公開」と出ている");

  // 公開に戻す。**戻せたことをその場で確かめる**。
  // 黙って失敗すると、以降の検査が「非公開だから見えない」のか
  // 「本当に見えてはいけないから見えない」のか区別できなくなる。
  const page2 = await artist.get(`/works/${workId}`);
  const form = forms(page2.html).find(
    (f) => /公開する/.test(f.text) && !/下書きに戻す/.test(f.text),
  );
  must(!!form?.actionId, "「公開する」のボタンがある");
  await artist.post(`/works/${workId}`, { [form.actionId]: "", ...form.fields });

  const back = await visitor.get(`/works/${workId}`);
  must(back.status === 200, "公開に戻せた", `実際 ${back.status}`);
}

// ── 9. 公開を切ると、また見えなくなる ───────────────────
section("9. 公開設定を切ると、存在ごと消える");
{
  await submitAccountForm(fan, "公開設定を保存する", {});

  const res = await visitor.get(`/u/${fanHandle}`);
  must(!tabsOf(res.html).includes("お気に入り"), "タブがまた消えた");

  const forced = await visitor.get(`/u/${fanHandle}?tab=saves`);
  must(
    !new RegExp(`プロフィール作品${stamp}`).test(textOf(forced.html)),
    "直接指定しても中身が出ない",
  );

  // 本人はいつでも見られる
  const mine = await fan.get("/saves");
  must(
    new RegExp(`プロフィール作品${stamp}`).test(textOf(mine.html)),
    "本人は設定に関わらず見られる",
  );
}

// ── 10. いいねと分離されている ──────────────────────────
section("10. いいねとお気に入りが混ざらない");
{
  const t = textOf((await fan.get("/saves")).html);
  must(!/いいね/.test(t), "お気に入り一覧にいいね件数が出ていない");

  // ランキングは保存を見ない（保存しただけで順位が動かない）
  const ranking = textOf((await visitor.get("/rankings")).html);
  must(!/保存/.test(ranking), "ランキングに保存の数が出ていない");
}

// ── 11. 作品ページから辿れる ────────────────────────────
section("11. 作者名からポートフォリオへ行ける");
{
  const res = await visitor.get(`/works/${workId}`);
  must(
    new RegExp(`/u/${artistHandle}`).test(res.html),
    "作品ページの作者名がプロフィールへのリンクになっている",
  );
}

await finish();
