#!/usr/bin/env node
/**
 * verify-launch.mjs ／ 本番URLの応答を、外から確かめる
 *
 * 【なぜ要るか】
 *   `docs/launch-checklist.md` の手順6・9・10 の成功判定は、
 *   ブラウザで1つずつ開いて目視することになっていた。
 *   **目視は、項目が増えるほど飛ばされる。**
 *   しかも公開後は毎日見る（手順10）ので、人の手でやる作業ではない。
 *
 * 【読むだけ】
 *   このスクリプトは**何も書き換えない。**
 *   だから、いつ・何度実行しても安全で、
 *   setup-domain / setup-auth を走らせる**前**の状態を控えるのにも使える。
 *
 * 【あってはいけないものも見る】
 *   検査が「あるべきものがあるか」しか見ておらず、
 *   **「あってはいけないものが無いか」を見ていなかった**（D66 / D123）。
 *   本番の作品一覧が検査データで埋まっていたのは、それが理由。
 *   ここでは両方を見る。
 *
 * 【使い方】
 *   npm run verify:launch
 *   npm run verify:launch -- --url https://tsutawarukana.com
 *   npm run verify:launch -- --old https://drawing-prompt-quiz.vercel.app
 *
 *   --url  … 調べる先。既定は NEXT_PUBLIC_SITE_URL
 *   --old  … 畳んだはずの旧URL。指定するとリダイレクトを確かめる（D115）
 */

import { env, must, note, section, summary, DIM, BOLD, RESET, YELLOW } from "./_setup-common.mjs";

// ── 調べる先を決める ─────────────────────────────────

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

const SITE = (arg("url") ?? env.NEXT_PUBLIC_SITE_URL ?? "").trim().replace(/\/$/, "");
const OLD = (arg("old") ?? "").trim().replace(/\/$/, "");

if (!SITE) {
  console.log("");
  console.log("調べる先が分かりません。どちらかを指定してください。");
  console.log("  npm run verify:launch -- --url https://tsutawarukana.com");
  console.log("  .env.local に NEXT_PUBLIC_SITE_URL を書く");
  console.log("");
  process.exit(1);
}

/**
 * 検査データの目印（D123）。作品名にこれが出たら、掃除が済んでいない。
 *
 * **最初は6語しか並べていなかった。それでは109件を取りこぼした。**
 * 2026-08-08 に本番の題名を全部数え直して、19種すべてを覆う形にした。
 * 目で選んだ目印は、必ず漏れる。
 *
 * **この一覧は補助でしかない。**題名は変わりうるので、
 * 正しい判定は「持ち主が検査用の利用者か」で行う（cleanup:testdata）。
 * ここは外からHTTPで見ているだけなので、持ち主が分からない。
 */
const SMOKE_MARKERS = [
  "スモーク", // スモーク・AI作品 / クイズ対象 / 反応対象 / スモークテスト・…
  "ランキング", // ランキングAI / 下書き / 上位 / 下位
  "自作いいねだけ",
  "下書き作品",
  "残す作品",
  "残る作品",
  "プロフィール作品",
  "同時投稿",
  "連打の的",
  "漏洩調査",
  "受け取らないはず",
];

// ── 道具 ────────────────────────────────────────────

async function get(path, { redirect = "follow" } = {}) {
  try {
    const res = await fetch(`${SITE}${path}`, {
      redirect,
      headers: { "user-agent": "verify-launch" },
      signal: AbortSignal.timeout(20000),
    });
    const body = res.headers.get("content-type")?.includes("text/") ? await res.text() : "";
    return { status: res.status, headers: res.headers, body, ok: true };
  } catch {
    return { status: 0, headers: new Headers(), body: "", ok: false };
  }
}

/** タグを落として本文だけにする */
function text(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ");
}

console.log("");
console.log(`${BOLD}[公開の検査]${RESET} ${DIM}${SITE}${RESET}`);

// ── 1. 入口 ─────────────────────────────────────────

section("入口");

const top = await get("/");

if (!must(top.ok && top.status === 200, "トップページが開く", `${top.status || "接続できません"}`)) {
  console.log("");
  console.log(`${YELLOW}  ここが通らないと、以降の判定に意味がありません。${RESET}`);
  console.log("");
  process.exit(summary("公開の検査"));
}

const title = /<title>([^<]*)<\/title>/.exec(top.body)?.[1] ?? "";
must(title.length > 0, "タイトルが入っている", title);

// ── 2. 限定公開が外れていないか（手順0） ──────────────

section("限定公開（検索から外れているか）");

const robotsHeader = top.headers.get("x-robots-tag") ?? "";
must(
  /noindex/i.test(robotsHeader),
  "応答ヘッダに noindex が付いている",
  robotsHeader || "X-Robots-Tag がありません",
);

const robotsMeta = /<meta[^>]+name="robots"[^>]+content="([^"]*)"/i.exec(top.body)?.[1] ?? "";
must(/noindex/i.test(robotsMeta), "HTML の meta にも noindex がある", robotsMeta || "meta がありません");

// meta とヘッダの両方が要る理由は layout.tsx に書いてある。
// 片方だけだと、HTML でない応答（画像・OGP）に穴が残る。

// ── 3. 閉じているべきもの（手順6） ────────────────────

section("閉じているべきもの");

const health = await get("/health");
must(health.status === 404, "/health が 404", String(health.status));

const healthAuth = await get("/health/auth");
must(healthAuth.status === 404, "/health/auth が 404", String(healthAuth.status));

const cron = await get("/api/cron/cleanup");
must(cron.status === 401, "/api/cron/cleanup が鍵なしで 401", String(cron.status));

must(!/sb_secret_/.test(top.body), "トップページに秘密の鍵が出ていない");

// ── 4. 規約とプライバシー（手順2） ────────────────────

section("規約とプライバシーポリシー");

const terms = await get("/terms");
must(terms.status === 200, "/terms が開く", String(terms.status));

const privacy = await get("/privacy");
must(privacy.status === 200, "/privacy が開く", String(privacy.status));

const privacyText = text(privacy.body);
must(
  !privacyText.includes("公開前に連絡先を記載します"),
  "連絡先が雛形のままになっていない",
  privacyText.includes("公開前に連絡先を記載します") ? "雛形が残っています" : "",
);
must(!privacyText.includes("（雛形）"), "本文が「（雛形）」のままになっていない");

const hasContact = /[\w.+-]+@[\w-]+\.[\w.]+/.test(privacyText);
must(hasContact, "連絡先のメールアドレスが書いてある");

// ── 5. 作品一覧（手順9・D123） ───────────────────────

section("作品一覧（あってはいけないものが無いか）");

const works = await get("/works");
must(works.status === 200, "/works が開く", String(works.status));

const worksText = text(works.body);
const found = SMOKE_MARKERS.filter((m) => worksText.includes(m));

must(
  found.length === 0,
  "検査用の作品が1件も出ていない",
  found.length > 0 ? `見つかった目印: ${found.join(" / ")}` : "",
);

// 掃除したあとフィードが空になる問題（D124）。
// 0件は「掃除できている」と「答える対象が無い」の両方を意味するので、
// 失敗にはせず、必ず目に入るところに出す。
const workLinks = new Set(works.body.match(/\/works\/[0-9a-f-]{36}/g) ?? []);
if (workLinks.size === 0) {
  note("作品が1件もありません", "答える対象が0件では、公開しても何も起きません（D124）");
} else {
  note(`作品が ${workLinks.size} 件見えています`, found.length > 0 ? "※ 検査データを含みます" : "");
}

// ── 6. 共有カードの絶対URL（手順9） ───────────────────

section("共有カード");

// 共有カードが本当に効くのは作品ページ（D64）。トップではなく、そこを見る。
const firstWork = (works.body.match(/\/works\/[0-9a-f-]{36}/) ?? [])[0];

if (!firstWork) {
  note("作品が無いので共有カードを確かめられません", "作品を1件入れてから、もう一度");
} else {
  const wk = await get(firstWork);
  const og = (prop) =>
    new RegExp(`<meta[^>]+property="og:${prop}"[^>]+content="([^"]*)"`, "i").exec(wk.body)?.[1] ?? "";

  const ogUrl = og("url");
  const ogImage = og("image");

  must(ogUrl.startsWith(SITE), "作品の og:url が本番URLを向いている", ogUrl || "ありません");
  must(ogImage.startsWith(SITE), "作品の og:image が本番URLを向いている", ogImage || "ありません");
  must(
    ogImage.includes("/opengraph-image"),
    "共有カードが専用の画像を指している",
    ogImage.includes("/opengraph-image") ? "" : "作品画像を直に晒している可能性があります",
  );

  // **答えが漏れていないこと**（D64）は、ここでは形からしか見られない。
  // タグの中身と突き合わせる検査は DB 側（db:verify）の仕事。
  note("答えが載っていないかは目視で確かめる", "D64。ここでは形だけを見ています");
}

const topOgUrl = /<meta[^>]+property="og:url"[^>]+content="([^"]*)"/i.exec(top.body)?.[1] ?? "";
if (!topOgUrl) note("トップには og:url がありません", "作品ページにはあるので、実害はありません");

// ── 7. 旧URLが畳まれているか（D115） ──────────────────

if (OLD) {
  section("旧URL");

  let redirected = false;
  let detail = "";
  try {
    const res = await fetch(`${OLD}/`, {
      redirect: "manual",
      headers: { "user-agent": "verify-launch" },
      signal: AbortSignal.timeout(20000),
    });
    const loc = res.headers.get("location") ?? "";
    redirected = res.status >= 300 && res.status < 400 && loc.startsWith(SITE);
    detail = `${res.status} ${loc}`;
  } catch {
    detail = "接続できません";
  }

  must(redirected, "旧URLが本番URLへリダイレクトする", detail);

  // 両方から入れる状態にすると、CAPTCHA のホスト名照合で
  // **片方からの通報だけが黙って落ちる**（D115）。
}

// ── まとめ ──────────────────────────────────────────

const code = summary("公開の検査");

if (code !== 0) {
  console.log(`${DIM}  それぞれの意味と直しかた: docs/launch-checklist.md${RESET}`);
  console.log("");
}

process.exit(code);
