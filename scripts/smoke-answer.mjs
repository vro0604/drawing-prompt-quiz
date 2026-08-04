#!/usr/bin/env node
/**
 * smoke-answer.mjs ／ 一覧とクイズを、ブラウザと同じ道筋で通す
 *
 * 作品を投稿する → 一覧に出る（AIは通常一覧に出ない）→ 絵を見て4択に答える →
 * 採点結果と正解が出る → 伝達率が動く、までを実際に動かす。
 *
 * 【いちばん大事な確認】
 *   1. 答える前のページに正解が無い（**当てられることで確かめる**。下記）
 *   2. 作者は自分の作品に回答できない（D28）
 *   3. 同じ作品には1回しか答えられない
 *   4. AI作品が通常の一覧に出ない（Step 8 の終了条件）
 *   5. 集計（回答数・伝達率）が実際の回答と合う
 *
 * 【「正解が漏れていない」をどう確かめるか】
 *   正解のタグは4択のうちの1つとして必ず HTML に出るので、
 *   「その文字列が無いこと」では確かめられない。**どれが正解かが
 *   分からないこと**が要件だから。
 *
 *   そこで逆向きに見る。
 *     ・お題を引いた本人だけが知っている答えを使って選ぶ → 全問正解になる
 *     ・答えを見ずに別の選択肢を選ぶ → 不正解になる
 *   採点が本当に DB 側で行われていて、選択と正誤が対応していることが分かる。
 *   加えて、出題の HTML に is_correct のような印が無いことも見る。
 *
 * 【前提】
 *   ・別のターミナルで npm run dev を動かしておくこと
 *   ・Supabase の Authentication → Email で Confirm email が OFF であること
 *
 * 【残るデータ】
 *   **消えない。** 登録ユーザー1人、ゲスト2人、作品2件と回答が残る。
 *
 * 【使い方】
 *   npm run smoke:answer
 */

import {
  clean,
  drawPrompt,
  hasQuizForm,
  finish,
  forms,
  makePng,
  must,
  parseQuiz,
  register,
  requireAutoConfirm,
  section,
  session,
  fixtureSession,
  submitWork,
  textOf,
} from "./_smoke-http.mjs";

await requireAutoConfirm();

const author = session("author");
// **ゲストではなく固定の検査用利用者。**
// この検査の本題は採点と集計で、「ゲストでも答えられること」は
// smoke:anon が持つ。ゲストで回すと匿名サインインの上限に当たる（D83）。
const solver = await fixtureSession("solver");   // 答えを知っていて全問正解する側
const guesser = await fixtureSession("guesser"); // わざと外す側

// ── 1. 作品を2件用意する（通常1件・AI 1件）────────────────
section("1. 作品を用意する（オリジナル1件・AI 1件）");

await register(author, "author");

const original = await drawPrompt(author, "standard");
let page = await submitWork(
  author,
  original.promptId,
  { title: "スモーク・クイズ対象", division: "original", actualTimeSeconds: "3600" },
  makePng(100, 70),
);
const workId = /^\/works\/([0-9a-f-]{36})/.exec(page.path)?.[1];
must(!!workId, "オリジナル作品を投稿した", page.path);
must(original.answers.size > 0, "お題の答えを控えた", `${original.answers.size}枠`);

const aiPrompt = await drawPrompt(author, "easy");
page = await submitWork(
  author,
  aiPrompt.promptId,
  { title: "スモーク・AI作品", division: "ai" },
  makePng(90, 60),
);
const aiWorkId = /^\/works\/([0-9a-f-]{36})/.exec(page.path)?.[1];
must(!!aiWorkId, "AI作品を投稿した", page.path);

// ── 2. 一覧と AI の分離（Step 8 の終了条件）──────────────
section("2. AI作品が通常の一覧に出ない");
{
  const normal = await guesser.get("/works");
  must(normal.status === 200, "未サインインでも一覧が見える", `実際 ${normal.status}`);
  must(/スモーク・クイズ対象/.test(normal.html), "通常の一覧にオリジナル作品が出る");
  must(!/スモーク・AI作品/.test(normal.html), "通常の一覧に AI作品が出ない");

  const ai = await guesser.get("/works?tab=ai");
  must(/スモーク・AI作品/.test(ai.html), "AIタブには AI作品が出る");
  must(!/スモーク・クイズ対象/.test(ai.html), "AIタブに通常作品が出ない");

  const fanartTab = await guesser.get("/works?tab=fanart");
  must(
    !/スモーク・クイズ対象/.test(fanartTab.html),
    "ファンアートタブにオリジナル作品が出ない",
  );
}

// ── 3. 出題に正解の印が無い ────────────────────────────
section("3. 答える前のページに正解の印が無い");

let quiz;
{
  const res = await solver.get(`/works/${workId}`);
  must(res.status === 200, "作品ページが開ける", `実際 ${res.status}`);

  quiz = parseQuiz(res.html);
  must(quiz.length > 0, "出題が出ている", `${quiz.length}問`);
  must(
    quiz.every((q) => q.choices.length === 4),
    "どの問も4択",
    quiz.map((q) => q.choices.length).join(","),
  );
  must(!/is_correct/.test(res.html), "HTML に is_correct が出ていない");
  must(!/correct_tag_id|correct_label/.test(res.html), "HTML に正解タグの項目が無い");
  must(/回答する/.test(res.html), "回答ボタンが出ている");

  // --- 選択肢のタグが1つのお題の中で重複しないこと ---------------------------
  //
  // 【なぜこれが漏洩の検査になるか】
  //   ハズレは、そのお題の正解タグを**全枠ぶん**除いて選ばれる。
  //   だからタグ X が問Aの正解なら、X は問Bのハズレには絶対に出ない。
  //
  //   裏を返すと、X が2つの問の選択肢に出ていれば
  //   **X はどちらの問でも不正解だと確定する**。
  //   絵を見ずに候補を1つ消せてしまい、4択が実質3択になる。
  //
  //   これは画面の出し方では防げない。生成の時点で作らないしかないので、
  //   出来上がった選択肢を数えて確かめる。
  const allChoices = quiz.flatMap((q) => q.choices.map((c) => c.tagId));
  const distinct = new Set(allChoices);

  must(quiz.length === 3, "標準モードは3問", `${quiz.length}問`);
  must(allChoices.length === 12, "3問で12選択肢", `${allChoices.length}`);
  must(
    distinct.size === 12,
    "12選択肢のタグがすべて異なる（重複ゼロ）",
    `distinct=${distinct.size}`,
  );

  // 正解タグが、その問以外の選択肢に出ていないこと。
  // 上の distinct=12 が成り立てば自動的に満たされるが、
  // 「何を守っているのか」が読み取れるように明示して見る。
  for (const q of quiz) {
    const correctLabel = original.answers.get(q.slotLabel);
    const elsewhere = quiz
      .filter((other) => other.name !== q.name)
      .flatMap((other) => other.choices)
      .filter((c) => c.label === correctLabel);

    must(
      elsewhere.length === 0,
      `「${q.slotLabel}」の正解が他の問の選択肢に出ていない`,
      elsewhere.length ? `${elsewhere.length}件` : "",
    );
  }
}

// ── 4. 答えを知っている側が全問正解する ────────────────
section("4. 採点が正しい（答えを使えば全問正解になる）");
{
  const res = await solver.get(`/works/${workId}`);
  const form = forms(res.html).find((f) => /回答する/.test(f.text));
  must(!!form?.actionId, "回答フォームに Server Action がある");

  const fields = { [form.actionId]: "", workId };
  let matched = 0;

  for (const q of quiz) {
    const correctLabel = original.answers.get(q.slotLabel);
    const hit = q.choices.find((c) => c.label === correctLabel);
    if (hit) {
      fields[q.name] = hit.tagId;
      matched += 1;
    } else {
      // 答えが選択肢に無いのは異常（4択には必ず正解が1つ入る）
      fields[q.name] = q.choices[0].tagId;
    }
  }

  must(matched === quiz.length, "各問の4択に正解が含まれている", `${matched}/${quiz.length}`);

  const after = await solver.post(`/works/${workId}`, fields);
  const t = textOf(after.html);

  must(new RegExp(`${quiz.length}問中 ${quiz.length}問 正解`).test(t), "全問正解になった");
  must(/全問正解/.test(t), "全問正解の表示が出た");
  must(!hasQuizForm(after.html), "回答後は入力欄が消える");

  // 正解は「答えたあと」に初めて出る
  for (const label of original.answerLabels) {
    if (!quiz.some((q) => q.choices.some((c) => c.label === label))) continue;
    must(t.includes(label), `回答後は正解「${label}」が表示される`);
  }
}

// ── 5. 2回目は断られる ─────────────────────────────────
section("5. 同じ作品には1回しか答えられない");
{
  const res = await solver.get(`/works/${workId}`);
  must(/あなたの回答/.test(textOf(res.html)), "開き直すと結果が出る");
  must(!hasQuizForm(res.html), "2回目の入力欄は出ない");
  must(
    /もう一度答えることはできません/.test(textOf(res.html)),
    "やり直せないことが書かれている",
  );
}

// ── 6. わざと外した側は不正解になる ────────────────────
section("6. 別の選択を送ると不正解になる");
{
  const res = await guesser.get(`/works/${workId}`);
  const parsed = parseQuiz(res.html);
  const form = forms(res.html).find((f) => /回答する/.test(f.text));

  const fields = { [form.actionId]: "", workId };
  for (const q of parsed) {
    const correctLabel = original.answers.get(q.slotLabel);
    // 正解ではない選択肢を選ぶ
    const wrong = q.choices.find((c) => c.label !== correctLabel);
    fields[q.name] = wrong.tagId;
  }

  const after = await guesser.post(`/works/${workId}`, fields);
  const t = textOf(after.html);

  must(new RegExp(`${parsed.length}問中 0問 正解`).test(t), "全問不正解になった");
  must(/不正解/.test(t), "不正解の表示が出た");
  must(
    original.answerLabels.some((l) => t.includes(l)),
    "外した場合も正解が表示される",
  );
}

// ── 7. 作者は自分の作品に回答できない（D28）──────────────
section("7. 作者は自分の作品に回答できない（D28）");
{
  const res = await author.get(`/works/${workId}`);
  must(
    /自分の作品には回答できません/.test(textOf(res.html)),
    "作者には回答できない旨が出る",
  );
  must(!hasQuizForm(res.html), "作者の画面に入力欄が無い");

  // 画面に出ていなくても、POST は誰でも作れる。DB 側で止まることを確かめる。
  //
  // 作者の画面にはフォームが無いので、別の作品のページから
  // Server Action の呼び出し口だけを借りて、宛先を workId にして送る。
  // 送る選択の中身は問われない。submit_answer は作者かどうかを
  // 選択の検査より先に見るため、そこで断られる。
  const quizPage = await guesser.get(`/works/${aiWorkId}`);
  const form = forms(quizPage.html).find((f) => /回答する/.test(f.text));
  const parsed = parseQuiz(quizPage.html);

  const fields = { [form.actionId]: "", workId };
  for (const q of parsed) fields[q.name] = q.choices[0].tagId;

  const forced = await author.post(`/works/${workId}`, fields);
  must(
    /自分の作品には回答できません/.test(textOf(forced.html)),
    "直接 POST しても DB 側で断られる",
  );
}

// ── 8. 集計が実際の回答と合う ──────────────────────────
section("8. 集計（回答数・伝達率）が動く");
{
  const res = await guesser.get(`/works/${workId}`);
  const t = textOf(res.html);

  must(/項目別の伝達率/.test(t), "伝達率の欄が出ている");

  // 2人が答え、片方が全問正解・片方が全問不正解なので、
  // どの枠も「2回中1回」＝50%になる。
  const ratios = [...clean(res.html).matchAll(/(\d+) \/ (\d+)\s*<\/span>/g)].map(
    (m) => `${m[1]}/${m[2]}`,
  );
  must(ratios.length > 0, "枠ごとの内訳が出ている", ratios.join(" "));
  must(
    ratios.every((r) => r === "1/2"),
    "どの枠も 2回中1回正解（50%）",
    ratios.join(" "),
  );
  must(/50%/.test(t), "50% と表示されている");

  const list = await guesser.get("/works");
  must(/回答 2/.test(textOf(list.html)), "一覧の回答数が 2 になっている");
}

await finish();
