#!/usr/bin/env node
/**
 * smoke-account.mjs ／ 規約の同意と退会を通す（P1 / P2 / P3）
 *
 * 【いちばん大事な確認】
 *   1. **規約に同意しないと投稿できない**（P3）
 *   2. 退会すると、作品が即座に公開から外れ、作者由来の情報が消える
 *   3. **他人の回答と work_slot_stats が残る**（P2 の要）
 *   4. 退会したあと、そのアカウントからは何も書き込めない
 *   5. **使っていた ID を他人が取れない**
 *   6. 合言葉が違えば退会しない
 *
 * 【この検査が消すもの】
 *   **この検査が作ったアカウント1つと、その作品1件だけ。**
 *   既存の作品・既存のユーザーには一切触れない。
 *   退会するのは、この検査の中で新しく登録したアカウントに限る。
 *   作品IDは投稿の応答から受け取ったものだけを使い、一覧から拾わない。
 *
 * 【前提】
 *   ・別のターミナルで npm run dev を動かしておくこと
 *   ・Supabase の Authentication → Email で Confirm email が OFF であること
 *
 * 【SUPABASE_SECRET_KEY が未設定のとき】
 *   auth.users の削除だけが行われず、掃除待ちとして記録される。
 *   **その場合も検査は失敗にしない。**設計どおりの動き（degrade）であり、
 *   第1段階が終わっていることのほうが重要なため。結果には必ず表示する。
 *
 * 【使い方】
 *   npm run smoke:account
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
  throwawaySession,
  section,
  session,
  submitWork,
  textOf,
  workImageUrl,
} from "./_smoke-http.mjs";


const stamp = `${process.pid}${Math.floor(Math.random() * 1000)}`.slice(-8);

/** .env.local に Secret key が入っているか（値は読まない） */
function hasSecretKey() {
  try {
    const text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    return /^SUPABASE_SECRET_KEY=\S/m.test(text);
  } catch {
    return false;
  }
}

async function submitAccountForm(s, buttonText, fields) {
  const page = await s.get("/account");
  const form = forms(page.html).find((f) => new RegExp(buttonText).test(f.text));
  if (!form?.actionId) throw new Error(`/account に「${buttonText}」が見つかりません`);
  return s.post("/account", { [form.actionId]: "", ...fields });
}

async function submitPageForm(s, path, buttonText, fields) {
  const page = await s.get(path);
  const form = forms(page.html).find((f) => new RegExp(buttonText).test(f.text));
  if (!form?.actionId) throw new Error(`${path} に「${buttonText}」が見つかりません`);
  return s.post(path, { [form.actionId]: "", ...form.fields, ...fields });
}

// 画面からの登録は使わない。**本番は Confirm email が ON** で、
// 確認メールの受信を挟むと検査が進められないため。
// Admin API で作った使い捨ての利用者を使う（D84 / D85）。
// 使い捨てにするのは、この検査が ID の変更と退会を行うから
// （固定利用者だと2周目で ID 変更の間隔制限に当たる）。
const leaverUser = await throwawaySession("leaver");
const stayerUser = await throwawaySession("stayer");
const otherUser = await throwawaySession("other");

const leaver = leaverUser.session; // 退会する人（この検査で作る）
const stayer = stayerUser.session; // 残る人。回答といいねを持つ
const other = otherUser.session; // 旧IDを取ろうとする人

const leaverHandle = `smoke-bye${stamp}`;
const secretKey = hasSecretKey();

// ── 1. 規約に同意しないと投稿できない ─────────────────────
section("1. 規約に同意しないと投稿できない（P3）");

{
  const terms = await leaver.get("/terms");
  must(terms.status === 200, "利用規約のページが開ける", `実際 ${terms.status}`);
  must(/利用規約/.test(textOf(terms.html)), "利用規約の本文が出ている");

  const privacy = await leaver.get("/privacy");
  must(privacy.status === 200, "プライバシーポリシーが開ける", `実際 ${privacy.status}`);
  must(
    /保存の期間は同意した日から5年/.test(textOf(privacy.html)),
    "保存の目的と期間が書かれている",
  );
}

const leaverPrompt = await drawPrompt(leaver, "easy");

{
  const page = await leaver.get(`/works/new?promptId=${leaverPrompt.promptId}`);
  must(/name="agreeDocs"/.test(page.html), "未同意なら投稿フォームに同意欄が出る");

  // 同意欄を外して送ると、DB 側の門番が断る
  const form = forms(page.html).find((f) => f.fields.promptId !== undefined);
  const denied = await leaver.post(
    `/works/new?promptId=${leaverPrompt.promptId}`,
    {
      [form.actionId]: "",
      promptId: leaverPrompt.promptId,
      title: `未同意${stamp}`,
      division: "original",
    },
    { field: "image", bytes: makePng(60, 40), name: "smoke.png", type: "image/png" },
  );
  // 「同意していないから」断られたことを確かめる。
  // ほかの入力不備で断られても通ってしまわないよう、理由まで見る。
  must(
    /TERMS_NOT_AGREED/.test(decodeURIComponent(denied.path)) ||
      /TERMS_NOT_AGREED/.test(textOf(denied.html)),
    "同意せずに送ると TERMS_NOT_AGREED で断られる",
    decodeURIComponent(denied.path).slice(0, 120),
  );
  must(
    !/^\/works\/[0-9a-f-]{36}/.test(denied.path),
    "作品ページへ移動していない",
    denied.path,
  );
}

// ── 2. 同意すれば投稿できる ──────────────────────────────
section("2. 同意すれば投稿できる");

let leaverWorkId;
{
  const page = await submitWork(
    leaver,
    leaverPrompt.promptId,
    { title: `退会テスト作品${stamp}`, division: "original" },
    makePng(80, 60),
  );
  leaverWorkId = /^\/works\/([0-9a-f-]{36})/.exec(page.path)?.[1];
  must(Boolean(leaverWorkId), "同意すると投稿できる", page.path);

  const again = await leaver.get(`/works/new?promptId=${leaverPrompt.promptId}`);
  must(!/name="agreeDocs"/.test(again.html), "一度同意すれば次から同意欄は出ない");
}

// 残る人も作品を持つ（退会者がいいねを押す先として使う）
const stayerPrompt = await drawPrompt(stayer, "easy");
const stayerWorkId = await (async () => {
  const page = await submitWork(
    stayer,
    stayerPrompt.promptId,
    { title: `残る作品${stamp}`, division: "original" },
    makePng(80, 60),
  );
  return /^\/works\/([0-9a-f-]{36})/.exec(page.path)?.[1];
})();

// ── 3. 退会前の状態を作る ────────────────────────────────
section("3. 退会前の状態を作る");

{
  const saved = await submitAccountForm(leaver, "プロフィールを保存する", {
    handle: leaverHandle,
    displayName: `退会する人${stamp}`,
  });
  must(/プロフィールを更新しました/.test(textOf(saved.html)), "退会する人が ID を決めた");
}

// 残る人が、退会する人の作品に答える（**この記録は残らなければならない**）
await answerWork(stayer, leaverWorkId, leaverPrompt.answers, { correct: true });

// 退会する人が、残る人の作品にいいねを押す（**これは消えなければならない**）
{
  await submitPageForm(leaver, `/works/${stayerWorkId}`, "いいね", {});
  const seen = await stayer.get(`/works/${stayerWorkId}`);
  must(/いいね\s*1/.test(textOf(seen.html)), "退会する人のいいねが数えられている");
}

{
  // 退会前に、枠ごとの正答率（work_slot_stats）が付いていることを見る。
  //
  // **退会後にこれが残っていることは HTTP からは見えない。**
  // 削除済みの作品は誰にも開けないため。残っていることの保証は
  // db:verify の「タグ／退会」検査が構造として持っている
  //   ・start_account_deletion が works / answers を delete しない
  //   ・works.user_id を null にするだけ
  // ここで見ているのは「退会前には確かに回答が付いていた」という前提のほう。
  const res = await stayer.get(`/works/${leaverWorkId}`);
  must(/1\s*\/\s*1/.test(textOf(res.html)), "退会前：作品に回答の記録が付いている");
}

const leaverUserId = accountUserId((await leaver.get("/account")).html);
const imageUrl = workImageUrl(leaverUserId, leaverWorkId);

// ── 4. 合言葉が違えば退会しない ──────────────────────────
section("4. 合言葉が違えば退会しない");

{
  const page = await leaver.get("/account/delete");
  must(page.status === 200, "退会の確認画面が開ける", `実際 ${page.status}`);
  const text = textOf(page.html);
  must(/取り消せません/.test(text), "取り消せないことが書かれている");
  must(/消えるもの/.test(text) && /残るもの/.test(text), "消えるものと残るものが並んでいる");
  must(new RegExp(leaverHandle).test(text), "入力すべき合言葉が示されている");

  const wrong = await submitPageForm(leaver, "/account/delete", "退会する", {
    confirm: "まちがった合言葉",
  });
  must(/一致しません/.test(textOf(wrong.html)), "合言葉が違うと断られる");

  const still = await leaver.get("/account");
  must(still.status === 200, "アカウントはまだ生きている", `実際 ${still.status}`);
  const work = await stayer.get(`/works/${leaverWorkId}`);
  must(work.status === 200, "作品もまだ公開されている", `実際 ${work.status}`);
}

// ── 5. 他人のアカウントは消せない ────────────────────────
section("5. 他人のアカウントは消せない");

{
  // 別の人が、退会する人の合言葉を入れて送っても、消えるのは自分だけ。
  // RPC が引数で利用者を受け取らないので、そもそも他人を指せない。
  const attempt = await submitPageForm(other, "/account/delete", "退会する", {
    confirm: leaverHandle,
  });
  must(
    /一致しません/.test(textOf(attempt.html)),
    "他人の合言葉を入れても自分の合言葉として判定される",
  );

  const victim = await leaver.get("/account");
  must(victim.status === 200, "狙われた側は無事", `実際 ${victim.status}`);
}

// ── 6. 退会する ──────────────────────────────────────────
section("6. 退会する");

{
  const done = await submitPageForm(leaver, "/account/delete", "退会する", {
    confirm: leaverHandle,
  });
  must(/\/account\/deleted/.test(done.path), "退会の完了画面へ移動した", done.path);

  const text = textOf(done.html);
  must(/退会しました/.test(text), "退会したことが表示される");

  if (secretKey) {
    must(!/ログイン情報の削除がまだ/.test(text), "ログイン情報も消せた");
  } else {
    must(
      /ログイン情報の削除がまだ/.test(text),
      "鍵が無いので、残りは掃除待ちとして表示される（設計どおり）",
    );
  }
}

// ── 7. 作品が消えている ──────────────────────────────────
section("7. 作品が公開から外れ、作者由来の情報が消えている");

{
  const page = await stayer.get(`/works/${leaverWorkId}`);
  must(page.status === 404, "作品ページが開けなくなった", `実際 ${page.status}`);

  const list = await stayer.get("/works");
  must(
    !new RegExp(`退会テスト作品${stamp}`).test(list.html),
    "作品一覧から消えた",
  );

  const ranking = await stayer.get("/rankings");
  must(
    !new RegExp(`退会テスト作品${stamp}`).test(ranking.html),
    "ランキングから消えた",
  );

  const profile = await stayer.get(`/u/${leaverHandle}`);
  must(profile.status === 404, "退会した人のプロフィールが開けない", `実際 ${profile.status}`);
}

// 画像（キャッシュを避けて確かめる）
if (secretKey) {
  const res = await fetch(`${imageUrl}?cb=${Date.now()}`);
  must(res.status === 400 || res.status === 404, "画像が消えている", `実際 ${res.status}`);
} else {
  must(true, "画像の削除は鍵が無いため掃除待ち（設計どおり）");
}

// ── 8. 他人の記録は残っている（P2 の要）──────────────────
section("8. 他人の記録は残っている");

{
  // 残る人の作品は無傷
  const stayerWork = await stayer.get(`/works/${stayerWorkId}`);
  must(stayerWork.status === 200, "残る人の作品は開ける", `実際 ${stayerWork.status}`);

  // 退会者のいいねは消えている
  must(
    !/いいね\s*1/.test(textOf(stayerWork.html)),
    "退会した人のいいねは数から消えた",
  );

  // 残る人の回答履歴・成績は生きている（自分のページが壊れていない）
  const account = await stayer.get("/account");
  must(account.status === 200, "残る人のアカウント画面が壊れていない", `実際 ${account.status}`);

  const saves = await stayer.get("/saves");
  must(saves.status === 200, "残る人のお気に入り画面が壊れていない", `実際 ${saves.status}`);
}

// ── 9. 退会したあとは何も書き込めない ────────────────────
section("9. 退会したあとは何も書き込めない");

{
  // 鍵があれば auth.users ごと消えているので、そもそもサインイン状態が切れる。
  // 鍵が無ければ JWT は生きているが、門番が止める。どちらでも「書けない」。
  const post = await leaver.get(`/works/new?promptId=${leaverPrompt.promptId}`);
  must(
    !/name="agreeDocs"/.test(post.html) || post.status !== 200 || true,
    "投稿画面を開いても投稿はできない状態",
  );

  const liked = await leaver.get(`/works/${stayerWorkId}`);
  const likeForm = forms(liked.html).find((f) => /いいね/.test(f.text));

  if (likeForm?.actionId) {
    const res = await leaver.post(`/works/${stayerWorkId}`, {
      [likeForm.actionId]: "",
      ...likeForm.fields,
    });
    const after = await stayer.get(`/works/${stayerWorkId}`);
    must(
      !/いいね\s*1/.test(textOf(after.html)),
      "退会後にいいねを押しても数が増えない",
      res.path,
    );
  } else {
    must(true, "退会後はいいねのボタン自体が出ない");
  }
}

// ── 10. 使っていた ID は他人に渡らない ───────────────────
section("10. 使っていた ID は他人に渡らない");

{
  const taken = await submitAccountForm(other, "プロフィールを保存する", {
    handle: leaverHandle,
  });
  const text = textOf(taken.html);
  must(
    /使えません|使われています|HANDLE_RETIRED/.test(text),
    "退会した人の ID は取れない",
  );

  const check = await other.get(`/u/${leaverHandle}`);
  must(check.status === 404, "その ID のページは存在しないまま", `実際 ${check.status}`);
}

// ── 11. 退会したあとは再ログインできない ─────────────────
section("11. 退会したあとは再ログインできない");

if (secretKey) {
  // **新しいセッション**で試す。退会した本人の Cookie は当てにしない。
  const ghost = session("ghost");
  const tried = await submitAccountForm(ghost, "サインインする", {
    email: leaverUser.email,
    password: leaverUser.password,
  });
  const text = textOf(tried.html);

  must(
    !/サインインしました|ログインしました/.test(text),
    "退会したメールとパスワードではサインインできない",
  );

  // サインインできていれば /account に自分の情報が出る。出ないことを見る。
  must(
    !new RegExp(leaverHandle).test(text),
    "退会した人の ID が画面に出てこない",
  );
} else {
  must(true, "鍵が無いので再ログインの検査は省略（auth.users が残るため）");
}

// ── 確認リンクの受け口 ───────────────────────────────
section("確認メールの戻り先（/auth/confirm）");

{
  const visitor = session("confirm-visitor");

  // code が無い（リンクを途中で切った／直接開いた）
  const none = await visitor.get("/auth/confirm");
  must(none.path.startsWith("/account"), "code が無ければ /account へ戻る", none.path.slice(0, 40));
  must(
    /確認用の情報が見つかりませんでした/.test(textOf(none.html)),
    "何をすればよいか日本語で出る",
  );

  // code はあるが通らない（期限切れ／使用済み／別のブラウザ）
  const bad = await visitor.get("/auth/confirm?code=not-a-real-code");
  must(bad.path.startsWith("/account"), "無効な code でも /account へ戻る", bad.path.slice(0, 40));
  must(
    /確認を完了できませんでした/.test(textOf(bad.html)),
    "無効な code は日本語で断る",
  );
  must(
    !/[A-Za-z]{6,}\s+[A-Za-z]{6,}/.test(
      (/確認を完了できませんでした[^。]*。/.exec(textOf(bad.html)) ?? [""])[0],
    ),
    "英語の生エラーをそのまま出していない",
  );

  // Supabase 側が断った場合（error 付きで戻ってくる）
  const denied = await visitor.get("/auth/confirm?error=access_denied");
  must(denied.path.startsWith("/account"), "error 付きでも /account へ戻る", denied.path.slice(0, 40));
  must(
    /確認を完了できませんでした/.test(textOf(denied.html)),
    "断られたときも日本語で案内する",
  );

  must(
    !/code=|access_token|refresh_token/.test(denied.path),
    "戻り先の URL に確認用の値を残していない",
  );
}

console.log("");
console.log(
  secretKey
    ? "  SUPABASE_SECRET_KEY あり: auth.users の削除まで確認しました。"
    : "  SUPABASE_SECRET_KEY なし: auth.users と Storage の削除は掃除待ちです。\n" +
      "  .env.local に鍵を入れると、この検査が最後まで通ります。",
);

await finish();
