#!/usr/bin/env node
/**
 * smoke-ranking.mjs ／ ランキングを、ブラウザと同じ道筋で通す
 *
 * 作品を5件用意する → いいねを押す → 回答を集める →
 * 3種類 × 2部門のランキングに、正しい順で・正しい顔ぶれで出るかを見る。
 *
 * 【いちばん大事な確認】
 *   1. **自作へのいいねが順位を動かさない**（D57）
 *      表示用の総数には入るが、順位に使う票数からは除かれる。
 *      これが効いていないと、投稿者は誰でも自分を1票ぶん押し上げられる。
 *   2. 下書き・AI作品が通常ランキングに出ない（漏洩と部門分離）
 *   3. 伝達率は回答5人以上の作品だけが並ぶ（R6）
 *   4. 時間区分がお題の制限時間で決まる（自己申告の実績時間ではない。D25）
 *   5. ランキングのページにお題の正解が出ていない（D23）
 *
 * 【順位を絶対値で見ない理由】
 *   ランキングは DB 全体を対象にする。過去のスモークで作られた作品が
 *   すでに並んでいるので「1位であること」は確かめられない。
 *   そこで**この検査が作った作品どうしの前後関係**だけを見る。
 *   ページを最後までたどってから比べるので、20件を超えても崩れない。
 *
 * 【前提】
 *   ・別のターミナルで npm run dev を動かしておくこと
 *   ・Supabase の Authentication → Email で Confirm email が OFF であること
 *
 * 【残るデータ】
 *   **消えない。** 登録ユーザー3人・ゲスト5人と、作品5件・いいね・回答が残る。
 *
 * 【使い方】
 *   npm run smoke:ranking
 */

import {
  answerWork,
  clean,
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
const RANKING_PAGE_SIZE = 20;

/** ランキングの1行を読み解く。順位・作品ID・行の文字を返す */
function parseRanking(html) {
  const out = [];
  for (const m of clean(html).matchAll(/<li class="flex items-start[\s\S]*?<\/li>/g)) {
    const frag = m[0];
    const id = /\/works\/([0-9a-f-]{36})/.exec(frag)?.[1];
    const rank = Number.parseInt(/tabular-nums">(\d+)</.exec(frag)?.[1] ?? "0", 10);
    const text = frag.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (id) out.push({ id, rank, text });
  }
  return out;
}

/**
 * ランキングを最後のページまでたどって全行を集める。
 *
 * 上位20件だけ見ると、過去のスモークが作った作品に押し出されて
 * 「出ていないこと」と「まだ先のページにあること」を取り違える。
 */
async function collectRanking(s, query) {
  const rows = [];
  for (let page = 1; page <= 12; page += 1) {
    const params = new URLSearchParams(query);
    if (page > 1) params.set("page", String(page));
    const res = await s.get(`/rankings?${params.toString()}`);
    const parsed = parseRanking(res.html);
    rows.push(...parsed);
    if (parsed.length < RANKING_PAGE_SIZE) break;
  }
  return rows;
}

/** 作品ページのいいねボタンを押す */
async function like(s, workId) {
  const page = await s.get(`/works/${workId}`);
  const form = forms(page.html).find((f) => /^いいね \d+$/.test(f.text.trim()));
  if (!form?.actionId) throw new Error(`「いいね」のボタンが見つかりません: ${workId}`);
  return s.post(`/works/${workId}`, { [form.actionId]: "", ...form.fields });
}

/** 投稿して作品IDを返す */
async function post(s, promptId, title, extra) {
  const page = await submitWork(s, promptId, { title, ...extra }, makePng(80, 60));
  const id = /^\/works\/([0-9a-f-]{36})/.exec(page.path)?.[1];
  if (!id) throw new Error(`投稿に失敗しました（${title}）: ${page.path}`);
  return id;
}

const artist = session("artist");
const fanA = session("fanA");
const fanB = session("fanB");
const guests = [1, 2, 3, 4, 5].map((n) => session(`guest${n}`));
const visitor = session("visitor"); // 未サインイン

// ── 1. 作品を用意する ────────────────────────────────────
section("1. 作品を用意する（通常3件・AI 1件・下書き1件）");

await register(artist, "artist");
await register(fanA, "fanA");
await register(fanB, "fanB");

// 制限時間を分けて、時間区分の検査に使う。
//   1800秒 → medium ／ 600秒 → short ／ 無制限 → unlimited ／ 3600秒 → long
const topPrompt = await drawPrompt(artist, "standard", "1800");
const topId = await post(artist, topPrompt.promptId, `ランキング上位${stamp}`, {
  division: "original",
});

const lowPrompt = await drawPrompt(artist, "standard", "600");
const lowId = await post(artist, lowPrompt.promptId, `ランキング下位${stamp}`, {
  division: "original",
});

const selfPrompt = await drawPrompt(artist, "easy", "");
const selfId = await post(artist, selfPrompt.promptId, `自作いいねだけ${stamp}`, {
  division: "original",
});

const aiPrompt = await drawPrompt(artist, "easy", "3600");
const aiId = await post(artist, aiPrompt.promptId, `ランキングAI${stamp}`, {
  division: "ai",
});

const draftPrompt = await drawPrompt(artist, "easy", "1800");
const draftId = await post(artist, draftPrompt.promptId, `ランキング下書き${stamp}`, {
  division: "original",
  saveAs: "draft",
});

must(!!topId && !!lowId && !!selfId && !!aiId && !!draftId, "作品を5件用意した");

// ── 2. いいねを集める ────────────────────────────────────
section("2. いいねを集める（自作へのいいねを含む）");
{
  // 上位: 他人2票 ＋ 自作1票 → 表示3 / 順位2
  await like(fanA, topId);
  await like(fanB, topId);
  await like(artist, topId);

  // 下位: 他人1票 ＋ 自作1票 → 表示2 / 順位1
  //
  // **ここが検査の要**。表示用の総数だけを見れば上位と下位はどちらも
  // 「あとから作られたほうが上」で並び替わってしまう。
  await like(fanA, lowId);
  await like(artist, lowId);

  // 自作いいねだけ: 表示1 / 順位0
  await like(artist, selfId);

  const page = await visitor.get(`/works/${topId}`);
  must(/いいね 3/.test(textOf(page.html)), "上位作品のいいねが 3 件");

  const lowPage = await visitor.get(`/works/${lowId}`);
  must(/いいね 2/.test(textOf(lowPage.html)), "下位作品のいいねが 2 件");
}

// ── 3. 未サインインでも開ける ────────────────────────────
section("3. 未サインインでもランキングが見える");
{
  const res = await visitor.get("/rankings");
  must(res.status === 200, "ランキングが開ける", `実際 ${res.status}`);
  must(/ランキング/.test(textOf(res.html)), "見出しが出ている");
  must(/人気/.test(res.html) && /伝達率/.test(res.html) && /時間別/.test(res.html),
    "3種類の切り替えが出ている");
}

// ── 4. 自作いいねが順位を動かさない（D57）────────────────
section("4. 自作へのいいねは順位に数えない（D57）");
{
  const rows = await collectRanking(visitor, { type: "popular" });

  const top = rows.find((r) => r.id === topId);
  const low = rows.find((r) => r.id === lowId);
  const self = rows.find((r) => r.id === selfId);

  must(!!top && !!low && !!self, "3件とも人気ランキングに出ている");
  must(top.rank < low.rank, "他人2票の作品が他人1票の作品より上", `${top.rank} < ${low.rank}`);

  // 表示用の総数と、順位に使った票数の両方が出ていること。
  // 総数だけなら上位3・下位2で、あとから作った下位が同点にもならないが、
  // **自作を数えたときの並び**（下位のほうが新しいので上に来る）と
  // 実際の並びが違うことが、除外が効いている証拠になる。
  must(/いいね 3 （順位に数えたのは 2）/.test(top.text), "上位: 表示3・順位2 と出ている", top.text);
  must(/いいね 2 （順位に数えたのは 1）/.test(low.text), "下位: 表示2・順位1 と出ている", low.text);
  must(/いいね 1 （順位に数えたのは 0）/.test(self.text), "自作のみ: 表示1・順位0 と出ている", self.text);

  must(self.rank > low.rank, "自作いいねだけの作品は1票の作品より下", `${self.rank} > ${low.rank}`);
}

// ── 5. 出てはいけないものが出ない ────────────────────────
section("5. 下書きと AI 作品が通常ランキングに出ない");
{
  const normal = await collectRanking(visitor, { type: "popular" });
  const ids = new Set(normal.map((r) => r.id));

  must(!ids.has(draftId), "下書きが通常ランキングに出ない");
  must(!ids.has(aiId), "AI作品が通常ランキングに出ない");

  const ai = await collectRanking(visitor, { type: "popular", feed: "ai" });
  const aiIds = new Set(ai.map((r) => r.id));

  must(aiIds.has(aiId), "AI部門には AI作品が出る");
  must(!aiIds.has(topId), "AI部門に通常作品が出ない");
  must(!aiIds.has(draftId), "AI部門にも下書きが出ない");

  const html = (await visitor.get("/rankings?feed=ai")).html;
  must(/AI生成/.test(textOf(html)), "AI部門であることが画面に出ている");
}

// ── 6. 時間区分はお題の制限時間で決まる ──────────────────
section("6. 時間別は「お題の制限時間」で分かれる（D25）");
{
  const medium = await collectRanking(visitor, { type: "duration", time: "medium" });
  const short = await collectRanking(visitor, { type: "duration", time: "short" });
  const unlimited = await collectRanking(visitor, { type: "duration", time: "unlimited" });

  must(medium.some((r) => r.id === topId), "30分のお題は「16〜59分」に出る");
  must(!short.some((r) => r.id === topId), "30分のお題は「15分以内」に出ない");
  must(short.some((r) => r.id === lowId), "10分のお題は「15分以内」に出る");
  must(unlimited.some((r) => r.id === selfId), "無制限のお題は「無制限」に出る");
  must(!unlimited.some((r) => r.id === topId), "無制限の区分に時間つきのお題が出ない");

  // 区分の中も順位は「作者本人を除いた票数」で決まる
  const mediumTop = medium.find((r) => r.id === topId);
  must(/順位に数えたのは 2/.test(mediumTop.text), "時間別でも自作いいねを除いている", mediumTop.text);
}

// ── 7. 伝達率は回答5人以上から ───────────────────────────
section("7. 伝達率は回答が5人以上の作品だけ（R6）");
{
  // まず4人だけ答える。まだ並ばないこと。
  for (const g of guests.slice(0, 4)) {
    await answerWork(g, topId, topPrompt.answers, { correct: true });
  }

  let rows = await collectRanking(visitor, { type: "accuracy" });
  must(!rows.some((r) => r.id === topId), "回答4人では伝達率ランキングに出ない");

  const page = await visitor.get("/rankings?type=accuracy");
  must(
    /回答が5人以上の作品だけが並びます/.test(textOf(page.html)),
    "5人以上という条件が画面に書かれている",
  );

  // 5人目が答えると並ぶ
  await answerWork(guests[4], topId, topPrompt.answers, { correct: true });

  rows = await collectRanking(visitor, { type: "accuracy" });
  const top = rows.find((r) => r.id === topId);
  must(!!top, "回答5人で伝達率ランキングに出る");
  must(/100%/.test(top.text), "全員正解なので 100%", top.text);
  must(/伝達率/.test(top.text), "伝達率であることが出ている");

  // 4人しか答えていない作品は、そのままでは出ない
  for (const g of guests.slice(0, 4)) {
    await answerWork(g, lowId, lowPrompt.answers, { correct: false });
  }

  rows = await collectRanking(visitor, { type: "accuracy" });
  must(!rows.some((r) => r.id === lowId), "回答4人の作品はやはり出ない");
  must(rows.some((r) => r.id === topId), "5人の作品は出たまま");
}

// ── 8. 正解が漏れていない ────────────────────────────────
section("8. ランキングの画面にお題の正解が無い（D23）");
{
  for (const query of ["", "?type=accuracy", "?type=duration&time=medium", "?feed=ai"]) {
    const res = await visitor.get(`/rankings${query}`);
    const t = textOf(res.html);

    must(!/is_correct/.test(res.html), `${query || "（既定）"}: is_correct が無い`);
    must(
      !/correct_tag_id|correct_label|prompt_id|time_limit_seconds/.test(res.html),
      `${query || "（既定）"}: 内部の項目名が漏れていない`,
    );

    const leaked = topPrompt.answerLabels.filter((label) => t.includes(label));
    must(leaked.length === 0, `${query || "（既定）"}: お題の答えが出ていない`, leaked.join(" "));
  }
}

// ── 9. 一覧からの導線 ────────────────────────────────────
section("9. 作品一覧からランキングへ行ける");
{
  const res = await visitor.get("/works");
  must(/\/rankings/.test(res.html), "作品一覧にランキングへのリンクがある");
}

finish();
