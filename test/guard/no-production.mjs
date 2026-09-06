/**
 * no-production.mjs ／ ローカルの試験が本番へ1バイトも送らないようにする柵
 *
 * 【なぜ要るか】
 *   2026-09-05 に、ローカルのスモークが .env.local を読み込んで
 *   **本番の Supabase へ認証要求を送った。**拒否されたので実害は無かったが、
 *   拒否されたから無害だっただけで、止めたのは本番側であってこちら側ではない。
 *
 *   同じことが起きない形にする。読み込み順を直すのではなく、
 *   **通信を始める前に接続先を検査して、本番なら異常終了させる。**
 *
 * 【何を本番と見なすか（推測しない）】
 *   このプロジェクトの実際の本番識別子を、名前で列挙する。
 *   「production らしい文字列」といった当て推量はしない。
 *     ・Supabase の project ref
 *     ・その project の hostname
 *     ・本番のドメイン
 *   加えて、.env.local に書かれている値そのもの（鍵を含む）を
 *   **ハッシュにして**照合する。値は1文字も表示しない。
 *
 * 【いつ止めるか】
 *   最初のネットワーク要求より前。install() を呼んだ時点で
 *     ① いまの環境変数を全部見る
 *     ② グローバルの fetch を包み、許可した宛先以外を投げる
 *   の2つを行う。②があるので、あとから環境変数を書き換えても素通りしない。
 *
 * 【解除できないこと】
 *   環境変数では外せない。外す手段は「production 用の別の入口から入る」
 *   ことだけで、それは process.argv に --production を付けたときにしか
 *   起こらない（scripts/_env-target.mjs）。
 *   ローカル試験のコマンドはその引数を渡さないので、外れようがない。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * このプロジェクトの本番識別子。**推測ではなく実在の値。**
 * 出所: package.json の db:link（--project-ref）と .env.local の接続先。
 */
export const PRODUCTION_REFS = ["oyyiutiptsffckujqkvl"];

export const PRODUCTION_HOSTS = [
  "oyyiutiptsffckujqkvl.supabase.co",
  "tsutawarukana.com",
  "www.tsutawarukana.com",
  "drawing-prompt-quiz.vercel.app",
];

/**
 * ここへだけ通信してよい。
 *
 * 【IPv6 の loopback を入れていない理由】
 *   2026-09-05 に数えたところ、この工程で `[::1]` を書いている場所は
 *   **1つも無い。**擬似 Supabase は 127.0.0.1 に bind し
 *   （test/e2e/supabase-mock.mjs の listen(0, "127.0.0.1")）、
 *   アプリは `next dev --hostname 127.0.0.1` で立て、
 *   スモークの既定の宛先は http://localhost:3000。
 *   **使っていない宛先を許可すると、柵の穴がそのぶん増える。**
 *   IPv6 で待ち受ける形に変えるときは、そのときここへ足す。
 */
export const ALLOWED_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "0.0.0.0",
]);

/** 接続先が入りうる環境変数。ここに無い名前も、値の照合では全部見る */
const CONNECTION_VARS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_DB_URL",
  "DATABASE_URL",
  "POSTGRES_URL",
  "NEXT_PUBLIC_SITE_URL",
  "SMOKE_BASE_URL",
  "SITE_DOMAIN",
];

/**
 * 公開されている試験用の値。**秘密ではないので照合から外す。**
 *
 * Cloudflare Turnstile が公開しているテスト鍵。誰でも同じ値を使うので、
 * .env.local に入っていても「本番の資格情報」ではない。
 * 外さないと、検証用の環境が同じ値を使っているだけで柵に止められる
 * （実測: test:e2e が起動できなかった）。
 * scripts/check-env.mjs の TEST_KEYS と同じ一覧。
 */
const PUBLIC_TEST_VALUES = new Set([
  "1x00000000000000000000AA",
  "2x00000000000000000000AB",
  "3x00000000000000000000FF",
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
]);

/** 値を出さずに「同じ値かどうか」だけを見るための短い指紋 */
function fingerprint(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

/**
 * .env.local に書かれている値の指紋を作る。
 *
 * **値そのものは返さない。**返すのは「変数名 → 指紋」だけ。
 * これで「本番の鍵が環境に入っている」ことを、鍵を表示せずに言える。
 */
function productionSecretFingerprints() {
  const map = new Map();
  let text;
  try {
    text = readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
  } catch {
    return map; // 手元に本番の控えが無い環境（CI など）。照合するものが無いだけ
  }

  for (const line of text.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const value = m[2].trim();
    // 短すぎる値は偶然一致しうるので照合しない（"1" や "true" など）
    if (value.length < 12) continue;
    // 公開の試験用の値は秘密ではない
    if (PUBLIC_TEST_VALUES.has(value)) continue;
    map.set(fingerprint(value), m[1]);
  }
  return map;
}

/** 本番の文字列が入っていないか */
function scanValue(name, value) {
  const problems = [];
  const lower = String(value).toLowerCase();

  for (const ref of PRODUCTION_REFS) {
    if (lower.includes(ref)) {
      problems.push(`${name} に本番の project ref が入っています`);
    }
  }
  for (const host of PRODUCTION_HOSTS) {
    if (lower.includes(host)) {
      problems.push(`${name} に本番のホスト名（${host}）が入っています`);
    }
  }
  return problems;
}

/** URL らしい値の宛先が、許可したホストか */
function scanHost(name, value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return []; // URL でないなら、ここでは何も言わない（文字列の検査は別に通る）
  }
  if (ALLOWED_HOSTS.has(url.hostname)) return [];
  return [`${name} の接続先ホストが ${url.hostname} です（許可はローカルのみ）`];
}

/**
 * いまの環境変数を全部調べる。問題があれば理由の配列を返す。
 * **値は1つも含めない。**含めるのは変数名と、ホスト名だけ。
 */
export function inspectEnvironment(env = process.env) {
  const problems = [];
  const secrets = productionSecretFingerprints();

  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || value === "") continue;

    problems.push(...scanValue(name, value));

    if (value.length >= 12) {
      const source = secrets.get(fingerprint(value));
      if (source) {
        problems.push(
          `${name} の値が .env.local の ${source} と同じです（本番の資格情報）`,
        );
      }
    }
  }

  for (const name of CONNECTION_VARS) {
    const value = env[name];
    if (typeof value === "string" && value !== "") {
      problems.push(...scanHost(name, value));
    }
  }

  return [...new Set(problems)];
}

/** 失敗したときの出しかた。**値は出さない** */
function abort(problems, context) {
  console.error("");
  console.error("========================================================");
  console.error(" 本番への接続を検出したため、実行を中止しました");
  console.error("========================================================");
  console.error(` 場所: ${context}`);
  console.error("");
  for (const p of problems) console.error(`  ・${p}`);
  console.error("");
  console.error(" ローカルの試験は 127.0.0.1 / localhost へしか接続できません。");
  console.error(" 本番を確かめたいときは、本番用のコマンド（末尾に --production を");
  console.error(" 付ける経路）を使ってください。この柵は環境変数では外せません。");
  console.error("");
  process.exit(70);
}

/**
 * 宛先が許可されているか。**ホスト名だけを見る。**
 * 末尾のスラッシュ・大文字小文字・パス・ポート・利用者情報が付いていても、
 * URL として解釈したあとの hostname は同じになる。
 */
export function isAllowedUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return null; // URL として読めない（相対など）。ここでは判断しない
  }
  return ALLOWED_HOSTS.has(url.hostname.toLowerCase());
}

let installed = false;

/**
 * 柵を立てる。**最初のネットワーク要求より前に呼ぶこと。**
 *
 *   1. いまの環境変数を調べ、本番の痕跡があればその場で終了する
 *   2. グローバルの fetch を包み、許可外のホストへの要求を投げる
 *
 * 2 があるので、あとから環境変数を差し替えても素通りしない。
 */
export function installLocalOnlyGuard(context = "ローカル試験") {
  if (installed) return;
  installed = true;

  const problems = inspectEnvironment();
  if (problems.length > 0) abort(problems, context);

  const originalFetch = globalThis.fetch;

  /** 止めるときの共通処理。**握りつぶせない形にする** */
  function block(kind, host) {
    const message =
      `本番または外部への${kind}を止めました: ${host}（${context}）。` +
      "ローカル試験が接続してよいのは 127.0.0.1 / localhost だけです。";
    console.error(`\n${message}\n`);
    // 例外にすると呼び出し側が握りつぶすことがある。終了コードも立てる
    process.exitCode = 70;
    return new Error(message);
  }

  globalThis.fetch = async function guardedFetch(input, init) {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input?.url ?? "");

    const allowed = isAllowedUrl(raw);
    if (allowed === false) {
      throw block("通信", new URL(raw).hostname);
    }

    // --- リダイレクトを自分で追う -------------------------------------------
    //
    // 【なぜ要るか】
    //   fetch は既定で 3xx を自動で追う。追うのは fetch の内側なので、
    //   **ここで包んでも2跳び目以降は見えない。**
    //   ローカルのページが外部へ 302 を返したら、そのまま外へ出てしまう。
    //
    //   そこで、呼び出し側が既定（follow）のときだけ manual に切り替え、
    //   1跳びごとに宛先を検査してから自分で追う。
    //   呼び出し側が manual / error を指定しているときは何もしない
    //   （その場合は跳ばないので、追う必要が無い）。
    const wantsFollow = !init?.redirect || init.redirect === "follow";
    if (!wantsFollow) {
      return originalFetch.call(this, input, init);
    }

    let target = input;
    let options = { ...init, redirect: "manual" };

    for (let hop = 0; hop <= 20; hop += 1) {
      const res = await originalFetch.call(this, target, options);

      if (res.status < 300 || res.status > 399) return res;

      const location = res.headers.get("location");
      if (!location) return res;

      const base =
        typeof target === "string"
          ? target
          : target instanceof URL
            ? target.href
            : (target?.url ?? "");
      const next = new URL(location, base);

      if (!ALLOWED_HOSTS.has(next.hostname.toLowerCase())) {
        throw block("リダイレクト", next.hostname);
      }

      // 303、および 301/302 の POST は GET に落ちる（Fetch の規定と同じ）
      const method = (options.method ?? "GET").toUpperCase();
      const toGet =
        res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST");

      target = next.href;
      options = toGet
        ? { ...options, method: "GET", body: undefined }
        : options;
    }

    throw block("リダイレクト", "（20回を超えました）");
  };

  // --- WebSocket も同じ柵の中に入れる ---------------------------------------
  //
  // fetch を包んでも WebSocket は素通りする。宛先の形が同じなので、
  // 同じ許可一覧で判定する。Node 22 以降はグローバルにある。
  const OriginalWebSocket = globalThis.WebSocket;
  if (typeof OriginalWebSocket === "function") {
    class GuardedWebSocket extends OriginalWebSocket {
      constructor(url, protocols) {
        const raw = url instanceof URL ? url.href : String(url);
        let host = null;
        try {
          host = new URL(raw).hostname.toLowerCase();
        } catch {
          host = null;
        }
        if (host !== null && !ALLOWED_HOSTS.has(host)) {
          throw block("WebSocket 接続", host);
        }
        super(url, protocols);
      }
    }
    globalThis.WebSocket = GuardedWebSocket;
  }

  return { originalFetch };
}

/**
 * `.env.local` に書かれている**変数名だけ**を返す。値は返さない。
 *
 * Next.js は `.env.local` を必ず読む（@next/env の loadEnvConfig）。
 * `NEXT_DISABLE_ENV_FILES` のような取り消しの仕組みは 16.2.12 に無い
 * （実測: node_modules/@next/env/dist/index.js に該当の分岐が1つも無い）。
 *
 * ただし **すでに環境にある名前は上書きしない**作りになっている
 * （同ファイルの processEnv: `typeof l[t]==="undefined"` のときだけ入れる）。
 * だから「名前だけ先に埋めておく」と、本番の値は1つも入ってこない。
 */
export function envFileKeys() {
  try {
    const text = readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
    const keys = [];
    for (const line of text.split("\n")) {
      const m = /^([A-Z0-9_]+)=/.exec(line.trim());
      if (m) keys.push(m[1]);
    }
    return keys;
  } catch {
    return [];
  }
}

/**
 * 子プロセスへ渡す環境から、`.env.local` の値が入り込む隙を無くす。
 *
 * こちらが指定していない名前には、**当たり障りのない印**を入れておく。
 * 入れておけば Next.js の読み込みは「すでにある」と判断して素通りする。
 *
 * **値を読んで写すのではない。**名前だけを見て、別の文字列を置く。
 */
export function neutraliseEnvFiles(env) {
  const out = { ...env };
  for (const key of envFileKeys()) {
    if (out[key] === undefined || out[key] === "") {
      out[key] = "unused-in-local-checks";
    }
  }
  return out;
}

/** 環境変数から .env.local 由来の値を読ませないための空の入れ物 */
export const NO_ENV_FILE = Object.freeze({});
