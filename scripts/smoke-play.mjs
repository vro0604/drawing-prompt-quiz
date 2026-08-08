#!/usr/bin/env node
/**
 * smoke-play.mjs ／ /play の一連の流れを、ブラウザと同じ道筋で通す
 *
 * モード選択 → start_draft → 伏せカード表示 → reveal_card ×5 →
 * reroll_draft → reveal_card ×5 → complete_draft → 確定お題ページ
 *
 * 【どうやってボタンを押しているか】
 *   Next.js の Server Action は JavaScript が無効でも動くように、
 *   form の中に $ACTION_ID_... という hidden 項目を置く。
 *   その項目を含めて POST すれば、ブラウザでボタンを押したのと同じことになる。
 *   だからヘッドレスブラウザを入れずに画面の流れを確かめられる。
 *
 * 【いちばん大事な確認】
 *   めくる前のカードの中身が HTML に含まれていないこと。
 *   ここが漏れると、ページのソースを見るだけで答えが分かってしまう。
 *
 * 【前提】
 *   別のターミナルで npm run dev を動かしておくこと。
 *
 * 【残るデータ】
 *   ゲスト1人ぶんの draft_sessions と prompts が残る。
 *   手で操作したときと同じもので、30日後の掃除対象になる。
 *
 * 【使い方】
 *   npm run smoke:play
 */
import { assertNotRateLimited, fixtureSession, retryingFetch } from "./_smoke-http.mjs";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";

// **ゲストではなく固定の検査用利用者で回す。**
//
// この検査の本題はドラフト画面の流れ（めくる・引き直す・確定する）で、
// 「ゲストのまま引けること」は smoke:anon が持っている。
// ゲストで回すと 1回ごとに匿名サインインを使い、
// 続けて回すと Supabase の上限（1時間30回・IP単位）に当たる（D83）。
//
// fixtureSession が用意した Cookie をそのまま種にする。
const seed = await fixtureSession("play-user");
const jar = new Map(Object.entries(seed.cookies()));

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function storeCookies(res) {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const c of raw) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

async function get(path) {
  const res = await retryingFetch(
    BASE + path,
    { headers: { cookie: cookieHeader() }, redirect: "manual" },
    { retry: true },
  );
  storeCookies(res);
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    // 回数制限に当たったら、ここで止める。
    // 先へ進めても「盤面が出た」「めくるボタンがある」が
    // 次々に失敗するだけで、原因がまったく読み取れない。
    assertNotRateLimited(location);
    return get(location.replace(BASE, ""));
  }
  const html = await res.text();
  assertNotRateLimited(html);
  return { html, status: res.status, path };
}

async function post(path, fields) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  const res = await retryingFetch(
    BASE + path,
    { method: "POST", headers: { cookie: cookieHeader() }, body, redirect: "manual" },
    { retry: false },
  );
  storeCookies(res);
  const loc = res.headers.get("location");
  if (loc) return get(loc.replace(BASE, ""));
  return { html: await res.text(), status: res.status, path };
}

/** form 要素を切り出して、action id と hidden 項目を取り出す */
function forms(html) {
  const out = [];
  const re = /<form\b[\s\S]*?<\/form>/g;
  let m;
  while ((m = re.exec(html))) {
    const frag = m[0];
    const actionId = /name="(\$ACTION_ID_[a-f0-9]+)"/.exec(frag)?.[1];
    const fields = {};
    for (const im of frag.matchAll(/<input[^>]*name="([^"$][^"]*)"[^>]*value="([^"]*)"[^>]*>/g)) {
      fields[im[1]] = im[2];
    }
    const text = frag.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    out.push({ actionId, fields, text, frag });
  }
  return out;
}

function textOf(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 盤面の進み具合を「決まった枠 / 全部の枠」で返す。
 *
 * 【文言から読まない】
 *   以前は「0 / 5 枠 決定」という**画面の文字**で確かめていた。
 *   言い回しを変えるだけでこの検査が落ちるので、手がかりを data-* に移した。
 *   進み具合の見せ方（棒・点・文章）は自由に変えられる。
 */
function progress(html) {
  const tag = /<[a-z]+[^>]*\sdata-board[^>]*>/.exec(html)?.[0] ?? "";
  const chosen = /data-chosen="(\d+)"/.exec(tag)?.[1];
  const slots = /data-slots="(\d+)"/.exec(tag)?.[1];
  return chosen === undefined || slots === undefined ? null : `${chosen}/${slots}`;
}

/**
 * まだめくっていないカードの枚数。
 *
 * 【「?」を数えない】
 *   以前は `>?</button>` の個数で数えていた。**伏せカードの見た目を
 *   変えると落ちる**ので、めくりの演出に手を入れられなかった。
 */
function hiddenCards(html) {
  return (html.match(/data-card="hidden"/g) ?? []).length;
}

const log = (ok, label, extra = "") =>
  console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? "  " + extra : ""}`);

let bad = 0;
const must = (ok, label, extra = "") => {
  log(ok, label, extra);
  if (!ok) bad += 1;
};

// ── 1. モード選択画面 ─────────────────────────────
let page = await get("/play");
must(page.status === 200, "GET /play が 200");
must(/モード/.test(page.html) && /標準/.test(page.html), "モード選択が出ている");
// 「まだサインインしていません」の表示は、未サインインで開いたときのもの。
// この検査は固定の検査用利用者で回すので出ない（smoke:anon が見ている）。
must(
  !/まだサインインしていません/.test(page.html),
  "サインイン済みとして開けている",
);

// ── 2. start_draft ────────────────────────────────
const startForm = forms(page.html).find((f) => /ドラフトを始める/.test(f.text));
must(!!startForm?.actionId, "開始フォームに Server Action がある");
page = await post("/play", {
  [startForm.actionId]: "",
  modeKey: "standard",
  timeLimitSeconds: "3600",
});
must(/標準/.test(textOf(page.html)) && progress(page.html) === "0/5", "盤面が出た（0/5 枠）");
must(/ゲスト/.test(page.html), "ゲストとして発行された");

const hiddenCount = hiddenCards(page.html);
must(hiddenCount === 5, "いまめくれるのは1枠ぶんの5枚だけ", `実際 ${hiddenCount}`);
must(!/万年筆|折り鶴|妖精/.test(textOf(page.html)), "伏せカードの中身が HTML に出ていない");

// ── 3. reveal_card ×5 ─────────────────────────────
for (let i = 1; i <= 5; i += 1) {
  const f = forms(page.html).find((x) => x.fields.candidateIndex !== undefined);
  if (!f) {
    must(false, `${i}枠目のめくるボタンが見つかる`);
    break;
  }
  page = await post("/play", { [f.actionId]: "", ...f.fields });
  must(progress(page.html) === `${i}/5`, `${i}枠目を決定`, progress(page.html) ?? "-");
}
must(/このお題で確定する/.test(page.html), "確定ボタンが出た");

// ── 4. reroll ─────────────────────────────────────
const rerollForm = forms(page.html).find((f) => /全部引き直す/.test(f.text));
must(!!rerollForm, "引き直しボタンがある");
page = await post("/play", { [rerollForm.actionId]: "", ...rerollForm.fields });
must(progress(page.html) === "0/5", "引き直して白紙に戻った", progress(page.html) ?? "-");
must(/引き直し 残り 0 回/.test(textOf(page.html)), "残り回数が0になった");
must(!/全部引き直す/.test(page.html), "引き直しボタンが消えた");

// ── 5. 再度めくって確定 ────────────────────────────
for (let i = 1; i <= 5; i += 1) {
  const f = forms(page.html).find((x) => x.fields.candidateIndex !== undefined);
  page = await post("/play", { [f.actionId]: "", ...f.fields });
}
must(progress(page.html) === "5/5", "5枠すべて決定", progress(page.html) ?? "-");

// ── 6. complete_draft → 確定お題ページ ─────────────
const completeForm = forms(page.html).find((f) => /このお題で確定する/.test(f.text));
page = await post("/play", { [completeForm.actionId]: "", ...completeForm.fields });
must(/^\/prompt\//.test(page.path), "確定お題ページへ移動した", page.path);
must(/お題が確定しました/.test(page.html), "確定の見出しが出た");
const slotLabels = ["モチーフA", "モチーフB", "メインカラー", "種族", "ジャンル類型"];
must(
  slotLabels.every((l) => page.html.includes(l)),
  "5枠すべての答えが並んでいる",
);
must(/制作時間 1時間/.test(textOf(page.html)), "制作時間が出ている");
must(/引き直し 1 回/.test(textOf(page.html)), "引き直しの記録が出ている");
must(/引かなかったカードは/.test(page.html), "未選択カードは未開示のまま");

console.log("\n答え: " + textOf(page.html).match(/お題[\s\S]{0,200}/)?.[0]?.slice(0, 200));

// ── 7. 確定後の /play ──────────────────────────────
page = await get("/play");
must(/ドラフトを始める/.test(page.html), "確定後は新しいドラフトを始められる");

console.log(bad === 0 ? "\n=== すべて期待どおり ===" : `\n=== ${bad}件 失敗 ===`);
process.exit(bad === 0 ? 0 : 1);
