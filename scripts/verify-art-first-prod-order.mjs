/**
 * 本番と同じ並びで migration を当ててから、持ち込み（art_first）だけを足して確かめる。
 *
 * 目的は1つ。**手元のDBに偶然残っているものが art_first を成立させていないか。**
 * まっさらなDBへ、本番に入っている44本だけを当て、そのうえで art_first を当てる。
 * 一巡ドローの書きかけ（20260907120000）は入れない。
 */
import { readFile } from "node:fs/promises";
import { createTestDb } from "../test/db/harness.mjs";
import {
  makeMember,
  asMember,
  drawPrompt,
  postWork,
  pickTags,
  postArtFirstWork,
  answerWork,
  value,
} from "../test/db/helpers.mjs";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
}

// 本番に入っている最後の migration は 20260907110000。
// before に 20260907120000 を渡すと、それより前だけが当たる＝本番と同じ44本。
const db = await createTestDb({ before: "20260907120000" });

const applied = (
  await db.query(`select 1`)
).rowCount !== null;
check("本番と同じ44本が当たる", applied);

// 書きかけが入っていないことを、関数の有無で確かめる（pick_card は書きかけ側の関数）
const wip = await db.query(
  `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname in ('pick_card','redo_slot')`,
);
check("一巡ドローの書きかけが入っていない", wip.rows[0].n === 0, `pick_card/redo_slot=${wip.rows[0].n}`);

// ここで初めて art_first を当てる
const sql = await readFile(
  new URL("../supabase/migrations/20260908090000_art_first.sql", import.meta.url),
  "utf8",
);
try {
  await db.exec(sql);
  check("art_first の migration が当たる", true);
} catch (e) {
  check("art_first の migration が当たる", false, e.message);
  report();
}

// --- 入ったものを1つずつ数える -------------------------------------------
const fn = await db.query(
  `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname in ('create_art_first_work','get_art_first_vocabulary')
    order by 1`,
);
check(
  "関数が2本とも在る",
  fn.rows.length === 2,
  fn.rows.map((r) => r.proname).join(" / "),
);

const modes = await db.query(
  `select mode_key, word_source, is_active, uses_two_stage, word_count_min, word_count_max
     from public.draft_modes order by sort_order`,
);
const byKey = Object.fromEntries(modes.rows.map((r) => [r.mode_key, r]));
check(
  "既存4モードの word_source が実態どおり",
  byKey.easy?.word_source === "fixed_slots" &&
    byKey.standard?.word_source === "fixed_slots" &&
    byKey.normal?.word_source === "two_stage_draw" &&
    byKey.hard?.word_source === "two_stage_draw",
  modes.rows.map((r) => `${r.mode_key}=${r.word_source}`).join(" / "),
);
check(
  "art_first のモードが在り、画面には出ない",
  byKey.art_first?.word_source === "author_pick" &&
    byKey.art_first?.is_active === false &&
    byKey.art_first?.uses_two_stage === false &&
    byKey.art_first?.word_count_min === 3 &&
    byKey.art_first?.word_count_max === 6,
  JSON.stringify(byKey.art_first ?? null),
);

const origin = await db.query(
  `select pg_get_constraintdef(oid) as def from pg_constraint
    where conrelid='public.prompts'::regclass and conname='prompts_origin_check'`,
);
check(
  "出どころの許可値が4つ",
  /art_first/.test(origin.rows[0].def) &&
    /draft/.test(origin.rows[0].def) &&
    /saved/.test(origin.rows[0].def) &&
    /daily/.test(origin.rows[0].def),
  origin.rows[0].def,
);

// --- 通常の経路が壊れていないか -------------------------------------------
const u = await makeMember(db, "prod-order");
try {
  const p = await drawPrompt(db, u, { mode: "normal", timeLimit: 3600 });
  await postWork(db, u, p.prompt_id, "通常の作品");
  const cards = await value(db, asMember(u), `select public.get_my_prompt($1)`, [p.prompt_id]);
  check(
    "通常のドロー（normal）が通り、3〜4語のお題ができる",
    cards.cards.length >= 3 && cards.cards.length <= 4,
    `${cards.cards.length} 語`,
  );
} catch (e) {
  check("通常のドロー（normal）が通り、3〜4語のお題ができる", false, e.message);
}

// --- 持ち込みが通るか -------------------------------------------------------
try {
  const ids = [];
  for (const [cat, n] of [["morph", 1], ["emotion", 1], ["color", 1], ["action", 1]]) {
    for (const t of await pickTags(db, cat, n)) ids.push(t.id);
  }
  const { workId, question_count } = await postArtFirstWork(db, u, ids);
  check("持ち込みの作品が作れる", true);
  check("選んだ4語がそのまま4問になる（全語出題）", question_count === 4, `${question_count} 問`);

  const row = (
    await db.query(
      `select p.origin, p.draft_session_id, p.time_limit_seconds
         from public.works w join public.prompts p on p.id = w.prompt_id where w.id = $1`,
      [workId],
    )
  ).rows[0];
  check(
    "出どころが art_first ／ ドラフト無し ／ 制限時間なし",
    row.origin === "art_first" && row.draft_session_id === null && row.time_limit_seconds === null,
    JSON.stringify(row),
  );

  const v = await makeMember(db, "prod-order-viewer");
  const a = await answerWork(db, v, workId, { correct: true });
  check("他の人が全問に答えられる", a.correct_count === 4, `正解 ${a.correct_count}`);
} catch (e) {
  check("持ち込みの作品が作れる", false, e.message);
}

// --- 診断（db-checks の A 群）を、この状態で流す ---------------------------
const { diagnostics } = await import("../scripts/db-checks.mjs");
let bad = [];
for (const d of diagnostics) {
  const r = await db.query(d.sql);
  if (r.rows.length > 0) bad.push(`${d.id}(${r.rows.length}件)`);
}
check("診断が全部0件", bad.length === 0, bad.join(" / "));

report();

function report() {
  console.log("");
  for (const r of results) {
    console.log(`  ${r.ok ? "○" : "✗"} ${r.name}${r.detail ? `  ${r.detail}` : ""}`);
  }
  const ng = results.filter((x) => !x.ok).length;
  console.log(`\n合計 ${results.length} 件 / 合格 ${results.length - ng} 件 / 不合格 ${ng} 件`);
  process.exit(ng === 0 ? 0 : 1);
}
