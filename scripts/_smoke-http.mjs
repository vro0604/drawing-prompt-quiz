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
import {
  createThrowawayUser,
  deleteReportsBy,
  ensureFixtureUser,
  loadCookies,
  storeCookies,
} from "./_smoke-users.mjs";

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

// ── 後片づけ ──────────────────────────────────────────
//
// 【なぜ要るか】
//   検査は毎回、作品と回答を新しく作る。片づけないと
//   ランキングや一覧が検査用の作品で埋まり、**次の実行の前提が変わる。**
//   何周も回す試験ではとくに効いてくる。
//
// 【消しかた】
//   画面から削除する（`/works/{id}/delete`）。専用の抜け道は作らない。
//   **この工程の削除の流れをそのまま通す**ので、片づけ自体が
//   削除機能の検査を兼ねる。行は残り、公開から外れて画像が消える。
//
// 【消すのはこの実行が作ったものだけ】
//   一覧から拾ったIDは決して入れない。投稿の応答で受け取ったIDだけを積む。

const created = [];

/** この実行が作った作品を、あとで片づけるために覚えておく */
export function trackWork(s, workId, title) {
  if (workId && title) created.push({ s, workId, title });
}

/**
 * 覚えておいた作品を消す。**失敗しても検査の合否は変えない。**
 * 片づけの失敗で「検査が落ちた」ことにすると、本題が見えなくなる。
 */
export async function cleanupCreatedWorks() {
  let removed = 0;

  for (const { s, workId, title } of created.reverse()) {
    try {
      const page = await s.get(`/works/${workId}/delete`);
      const form = forms(page.html).find((f) => /削除する/.test(f.text));
      if (!form?.actionId) continue;

      await s.post(`/works/${workId}/delete`, {
        [form.actionId]: "",
        ...form.fields,
        confirmTitle: title,
      });
      removed += 1;
    } catch {
      // 片づけの失敗は握りつぶす。掃除 Cron が拾う
    }
  }

  if (created.length > 0) {
    console.log(`\n[片づけ] この検査が作った作品 ${removed}/${created.length} 件を削除しました`);
  }
}

/**
 * この実行が作った使い捨て利用者。**後片づけの範囲を決めるためだけ**に持つ。
 * ここに入るのは数秒前に Admin API で作った人だけで、既存の利用者は入らない。
 */
const throwawayIds = [];

/**
 * 使い捨て利用者が出した通報を消す。**失敗しても合否は変えない。**
 *
 * 通報は「24時間に10件まで」。使い捨ての人を使えば枠は毎回まっさらだが、
 * 行は実データに残る。運営が見る列が検査用で埋まらないよう片づける（D91）。
 */
async function cleanupSmokeReports() {
  if (throwawayIds.length === 0) return;

  const removed = await deleteReportsBy(throwawayIds);
  if (removed === null) {
    console.log("[片づけ] 検査用の通報を消せませんでした（SUPABASE_SECRET_KEY を確認）");
  } else if (removed > 0) {
    console.log(`[片づけ] この検査が出した通報 ${removed} 件を削除しました`);
  }
}

export async function finish() {
  await cleanupCreatedWorks();
  await cleanupSmokeReports();
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

/**
 * 通信そのものが切れたときだけ、読み取りをやり直す。
 *
 * 【なぜ要るか】
 *   スモークを続けて何十回も回すと、使い回している接続を
 *   サーバー側が閉じる瞬間に当たることがある（ECONNRESET）。
 *   実際、ranking を5回連続で回した5回目で起きた。
 *
 *   これは**アプリの不具合ではない**が、ここで落ちると
 *   検査全体が中断し、本当に見たかったことが分からなくなる。
 *
 * 【やり直すのは GET だけ】
 *   POST をやり直すと、**届いていた場合に二重送信になる。**
 *   いいねが2回入ったり、作品が2件できたりしては検査にならない。
 *   POST が切れたときは、理由を書いてそのまま失敗させる。
 *
 * 【HTTP のエラーはやり直さない】
 *   404 も 500 も「届いて返ってきた」結果なので、そのまま返す。
 *   やり直してよいのは、**返事が返ってこなかったとき**だけ。
 */
export async function retryingFetch(url, options, { retry }) {
  let last;

  for (let attempt = 1; attempt <= (retry ? 3 : 1); attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (e) {
      last = e;
      const cause = e?.cause?.code ?? "";
      const transient = ["ECONNRESET", "ECONNREFUSED", "UND_ERR_SOCKET", "EPIPE"].includes(cause);
      if (!transient || attempt === 3) break;
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }

  throw new Error(
    [
      `${options?.method ?? "GET"} ${url} への通信が切れました（${last?.cause?.code ?? last?.message}）。`,
      "",
      retry
        ? "3回やり直しても届きませんでした。npm run dev が動いているか確かめてください。"
        : "**送信（POST）はやり直しません。**届いていた場合に二重送信になるためです。",
      "",
      "これはアプリの不具合ではなく、手元の接続が切れたときに出ます。",
    ].join("\n"),
  );
}

export function session(name, initialCookies) {
  const jar = new Map(Object.entries(initialCookies ?? {}));

  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

  const store = (res) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  };

  async function get(path) {
    const res = await retryingFetch(
      BASE + path,
      { headers: { cookie: cookieHeader() }, redirect: "manual" },
      { retry: true },
    );
    store(res);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      assertNotRateLimited(location);
      return get(location.replace(BASE, ""));
    }
    const html = await res.text();
    assertNotRateLimited(html);
    return { html, status: res.status, path };
  }

  async function post(path, fields, file) {
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.append(k, v);
    if (file) body.append(file.field, new Blob([file.bytes], { type: file.type }), file.name);

    const res = await retryingFetch(
      BASE + path,
      { method: "POST", headers: { cookie: cookieHeader() }, body, redirect: "manual" },
      { retry: false },
    );
    store(res);
    const loc = res.headers.get("location");
    if (loc) {
      assertNotRateLimited(loc);
      return get(loc.replace(BASE, ""));
    }
    const html = await res.text();
    assertNotRateLimited(html);
    return { html, status: res.status, path };
  }

  /** いまの Cookie を控えとして持ち出す（固定利用者の使い回しに使う） */
  const cookies = () => Object.fromEntries(jar);

  return { name, get, post, cookies };
}

/**
 * Supabase の回数制限に当たったら、**その場で止める。**
 *
 * 【なぜ要るか】
 *   ゲストを作れなくなると、回答も通報も記録されない。
 *   そのままスモークを続けると
 *     「全問正解になった」が失敗
 *     「伝達率が 50% になっている」が失敗
 *   のように、**まったく関係のない項目が失敗として並ぶ。**
 *
 *   公開前デバッグで実際にこれをやり、
 *   submit_answer の作り直しを疑って半日ぶんの回り道をした。
 *   原因が「制限に当たっただけ」と分かる形にしておく。
 *
 * 【上限】
 *   匿名サインインは**1時間あたり30回・IPアドレス単位**が既定。
 *   スモークは1周で十数人ぶん使うので、続けて何周も回すと必ず当たる。
 *   上げるのは Supabase ダッシュボードの
 *   Authentication → Rate limits（docs/launch-checklist.md 手順5）。
 */
export function assertNotRateLimited(text) {
  if (typeof text !== "string") return;
  if (!/ただいま混み合っています|Request%20rate%20limit|Request rate limit/.test(text)) return;

  throw new Error(
    [
      "",
      "Supabase の回数制限に当たりました（この先の失敗はすべて巻き添えです）。",
      "",
      "  ・匿名サインインの既定は 1時間あたり30回・IPアドレス単位",
      "  ・スモークは1周で十数人ぶん使うため、続けて回すと当たる",
      "",
      "対処:",
      "  1. 1時間ほど待ってからもう一度実行する",
      "  2. または Supabase ダッシュボード → Authentication → Rate limits で上限を上げる",
      "",
      "**これはアプリの不具合ではありません。**",
    ].join("\n"),
  );
}

/**
 * Supabase の生エラーが、そのまま画面へ出ていないか見る。
 *
 * 【なぜ要るか】
 *   本番の認証試験で `email rate limit exceeded` が画面に出た（D89）。
 *   これは送信枠を使い切っただけで、利用者の入力は正しい。
 *   英語のまま出ると「自分が間違えた」と読まれ、**同じ操作を繰り返される。**
 *   繰り返すほど枠は空かないので、いちばん困る行動を促してしまう。
 *
 * @returns 見つかった英語の断片。無ければ null
 */
const RAW_AUTH_TEXT = [
  /email rate limit exceeded/i,
  /over_email_send_rate_limit/i,
  /over_request_rate_limit/i,
  /New password should be different/i,
  /same_password/i,
  /Invalid login credentials/i,
  /User already registered/i,
  /Password should be at least/i,
  /AuthApiError/i,
];

export function rawAuthError(html) {
  const t = textOf(html);
  for (const re of RAW_AUTH_TEXT) {
    const m = re.exec(t);
    if (m) return m[0];
  }
  return null;
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
 * 作品画像の公開URL。
 *
 * **画面の HTML から拾わない。** 一覧も作品ページも next/image を通すので、
 * src は /_next/image?url=... の形になっていて、Storage の URL そのものは
 * そのままの形で現れない。取り違えたまま fetch すると、消えていなくても
 * 400 が返り、「消えている」と誤って判定してしまう。
 *
 * パスの形は spec 8-6 の {user_id}/{work_id}.{拡張子}。
 */
export function workImageUrl(userId, workId, ext = "png") {
  const env = { ...readEnvLocal(), ...process.env };
  const base = env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) throw new Error(".env.local に NEXT_PUBLIC_SUPABASE_URL がありません");
  return `${base}/storage/v1/object/public/works/${userId}/${workId}.${ext}`;
}

/**
 * メール確認が OFF になっているか確かめる。
 *
 * ON のままだと登録直後にセッションが返らず、投稿まで進めない。
 * 「投稿できない」のか「登録できていないだけ」なのか分からなくなるので、
 * 先に切り分けておく。
 */
/**
 * いま Confirm email が OFF（＝登録がその場で完了する）か。
 *
 * 【なぜ真偽値で欲しいか】
 *   本番は Confirm email が **ON**。ON のときの昇格は
 *   「確認メールを送ったところで止まる」のが正しい姿で、
 *   **止まること自体を検査したい。**
 *   一律に「OFF でなければ実行しない」にすると、
 *   本番と同じ設定での検査ができなくなる。
 */
export async function isAutoConfirm() {
  const env = { ...readEnvLocal(), ...process.env };
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) {
    console.error(".env.local に NEXT_PUBLIC_SUPABASE_URL と ...PUBLISHABLE_KEY が必要です。");
    process.exit(1);
  }

  const res = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } });
  const settings = await res.json();
  return settings.mailer_autoconfirm === true;
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

/** /account でサインイン済みかどうか */
export function isSignedIn(html) {
  return /登録ユーザーとしてサインインしています/.test(textOf(html));
}

/**
 * メールと合言葉で /account からサインインする。
 *
 * **匿名サインインではない。**認証の口は叩くが、こちらは
 * 「5分に30回」の枠で、匿名の「1時間に30回」より12倍ゆるい。
 * さらに fixtureSession が Cookie を使い回すので、
 * ふだんはここまで来ない。
 */
export async function signIn(s, email, password) {
  const page = await s.get("/account");
  const form = forms(page.html).find((f) => /サインインする/.test(f.text));
  if (!form?.actionId) throw new Error("/account にサインインフォームが見つかりません");

  const after = await s.post("/account", { [form.actionId]: "", email, password });

  if (!isSignedIn(after.html)) {
    throw new Error(
      `検査用の利用者としてサインインできませんでした: ${textOf(after.html).slice(0, 120)}`,
    );
  }
  return after;
}

/**
 * 使い回しの検査用利用者としてサインインしたセッションを返す。
 *
 * 【ここが回数制限をほどく肝】
 *   1. 前回の Cookie が控えにあれば、まずそれで開いてみる
 *   2. まだ有効ならそのまま使う → **認証の口を1回も叩かない**
 *   3. 切れていたときだけサインインし直し、新しい Cookie を控える
 *
 *   ふだんの実行は 1 と 2 で終わるので、何周回しても上限に当たらない。
 *
 * 【匿名サインインは使わない】
 *   ゲストとして遊べることは smoke:anon が確かめる。
 *   ランキングや投稿の検査は本題がそこではないので、
 *   外の上限に振り回されないよう固定利用者を使う。
 *
 * @param role 役割名。`dpq-fixture-<役割>@dpq-smoke.invalid` になる
 */
export async function fixtureSession(role) {
  const cached = loadCookies(role);
  const s = session(role, cached);

  if (Object.keys(cached).length > 0) {
    const page = await s.get("/account");
    if (isSignedIn(page.html)) {
      storeCookies(role, s.cookies());
      return s;
    }
  }

  const user = await ensureFixtureUser(role);
  const fresh = session(role);
  await signIn(fresh, user.email, user.password);
  storeCookies(role, fresh.cookies());
  return fresh;
}

/**
 * 使い捨ての検査用利用者としてサインインしたセッションを返す。
 *
 * 退会の検査のように、**その人が消える前提**の流れで使う。
 * 使い回すと次の実行で「もう居ない人」になってしまうため。
 */
export async function throwawaySession(role) {
  const user = await createThrowawayUser(role);
  const s = session(`${role}-throwaway`);
  await signIn(s, user.email, user.password);

  // 片づけの範囲に入れる。**ここに入った人の行しか消さない**
  throwawayIds.push(user.id);

  return { session: s, ...user };
}

/** 検査用の資格情報。実在しないドメインにする */
function newCredentials(label) {
  return {
    email: `dpq-smoke-${label}-${process.pid}-${Math.floor(Math.random() * 1e6)}@example.com`,
    password: `smoke-${Math.random().toString(36).slice(2)}A1!`,
  };
}

/** /account の登録フォームを探す */
async function registerForm(s) {
  const page = await s.get("/account");
  const form = forms(page.html).find(
    (f) => /登録する/.test(f.text) && !/サインインする/.test(f.text),
  );
  if (!form?.actionId) throw new Error("/account に登録フォームが見つかりません");
  return form;
}

/** /account の登録フォームを送る。ゲストなら昇格、未サインインなら新規作成 */
export async function register(s, label) {
  const { email, password } = newCredentials(label);
  const form = await registerForm(s);

  const after = await s.post("/account", { [form.actionId]: "", email, password });
  return { email, password, page: after };
}

/**
 * 登録フォームを**同時に n 本**送る（二重送信の再現）。
 *
 * 【何を再現しているか】
 *   本番でボタンに反応が無く、利用者が続けて2回押していた。
 *   1回目でパスワードが確定し、2回目が同じパスワードを送ったため
 *   Supabase が same_password を返して「登録できませんでした」と出た。
 *
 *   Enter とクリックが重なった場合も、届くのは同じ POST が2本。
 *   ここでは**まったく同時**に投げて、いちばん厳しい形で確かめる。
 *
 * @returns すべての応答ページ。1本でも失敗表示が出たら不合格
 */
export async function registerConcurrent(s, label, times) {
  const { email, password } = newCredentials(label);
  const form = await registerForm(s);

  const pages = await Promise.all(
    Array.from({ length: times }, () =>
      s.post("/account", { [form.actionId]: "", email, password }),
    ),
  );

  return { email, password, pages };
}

/**
 * 投稿フォームを送る。戻り値は移動先のページ
 *
 * 【規約への同意】
 *   P3 以降、初回の投稿には利用規約とプライバシーポリシーへの同意が要る。
 *   未同意なら画面に同意欄（agreeDocs と版の hidden）が出るので、
 *   出ていればそのまま同意して送る。
 *
 *   ここで自動的に同意させているのは、**この関数を使うすべてのスモークが
 *   「投稿できること」を確かめる目的だから**。同意そのものの検査は
 *   smoke:account が別に行う（同意しないと投稿できないことも見る）。
 *
 * 【4番目の引数】
 *   ふつうは PNG のバイト列をそのまま渡す（名前と種類は smoke.png / image/png）。
 *   **壊れた画像や、名前と中身が食い違うものを送りたいとき**は
 *   `{ bytes, name, type }` の形で渡す。smoke:work の第9節が使う。
 */
export async function submitWork(s, promptId, fields, png) {
  const page = await s.get(`/works/new?promptId=${promptId}`);
  const form = forms(page.html).find((f) => f.fields.promptId !== undefined);
  if (!form?.actionId) throw new Error("/works/new に投稿フォームが見つかりません");

  // 同意欄が出ているときだけ、版を添えて同意する
  const agree = /name="agreeDocs"/.test(page.html)
    ? {
        agreeDocs: "on",
        termsVersion: form.fields.termsVersion ?? "",
        privacyVersion: form.fields.privacyVersion ?? "",
      }
    : {};

  // バイト列そのままでも、名前と種類を添えた形でも受ける
  const file = ArrayBuffer.isView(png)
    ? { field: "image", bytes: png, name: "smoke.png", type: "image/png" }
    : { field: "image", bytes: png.bytes, name: png.name, type: png.type };

  const after = await s.post(
    `/works/new?promptId=${promptId}`,
    { [form.actionId]: "", promptId, ...agree, ...fields },
    file,
  );

  // 作れたものは、その場で片づけ対象に入れておく。
  // **各検査に覚えさせない。**忘れた1件が次の実行の前提を変えるので、
  // 作る場所が1つしかないここで機械的に積む。
  const workId = /^\/works\/([0-9a-f-]{36})/.exec(after.path)?.[1];
  if (workId) trackWork(s, workId, fields.title);

  return after;
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
