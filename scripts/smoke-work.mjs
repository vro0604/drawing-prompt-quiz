#!/usr/bin/env node
/**
 * smoke-work.mjs ／ 作品投稿の一連の流れを、ブラウザと同じ道筋で通す
 *
 * ゲストでお題を引く → 昇格して登録 → 画像を選ぶ → アップロード →
 * 作品情報を入れる → create_work → 作品詳細、までを2人ぶん動かし、
 * **非公開作品と他人の下書きが漏れないこと**を実際に確かめる。
 *
 * 【どうやってボタンを押しているか】
 *   Next.js の Server Action は JavaScript が無効でも動くように、
 *   form の中に $ACTION_ID_... という hidden 項目を置く。
 *   その項目を含めて POST すれば、ブラウザでボタンを押したのと同じことになる。
 *   画像も multipart/form-data で一緒に送れる。
 *
 * 【いちばん大事な確認】
 *   1. 匿名ゲストのままでは投稿できない（spec C3 / D27-1）
 *   2. 昇格しても uid が変わらず、ゲストのときのお題で投稿できる（11-2）
 *   3. 下書きは本人にしか見えない（他人・未サインインからは 404）
 *   4. 作品ページに、そのお題の答え（タグ名）が1文字も出ていない
 *
 * 【前提】
 *   ・別のターミナルで npm run dev を動かしておくこと
 *   ・Supabase の Authentication → Email で **Confirm email が OFF** であること
 *     （ON だと登録が確認メール待ちになり、この流れは途中で止まる。
 *       /auth/v1/settings の mailer_autoconfirm で自動判定し、
 *       OFF でなければ理由を出して終了する）
 *
 * 【秘密は使わない】
 *   SUPABASE_SECRET_KEY は読まない。画面と同じ経路だけを通す。
 *
 * 【残るデータ】
 *   **消えない。** 登録ユーザー2人と、そのお題・作品・画像が残る。
 *
 *   works.user_id は profiles を ON DELETE RESTRICT で参照しているため、
 *   作品を持つユーザーは削除できない。手で消すには先に作品を消す必要があり、
 *   それはデータの削除にあたるのでこのスクリプトには入れない。
 *   （開発用プロジェクトなので、たまるようなら手で片付ける）
 *
 * 【使い方】
 *   npm run smoke:work
 */

import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";

// ── 判定 ──────────────────────────────────────────────
let bad = 0;
const must = (ok, label, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? "  " + extra : ""}`);
  if (!ok) bad += 1;
};
const section = (t) => console.log(`\n${t}`);

// ── 前提の確認：メール確認が OFF になっているか ─────────────
//
// ON のままだと登録直後にセッションが返らず、この流れは通らない。
// 「投稿できない」のか「登録できていないだけ」なのか分からなくなるので、
// 先に切り分けておく。

function readEnvLocal() {
  const out = {};
  try {
    const text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of text.split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {
    // 無ければ下で弾く
  }
  return out;
}

const env = readEnvLocal();
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
const PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!SUPABASE_URL || !PUBLISHABLE_KEY) {
  console.error(".env.local に NEXT_PUBLIC_SUPABASE_URL と ...PUBLISHABLE_KEY が必要です。");
  process.exit(1);
}

{
  const res = await fetch(`${SUPABASE_URL}/auth/v1/settings`, {
    headers: { apikey: PUBLISHABLE_KEY },
  });
  const settings = await res.json();
  if (!settings.mailer_autoconfirm) {
    console.error(
      [
        "Supabase の Confirm email が ON になっています。",
        "",
        "この検査は画面の登録フローをそのまま通すため、確認メールの受信が挟まると進めません。",
        "対処: ダッシュボード → Authentication → Sign In / Providers → Email",
        "      → Confirm email を OFF にしてから、もう一度実行してください。",
      ].join("\n"),
    );
    process.exit(1);
  }
}

// ── ブラウザ1つぶんのセッション（Cookie を別々に持つ）─────────────
function session(name) {
  const jar = new Map();

  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

  const store = (res) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  };

  async function get(path) {
    const res = await fetch(BASE + path, {
      headers: { cookie: cookieHeader() },
      redirect: "manual",
    });
    store(res);
    if (res.status >= 300 && res.status < 400) {
      return get(res.headers.get("location").replace(BASE, ""));
    }
    return { html: await res.text(), status: res.status, path };
  }

  async function post(path, fields, file) {
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.append(k, v);
    if (file) body.append(file.field, new Blob([file.bytes], { type: file.type }), file.name);

    const res = await fetch(BASE + path, {
      method: "POST",
      headers: { cookie: cookieHeader() },
      body,
      redirect: "manual",
    });
    store(res);
    const loc = res.headers.get("location");
    if (loc) return get(loc.replace(BASE, ""));
    return { html: await res.text(), status: res.status, path };
  }

  return { name, get, post };
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

/** /account に出ている「ID: ...」を取り出す。昇格で変わらないことの確認に使う */
function accountUserId(html) {
  return /ID:\s*([0-9a-f-]{36})/.exec(textOf(html))?.[1] ?? null;
}

// ── 検査用の PNG を組み立てる ────────────────────────────
//
// 画像ライブラリを入れずに済ませたいので、最小の PNG を手で作る。
// 幅・高さを引数で変えられるようにしてあるのは、
// works.image_width / image_height が実物から数えられているかを
// 出力側で確かめるため。

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // ビット深度
  ihdr[9] = 2; // カラータイプ 2 = RGB

  // 各行は「フィルタ種別1バイト + RGB×幅」
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const at = rowStart + 1 + x * 3;
      raw[at] = (x * 7) % 256;
      raw[at + 1] = (y * 11) % 256;
      raw[at + 2] = 160;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── お題を1つ引いて確定する（/play を通す）─────────────────────
async function drawPrompt(s, modeKey) {
  let page = await s.get("/play");

  const startForm = forms(page.html).find((f) => /ドラフトを始める/.test(f.text));
  if (!startForm?.actionId) throw new Error("/play に開始フォームが見つかりません");

  page = await s.post("/play", {
    [startForm.actionId]: "",
    modeKey,
    timeLimitSeconds: "3600",
  });

  // 「めくる」ボタンが無くなるまで押し続ける
  for (let guard = 0; guard < 12; guard += 1) {
    const f = forms(page.html).find((x) => x.fields.candidateIndex !== undefined);
    if (!f) break;
    page = await s.post("/play", { [f.actionId]: "", ...f.fields });
  }

  const completeForm = forms(page.html).find((f) => /このお題で確定する/.test(f.text));
  if (!completeForm) throw new Error("確定ボタンが出ませんでした");

  page = await s.post("/play", { [completeForm.actionId]: "", ...completeForm.fields });

  const promptId = /^\/prompt\/([0-9a-f-]{36})/.exec(page.path)?.[1];
  if (!promptId) throw new Error(`確定お題ページへ移動しませんでした: ${page.path}`);

  // 答え（タグ名）を控える。あとで作品ページに出ていないことを確かめる。
  const answers = [
    ...page.html.matchAll(/<span class="text-lg font-bold">([^<]+)<\/span>/g),
  ].map((m) => m[1].trim());

  return { promptId, answers };
}

/** /account の登録フォームを送る。ゲストなら昇格、未サインインなら新規作成 */
async function register(s, label) {
  const email = `dpq-smoke-${label}-${process.pid}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const password = `smoke-${Math.random().toString(36).slice(2)}A1!`;

  const page = await s.get("/account");
  const form = forms(page.html).find(
    (f) => /登録する/.test(f.text) && !/サインインする/.test(f.text),
  );
  if (!form?.actionId) throw new Error("/account に登録フォームが見つかりません");

  const after = await s.post("/account", { [form.actionId]: "", email, password });
  return { email, password, page: after };
}

/** 投稿フォームを送る。戻り値は移動先のページ */
async function submitWork(s, promptId, fields, png) {
  const page = await s.get(`/works/new?promptId=${promptId}`);
  const form = forms(page.html).find((f) => f.fields.promptId !== undefined);
  if (!form?.actionId) throw new Error("/works/new に投稿フォームが見つかりません");

  return s.post(
    `/works/new?promptId=${promptId}`,
    { [form.actionId]: "", promptId, ...fields },
    { field: "image", bytes: png, name: "smoke.png", type: "image/png" },
  );
}

// ════════════════════════════════════════════════════════
//  ここから本番
// ════════════════════════════════════════════════════════

const author = session("author");
const stranger = session("stranger");
const visitor = session("visitor");

// ── 0. ゲストのままお題を引き、投稿できないことを確かめる ────────
section("0. 匿名ゲストは投稿できない（spec C3 / D27-1）");

const original = await drawPrompt(author, "standard");
const guestId = accountUserId((await author.get("/account")).html);

must(!!guestId, "ゲストとして発行されている", guestId ?? "");
{
  const page = await author.get(`/works/new?promptId=${original.promptId}`);
  must(
    /投稿にはアカウント登録が必要です/.test(textOf(page.html)),
    "ゲストには投稿フォームではなく登録の案内が出る",
  );
  must(!/<input[^>]*type="file"/.test(page.html), "ゲストの画面に画像の入力欄が無い");
}

// ── 1. 昇格する（uid が変わらないこと）──────────────────
section("1. ゲストから昇格して登録する（spec 11-2）");
{
  const { page } = await register(author, "author");
  must(
    /登録ユーザーとしてサインインしています/.test(textOf(page.html)),
    "登録ユーザーになった",
  );
  must(
    accountUserId(page.html) === guestId,
    "昇格しても uid が変わらない",
    `${guestId} → ${accountUserId(page.html)}`,
  );
}

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
  const t = textOf(page.html);
  const leaked = original.answers.filter((a) => a && t.includes(a));
  must(leaked.length === 0, "作品ページにお題の答えが出ていない", leaked.join(" "));
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

await register(stranger, "stranger");

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
  const t = textOf(res.html);
  const leaked = original.answers.filter((a) => a && t.includes(a));
  must(leaked.length === 0, "訪問者にもお題の答えが出ていない", leaked.join(" "));
}

// 存在しないIDも同じ 404（他人の下書きと区別がつかない）
{
  const res = await visitor.get("/works/00000000-0000-0000-0000-000000000000");
  must(res.status === 404, "存在しないIDも 404（下書きと区別がつかない）", `実際 ${res.status}`);
}

// ── 5. 下書きを公開する ────────────────────────────────
section("5. 下書きを公開する");
{
  let res = await author.get(`/works/${draftWorkId}`);
  const form = forms(res.html).find((f) => /公開する/.test(f.text));
  res = await author.post(`/works/${draftWorkId}`, { [form.actionId]: "", ...form.fields });

  // 「下書き」という語だけで見ると、作者向けの「下書きに戻す」ボタンに当たる。
  // 本人限定表示（OwnerOnlyView）から公開表示（PublicView）へ切り替わったことを、
  // 両者にしか出ない文言で見分ける。
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

console.log(bad === 0 ? "\n=== すべて期待どおり ===" : `\n=== ${bad}件 失敗 ===`);
process.exit(bad === 0 ? 0 : 1);
