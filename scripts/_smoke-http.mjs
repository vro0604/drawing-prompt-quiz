/**
 * _smoke-http.mjs ／ スモークテストの共通部分
 *
 * smoke-work.mjs と smoke-answer.mjs が使う。
 * 「画面をブラウザと同じ道筋で叩く」ための道具だけを置き、
 * **何を確かめるか**は各スクリプト側に書く。
 *
 * 【Server Action の押しかた】
 *   Next.js の Server Action は JavaScript が無効でも動くように、
 *   form の中に $ACTION_ID_... という hidden 項目を置く。
 *   その項目を含めて POST すれば、ボタンを押したのと同じことになる。
 *   だからヘッドレスブラウザを入れずに画面の流れを確かめられる。
 */

import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

export const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";

// ── 判定 ──────────────────────────────────────────────

let failures = 0;

export function must(ok, label, extra = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? "  " + extra : ""}`);
  if (!ok) failures += 1;
  return ok;
}

export function section(title) {
  console.log(`\n${title}`);
}

export function finish() {
  console.log(failures === 0 ? "\n=== すべて期待どおり ===" : `\n=== ${failures}件 失敗 ===`);
  process.exit(failures === 0 ? 0 : 1);
}

// ── HTML の扱い ────────────────────────────────────────

/**
 * HTML コメントを取り除く。
 *
 * React は隣り合う値の境目に <!-- --> を挟むことがある。
 *   {n}. {label} はどれ？  →  1<!-- -->. <!-- -->モチーフA<!-- --> はどれ？
 * 素の文字列として照合すると必ず外すので、先に落としておく。
 */
export function clean(html) {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

/** タグを落として本文だけにする */
export function textOf(html) {
  return clean(html)
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** form 要素を切り出して、action id と hidden 項目を取り出す */
export function forms(html) {
  const out = [];
  const re = /<form\b[\s\S]*?<\/form>/g;
  const source = clean(html);
  let m;
  while ((m = re.exec(source))) {
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

// ── ブラウザ1つぶんのセッション（Cookie を別々に持つ）─────────────

export function session(name) {
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

// ── 前提の確認 ────────────────────────────────────────

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

/**
 * メール確認が OFF になっているか確かめる。
 *
 * ON のままだと登録直後にセッションが返らず、投稿まで進めない。
 * 「投稿できない」のか「登録できていないだけ」なのか分からなくなるので、
 * 先に切り分けておく。
 */
export async function requireAutoConfirm() {
  const env = { ...readEnvLocal(), ...process.env };
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) {
    console.error(".env.local に NEXT_PUBLIC_SUPABASE_URL と ...PUBLISHABLE_KEY が必要です。");
    process.exit(1);
  }

  const res = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } });
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

// ── 検査用の PNG を組み立てる ────────────────────────────
//
// 画像ライブラリを入れずに済ませたいので、最小の PNG を手で作る。
// 幅・高さを引数で変えられるのは、works.image_width / image_height が
// 実物から数えられているかを出力側で確かめるため。

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

export function makePng(width, height) {
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

// ── 画面の流れ（複数のスクリプトで使うもの）─────────────────

/**
 * お題を1つ引いて確定する。答え（枠 → タグ）も控えて返す。
 *
 * timeLimitSeconds は時間別ランキングの区分を作り分けるために渡せる。
 * 空文字は「無制限」（/play の選択肢と同じ値）。既定の 3600 は、
 * 先に書いた検査の前提を変えないため。
 */
export async function drawPrompt(s, modeKey, timeLimitSeconds = "3600") {
  let page = await s.get("/play");

  const startForm = forms(page.html).find((f) => /ドラフトを始める/.test(f.text));
  if (!startForm?.actionId) throw new Error("/play に開始フォームが見つかりません");

  page = await s.post("/play", {
    [startForm.actionId]: "",
    modeKey,
    timeLimitSeconds,
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

  // 答え。枠のラベル → タグのラベル。
  // 作品ページに出ていないことの確認と、クイズに正解するために使う。
  const answers = new Map();
  const html = clean(page.html);
  for (const m of html.matchAll(
    /<span class="w-28[^"]*">([^<]+)<\/span>\s*<span class="text-lg font-bold">([^<]+)<\/span>/g,
  )) {
    answers.set(m[1].trim(), m[2].trim());
  }

  return { promptId, answers, answerLabels: [...answers.values()] };
}

/** /account の登録フォームを送る。ゲストなら昇格、未サインインなら新規作成 */
export async function register(s, label) {
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
export async function submitWork(s, promptId, fields, png) {
  const page = await s.get(`/works/new?promptId=${promptId}`);
  const form = forms(page.html).find((f) => f.fields.promptId !== undefined);
  if (!form?.actionId) throw new Error("/works/new に投稿フォームが見つかりません");

  return s.post(
    `/works/new?promptId=${promptId}`,
    { [form.actionId]: "", promptId, ...fields },
    { field: "image", bytes: png, name: "smoke.png", type: "image/png" },
  );
}

/**
 * 作品のクイズに1回答える。
 *
 * answers は drawPrompt が返した「枠のラベル → タグのラベル」。
 * correct を false にすると、正解以外を選んで全問外す。
 *
 * 【同じセッションで2回呼ばない】
 *   1つの作品には1回しか答えられない（UNIQUE(work_id, user_id)）。
 *   回答者を増やしたいときはセッションを分ける。
 */
export async function answerWork(s, workId, answers, { correct = true } = {}) {
  const res = await s.get(`/works/${workId}`);
  const parsed = parseQuiz(res.html);
  const form = forms(res.html).find((f) => /回答する/.test(f.text));
  if (!form?.actionId) throw new Error(`/works/${workId} に回答フォームがありません`);

  const fields = { [form.actionId]: "", workId };
  for (const q of parsed) {
    const correctLabel = answers.get(q.slotLabel);
    const pick = correct
      ? (q.choices.find((c) => c.label === correctLabel) ?? q.choices[0])
      : (q.choices.find((c) => c.label !== correctLabel) ?? q.choices[0]);
    fields[q.name] = pick.tagId;
  }

  return s.post(`/works/${workId}`, fields);
}

/**
 * 出題フォームを読み解く。
 *
 * 1問 = 1つの fieldset。legend が「1. モチーフA はどれ？」の形で、
 * 中のラジオが name="q_{問のID}" value="{タグのID}"、
 * その直後の span が選択肢の文字。
 */
export function parseQuiz(html) {
  const source = clean(html);
  const questions = [];

  for (const fs of source.matchAll(/<fieldset[\s\S]*?<\/fieldset>/g)) {
    const frag = fs[0];

    const legend = /<legend[^>]*>([\s\S]*?)<\/legend>/.exec(frag)?.[1] ?? "";
    // 「1. モチーフA はどれ？」から枠のラベルだけを取り出す
    const slotLabel = legend
      .replace(/<[^>]+>/g, "")
      .replace(/^\s*\d+\.\s*/, "")
      .replace(/\s*はどれ？\s*$/, "")
      .trim();

    const choices = [];
    let name = null;
    for (const c of frag.matchAll(
      /name="(q_\d+)"[^>]*value="(\d+)"[^>]*>\s*<span>([^<]*)<\/span>/g,
    )) {
      name = c[1];
      choices.push({ tagId: c[2], label: c[3].trim() });
    }

    if (name) questions.push({ name, slotLabel, choices });
  }

  return questions;
}

/**
 * 回答の入力欄が出ているか。
 *
 * 「回答する」という文字列では見分けられない。作者向けの案内にある
 * 「回答すると伝達率が…」にも含まれてしまうため。
 * ラジオボタンそのものの有無で見る。
 */
export function hasQuizForm(html) {
  return parseQuiz(html).length > 0;
}

/**
 * 出題部分（fieldset）を取り除いた本文。
 *
 * 【なぜ必要か】
 *   正解のタグは4択のうちの1つとして必ず HTML に出る。だから
 *   「答えの文字が page に無いこと」では漏洩を確かめられない。
 *   要件は **どれが正解か分からないこと** なので、
 *   選択肢の外に答えが出ていないかを見る。
 */
export function textOutsideQuiz(html) {
  return textOf(clean(html).replace(/<fieldset[\s\S]*?<\/fieldset>/g, ""));
}

/** /account に出ている「ID: ...」を取り出す。昇格で変わらないことの確認に使う */
export function accountUserId(html) {
  return /ID:\s*([0-9a-f-]{36})/.exec(textOf(html))?.[1] ?? null;
}
