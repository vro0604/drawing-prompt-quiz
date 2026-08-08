#!/usr/bin/env node
/**
 * cleanup-testdata.mjs ／ 本番に残った検査用の作品を片づける
 *
 * 【なぜ要るか】
 *   本番の作品一覧が、検査用の作品で埋まっていた（D123）。
 *   `docs/launch-checklist.md` 手順9 に全部○がついても、この状態で公開される。
 *
 *   D85 は「片づけの失敗は握りつぶす。消し残しは掃除 Cron が拾う」と書いたが、
 *   **作品については成り立っていない。**
 *     ・cleanup_orphan_prompts は「作品の無いお題」を消すもので、作品は対象外
 *     ・D70 により、持ち主を消しても作品の行は残る
 *     ・smoke:fixtures:purge は利用者を消すだけ
 *   だから、消すものがどこにも無かった。
 *
 * 【何を検査データと見なすか】
 *   **題名では判定しない。**
 *   最初に題名の目印を6語ならべたが、それでは109件を取りこぼした。
 *   目で選んだ目印は必ず漏れる。
 *
 *   持ち主のメールアドレスで判定する。検査が作る利用者は3種類しかない。
 *     dpq-smoke-…@example.com     使い捨て（各実行で作られる）
 *     …@dpq-smoke.invalid         固定（.smoke-fixtures.json）
 *     dpq-fixture-…               同上
 *   **この3つに当たらない持ち主の作品には、絶対に触らない。**
 *
 * 【どう消すか】
 *   delete_work と同じことをする。あれは UPDATE 1回しかしていない。
 *     is_published = false（先に公開から外す）
 *     deleted_at   = now()
 *   **行は消さない**（D63）。回答・いいね・通報が works を参照していて、
 *   どれも ON DELETE CASCADE だから、行ごと消すと判断材料が消える。
 *
 *   画像には触らない。migration にこう書いてある。
 *     「呼ばれないまま終わっても作品は削除済みのままで、公開へは戻らない。
 *       残るのは容量の問題だけで、Step 16 の掃除が拾う」
 *
 * 【利用者は消さない】
 *   作品さえ隠れれば一覧はきれいになる。利用者を消すのは別の作業なので混ぜない。
 *   固定利用者を消したいときは `npm run smoke:fixtures:purge`。
 *
 * 【使い方】
 *   npm run cleanup:testdata            … 下見（何も書き換えない）
 *   npm run cleanup:testdata -- --apply … 実行
 *
 * 【要る環境変数】
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SECRET_KEY   … RLS を迂回する。**この作業でだけ使う**
 */

import { DRY_RUN, BOLD, CYAN, DIM, GREEN, RED, RESET, YELLOW, need } from "./_setup-common.mjs";

const URL_BASE = need("NEXT_PUBLIC_SUPABASE_URL", "Supabase の接続先");
const SECRET = need("SUPABASE_SECRET_KEY", "RLS を迂回する鍵（この作業でだけ使う）");

const headers = {
  apikey: SECRET,
  authorization: `Bearer ${SECRET}`,
  "content-type": "application/json",
};

/** 検査が作る利用者の見分けかた。**ここに当たらないものには触らない** */
function isTestUser(user) {
  const email = user?.email ?? "";
  return (
    email.startsWith("dpq-smoke-") ||
    email.startsWith("dpq-fixture-") ||
    email.endsWith("@dpq-smoke.invalid")
  );
}

console.log("");
console.log(`${BOLD}[検査データの片づけ]${RESET}`);
console.log("");
if (DRY_RUN) {
  console.log(`${CYAN}${BOLD}［下見］${RESET} ${CYAN}何を消すかだけを表示します。書き換えません。${RESET}`);
  console.log(`${DIM}        実行するには --apply を付けてください${RESET}`);
} else {
  console.log(`${YELLOW}${BOLD}［実行］${RESET} ${YELLOW}実際に本番の作品を削除済みにします${RESET}`);
}
console.log("");

// ── 1. 生きている作品を集める ────────────────────────

const worksRes = await fetch(
  `${URL_BASE}/rest/v1/works?deleted_at=is.null&select=id,title,user_id,image_path&limit=2000`,
  { headers },
);

if (!worksRes.ok) {
  console.log(`${RED}✗ 作品を読めませんでした（${worksRes.status}）${RESET}`);
  process.exit(1);
}

const works = await worksRes.json();

// ── 2. 持ち主を集める ───────────────────────────────

let page = 1;
let users = [];
for (;;) {
  const r = await fetch(`${URL_BASE}/auth/v1/admin/users?page=${page}&per_page=1000`, { headers });
  if (!r.ok) {
    console.log(`${RED}✗ 利用者を読めませんでした（${r.status}）${RESET}`);
    process.exit(1);
  }
  const j = await r.json();
  const list = j.users ?? [];
  users = users.concat(list);
  if (list.length < 1000) break;
  page += 1;
}

const byId = new Map(users.map((u) => [u.id, u]));

// ── 3. 分ける ───────────────────────────────────────

const targets = [];
const keep = [];

for (const w of works) {
  const owner = byId.get(w.user_id);
  // 持ち主が分からないものは**触らない**。分からないものを消さない
  if (owner && isTestUser(owner)) targets.push({ ...w, email: owner.email });
  else keep.push({ ...w, email: owner?.email ?? "（持ち主が分かりません）" });
}

console.log(`  生きている作品        ${works.length}`);
console.log(`  ${YELLOW}消す（検査用の持ち主）${RESET}  ${targets.length}`);
console.log(`  ${GREEN}残す${RESET}                  ${keep.length}`);
console.log("");

if (keep.length > 0) {
  console.log(`${BOLD}残るもの${RESET}`);
  for (const w of keep.slice(0, 30)) {
    console.log(`  ${GREEN}✓${RESET} ${w.title}  ${DIM}${w.email}${RESET}`);
  }
  if (keep.length > 30) console.log(`  ${DIM}…ほか ${keep.length - 30}件${RESET}`);
  console.log("");
} else {
  console.log(`${YELLOW}${BOLD}★ 残る作品は1件もありません。${RESET}`);
  console.log(`${YELLOW}  片づけると、作品一覧は完全に空になります（D124）。${RESET}`);
  console.log(`${YELLOW}  絵を当てるサービスなので、答える対象が0件では公開しても何も起きません。${RESET}`);
  console.log(`${DIM}  公開の前に、本物の作品を自分で数点入れてください。${RESET}`);
  console.log("");
}

if (targets.length === 0) {
  console.log(`${GREEN}${BOLD}✓ 消すものはありません${RESET}`);
  console.log("");
  process.exit(0);
}

// 消す対象の内訳を、題名の種類でまとめて見せる
const kinds = new Map();
for (const w of targets) {
  const k = w.title.replace(/[0-9]+$/, "");
  kinds.set(k, (kinds.get(k) ?? 0) + 1);
}

console.log(`${BOLD}消すもの（題名の種類ごと）${RESET}`);
for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${k}`);
}
console.log("");

// ── 4. 消す ─────────────────────────────────────────

if (DRY_RUN) {
  console.log(`${CYAN}${BOLD}［下見］何も書き換えていません。${RESET}`);
  console.log(`${DIM}  実行するには --apply を付けてください${RESET}`);
  console.log("");
  process.exit(0);
}

console.log(`${BOLD}消します${RESET}`);
console.log("");

// delete_work と同じ UPDATE。行は消さない（D63）
let done = 0;
let failed = 0;
const CHUNK = 50;

for (let i = 0; i < targets.length; i += CHUNK) {
  const chunk = targets.slice(i, i + CHUNK);
  const ids = chunk.map((w) => w.id).join(",");

  const res = await fetch(`${URL_BASE}/rest/v1/works?id=in.(${ids})`, {
    method: "PATCH",
    headers: { ...headers, prefer: "return=minimal" },
    body: JSON.stringify({ is_published: false, deleted_at: new Date().toISOString() }),
  });

  if (res.ok) {
    done += chunk.length;
    console.log(`  ${GREEN}✓${RESET} ${done}/${targets.length}`);
  } else {
    failed += chunk.length;
    console.log(`  ${RED}✗ ${chunk.length}件が消せませんでした（${res.status}）${RESET}`);
  }
}

console.log("");

if (failed > 0) {
  console.log(`${RED}${BOLD}✗ ${failed}件が残りました${RESET}`);
  console.log("");
  process.exit(1);
}

console.log(`${GREEN}${BOLD}✓ ${done}件を削除済みにしました${RESET}`);
console.log("");
console.log(`${BOLD}次にやること${RESET}`);
console.log(`  1. npm run verify:launch -- --url <本番URL>`);
console.log(`     ${DIM}「検査用の作品が1件も出ていない」が通ること${RESET}`);
console.log(`  2. **本物の作品を数点投稿する**（D124）`);
console.log(`     ${DIM}一覧が空のままでは、公開しても何も起きません${RESET}`);
console.log("");
console.log(`${DIM}  画像は消していません。Step 16 の掃除 Cron が拾います${RESET}`);
console.log("");
