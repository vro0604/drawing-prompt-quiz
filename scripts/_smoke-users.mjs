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
import { readTargetEnv } from "./_env-target.mjs";
import { createClient } from "@supabase/supabase-js";

/** 実在しないことが規格で保証されているドメイン（RFC 2606） */
const DOMAIN = "dpq-smoke.invalid";
const PREFIX = "dpq-fixture-";

/** Cookie と資格情報の控え。Git には入れない（.gitignore 済み） */
/**
 * 控えの置き場。
 *
 * **検証用の環境で回すときは、本番向けの控えを上書きしない。**
 * 本番の固定利用者のIDと合言葉が入っているファイルなので、
 * 別の接続先で走らせたときに書き換えると、次に本番へ向けたときに
 * 「知らない利用者」になって作り直しが走る。
 * SMOKE_FIXTURES_FILE を渡せば置き場を分けられる。
 */
const CACHE_FILE = process.env.SMOKE_FIXTURES_FILE
  ? new URL(`file://${process.env.SMOKE_FIXTURES_FILE}`)
  : new URL("../.smoke-fixtures.json", import.meta.url);

// ── 環境変数 ──────────────────────────────────────────

/**
 * 接続先の決定は scripts/_env-target.mjs に1本化した。
 *
 * 【前はどうなっていたか】
 *   ここで .env.local を直接読み、process.env と混ぜていた。
 *   そのため `npm run smoke:draft` を素で打つと、**本番の Supabase へ
 *   認証要求が飛んだ。**拒否されたので実害は無かったが、
 *   止めたのは本番側であって、こちら側ではなかった。
 *
 * 【いまはどうなるか】
 *   --production を付けたときだけ .env.local を読む。
 *   付けていなければ .env.local は**読まれず**、
 *   本番のURL・project ref・ホスト名・鍵が環境に入っていれば、
 *   最初の通信より前に異常終了する。柵は環境変数では外せない。
 */
const env = readTargetEnv({ context: "スモーク（HTTP）" });

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
        "検査用の利用者を作るには接続先と秘密鍵が要ります。",
        "",
        "  ローカルで動かすときは、検証用の環境ごと立ち上げてください:",
        "    npm run test:smoke:local",
        "",
        "  本番へ向けるときは、本番用の入口から入ってください:",
        "    npm run smoke:prod -- <スクリプト名>",
        "",
        "  素の `npm run smoke:*` は .env.local を読みません。",
        "  本番へうっかり接続しないための決まりです（値は表示しません）。",
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

/**
 * この実行が作った使い捨て利用者の**通報だけ**を消す。
 *
 * 【なぜ要るか】
 *   通報は「24時間に10件まで」（step15 の create_report）。
 *   検査が固定の利用者で通報していたため、何度か回すと枠を使い切り、
 *   **時間が経つまで通らない検査**になっていた（D91）。
 *
 *   使い捨ての利用者に変えれば枠は毎回まっさらだが、
 *   そのぶん通報の行が実データに積み上がる。運営が見る列が
 *   検査用の行で埋まらないよう、この実行が作ったものだけを消す。
 *
 * 【安全のための決まり】
 *   ・消す相手は**引数で渡された ID だけ**。一覧から拾わない
 *   ・その ID は、この実行が数秒前に Admin API で作った利用者のもの
 *   ・空の一覧では何もしない（`in ()` で全件に当たる事故を防ぐ）
 *   ・**本番の通報上限そのものは変えない**
 *
 * @returns 消した件数。鍵が無いなど、消せなかったときは null
 */
export async function deleteReportsBy(userIds) {
  const ids = [...new Set((userIds ?? []).filter(Boolean))];
  if (ids.length === 0) return 0;

  try {
    const admin = adminClient();
    const { data, error } = await admin
      .from("reports")
      .delete()
      .in("reporter_id", ids)
      .select("id");

    if (error) return null;
    return data?.length ?? 0;
  } catch {
    return null;
  }
}

/**
 * 確認メールに入るのと**同じ印**（token_hash）を作る。
 *
 * 【なぜ Admin API で作るか】
 *   本物の確認メールは受け取れないので、検査からは中身を読めない。
 *   `generateLink` は**メールを送らずに**同じ印だけを返してくれる。
 *   これで「メールのリンクを開いた」状態を、そのまま再現できる。
 *
 * 【何が確かめられるか】
 *   印はリンクの中に入っていて、控え（Cookie）を使わない。
 *   だから**登録したのと違うブラウザで開いても通る**はずで、
 *   そこが本番で壊れていた（PCで登録 → スマホで確認 → 失敗。D92）。
 *   検査では、まっさらな Cookie 入れ物で開いて確かめる。
 *
 * @returns 印と、その人の ID・メール・合言葉
 */
export async function generateSignupConfirm(label) {
  const admin = adminClient();
  const suffix = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const email = fixtureEmail(`${label}-${suffix}`);
  const password = newPassword();

  const { data, error } = await admin.auth.admin.generateLink({
    type: "signup",
    email,
    password,
  });
  if (error) throw new Error(`確認用の印を作れません: ${error.message}`);

  const tokenHash = data?.properties?.hashed_token;
  if (!tokenHash) throw new Error("確認用の印が返りませんでした");

  return { email, password, userId: data.user.id, tokenHash };
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
/** 検査用の利用者のIDだけを並べる。消さない */
export async function fixtureUserIds() {
  const admin = adminClient();
  const ids = [];
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`利用者を並べられません: ${error.message}`);
    for (const u of data.users) if (isFixtureEmail(u.email)) ids.push(u.id);
    if (data.users.length < 200) break;
  }
  return ids;
}

/**
 * 消せなかった理由を、同じものどうしまとめて数える。
 *
 * **先頭の数件だけを見せると、全体像を取り違える。**
 * 2026-09-10 は119人ぶんの理由がすべて同じだったが、
 * 5件しか出していなかったので「たまたま5件失敗した」ようにも読めた。
 * 理由ごとの件数で出せば、1種類なのか混ざっているのかがすぐ分かる。
 *
 * @param reasons 失敗1回につき1つの文字列
 * @returns 「◯人: 理由」の並び。多い順
 */
export function summarizeFailures(reasons) {
  const byReason = new Map();
  for (const r of reasons ?? []) {
    const key = String(r ?? "").trim() || "理由が返らなかった";
    byReason.set(key, (byReason.get(key) ?? 0) + 1);
  }
  return [...byReason]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${n} 人: ${reason}`);
}

export async function purgeFixtureUsers({
  dryRun = false,
  client = null,
  remove = null,
  pauseMs = 120,
} = {}) {
  // client と remove は試験から差し替えるための口。
  // 何も渡さなければ本物（本番の Admin API）を使う。
  const admin = client ?? adminClient();

  // 【先に全部並べてから消す】
  //   以前は「1ページ読む → その場で消す → 次のページ」だった。
  //   消すと後ろの人が前へ詰まるので、**ページの境目にいた人が飛ばされる。**
  //   2026-09-10 の実測で、317 人が対象なのに 133 人しか消えなかった。
  //   数え終わってから消せば、並びが動いても取りこぼさない。
  const ids = [];
  const byRole = new Map();
  let scanned = 0;

  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`利用者を並べられません: ${error.message}`);

    for (const u of data.users) {
      scanned += 1;
      if (!isFixtureEmail(u.email)) continue; // ← ここが唯一の関門
      ids.push(u.id);
      // 役割ごとの数。**「何が残っているか」を、メールを出さずに言うため**
      const role = u.email.slice(PREFIX.length).split("@")[0].replace(/-\d+-\d+$/, "");
      byRole.set(role, (byRole.get(role) ?? 0) + 1);
    }

    if (data.users.length < 200) break;
  }

  const matched = ids.length;
  let removed = 0;

  const reasons = [];

  /**
   * 1人消す。**supabase-js を通さず、生のまま叩く。**
   *
   * 【なぜ生で叩くか】
   *   supabase-js の deleteUser は応答の本文を捨ててしまい、
   *   `AuthRetryableFetchError / 500 / {}` としか返らない。
   *   2026-09-10 に119人が消せなかったとき、この形では
   *   「500だった」以上のことが何も分からず、原因にたどり着けなかった。
   *   本当の中身は本文のほうに入っている:
   *     {"code":500,"error_code":"unexpected_failure",
   *      "msg":"Database error deleting user","error_id":"…"}
   *
   * 【やり直しの回数】
   *   混んでいて返らないだけなら、間を空ければ通る。
   *   一方 4xx は何回やっても同じなので、その場で諦める。
   */
  const deleteOne = remove ?? (async (id) => {
    let last = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let res;
      try {
        res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users/${id}`, {
          method: "DELETE",
          headers: {
            apikey: env.SUPABASE_SECRET_KEY,
            authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
          },
        });
      } catch (e) {
        last = `つながらない: ${e instanceof Error ? e.message : String(e)}`;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }

      if (res.ok) return null;

      const body = (await res.text()).slice(0, 300);
      let msg = body;
      try {
        const j = JSON.parse(body);
        msg = j.msg ?? j.message ?? j.error_description ?? body;
      } catch {
        // JSON でなければ本文をそのまま使う
      }
      last = `${res.status} ${msg}`;

      // 「相手が悪い」以外（4xx）は、やり直しても答えは変わらない
      if (res.status < 500) return last;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
    return last;
  });

  if (!dryRun) {
    for (const id of ids) {
      // 隣どうしの間も少し空ける。**まとめて叩かない**
      if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
      const delErr = await deleteOne(id);
      if (delErr) {
        // **握りつぶさない。**消えなかった理由が分からないと、
        // 「対象317人・消えた133人」の差が説明できない
        reasons.push(delErr);
      } else {
        removed += 1;
      }
    }

    // 控えを捨てるのは、本物を相手にしたときだけ。
    // **試験から呼ばれたときに本番の控えを消してはいけない。**
    try {
      if (client === null && remove === null) unlinkSync(CACHE_FILE);
    } catch {
      // 控えが無くても構わない
    }
  }

  return {
    scanned,
    matched,
    removed,
    kept: scanned - matched,
    failures: summarizeFailures(reasons),
    byRole,
  };
}

// ── コマンドとして実行されたとき ──────────────────────

if (process.argv[1] && process.argv[1].endsWith("_smoke-users.mjs")) {
  if (process.argv.includes("--dry-run")) {
    // **消す前に数を言う。**消したあとでは「多すぎた」と気づけない
    const r = await purgeFixtureUsers({ dryRun: true });
    console.log(`［下見］検査用の利用者 ${r.matched} 人が対象です（${r.scanned} 人を確認）。`);
    console.log(`        消さない利用者: ${r.kept} 人`);
    console.log("        何も書き換えていません。実行するには --purge を付けてください。");
  } else if (process.argv.includes("--purge")) {
    const { scanned, removed, kept } = await purgeFixtureUsers();
    console.log(`検査用の利用者を ${removed} 人消しました（${scanned} 人を確認／残した人 ${kept} 人）。`);
  } else {
    console.log(
      [
        "検査用の利用者を管理します。",
        "",
        "  node scripts/_smoke-users.mjs --dry-run … 何人が対象かだけを見る",
        "  node scripts/_smoke-users.mjs --purge   … 検査用の利用者を全部消す",
        "",
        `対象は ${PREFIX}…@${DOMAIN} だけです。ほかの利用者には触れません。`,
      ].join("\n"),
    );
  }
}
