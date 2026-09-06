#!/usr/bin/env node
/**
 * db-audit-prod.mjs ／ 本番DBを「読むだけ」で事前監査する
 *
 * 実行: npm run db:audit:prod   （キーチェーンから接続情報を組み立てる包みを通す）
 *
 * 【やること】
 *   本番へ migration を当てる前に、当ててよいかを決めるための材料を数える。
 *     1. どの migration が本番に入っているか（履歴）
 *     2. 手元のファイルとの差（未適用の本数とファイル名・欠番・内容のずれ）
 *     3. 既存データの件数（本文や個人情報は取らない。**数だけ**）
 *     4. 置き換える関数の署名・持ち主・権限
 *     5. これから作る表と列が、もう在ってしまわないか
 *     6. これから足す制約に、既存の行が違反しないか
 *
 * 【やらないこと】
 *   ・DDL（表や関数を作る・変える・消す）を1文も投げない
 *   ・DML（INSERT / UPDATE / DELETE）を1文も投げない
 *   ・書き込みのある RPC を1本も呼ばない
 *   ・migration を push しない
 *
 *   守り方は「気をつける」ではない。**接続した最初に
 *   `begin transaction read only` を張る。**この中では Postgres 自身が
 *   書き込みを拒む。最後は commit ではなく rollback で閉じる。
 *
 * 【本文と個人情報を出さない】
 *   取るのは件数と構造だけ。表示名・題名・メール・本文は1文字も select しない。
 *
 * 【手元との突き合わせに使う材料】
 *   docs/compat-matrix-data.json（node test/audit/schema-diff.mjs が作る）。
 *   「これから増える表・列・制約」の一覧がそこにある。無ければ、その節は飛ばす。
 */

import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

async function connectionString() {
  const fromEnv = process.env.SUPABASE_DB_URL;
  if (fromEnv && fromEnv.trim() !== "") return fromEnv.trim();
  if (!process.stdin.isTTY) {
    console.error("SUPABASE_DB_URL がありません。npm run db:audit:prod を使ってください。");
    process.exit(2);
  }
  return askHidden("接続文字列（本番。読むだけに使います）: ");
}

const head = (t) => console.log(`\n${BOLD}${t}${RESET}\n${"─".repeat(60)}`);
const row = (k, v) => console.log(`  ${String(k).padEnd(42)} ${v}`);

const url = await connectionString();
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

// **ここから先、この接続では1文字も書けない。**
await client.query("begin transaction read only");

const q = async (sql, params) => (await client.query(sql, params)).rows;

let notes = [];
const note = (t) => notes.push(t);

try {
  // ─── 0. どこへつないだか ────────────────────────────────────────────────
  head("0. 接続先");
  const who = (await q(
    `select current_database() as db, current_user as usr, version() as v,
            inet_server_addr()::text as addr`,
  ))[0];
  row("データベース", who.db);
  row("ロール", who.usr);
  row("サーバ", who.v.split(" ").slice(0, 2).join(" "));
  row("トランザクション", "read only（書き込みは Postgres 側が拒む）");

  // ─── 1. migration 履歴 ────────────────────────────────────────────────
  head("1. migration の履歴（本番に入っているもの）");
  const hasHistory = (await q(
    `select count(*)::int as n from information_schema.tables
      where table_schema = 'supabase_migrations' and table_name = 'schema_migrations'`,
  ))[0].n > 0;

  let remote = [];
  if (!hasHistory) {
    note("supabase_migrations.schema_migrations が無い。履歴を機械で読めない");
    row("履歴表", `${RED}無い${RESET}`);
  } else {
    remote = await q(
      `select version, coalesce(name,'') as name,
              coalesce(md5(array_to_string(statements, ';')), '') as h
         from supabase_migrations.schema_migrations order by version`,
    ).catch(async () =>
      // statements 列が無い版もある。その場合は version だけ読む
      q(`select version, coalesce(name,'') as name, '' as h
           from supabase_migrations.schema_migrations order by version`),
    );
    row("本番に入っている本数", remote.length);
    console.log(`  ${DIM}適用済みの version（古い順）${RESET}`);
    for (const r of remote) console.log(`      ${r.version} ${r.name}`);
  }

  const local = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  row("手元のファイル本数", local.length);

  const remoteVersions = new Set(remote.map((r) => r.version));
  const localVersions = local.map((f) => f.slice(0, f.indexOf("_")));
  const pending = local.filter((f) => !remoteVersions.has(f.slice(0, f.indexOf("_"))));
  const orphan = remote.filter((r) => !localVersions.includes(r.version));

  row("本番に未適用のファイル", `${pending.length} 本`);
  for (const f of pending) console.log(`      ${f}`);
  if (orphan.length) {
    row("本番にあるが手元に無い（欠番）", `${RED}${orphan.length} 本${RESET}`);
    for (const r of orphan) console.log(`      ${r.version} ${r.name}`);
    note(`本番にだけある migration が ${orphan.length} 本。手元と履歴がずれている`);
  } else {
    row("本番にあるが手元に無い（欠番）", `${GREEN}0 本${RESET}`);
  }

  // 同じ version で内容が違うもの
  const sameVersionDiff = [];
  for (const r of remote) {
    const f = local.find((x) => x.startsWith(`${r.version}_`));
    if (!f) continue;
    if (!r.h) continue;
    const body = await readFile(join(MIGRATIONS, f), "utf8");
    // 本番側は「;」で分けた文の配列を md5 したもの。手元のファイルと
    // 同じ形に揃えられないので、**厳密比較はできない。**
    // ここでは「本番側の記録があること」だけ残し、判定は保留にする。
    if (body.length === 0) sameVersionDiff.push(f);
  }
  // 名前のずれ（同じ version でファイル名が違う＝別物が当たっている疑い）
  const nameDiff = [];
  for (const r of remote) {
    const f = local.find((x) => x.startsWith(`${r.version}_`));
    if (!f) continue;
    const localName = f.slice(f.indexOf("_") + 1, -4);
    if (r.name && r.name !== localName) nameDiff.push(`${r.version}: 本番「${r.name}」/ 手元「${localName}」`);
  }
  row("同じ version で名前が違うもの", nameDiff.length === 0
    ? `${GREEN}0 本${RESET}` : `${RED}${nameDiff.length} 本${RESET}`);
  for (const d of nameDiff) console.log(`      ${d}`);
  if (nameDiff.length) note(`同じ version で名前が違う migration がある（${nameDiff.length} 本）`);

  row("同じ version で本文が違うもの", `${DIM}機械では判定しない（本番側は文の配列で保持）${RESET}`);
  note("同じ version の本文一致は、この監査では判定していない（本番側の保持形式が違うため）");

  // ─── 2. 既存データの件数 ──────────────────────────────────────────────
  head("2. 既存データの件数（本文・個人情報は取らない）");
  const counts = [
    ["profiles", `select count(*)::int n from public.profiles`],
    ["profiles のうち匿名（is_anonymous）", `select count(*)::int n from auth.users where coalesce(is_anonymous,false)`],
    ["prompts", `select count(*)::int n from public.prompts`],
    ["prompts / status=active", `select count(*)::int n from public.prompts where status='active'`],
    ["draft_sessions", `select count(*)::int n from public.draft_sessions`],
    ["works", `select count(*)::int n from public.works`],
    ["works / 公開", `select count(*)::int n from public.works where is_published`],
    ["works / 未削除", `select count(*)::int n from public.works where deleted_at is null`],
    ["works / 公開かつ審査OKかつ未削除", `select count(*)::int n from public.works where is_published and review_status='ok' and deleted_at is null`],
    ["answers", `select count(*)::int n from public.answers`],
    ["answer_items", `select count(*)::int n from public.answer_items`],
    ["tags", `select count(*)::int n from public.tags`],
    ["tags の最大id", `select coalesce(max(id),0)::int n from public.tags`],
    ["draft_modes", `select count(*)::int n from public.draft_modes`],
    ["saves", `select count(*)::int n from public.saves`],
    ["prompt_cards", `select count(*)::int n from public.prompt_cards`],
    ["quiz_questions", `select count(*)::int n from public.quiz_questions`],
    ["work_slot_stats", `select count(*)::int n from public.work_slot_stats`],
  ];
  for (const [label, sql] of counts) {
    try { row(label, (await q(sql))[0].n); }
    catch (e) { row(label, `${YELLOW}読めない（${String(e.message).split("\n")[0]}）${RESET}`); }
  }

  head("2b. 部門別・回答帯別の作品数");
  try {
    const byDiv = await q(
      `select division, count(*)::int as n from public.works
        where is_published and review_status='ok' and deleted_at is null
        group by division order by division`,
    );
    if (byDiv.length === 0) row("公開作品", "0 件");
    for (const r of byDiv) row(`部門 ${r.division}`, `${r.n} 件`);

    const bands = (await q(
      `select
         count(*) filter (where not exists (select 1 from public.answers a where a.work_id = w.id))::int as zero,
         count(*) filter (where exists (select 1 from public.answers a where a.work_id = w.id))::int as some
       from public.works w
       where w.is_published and w.review_status='ok' and w.deleted_at is null`,
    ))[0];
    row("回答0件の公開作品（第1救済帯）", bands.zero);
    row("回答1件以上の公開作品（第2救済帯）", bands.some);
  } catch (e) { row("部門別", `${YELLOW}読めない（${e.message}）${RESET}`); }

  head("2c. 旧方式（3問）の作品と、旧列の値の分布");
  try {
    const old3 = (await q(
      `select count(*)::int as n from public.works w
        where (select count(*) from public.quiz_questions q where q.prompt_id = w.prompt_id) = 3`,
    ))[0].n;
    row("出題が3問の作品", old3);
  } catch { row("出題が3問の作品", `${YELLOW}読めない${RESET}`); }

  for (const t of ["draft_sessions", "draft_modes"]) {
    try {
      const d = (await q(
        `select count(*) filter (where quiz_question_count is null)::int as n_null,
                count(*) filter (where quiz_question_count = 3)::int as n_3,
                count(*) filter (where quiz_question_count is not null and quiz_question_count <> 3)::int as n_other
           from public.${t}`,
      ))[0];
      row(`${t}.quiz_question_count`, `NULL ${d.n_null} / 3 ${d.n_3} / 3以外 ${d.n_other}`);
    } catch { row(`${t}.quiz_question_count`, `${YELLOW}読めない${RESET}`); }
  }

  head("2d. 有限時間のお題（期限の遡及に関わる）");
  try {
    const t = (await q(
      `select
         count(*) filter (where status='active' and time_limit_seconds is not null)::int as active_timed,
         count(*) filter (where status='active' and time_limit_seconds is not null
                            and created_at < now() - interval '7 days')::int as old_timed
       from public.prompts`,
    ))[0];
    row("いま active で有限時間のお題", t.active_timed);
    row("うち7日より古いもの（未投稿）", t.old_timed);
  } catch (e) { row("有限時間のお題", `${YELLOW}読めない（${e.message}）${RESET}`); }

  // ─── 3. これから作る表・列が、もう在ってしまわないか ────────────────────
  head("3. これから作る表・列が、もう在ってしまわないか");
  let matrix = null;
  try { matrix = JSON.parse(await readFile(join(ROOT, "docs", "compat-matrix-data.json"), "utf8")); }
  catch { note("docs/compat-matrix-data.json が無い。衝突検査を飛ばした（node test/audit/schema-diff.mjs で作る）"); }

  if (matrix) {
    const addedTables = matrix.report.tables.added;
    const addedColumns = matrix.report.columns.added;
    const existing = new Set((await q(
      `select table_name from information_schema.tables
        where table_schema='public' and table_type='BASE TABLE'`,
    )).map((r) => r.table_name));
    const clashTables = addedTables.filter((t) => existing.has(t));
    row("これから作る表", `${addedTables.length} 個`);
    row("そのうち本番に既にある名前", clashTables.length === 0
      ? `${GREEN}0 個${RESET}` : `${RED}${clashTables.length} 個: ${clashTables.join(", ")}${RESET}`);
    if (clashTables.length) note(`表名が衝突する: ${clashTables.join(", ")}`);

    const existingCols = new Set((await q(
      `select table_name||'.'||column_name as k from information_schema.columns
        where table_schema='public'`,
    )).map((r) => r.k));
    // 既にある表への列追加だけを見る（新設表の列は衝突しようがない）
    const colClash = addedColumns.filter((k) => existing.has(k.split(".")[0]) && existingCols.has(k));
    row("これから足す列", `${addedColumns.length} 個`);
    row("そのうち本番に既にある名前", colClash.length === 0
      ? `${GREEN}0 個${RESET}` : `${RED}${colClash.length} 個: ${colClash.slice(0, 10).join(", ")}${RESET}`);
    if (colClash.length) note(`列名が衝突する: ${colClash.join(", ")}`);
  }

  // ─── 3b. 履歴と実スキーマのずれ ────────────────────────────────────────
  //
  // 「22本入っている」という履歴を信じず、**その22本を当てた姿が
  // 本当に本番に出来ているか**を見る。手で当てた SQL や、
  // 履歴だけ進んで中身が入っていない状態を見つけるため。
  head("3b. 履歴と実スキーマのずれ（追跡済み22本を当てた姿と突き合わせる）");
  if (!matrix?.tracked) {
    note("追跡済みの姿が docs/compat-matrix-data.json に無い。ずれの検査を飛ばした");
    row("突き合わせ", `${YELLOW}材料が無い${RESET}`);
  } else {
    const prodFns = new Set((await q(
      `select p.oid::regprocedure::text as sig
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.prokind='f'`,
    )).map((r) => r.sig));
    const prodTbls = new Set((await q(
      `select table_name from information_schema.tables
        where table_schema='public' and table_type='BASE TABLE'`,
    )).map((r) => r.table_name));
    const prodCols = new Set((await q(
      `select c.table_name||'.'||c.column_name as k
         from information_schema.columns c
         join information_schema.tables t
           on t.table_schema=c.table_schema and t.table_name=c.table_name
        where c.table_schema='public' and t.table_type='BASE TABLE'`,
    )).map((r) => r.k));

    const cmp = (label, want, got) => {
      const missing = want.filter((x) => !got.has(x));
      const extra = [...got].filter((x) => !want.includes(x));
      row(`${label}／本番に足りない`, missing.length === 0
        ? `${GREEN}0${RESET}` : `${RED}${missing.length}: ${missing.slice(0, 8).join(", ")}${RESET}`);
      row(`${label}／本番にだけある`, extra.length === 0
        ? `${GREEN}0${RESET}` : `${YELLOW}${extra.length}: ${extra.slice(0, 8).join(", ")}${RESET}`);
      if (missing.length) note(`${label}が本番に ${missing.length} 個足りない（履歴と実スキーマがずれている）`);
      if (extra.length) note(`${label}が本番にだけ ${extra.length} 個ある（手で当てたものがある疑い）`);
    };
    cmp("関数", matrix.tracked.functions, prodFns);
    cmp("表", matrix.tracked.tables, prodTbls);
    cmp("列", matrix.tracked.columns, prodCols);
  }

  // ─── 4. 置き換える関数の署名と権限 ─────────────────────────────────────
  head("4. 今回置き換える関数の署名・持ち主・権限");
  const funcs = await q(
    `select p.oid::regprocedure::text as sig,
            pg_get_userbyid(p.proowner) as owner,
            p.prosecdef as secdef,
            coalesce(array_to_string(p.proconfig,','),'') as cfg,
            p.pronargdefaults as ndef,
            has_function_privilege('anon', p.oid, 'EXECUTE') as anon_x,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_x,
            has_function_privilege('public', p.oid, 'EXECUTE') as pub_x
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname = any($1)
      order by p.proname, p.pronargs`,
    [[
      "get_public_works", "get_next_work", "next_work_candidates",
      "start_draft", "complete_draft", "reroll_draft", "reveal_card",
      "draft_state_json", "build_quiz_for_prompt", "get_current_draft",
      "submit_answer", "get_work_quiz", "get_my_answer", "get_my_work_result",
      "get_work_detail", "get_my_work", "get_public_profile", "get_rankings",
      "get_answered_prompt", "answer_items_after_insert_stats", "cleanup_status",
    ]],
  );
  for (const f of funcs) {
    row(f.sig, `owner=${f.owner} secdef=${f.secdef} 既定値=${f.ndef} ` +
      `anon=${f.anon_x ? "○" : "×"} auth=${f.auth_x ? "○" : "×"} public=${f.pub_x ? "○" : "×"} ` +
      `${f.cfg.includes("search_path=") ? "" : RED + "search_path なし" + RESET}`);
    if (f.pub_x) note(`${f.sig} が PUBLIC から実行できる`);
  }

  head("4b. 同名で引数だけ違う関数（PostgREST で曖昧にならないか）");
  const overloads = await q(
    `select p.proname, count(*)::int as n,
            string_agg(p.pronargs::text||'引数(既定値'||p.pronargdefaults::text||')', ' / '
                       order by p.pronargs) as shapes
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.prokind='f'
      group by p.proname having count(*) > 1 order by 1`,
  );
  if (overloads.length === 0) row("同名の関数", `${GREEN}無し${RESET}`);
  for (const o of overloads) row(o.proname, `${o.n} 本: ${o.shapes}`);

  head("4c. これから drop する関数に、依存しているものが無いか");
  // 依存があると drop が失敗して migration ごと止まる。
  // 本番に実在するのは start_draft(text,int) だけ（ほかの4本は今回の束の中の関数）。
  const dropTargets = [
    "public.start_draft(text, int)",
    "public.get_public_works(text, text, int, int, text)",
  ];
  for (const t of dropTargets) {
    try {
      const deps = await q(
        `select distinct d.classid::regclass::text as kind, d.objid::text as obj
           from pg_depend d
          where d.refobjid = $1::regprocedure
            and d.deptype <> 'i'
            and d.classid <> 'pg_proc'::regclass`,
        [t],
      );
      row(t, deps.length === 0 ? `${GREEN}依存なし${RESET}`
        : `${YELLOW}依存 ${deps.length} 件: ${deps.map((d) => d.kind).join(", ")}${RESET}`);
      if (deps.length) note(`${t} に依存しているものがある（drop が失敗しうる）`);
    } catch {
      // regprocedure への変換で落ちる＝本番にその関数が無い
      row(t, `${DIM}本番に無い（drop は空振り）${RESET}`);
    }
  }

  // ─── 5. RLS と方針 ────────────────────────────────────────────────────
  head("5. RLS の状態");
  const rls = await q(
    `select c.relname as tbl, c.relrowsecurity as on,
            (select count(*)::int from pg_policies p
              where p.schemaname='public' and p.tablename=c.relname) as policies
       from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' order by 1`,
  );
  const noRls = rls.filter((r) => !r.on);
  row("RLS が有効な表", `${rls.length - noRls.length} / ${rls.length}`);
  if (noRls.length) {
    row("RLS が無効な表", `${YELLOW}${noRls.map((r) => r.tbl).join(", ")}${RESET}`);
    note(`RLS が無効な表がある: ${noRls.map((r) => r.tbl).join(", ")}`);
  }

  head("5b. card_slots の出題優先度（今回の変更と衝突しないか）");
  try {
    const cs = await q(`select card_slot_key, quiz_priority from public.card_slots order by quiz_priority, card_slot_key`);
    for (const r of cs) row(r.card_slot_key, r.quiz_priority);
  } catch (e) { row("card_slots", `${YELLOW}読めない（${e.message}）${RESET}`); }

  // ─── 6. 持ち出し・フレーバーの表が既にあるか ───────────────────────────
  head("6. 今回入れる機能の表が、既に本番にあるか");
  for (const t of ["carry_slots", "saved_elements", "prompt_flavor", "flavor_replies",
                   "usage_events", "draw_categories", "draft_session_slots", "prompt_renewals"]) {
    const n = (await q(
      `select count(*)::int as n from information_schema.tables
        where table_schema='public' and table_name=$1`, [t],
    ))[0].n;
    row(t, n > 0 ? `${YELLOW}既にある${RESET}` : "無い（今回作る）");
  }
  // ─── 7. 当てたときに落ちそうなところを、先に数える ─────────────────────
  head("7. 当てる前の当たり判定（既存の行が新しい決まりに違反しないか）");
  const preflight = [
    ["prompts.started_at を埋められない行（created_at が無い）",
     `select count(*)::int n from public.prompts where created_at is null`, 0],
    ["draft_sessions.started_at を埋められない行",
     `select count(*)::int n from public.draft_sessions where created_at is null`, 0],
    ["card_slots で優先度 24〜47 を既に使っている行（ずらす対象）",
     `select count(*)::int n from public.card_slots where quiz_priority between 24 and 47`, null],
    ["card_slots に color_1..3 が既にある",
     `select count(*)::int n from public.card_slots where card_slot_key in ('color_1','color_2','color_3')`, 0],
    ["card_slots に morph_1 が既にある（20260904090000 の投入先）",
     `select count(*)::int n from public.card_slots where card_slot_key = 'morph_1'`, 0],
    ["answers で回答項目が1つも無い行（question_count が0のまま残る）",
     `select count(*)::int n from public.answers a
       where not exists (select 1 from public.answer_items i where i.answer_id = a.id)`, null],
    ["answers で correct_count が項目数を超える行（exact_corrects の範囲違反）",
     `select count(*)::int n from public.answers a
        join (select answer_id, count(*)::int c from public.answer_items group by 1) x
          on x.answer_id = a.id
       where a.correct_count > x.c`, 0],
    ["work_slot_stats で corrects が attempts を超える行",
     `select count(*)::int n from public.work_slot_stats where corrects > attempts`, 0],
    ["user_slot_stats で corrects が attempts を超える行",
     `select count(*)::int n from public.user_slot_stats where corrects > attempts`, 0],
    // 次に出る番号が、既にある最大idより後ろにあるか。
    // is_called が真なら次は last_value + 1、偽なら last_value そのもの。
    ["tags の次の番号が、既存の最大idと衝突しないか",
     `select case when (select case when is_called then last_value + 1 else last_value end
                          from public.tags_id_seq)
                    > (select coalesce(max(id),0) from public.tags)
                  then 0 else 1 end as n`, 0],
    ["draft_modes に normal / hard が既にある",
     `select count(*)::int n from public.draft_modes where mode_key in ('normal','hard')`, 0],
    ["prompts に status='failed' の行が既にある",
     `select count(*)::int n from public.prompts where status = 'failed'`, 0],
  ];
  for (const [label, sql, want] of preflight) {
    try {
      const n = (await q(sql))[0].n;
      const ok = want === null ? null : Number(n) === want;
      const mark = ok === null ? DIM + "（数のみ）" + RESET
        : ok ? GREEN + "○" + RESET : RED + "×（期待 " + want + "）" + RESET;
      row(label, `${n} ${mark}`);
      if (ok === false) note(`${label} が ${n} 件ある（期待 ${want}）`);
    } catch (e) {
      row(label, `${YELLOW}読めない（${String(e.message).split("\n")[0]}）${RESET}`);
      note(`${label} を確かめられなかった`);
    }
  }

} finally {
  await client.query("rollback").catch(() => {});
  await client.end().catch(() => {});
}

head("気をつけること");
if (notes.length === 0) console.log("  無し");
for (const n of notes) console.log(`  ${YELLOW}・${n}${RESET}`);
console.log(`\n${DIM}この監査は1文字も書き込んでいない（read only トランザクション内で実行し、rollback で閉じた）。${RESET}`);
