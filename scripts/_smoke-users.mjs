/**
 * _smoke-users.mjs ／ 検査用の利用者を用意する
 *
 * ============================================================================
 * 【なぜ要るか】
 * ============================================================================
 *
 *   スモークはこれまで、必要な人数ぶん**匿名サインイン**をしていた。
 *   ゲストのまま遊べることがこのサービスの入口なので、
 *   検査もそれをなぞるのが自然に見えた。
 *
 *   ところが匿名サインインには **1時間30回・IPアドレス単位**という
 *   Supabase 側の上限がある。smoke:ranking は1回でゲストを5人使うので、
 *   続けて回すと必ず当たる。当たると
 *
 *     ・回答が記録されない
 *     ・「全問正解になった」「伝達率が50%」など**無関係な項目が失敗する**
 *     ・原因が読み取れず、アプリの不具合を疑って回り道をする
 *
 *   実際に公開前デバッグでこれをやり、submit_answer の作り直しを
 *   疑うところまで行った（D83）。
 *
 *   **外の上限に、こちらの検査が引きずられている状態だった。**
 *
 * ============================================================================
 * 【どう変えたか】
 * ============================================================================
 *
 *   1. 利用者は **Admin API で作る**（`auth.admin.createUser`）。
 *      管理用の口なので、公開の口にかかる回数制限を受けない。
 *
 *   2. 一度サインインしたら、その **Cookie を手元に保存して使い回す**。
 *      2回目以降の実行では認証の口をまったく叩かない。
 *
 *   3. **匿名サインインを使うのは smoke:anon だけ。**
 *      「ゲストのまま遊べる」ことはサービスの要件なので検査は続けるが、
 *      それを確かめる場所を1か所に集めた。
 *      ほかの検査は本題（ランキング・投稿・回答…）に集中する。
 *
 * ============================================================================
 * 【テスト専用だと分かるようにする】
 * ============================================================================
 *
 *   メールアドレスは必ず
 *
 *     dpq-fixture-<役割>@dpq-smoke.invalid
 *
 *   の形。`.invalid` は**規格上けっして実在しない**トップレベルドメイン
 *   （RFC 2606）なので、本物の利用者と取り違えようがない。
 *
 *   表示名にも「[検査用]」を付ける。
 *
 * ============================================================================
 * 【既存のデータには触れない】
 * ============================================================================
 *
 *   ここが作るのは上の形のメールを持つ利用者だけ。
 *   既存の利用者を探して使い回すことも、消すこともしない。
 *
 * ============================================================================
 * 【後片づけ】
 * ============================================================================
 *
 *   固定利用者そのものは**残す**（次の実行で使い回すため）。
 *   毎回消すと、そのたびに作り直しとサインインが必要になり、
 *   元の問題に戻ってしまう。
 *
 *   消すのは各検査が作った作品で、それは `_smoke-http.mjs` の
 *   `cleanupCreatedWorks()` が受け持つ。
 *
 *   固定利用者を消したいときは `node scripts/_smoke-users.mjs --purge`。
 */

import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

/** 実在しないことが規格で保証されているドメイン（RFC 2606） */
const DOMAIN = "dpq-smoke.invalid";
const PREFIX = "dpq-fixture-";

/** Cookie と資格情報の控え。Git には入れない（.gitignore 済み） */
const CACHE_FILE = new URL("../.smoke-fixtures.json", import.meta.url);

// ── 環境変数 ──────────────────────────────────────────

function readEnvLocal() {
  const out = {};
  try {
    const text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of text.split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2].trim();
    }
  } catch {
    // 無ければ process.env だけで進む
  }
  return { ...out, ...process.env };
}

const env = readEnvLocal();

/**
 * Admin API のクライアント。**秘密鍵を使うので、この値は絶対に表示しない。**
 */
function adminClient() {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = env.SUPABASE_SECRET_KEY;

  if (!url || !secret) {
    throw new Error(
      [
        "",
        "検査用の利用者を作るには SUPABASE_SECRET_KEY が要ります。",
        "",
        "  .env.local に次の2つを入れてください（値は表示しません）:",
        "    NEXT_PUBLIC_SUPABASE_URL",
        "    SUPABASE_SECRET_KEY   … sb_secret_ で始まる新しい形式",
        "",
        "  取り方: docs/launch-checklist.md 手順4",
      ].join("\n"),
    );
  }

  return createClient(url, secret, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ── 控えの読み書き ────────────────────────────────────

function loadCache() {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + "\n");
}

// ── 利用者を用意する ──────────────────────────────────

export function fixtureEmail(role) {
  return `${PREFIX}${role}@${DOMAIN}`;
}

/** 検査用のメールアドレスかどうか。**消す前に必ず通す** */
export function isFixtureEmail(email) {
  return typeof email === "string" && email.startsWith(PREFIX) && email.endsWith(`@${DOMAIN}`);
}

function newPassword() {
  return `Dpq-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}A1!`;
}

/**
 * 固定の検査用利用者を用意して、メールと合言葉を返す。
 *
 * すでに居れば作り直さない。合言葉が分からないときは
 * Admin API で付け替える（作り直すと ID が変わり、
 * その人の作品や回答との結び付きが切れてしまう）。
 *
 * @param role 役割名。そのままメールアドレスに入る
 */
export async function ensureFixtureUser(role) {
  const cache = loadCache();
  const email = fixtureEmail(role);
  const admin = adminClient();

  // 控えにあるなら、そのまま使えるか確かめる
  if (cache[role]?.id && cache[role]?.password) {
    const { data } = await admin.auth.admin.getUserById(cache[role].id);
    if (data?.user?.email === email) return { ...cache[role], email };
  }

  // 居るかどうか探す。**この形のメール以外は絶対に触らない**
  const found = await findByEmail(admin, email);
  const password = newPassword();

  if (found) {
    const { error } = await admin.auth.admin.updateUserById(found.id, {
      password,
      email_confirm: true,
    });
    if (error) throw new Error(`検査用利用者の合言葉を付け替えられません: ${error.message}`);

    cache[role] = { id: found.id, email, password, cookies: {} };
    saveCache(cache);
    return cache[role];
  }

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { smoke_fixture: true, role },
  });
  if (error) throw new Error(`検査用利用者を作れません: ${error.message}`);

  cache[role] = { id: data.user.id, email, password, cookies: {} };
  saveCache(cache);
  return cache[role];
}

/**
 * 使い捨ての検査用利用者。**毎回まっさらな人が要るとき**に使う。
 *
 * 退会の検査のように、その人が消える前提の流れで使う。
 * 控えには残さない（次の実行では別人になる）。
 */
export async function createThrowawayUser(role) {
  const admin = adminClient();
  const suffix = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const email = fixtureEmail(`${role}-${suffix}`);
  const password = newPassword();

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { smoke_fixture: true, role, throwaway: true },
  });
  if (error) throw new Error(`使い捨ての検査用利用者を作れません: ${error.message}`);

  return { id: data.user.id, email, password };
}

/** メールアドレスで1人だけ探す */
async function findByEmail(admin, email) {
  // listUsers はページ送りなので、見つかるまで進む。
  // 検査用の人数はたかが知れているので数ページで足りる。
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`利用者を探せません: ${error.message}`);
    const hit = data.users.find((u) => u.email === email);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

// ── Cookie の控え ─────────────────────────────────────

export function loadCookies(role) {
  return loadCache()[role]?.cookies ?? {};
}

export function storeCookies(role, cookies) {
  const cache = loadCache();
  if (!cache[role]) return;
  cache[role].cookies = cookies;
  saveCache(cache);
}

// ── 後片づけ ──────────────────────────────────────────

/**
 * 検査用の利用者を全部消す。
 *
 * **`dpq-fixture-…@dpq-smoke.invalid` 以外は絶対に消さない。**
 * 判定は isFixtureEmail が持っていて、そこを通らないものは飛ばす。
 */
export async function purgeFixtureUsers() {
  const admin = adminClient();
  let removed = 0;
  let scanned = 0;

  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`利用者を並べられません: ${error.message}`);

    for (const u of data.users) {
      scanned += 1;
      if (!isFixtureEmail(u.email)) continue; // ← ここが唯一の関門
      const { error: delErr } = await admin.auth.admin.deleteUser(u.id);
      if (!delErr) removed += 1;
    }

    if (data.users.length < 200) break;
  }

  try {
    unlinkSync(CACHE_FILE);
  } catch {
    // 控えが無くても構わない
  }

  return { scanned, removed };
}

// ── コマンドとして実行されたとき ──────────────────────

if (process.argv[1] && process.argv[1].endsWith("_smoke-users.mjs")) {
  if (process.argv.includes("--purge")) {
    const { scanned, removed } = await purgeFixtureUsers();
    console.log(`検査用の利用者を ${removed} 人消しました（${scanned} 人を確認）。`);
  } else {
    console.log(
      [
        "検査用の利用者を管理します。",
        "",
        "  node scripts/_smoke-users.mjs --purge   … 検査用の利用者を全部消す",
        "",
        `対象は ${PREFIX}…@${DOMAIN} だけです。ほかの利用者には触れません。`,
      ].join("\n"),
    );
  }
}
