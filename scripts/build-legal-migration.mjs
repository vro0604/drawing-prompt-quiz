#!/usr/bin/env node
/**
 * build-legal-migration.mjs
 *   docs/legal-draft.md の本文から、規約とポリシーを投入する migration を作る。
 *
 * 【なぜ生成するのか】
 *   本文は 700 行ある。**手で書き写すと、片方だけ直る事故が起きる。**
 *   D139 で get_public_profile を機械生成したのと同じ理由。
 *
 *   ドラフトを唯一の原本にする。本文を直すときは docs/legal-draft.md を直し、
 *   これを流し直す。**migration を直接編集しない。**
 *
 * 【止める条件】
 *   第5節のチェックをここで機械化する。1つでも当たれば SQL を書かずに終わる。
 *
 *     ・〔 が残っている（未確定の差し込み）
 *     ・「（雛形）」が残っている
 *     ・古いサービス名が残っている
 *     ・秘密の値らしき文字列が入っている
 *     ・$doc$ が本文に入っている（SQL の囲みが壊れる）
 *
 * 【使いかた】
 *   node scripts/build-legal-migration.mjs            … 中身を見るだけ（書かない）
 *   node scripts/build-legal-migration.mjs --write    … migration を書き出す
 *   node scripts/build-legal-migration.mjs --date 2026-08-09 --write
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DRAFT = resolve(ROOT, "docs/legal-draft.md");

const BOLD = "[1m";
const DIM = "[2m";
const RED = "[31m";
const GREEN = "[32m";
const RESET = "[0m";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

const WRITE = process.argv.includes("--write");
const SERVICE_NAME = "つたわるかな";
const OLD_SERVICE_NAME = "お題を引いて描くクイズ";

/** 制定日＝版番号。既定は今日（本番へ入れる日）。 */
const DATE = arg("date") ?? new Date().toISOString().slice(0, 10);

if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
  console.error(`${RED}制定日の形が違います: ${DATE}（例 2026-08-08）${RESET}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. ドラフトから本文を切り出す
// ---------------------------------------------------------------------------
//
// 見出しで挟む。行番号で切らないのは、**ドラフトを直すたびにずれる**ため。
// D147 で文書間リンクに行番号を使って壊したのと同じ理由。

const draft = readFileSync(DRAFT, "utf8");

/**
 * `start` の行から `end` の行の直前までを取り出す。
 * end が見つからなければ末尾まで。
 */
function slice(text, startLine, endLine) {
  const lines = text.split("\n");
  const from = lines.findIndex((l) => l.trim() === startLine);
  if (from < 0) throw new Error(`ドラフトに「${startLine}」がありません`);
  const rest = lines.slice(from + 1);
  const to = endLine ? rest.findIndex((l) => l.trim() === endLine) : -1;
  const body = to < 0 ? rest : rest.slice(0, to);
  return [startLine, ...body].join("\n").trim();
}

const terms = slice(draft, "# 利用規約", "## 3. プライバシーポリシードラフト");
// ポリシー本文の中にも「## 4.」で始まる条があるので、**見出しを全文で指定する。**
// 番号だけで切ると、条の途中で終わる（最初に書いたときそうなった）。
const privacy = slice(draft, "# プライバシーポリシー", "## 4. 未決定項目一覧");

// ---------------------------------------------------------------------------
// 2. 差し込みを埋める
// ---------------------------------------------------------------------------

/**
 * 折り返しをつなぐ。
 *
 * **表示側（_legal-body.tsx）は1行を1段落として描く。**
 * ドラフトは編集のしやすさのために1文を複数行へ折り返してあるので、
 * そのまま入れると**1文が3段落に割れて、行間が空いて見える。**
 *
 * 空行が段落の切れ目。空行までのあいだは、
 * 新しい構造（見出し・箇条書き・表）を始めない行を前の行へつなぐ。
 *
 * 日本語なので、つなぎ目に空白は入れない。
 * ドラフトの折り返しは、もともと日本語として切れる位置で折っている。
 */
function unwrap(body) {
  // 冒頭の「制定日:」「版:」は隣り合う独立した行。つなぐと1行になってしまう
  const starts = (l) =>
    /^(#{1,6} |- |\d+\. |\| |>|制定日[:：]|版[:：])/.test(l.trim()) || l.trim() === "";
  const out = [];

  for (const raw of body.split("\n")) {
    const line = raw.trimEnd();
    const prev = out[out.length - 1];
    const canJoin =
      prev !== undefined && prev.trim() !== "" && !starts(line) && !/^\|.*\|$/.test(prev);

    if (canJoin) out[out.length - 1] = prev + line.trim();
    else out.push(line);
  }

  return out.join("\n");
}

function fill(body) {
  return unwrap(
    body
      .replace(/制定日: 〔[^〕]*〕/g, `制定日: ${DATE}`)
      .replace(/版: 〔[^〕]*〕/g, `版: ${DATE}`)
      // ドラフトの節を区切っている `---` が末尾に付いてくる。
      // 掲示する本文には要らないので落とす
      .replace(/\n+-{3,}\s*$/, ""),
  ).trim();
}

const termsBody = fill(terms);
const privacyBody = fill(privacy);

// ---------------------------------------------------------------------------
// 3. 止める条件（第5節のチェック）
// ---------------------------------------------------------------------------

const problems = [];

function check(label, body, ok) {
  if (!ok) problems.push(label);
}

for (const [name, body] of [["利用規約", termsBody], ["ポリシー", privacyBody]]) {
  check(`${name}に未確定の差し込み 〔 が残っています`, body, !body.includes("〔"));
  check(`${name}に「（雛形）」が残っています`, body, !body.includes("（雛形）"));
  check(
    `${name}に古いサービス名「${OLD_SERVICE_NAME}」が残っています`,
    body,
    !body.includes(OLD_SERVICE_NAME),
  );
  check(`${name}に新しいサービス名が入っていません`, body, body.includes(SERVICE_NAME));
  check(`${name}に制定日が入っていません`, body, body.includes(`制定日: ${DATE}`));
  check(`${name}に版が入っていません`, body, body.includes(`版: ${DATE}`));
  // $doc$ が本文にあると、SQL の囲みがそこで閉じてしまう
  check(`${name}に $doc$ が入っています（SQL の囲みが壊れます）`, body, !body.includes("$doc$"));
  check(
    `${name}に秘密の値らしき文字列が入っています`,
    body,
    !/sb_secret_|sb_publishable_|eyJ[A-Za-z0-9_-]{20,}|0x4AAAAAAA/.test(body),
  );
  // 本文が短すぎたら、切り出しに失敗している
  check(`${name}の本文が短すぎます（${body.length}文字）`, body, body.length > 1500);
}

// 問い合わせ先が両方に入っていること（0-10 の確定事項）
const CONTACT = "vro.artcode@gmail.com";
check("利用規約に問い合わせ先がありません", termsBody, termsBody.includes(CONTACT));
check("ポリシーに問い合わせ先がありません", privacyBody, privacyBody.includes(CONTACT));

console.log(`${BOLD}[規約とポリシーの生成]${RESET} ${DIM}制定日・版 = ${DATE}${RESET}\n`);
console.log(`  利用規約           ${termsBody.split("\n").length} 行 / ${termsBody.length} 文字`);
console.log(`  プライバシーポリシー ${privacyBody.split("\n").length} 行 / ${privacyBody.length} 文字\n`);

if (problems.length > 0) {
  console.log(`${RED}${BOLD}✗ ${problems.length}件、公開できない状態です${RESET}\n`);
  for (const p of problems) console.log(`  ${RED}✗${RESET} ${p}`);
  console.log(`\n${DIM}  docs/legal-draft.md を直してから、もう一度実行してください。${RESET}`);
  process.exit(1);
}

console.log(`${GREEN}✓ 第5節のチェックをすべて通りました${RESET}\n`);

// ---------------------------------------------------------------------------
// 4. SQL を組み立てる
// ---------------------------------------------------------------------------
//
// **is_current は付け替える。**部分ユニーク索引で「有効な版は1つ」に
// 固定されているので、先に古い版を降ろしてから新しい版を上げる。
//
// 本文の投入は on conflict do update にする。同じ日に2回流しても、
// 2本目が「もう入っている」で黙って終わるのではなく、新しい本文で上書きされる。

const stamp = DATE.replace(/-/g, "") + "200000";

const sql = `-- ============================================================================
-- ${stamp}_legal_v1.sql
--   手順2 ／ 規約とポリシーの本文を、雛形から本物へ差し替える
-- ============================================================================
--
-- **このファイルは生成物。手で編集しない。**
--   原本は docs/legal-draft.md。本文を直すときはそちらを直して、
--   node scripts/build-legal-migration.mjs --write を流し直す。
--
-- 【何が変わるか】
--   利用規約           雛形42行  →  本物（${termsBody.split("\n").length}行）
--   プライバシーポリシー 雛形54行  →  本物（${privacyBody.split("\n").length}行）
--
--   埋めたもの
--     サービス名   つたわるかな（D114。08-04 の決定を改定した）
--     問い合わせ先 ${CONTACT}（legal-draft 0-10）
--     運営者表示   VRO（個人運営。legal-draft 0-11）
--     制定日・版   ${DATE}
--
-- 【投稿しようとした人に、もう一度同意を求めることになる】
--   app_guard_works が「いま有効な版に同意していなければ投稿を断る」形なので、
--   版が変わると**次に投稿する人は同意画面を通る。**
--   これは仕様どおり。いま居るのは検査用の利用者だけなので実害は無い。
--
--   **回答・閲覧・いいねは止まらない。**門番が見ているのは works への INSERT だけ。
--
-- 【戻しかた】
--   末尾に rollback を書いてある。is_current を古い版へ戻すだけ。
--   本文の行は残るので、取り違えても失われない。
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 利用規約
-- ----------------------------------------------------------------------------
--
-- **先に降ろしてから上げる。**terms_versions_current_idx が
-- 「is_current が true の行は1本まで」を強制しているので、
-- 2本同時に true になった瞬間に落ちる。

update public.terms_versions set is_current = false where is_current;

insert into public.terms_versions (version, body_md, is_current)
values ('${DATE}', $doc$${termsBody}
$doc$, true)
on conflict (version) do update
  set body_md = excluded.body_md, is_current = true;


-- ----------------------------------------------------------------------------
-- 2. プライバシーポリシー
-- ----------------------------------------------------------------------------

update public.privacy_versions set is_current = false where is_current;

insert into public.privacy_versions (version, body_md, is_current)
values ('${DATE}', $doc$${privacyBody}
$doc$, true)
on conflict (version) do update
  set body_md = excluded.body_md, is_current = true;


-- ----------------------------------------------------------------------------
-- 3. 入ったことを、この場で確かめる（D69）
-- ----------------------------------------------------------------------------

do $$
declare
  v_terms   text;
  v_privacy text;
  v_n       int;
begin
  select body_md into v_terms   from public.terms_versions   where is_current;
  select body_md into v_privacy from public.privacy_versions where is_current;

  if v_terms is null or v_privacy is null then
    raise exception '有効な版が見つかりません';
  end if;

  -- 有効な版は、それぞれ1本だけ
  select (select count(*) from public.terms_versions   where is_current)
       + (select count(*) from public.privacy_versions where is_current)
    into v_n;
  if v_n <> 2 then
    raise exception '有効な版が % 本あります（2本のはず）', v_n;
  end if;

  -- 雛形が残っていない
  if v_terms like '%（雛形）%' or v_privacy like '%（雛形）%' then
    raise exception '本文に「（雛形）」が残っています';
  end if;

  -- 連絡先が入っている（手順2 の主目的）
  if position('${CONTACT}' in v_privacy) = 0 then
    raise exception 'ポリシーに問い合わせ先が入っていません';
  end if;
  if position('${CONTACT}' in v_terms) = 0 then
    raise exception '規約に問い合わせ先が入っていません';
  end if;

  -- 未確定の差し込みが残っていない
  if position('〔' in v_terms) > 0 or position('〔' in v_privacy) > 0 then
    raise exception '本文に未確定の差し込み 〔 が残っています';
  end if;

  -- サービス名が新しいものになっている
  if position('${OLD_SERVICE_NAME}' in v_terms) > 0
     or position('${OLD_SERVICE_NAME}' in v_privacy) > 0 then
    raise exception '本文に古いサービス名が残っています';
  end if;

  raise notice '手順2 完了: 規約 % 文字 / ポリシー % 文字を版 ${DATE} で掲示しました',
    length(v_terms), length(v_privacy);
end $$;


-- ============================================================================
-- rollback（手で流す用）
-- ============================================================================
--
--   update public.terms_versions   set is_current = false where version = '${DATE}';
--   update public.privacy_versions set is_current = false where version = '${DATE}';
--   update public.terms_versions   set is_current = true  where version = '2026-08-04';
--   update public.privacy_versions set is_current = true  where version = '2026-08-04';
--
--   本文の行は消さない。取り違えても失われないようにしておく。
-- ============================================================================
`;

const out = resolve(ROOT, `supabase/migrations/${stamp}_legal_v1.sql`);

if (!WRITE) {
  console.log(`${DIM}--write を付けると、ここへ書き出します:${RESET}`);
  console.log(`  supabase/migrations/${stamp}_legal_v1.sql`);
  console.log(`  ${DIM}（${sql.length} 文字）${RESET}`);
  process.exit(0);
}

if (existsSync(out)) {
  console.log(`${DIM}既にある migration を上書きします（生成物なので安全）${RESET}`);
}

writeFileSync(out, sql, "utf8");
console.log(`${GREEN}✓ 書き出しました${RESET}  supabase/migrations/${stamp}_legal_v1.sql`);
console.log(`\n${DIM}次: npm run db:status で、何が流れるかを見る${RESET}`);
