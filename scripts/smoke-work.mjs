#!/usr/bin/env node
/**
 * smoke-work.mjs ／ 作品投稿の一連の流れを、ブラウザと同じ道筋で通す
 *
 * ゲストでお題を引く → 昇格して登録 → 画像を選ぶ → アップロード →
 * 作品情報を入れる → create_work → 作品詳細、までを動かし、
 * **非公開作品と他人の下書きが漏れないこと**を実際に確かめる。
 *
 * 【いちばん大事な確認】
 *   1. 匿名ゲストのままでは投稿できない（spec C3 / D27-1）
 *   2. 昇格しても uid が変わらず、ゲストのときのお題で投稿できる（11-2）
 *   3. 下書きは本人にしか見えない（他人・未サインインからは 404）
 *   4. 作品ページの、出題（4択）の外にお題の答えが出ていない
 *      （正解は4択の1つとして必ず出るので「文字が無いこと」では確かめられない。
 *        どれが正解か見分けられないことは smoke:answer が確かめる）
 *
 * 【前提】
 *   ・別のターミナルで npm run dev を動かしておくこと
 *   ・Supabase の Authentication → Email で Confirm email が OFF であること
 *     （自動で確かめ、ON なら理由を出して終了する）
 *
 * 【秘密は使わない】
 *   SUPABASE_SECRET_KEY は読まない。画面と同じ経路だけを通す。
 *
 * 【残るデータ】
 *   **消えない。** 登録ユーザー2人と、そのお題・作品・画像が残る。
 *   works.user_id は profiles を ON DELETE RESTRICT で参照しているため、
 *   作品を持つユーザーは削除できない。手で消すには先に作品を消す必要があり、
 *   それはデータの削除にあたるのでこのスクリプトには入れない。
 *
 * 【使い方】
 *   npm run smoke:work
 */

import {
  accountUserId,
  drawPrompt,
  finish,
  forms,
  makePng,
  must,
  requireAutoConfirm,
  section,
  session,
  fixtureSession,
  submitWork,
  textOf,
  textOutsideQuiz,
} from "./_smoke-http.mjs";

await requireAutoConfirm();

// **ゲストからは始めない。**
//
// 「ゲストは投稿できない」「昇格しても uid が変わらない」は
// smoke:anon へ移した。匿名サインインを使う場所を1本に集めて、
// Supabase の回数制限（1時間30回・IP単位）に検査全体が
// 引きずられないようにするため（D83）。
//
// ここの本題は投稿そのもの。作者は固定の検査用利用者を使う。
const author = await fixtureSession("work-author");
const stranger = await fixtureSession("work-stranger");
const visitor = session("visitor");

section("0. 投稿の準備（お題を引く）");

const original = await drawPrompt(author, "standard");
const guestId = accountUserId((await author.get("/account")).html);

must(!!guestId, "作者の uid が取れている", guestId ?? "");

// ── 2. ゲストのときに引いたお題で投稿する ────────────────
section("2. 公開作品を投稿する（オリジナル部門）");

let page = await submitWork(
  author,
  original.promptId,
  {
    title: "スモークテスト・オリジナル",
    division: "original",
    actualTimeSeconds: "3600",
  },
  makePng(120, 80),
);

const publicWorkId = /^\/works\/([0-9a-f-]{36})/.exec(page.path)?.[1];
must(!!publicWorkId, "投稿後に作品ページへ移動した", page.path);
must(
  /スモークテスト・オリジナル/.test(page.html),
  "ゲストのときに引いたお題でそのまま投稿できた",
);
must(/オリジナル/.test(textOf(page.html)), "部門が出ている");
must(/1時間/.test(textOf(page.html)), "実制作時間が出ている");
must(
  new RegExp(`/storage/v1/object/public/works/${guestId}/${publicWorkId}\\.png`).test(
    decodeURIComponent(page.html),
  ),
  "画像が {user_id}/{work_id}.png のパスで参照されている",
);
must(
  /width="120"/.test(page.html) && /height="80"/.test(page.html),
  "画像の大きさが実物から数えた 120×80 になっている",
);

// 答えが1つも出ていないこと
{
  const outside = textOutsideQuiz(page.html);
  const leaked = original.answerLabels.filter((a) => a && outside.includes(a));
  must(leaked.length === 0, "作品ページの、出題の外に答えが出ていない", leaked.join(" "));
  must(!/prompt_id|promptId/.test(page.html), "HTML に prompt_id が出ていない");
}

// 投稿すると未選択カードが開示される（D8 / D48）
{
  const promptPage = await author.get(`/prompt/${original.promptId}`);
  must(
    /引かなかったカード/.test(textOf(promptPage.html)),
    "投稿により未選択カードが開示された",
  );
}

// ── 3. 下書きを投稿する（ファンアート部門）────────────────
section("3. 下書きを投稿する（ファンアート部門）");

const fanart = await drawPrompt(author, "easy");

page = await submitWork(
  author,
  fanart.promptId,
  {
    title: "スモークテスト・ファンアート下書き",
    division: "fanart",
    sourceTitle: "架空の元作品",
    sourceCharacter: "架空のキャラクター",
    fanartNote: "独自解釈を含みます",
    actualTimeSeconds: "1800",
    saveAs: "draft",
  },
  makePng(64, 64),
);

const draftWorkId = /^\/works\/([0-9a-f-]{36})/.exec(page.path)?.[1];
must(!!draftWorkId, "下書きも作品ページへ移動する", page.path);
must(/下書き/.test(textOf(page.html)), "下書きの印が出ている");
must(/架空の元作品/.test(page.html), "元作品名が出ている");
must(/架空のキャラクター/.test(page.html), "キャラクター名が出ている");
must(/独自解釈を含みます/.test(page.html), "補足が出ている");
must(/公開する/.test(page.html), "公開ボタンが出ている");

// ── 4. 漏れの検査 ──────────────────────────────────────
section("4. 非公開作品・他人の下書きが漏れない");


for (const [s, label] of [
  [visitor, "未サインインの訪問者"],
  [stranger, "別の登録ユーザー"],
]) {
  const res = await s.get(`/works/${draftWorkId}`);
  must(res.status === 404, `${label} から下書きは 404`, `実際 ${res.status}`);
  must(
    !/スモークテスト・ファンアート下書き/.test(res.html),
    `${label} に下書きのタイトルが漏れていない`,
  );
  must(!/架空の元作品/.test(res.html), `${label} に下書きの元作品名が漏れていない`);
}

{
  const res = await visitor.get(`/works/${publicWorkId}`);
  must(res.status === 200, "公開作品は未サインインでも見える", `実際 ${res.status}`);

  // 【ここは「文字が無いこと」では確かめられない】
  //   正解のタグは4択のうちの1つとして必ず出るため。
  //   要件は「どれが正解か分からないこと」なので、
  //   出題の外に答えが出ていないことを見る。
  //   どれが正解か見分けられないことは smoke:answer が別途確かめる。
  const outside = textOutsideQuiz(res.html);
  const leaked = original.answerLabels.filter((a) => a && outside.includes(a));
  must(leaked.length === 0, "訪問者の画面で、出題の外に答えが出ていない", leaked.join(" "));
  must(!/is_correct|correct_tag_id|correct_label/.test(res.html), "正解の印が HTML に無い");
}

// 存在しないIDも同じ 404（他人の下書きと区別がつかない）
{
  const res = await visitor.get("/works/00000000-0000-0000-0000-000000000000");
  must(res.status === 404, "存在しないIDも 404（下書きと区別がつかない）", `実際 ${res.status}`);

  // **形が違うIDも同じ 404。**
  // そのまま DB へ渡すと「invalid input syntax for type uuid」で 500 になり、
  // そこだけ応答が変わってしまう。URL を打ち間違えただけの人に
  // 「うまく表示できませんでした」と出るのも正しくない。
  for (const bad of ["not-a-uuid", "12345", "../../etc/passwd"]) {
    const r = await visitor.get(`/works/${encodeURIComponent(bad)}`);
    must(r.status === 404, `形が違うIDも 404（${bad}）`, `実際 ${r.status}`);
  }
}

// ── 5. 下書きを公開する ────────────────────────────────
section("5. 下書きを公開する");
{
  let res = await author.get(`/works/${draftWorkId}`);
  const form = forms(res.html).find((f) => /公開する/.test(f.text));
  res = await author.post(`/works/${draftWorkId}`, { [form.actionId]: "", ...form.fields });

  // 「下書き」という語だけで見ると、作者向けの「下書きに戻す」ボタンに当たる。
  // 本人限定表示から公開表示へ切り替わったことを、両者にしか出ない文言で見分ける。
  must(!/この作品は下書きです/.test(textOf(res.html)), "公開後は下書きの説明が消える");
  must(/下書きに戻す/.test(textOf(res.html)), "公開表示になり、下書きに戻すボタンが出る");

  const seen = await visitor.get(`/works/${draftWorkId}`);
  must(seen.status === 200, "公開後は訪問者からも見える", `実際 ${seen.status}`);
  must(/架空の元作品/.test(seen.html), "ファンアートの表記が訪問者にも出る");
}

// ── 6. 1つのお題から2作品は作れない ───────────────────────
section("6. 1つのお題から作れる作品は1件まで（A11 / D17）");
{
  const res = await author.get(`/works/new?promptId=${original.promptId}`);
  must(
    /このお題ではもう投稿しています/.test(textOf(res.html)),
    "投稿済みのお題では投稿フォームが出ない",
  );
}

// ── 7. 他人のお題では投稿できない ──────────────────────
section("7. 他人のお題では投稿できない（D27-2 / D40）");
{
  const strangerPrompt = await drawPrompt(stranger, "easy");

  const res = await author.get(`/works/new?promptId=${strangerPrompt.promptId}`);
  must(
    /そのお題は見つかりません/.test(textOf(res.html)),
    "他人のお題IDは「見つかりません」になる（権限エラーとは言わない）",
  );

  const mine = await author.get(`/prompt/${strangerPrompt.promptId}`);
  must(mine.status === 404, "他人のお題ページも 404", `実際 ${mine.status}`);
}

// ── 8. 画像が実際に配信されている ──────────────────────
section("8. 画像が公開URLから取れる");
{
  const res = await visitor.get(`/works/${publicWorkId}`);
  const url = /https:\/\/[^"'\s]*\/storage\/v1\/object\/public\/works\/[^"'\s&]*\.png/.exec(
    decodeURIComponent(res.html),
  )?.[0];

  must(!!url, "作品ページに公開URLがある");
  if (url) {
    const img = await fetch(url);
    must(img.ok, "公開URLから画像が取れる", `${img.status}`);
    must(
      img.headers.get("content-type")?.includes("image/png") === true,
      "content-type が image/png",
      img.headers.get("content-type") ?? "",
    );
  }
}

// ── 9. 壊れた画像・偽装した画像は受け取らない ─────────────
//
// 【なぜここでまとめて見るか】
//   画像の種類と大きさは、ブラウザの申告ではなく**中身から数えている**
//   （src/features/work/image.ts）。その判定が効いていることを、
//   通る側だけでなく**通らない側から**確かめる。
//
// 【お題を使い切らない】
//   断られた投稿はお題を消費しない（create_work まで届かない）。
//   だから1つのお題で何度でも試せる。**新しいお題を引かない**のは、
//   検査のたびに残るお題を増やさないため。
section("9. 壊れた画像・偽装した画像は受け取らない");
{
  const badPrompt = await drawPrompt(author, "easy");

  /** 画像を1つ送って、返ってきた画面の文言を返す */
  const trySubmit = async (bytes, name, type) => {
    const res = await submitWork(
      author,
      badPrompt.promptId,
      { title: "受け取らないはず", division: "original" },
      { bytes, name, type },
    );
    return { text: textOf(res.html), path: res.path };
  };

  const cases = [
    {
      label: "0バイトのファイル",
      bytes: new Uint8Array(0),
      name: "empty.png",
      type: "image/png",
    },
    {
      label: "中身が画像でないファイル（拡張子だけ png）",
      bytes: new TextEncoder().encode("これは画像ではありません"),
      name: "notimage.png",
      type: "image/png",
    },
    {
      label: "途中で切れた PNG（ヘッダだけ）",
      bytes: makePng(10, 10).slice(0, 12),
      name: "broken.png",
      type: "image/png",
    },
  ];

  // 幅・高さの異常。
  //
  // **本物の 30000×30000 は作らない。**それだと 31MB になり、
  // 寸法ではなく容量の上限に当たってしまう（一度そうなった）。
  // 見たいのは「ヘッダの申告が範囲外なら断る」ことなので、
  // 小さな PNG のヘッダだけを 30000 に書き換える。
  // readImageInfo はヘッダの数字を読むので、これで判定を通せる。
  const forged = Buffer.from(makePng(10, 10));
  forged.writeUInt32BE(30000, 16); // 幅
  forged.writeUInt32BE(30000, 20); // 高さ
  cases.push({
    label: "幅・高さが範囲外だと申告する画像（30000×30000）",
    bytes: forged,
    name: "forged.png",
    type: "image/png",
  });

  // 容量の上限（5MB）。中身は正しい PNG のまま、後ろに詰め物をする。
  cases.push({
    label: "5MB を超えるファイル",
    bytes: Buffer.concat([makePng(10, 10), Buffer.alloc(5 * 1024 * 1024 + 1)]),
    name: "big.png",
    type: "image/png",
  });

  // **断られる例を先に全部やる。**断られた投稿はお題を消費しないので、
  // 1つのお題で何度でも試せる。
  for (const c of cases) {
    const { text, path } = await trySubmit(c.bytes, c.name, c.type);
    const accepted = /^\/works\/[0-9a-f-]{36}/.test(path);
    must(
      !accepted && /扱えません|画像を選んで|読み取れません|5MBまで/.test(text),
      `${c.label} を断る`,
      accepted ? "受け取ってしまった" : text.slice(0, 60),
    );
  }

  // **通る例はいちばん最後。**ここでお題を使い切るので、
  // これより後ろに断られる例を置くと「もう投稿しています」で
  // 落ちてしまう（実際に一度そうなった）。
  //
  // 中身から種類を決めるので、名前が jpg でも中身が PNG なら PNG として扱う。
  {
    const { path } = await trySubmit(makePng(20, 15), "actually-png.jpg", "image/jpeg");
    must(
      /^\/works\/[0-9a-f-]{36}/.test(path),
      "PNG の中身に jpg の名前を付けたものは、中身どおりに受け取る",
      path,
    );
  }
}

await finish();
