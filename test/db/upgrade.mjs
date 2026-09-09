/**
 * upgrade.mjs ／ 既にデータがあるDBへ、今回の migration を当てる試験
 *
 * 実行: npm run test:db:upgrade
 *
 * 【run.mjs と何が違うか】
 *   run.mjs は「まっさらなDBに全部当てた状態」を試している。
 *   本番はまっさらではない。**旧方式で作られたお題・作品・回答が入っている。**
 *   その上へ当てたときに何が起きるかは、まっさらの試験では分からない。
 *
 * 【手順】
 *   1. 2026-09-04 より前の migration だけを当てる（＝いまの本番と同じ作り）
 *   2. 旧方式でお題・作品・回答を作る
 *   3. その姿を控える（件数とハッシュ）
 *   4. 今回の migration 16本を当てる
 *   5. 控えと突き合わせ、1行も変わっていないことを確かめる
 *   6. 古い作品・古い回答が、いままでどおり読めることを確かめる
 *   7. 古いお題に期限が入ること、そのうち何件が猶予切れになるかを数える
 */

import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installLocalOnlyGuard } from "../guard/no-production.mjs";
import { applyMigrations, asRole, createUser } from "./harness.mjs";
import { asMember, value } from "./helpers.mjs";
import { recordCount } from "../counts.mjs";

// **最初のネットワーク要求より前に柵を立てる。**
// 本番のURL・project ref・ホスト名・鍵が環境にあれば、ここで異常終了する。
installLocalOnlyGuard("アップグレード試験（test:db:upgrade）");

const HERE = dirname(fileURLToPath(import.meta.url));

const NEW_MIGRATIONS_FROM = "20260904090000";

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, message: e.message ?? String(e) });
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** harness の SUPABASE_STUB と同じものを使うため、createTestDb を経由して作る */
async function freshOldDb() {
  const { createTestDb } = await import("./harness.mjs");
  return createTestDb({ before: NEW_MIGRATIONS_FROM });
}

async function main() {
  // --- 1. いまの本番と同じ作りのDB -----------------------------------------
  const db = await freshOldDb();

  const tables = await db.query(`select count(*)::int as n from pg_tables where schemaname='public'`);
  assert(
    tables.rows[0].n === 29,
    `当てる前の表が ${tables.rows[0].n} 個（本番と同じ29個のはず）`,
  );

  // --- 2. 旧方式でお題・作品・回答を作る -----------------------------------
  const author = await createUser(db, { handle: "old-author" });
  const viewer = await createUser(db, { handle: "old-viewer" });

  const versions = await db.query(
    `select (select version from public.terms_versions   where is_current) as t,
            (select version from public.privacy_versions where is_current) as p`,
  );
  for (const uid of [author, viewer]) {
    await asRole(db, { role: "authenticated", uid }, async (c) => {
      await c.query(`select public.agree_to_documents($1, $2)`, [
        versions.rows[0].t,
        versions.rows[0].p,
      ]);
    });
  }

  // 旧方式のドラフト（standard は枠が固定。この時点ではまだ有効）
  // **ここは当てる前のDBなので、めくると同時に決まる旧い reveal_card を使う。**
  // choose_card はまだ存在しない（D170 の migration で入る）。
  const drafted = await asRole(db, { role: "authenticated", uid: author }, async (c) => {
    const start = await c.query(`select public.start_draft('standard', 3600) as s`);
    let state = start.rows[0].s;
    for (const slot of state.slots) {
      const r = await c.query(`select public.reveal_card($1, $2, 0) as s`, [
        state.session_id,
        slot.card_slot_key,
      ]);
      state = r.rows[0].s;
    }
    const done = await c.query(`select public.complete_draft($1) as s`, [state.session_id]);
    return done.rows[0].s;
  });

  const workId = (await db.query(`select gen_random_uuid() as id`)).rows[0].id;
  await asRole(db, { role: "authenticated", uid: author }, async (c) => {
    await c.query(
      `select public.create_work($1, $2, '旧方式の作品', $3, 800, 600, 'original')`,
      [workId, drafted.prompt_id, `${author}/${workId}.png`],
    );
  });

  const oldAnswer = await asRole(db, { role: "authenticated", uid: viewer }, async (c) => {
    const q = await c.query(`select public.get_work_quiz($1) as q`, [workId]);
    const selections = q.rows[0].q.questions.map((x) => ({
      question_id: x.question_id,
      tag_id: Number(x.choices[0].tag_id),
    }));
    const a = await c.query(`select public.submit_answer($1, $2::jsonb) as a`, [
      workId,
      JSON.stringify(selections),
    ]);
    return a.rows[0].a;
  });

  // さらに、まだ投稿していない古いお題も1件作る（期限が入る対象）
  const staleAuthor = await createUser(db, { handle: "old-stale" });
  await asRole(db, { role: "authenticated", uid: staleAuthor }, async (c) => {
    await c.query(`select public.agree_to_documents($1, $2)`, [
      versions.rows[0].t,
      versions.rows[0].p,
    ]);
    const start = await c.query(`select public.start_draft('easy', 600) as s`);
    let state = start.rows[0].s;
    for (const slot of state.slots) {
      const r = await c.query(`select public.reveal_card($1, $2, 0) as s`, [
        state.session_id,
        slot.card_slot_key,
      ]);
      state = r.rows[0].s;
    }
    await c.query(`select public.complete_draft($1)`, [state.session_id]);
  });

  // 古いお題を「30日前に引いた」ことにする
  await db.query(
    `update public.prompts set created_at = now() - interval '30 days'
      where status = 'active'`,
  );

  // --- 3. 姿を控える --------------------------------------------------------
  const before = (
    await db.query(`
      select
        (select count(*) from public.prompts)        as n_prompts,
        (select count(*) from public.prompt_cards)   as n_cards,
        (select count(*) from public.works)          as n_works,
        (select count(*) from public.answers)        as n_answers,
        (select count(*) from public.answer_items)   as n_items,
        (select count(*) from public.tags)           as n_tags,
        (select coalesce(max(id),0) from public.tags) as max_tag_id,
        (select md5(coalesce(string_agg(s,'|' order by s),'')) from
          (select prompt_id::text||'/'||card_slot_key||'/'||slot_order::text||'/'||tag_id::text
             from public.prompt_cards) x(s))         as h_cards,
        (select md5(coalesce(string_agg(s,'|' order by s),'')) from
          (select id::text||'/'||pool_key||'/'||label from public.tags) x(s)) as h_tags,
        (select md5(coalesce(string_agg(s,'|' order by s),'')) from
          (select question_id::text||'/'||tag_id::text||'/'||is_correct::text
             from public.quiz_choices) x(s))         as h_choices,
        (select md5(coalesce(string_agg(s,'|' order by s),'')) from
          (select work_id::text||'/'||card_slot_key||'/'||attempts::text||'/'||corrects::text
             from public.work_slot_stats) x(s))      as h_stats,
        -- 互換期間だけ残す旧列。**値が保たれるか**を後で突き合わせる
        (select md5(coalesce(string_agg(s,'|' order by s),'')) from
          (select id::text||'/'||coalesce(quiz_question_count::text,'-')
             from public.draft_sessions) x(s))       as h_qqc_sessions,
        -- モードは今回2つ増える。**増えた行ではなく、元からあった行の値**を見る
        (select md5(coalesce(string_agg(s,'|' order by s),'')) from
          (select mode_key||'/'||quiz_question_count::text
             from public.draft_modes
            where mode_key in ('easy','standard')) x(s)) as h_qqc_modes
    `)
  ).rows[0];

  // --- 4. 今回の migration を当てる ----------------------------------------
  // 当てるべき本数は、**数え直して決める。**
  // ここに数字を書いておくと、migration を1本足すたびにこの試験が
  // 「本数が違う」で落ちる。落ちるのは正しいが、直し方が
  // 「数字を書き換える」になるので、次からは何も守らなくなる。
  const expected = readdirSync(fileURLToPath(new URL("../../supabase/migrations", import.meta.url)))
    .filter((f) => f.endsWith(".sql") && f >= NEW_MIGRATIONS_FROM).length;

  const applied = await applyMigrations(db, { from: NEW_MIGRATIONS_FROM });
  assert(
    applied.length === expected,
    `当てた migration が ${applied.length} 本（${NEW_MIGRATIONS_FROM} 以降のファイルは ${expected} 本）`,
  );
  assert(expected > 0, "当てる migration が1本も無い");

  // --- 5. 突き合わせ --------------------------------------------------------
  const after = (
    await db.query(`
      select
        (select count(*) from public.prompts)        as n_prompts,
        (select count(*) from public.prompt_cards)   as n_cards,
        (select count(*) from public.works)          as n_works,
        (select count(*) from public.answers)        as n_answers,
        (select count(*) from public.answer_items)   as n_items,
        (select md5(coalesce(string_agg(s,'|' order by s),'')) from
          (select prompt_id::text||'/'||card_slot_key||'/'||slot_order::text||'/'||tag_id::text
             from public.prompt_cards) x(s))         as h_cards,
        (select md5(coalesce(string_agg(s,'|' order by s),'')) from
          (select question_id::text||'/'||tag_id::text||'/'||is_correct::text
             from public.quiz_choices) x(s))         as h_choices,
        (select md5(coalesce(string_agg(s,'|' order by s),'')) from
          (select work_id::text||'/'||card_slot_key||'/'||attempts::text||'/'||corrects::text
             from public.work_slot_stats) x(s))      as h_stats
    `)
  ).rows[0];

  await test("お題・カード・作品・回答の件数が1件も変わらない", () => {
    for (const k of ["n_prompts", "n_cards", "n_works", "n_answers", "n_items"]) {
      assert(
        String(before[k]) === String(after[k]),
        `${k} が ${before[k]} → ${after[k]} に変わった`,
      );
    }
  });

  await test("お題カードの中身が1行も変わらない（答えがずれていない）", () => {
    assert(before.h_cards === after.h_cards, "prompt_cards の中身が変わった");
  });

  await test("クイズの選択肢と正解の印が1行も変わらない", () => {
    assert(before.h_choices === after.h_choices, "quiz_choices の中身が変わった");
  });

  await test("枠ごとの集計が1行も変わらない", () => {
    assert(before.h_stats === after.h_stats, "work_slot_stats の中身が変わった");
  });

  await test("既存タグの id と分類が1つも変わらない", async () => {
    // **件数ではなく、当てる前の最大 id で切る。**
    // タグの id は連番とは限らない（欠番がありうる）ので、
    // 件数で切ると新しい行が混ざったり、古い行が漏れたりする。
    const h = await db.query(
      `select md5(coalesce(string_agg(s,'|' order by s),'')) as h from
        (select id::text||'/'||pool_key||'/'||label from public.tags
          where id <= $1) x(s)`,
      [Number(before.max_tag_id)],
    );
    assert(h.rows[0].h === before.h_tags, "既存タグの id / 分類 / 表記が変わった");
  });

  await test("語彙が増えている（旧タグは減っていない）", async () => {
    const n = await db.query(`select count(*)::int as n from public.tags`);
    assert(
      n.rows[0].n > Number(before.n_tags),
      `タグが ${before.n_tags} → ${n.rows[0].n}（増えていない）`,
    );

    const old = await db.query(
      `select count(*)::int as n from public.tags
        where pool_key in ('motif','color','species','genre')`,
    );
    assert(old.rows[0].n === 156, `旧プールが ${old.rows[0].n} 件（156件のはず）`);
  });

  await test("古い作品が、いままでどおり公開一覧と詳細に出る", async () => {
    const list = await asRole(db, { role: "anon", uid: null }, async (c) => {
      const r = await c.query(
        `select count(*)::int as n from public.get_public_works(null,'new',20,0)`,
      );
      return r.rows[0].n;
    });
    assert(list === 1, `公開一覧が ${list} 件（1件のはず）`);

    const detail = await asRole(db, { role: "anon", uid: null }, async (c) => {
      const r = await c.query(`select public.get_work_detail($1) as d`, [workId]);
      return r.rows[0].d;
    });
    assert(detail !== null, "古い作品の詳細が取れない");
    assert(detail.title === "旧方式の作品", "古い作品のタイトルが変わった");
    assert(detail.answers_count === 1, "古い作品の回答数が変わった");
  });

  await test("古い回答が、いままでどおり本人に返る", async () => {
    const a = await value(db, asMember(viewer), `select public.get_my_answer($1)`, [workId]);
    assert(a !== null, "古い回答が取れない");
    assert(
      a.correct_count === oldAnswer.correct_count,
      `正答数が ${oldAnswer.correct_count} → ${a.correct_count} に変わった`,
    );
    assert(a.items.length === oldAnswer.items.length, "回答の内訳の数が変わった");
  });

  await test("古いお題が、いままでどおり作者に返る（分類名も変わらない）", async () => {
    const p = await value(db, asMember(author), `select public.get_my_prompt($1)`, [
      drafted.prompt_id,
    ]);
    assert(p !== null, "古いお題が取れない");
    assert(p.cards.length === 5, `古いお題のカードが ${p.cards.length} 枚（5枚のはず）`);

    const pools = new Set(p.cards.map((c) => c.pool_key));
    for (const pool of pools) {
      assert(
        ["motif", "color", "species", "genre"].includes(pool),
        `古いお題の分類が新しい名前に変わっている: ${pool}`,
      );
    }
  });

  await test("標準の migration だけでは、古いお題に期限が入らない（遡及は分離した）", async () => {
    const { rows } = await db.query(
      `select count(*)::int as n from public.prompts
        where status = 'active' and time_limit_seconds is not null
          and deadline_at is not null`,
    );
    assert(
      rows[0].n === 0,
      `migration を当てただけで ${rows[0].n} 件に期限が入った（0件のはず）`,
    );

    // 記録としての開始時刻は入る。**期限ではないので投稿は止まらない**
    const started = await db.query(
      `select count(*)::int as n from public.prompts where started_at is null`,
    );
    assert(started.rows[0].n === 0, "開始時刻が入っていないお題がある");
  });

  await test("読み取り専用の点検SQLが、遡及の影響を数えられる", async () => {
    const sql = await readFile(
      join(HERE, "..", "..", "supabase", "manual", "20260905_inspect_prompt_deadlines.sql"),
      "utf8",
    );
    const out = await db.exec(sql);
    const first = out[0].rows[0];
    assert(
      Number(first.would_get_deadline) >= 1,
      `遡及の対象が ${first.would_get_deadline} 件（1件以上のはず）`,
    );
    // 【2026-09-09】超過で失敗になるお題はもう無い。
    // 数えるのは「遡及すると超過中の表示になるお題」で、投稿は止まらない
    assert(
      Number(first.would_be_overrun) >= 1,
      `30日前のお題が would_be_overrun に数えられていない（${first.would_be_overrun} 件）`,
    );
    assert(
      Number(first.would_fail) === 0,
      `遡及で投稿できなくなるお題が ${first.would_fail} 件ある（0のはず）`,
    );

    // 点検で1行も書き換わっていないこと
    const still = await db.query(
      `select count(*)::int as n from public.prompts where deadline_at is not null`,
    );
    assert(still.rows[0].n === 0, "点検SQLがデータを書き換えた");
  });

  await test("手で遡及SQLを流したときだけ、古いお題に期限が入る", async () => {
    const sql = await readFile(
      join(HERE, "..", "..", "supabase", "manual", "20260905_backfill_prompt_deadlines.sql"),
      "utf8",
    );
    await db.exec(sql);

    const { rows } = await db.query(
      `select count(*)::int as n from public.prompts
        where status = 'active' and deadline_at is not null`,
    );
    assert(rows[0].n >= 1, "遡及SQLを流しても期限が入っていない");

    // 【2026-09-09 に意味が変わった】
    //   予定終了時刻を過ぎただけでは失敗にしない。数えるのは
    //   「まだ知らせていない超過」で、失敗の予備軍ではない。
    const { rows: overrun } = await db.query(
      `select (public.cleanup_status() ->> 'unnotified_overrun')::int as n`,
    );
    assert(overrun[0].n >= 1, "30日前のお題が「未通知の超過」として数えられていない");
  });

  await test("掃除は超過を知らせるだけで、失敗にも破棄にもしない", async () => {
    const worksBefore = await db.query(`select count(*)::int as n from public.works`);

    const notified = await asRole(db, { role: "service_role", uid: null }, async (c) => {
      const r = await c.query(`select public.notify_overrun_challenges(500) as n`);
      return r.rows[0].n;
    });
    assert(notified >= 1, "掃除が超過したお題を拾わなかった");

    // **失敗にも破棄にもならない。**古いお題でも、状態は 'active' のまま
    const { rows: failed } = await db.query(
      `select count(*)::int as n from public.prompts where status in ('failed','discarded')`,
    );
    assert(failed[0].n === 0, `超過だけで ${failed[0].n} 件が終了状態になった`);

    const worksAfter = await db.query(`select count(*)::int as n from public.works`);
    assert(
      worksBefore.rows[0].n === worksAfter.rows[0].n,
      "掃除で作品の行が動いた（D163 違反）",
    );

    // 投稿済みのお題は 'submitted' のまま
    const submitted = await db.query(
      `select status from public.prompts where id = $1`,
      [drafted.prompt_id],
    );
    assert(
      submitted.rows[0].status === "submitted",
      `投稿済みのお題が ${submitted.rows[0].status} になった`,
    );
  });

  await test("古いお題でも、規則を入れた直後は自動破棄されない", async () => {
    // 放置の起点は「最終操作」と「規則を入れた時刻」の遅いほう。
    // migration を当てた瞬間に、30日前の作りかけが一斉に消えないこと
    const n = await asRole(db, { role: "service_role", uid: null }, async (c) => {
      const r = await c.query(`select public.discard_inactive_challenges(500) as n`);
      return r.rows[0].n;
    });
    assert(n === 0, `当てた直後に ${n} 件が自動破棄された`);

    const { rows } = await db.query(
      `select count(*)::int as n from public.notification_events
        where kind in ('inactivity_warning','inactivity_discard')`,
    );
    assert(rows[0].n === 0, `当てた直後に放置の知らせが ${rows[0].n} 件出た`);
  });

  await test("旧方式のモードは、一般利用者から見えなくなる", async () => {
    const visible = await asRole(db, { role: "anon", uid: null }, async (c) => {
      const r = await c.query(`select mode_key from public.draft_modes order by sort_order`);
      return r.rows.map((x) => x.mode_key);
    });
    assert(
      JSON.stringify(visible) === JSON.stringify(["normal", "hard"]),
      `見えるモードが ${visible.join(",")}（normal, hard のはず）`,
    );

    // 行そのものは残っている（過去のお題が参照しているため）。
    // 5件の内訳は normal / hard と、隠してある旧2種 と、持ち込み（art_first。
    // これも一般利用者には出さない。2026-09-08 の migration で足した）
    const all = await db.query(`select count(*)::int as n from public.draft_modes`);
    assert(all.rows[0].n === 5, `モードの行が ${all.rows[0].n} 件（5件のはず）`);
  });

  await test("古い回答は旧方式の印が付き、内訳はビタ当てのまま", async () => {
    const { rows } = await db.query(
      `select scoring_version, question_count, exact_attempts, pair_attempts,
              correct_count
         from public.answers where work_id = $1`,
      [workId],
    );
    assert(rows.length === 1, "古い回答が消えている");
    assert(
      rows[0].scoring_version === "v1_fixed_count",
      `古い回答の版が ${rows[0].scoring_version}（v1_fixed_count のはず）`,
    );
    assert(
      rows[0].question_count === oldAnswer.items.length,
      `出題数の埋め戻しが ${rows[0].question_count}（${oldAnswer.items.length} のはず）`,
    );
    assert(
      rows[0].pair_attempts === 0 && rows[0].exact_attempts === rows[0].question_count,
      "古い回答が2択当てとして数えられている",
    );

    const { rows: items } = await db.query(
      `select distinct ai.answer_mode from public.answer_items ai
         join public.answers a on a.id = ai.answer_id where a.work_id = $1`,
      [workId],
    );
    assert(
      items.length === 1 && items[0].answer_mode === "exact",
      "古い回答の内訳がビタ当てになっていない",
    );
  });

  await test("古い作品の出題数は増えない（作り直さない）", async () => {
    // 旧方式の standard は枠が5つあるが、出題は3問だった。
    // **D165 は、これから作るお題に効く。**すでに答えの出ている作品を
    // 後から6問にすると、過去の回答が「未回答の問がある」状態になる。
    const { rows } = await db.query(
      `select count(*)::int as n from public.quiz_questions qq
         join public.works w on w.prompt_id = qq.prompt_id where w.id = $1`,
      [workId],
    );
    assert(rows[0].n === 3, `古い作品の出題が ${rows[0].n} 問（3問のまま のはず）`);
  });

  await test("旧方式（3問）の作品も、次の作品の候補になれる（D169）", async () => {
    // **問題数を理由に候補から外していないこと。**
    // D169 は「公開されていて、審査を通っていて、削除されていない」だけを
    // 資格にしている。旧方式で3問のまま残る作品も、その資格を満たす。
    const fresh = await createUser(db, { anonymous: false });
    const cand = await asRole(db, asMember(fresh), async (c) => {
      const r = await c.query(
        `select work_id, band from public.next_work_candidates(null)`,
      );
      return r.rows;
    });

    const hit = cand.find((r) => r.work_id === workId);
    assert(hit !== undefined, "旧方式の作品が次の作品の候補から外れている");
    // すでに1件回答が付いているので、第2救済帯に入るはず
    assert(
      Number(hit.band) === 2,
      `旧方式の作品の救済帯が ${hit.band}（回答1件なので2のはず）`,
    );
  });

  await test("旧列 quiz_question_count の値が、当てた後も1つも変わらない", async () => {
    // 落とさないと決めた列である。**残すだけでなく、値も保つ。**
    const { rows } = await db.query(`
      select
        (select md5(coalesce(string_agg(s,'|' order by s),'')) from
          (select id::text||'/'||coalesce(quiz_question_count::text,'-')
             from public.draft_sessions) x(s)) as h_sessions,
        (select md5(coalesce(string_agg(s,'|' order by s),'')) from
          (select mode_key||'/'||quiz_question_count::text
             from public.draft_modes
            where mode_key in ('easy','standard')) x(s)) as h_modes
    `);
    assert(
      rows[0].h_sessions === before.h_qqc_sessions,
      "draft_sessions.quiz_question_count の値が変わった",
    );
    assert(
      rows[0].h_modes === before.h_qqc_modes,
      "元からあった draft_modes の quiz_question_count の値が変わった",
    );
  });

  await test("新しい実装は、残した旧列をどこからも参照していない", async () => {
    // draft_state_json だけは、旧い画面へ返す鍵として触る（D165 の 3b）
    const { rows } = await db.query(
      `select p.proname from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prokind = 'f'
          and p.proname <> 'draft_state_json'
          and pg_get_functiondef(p.oid) like '%quiz_question_count%'`,
    );
    assert(
      rows.length === 0,
      `新方式が旧列を参照している: ${JSON.stringify(rows.map((r) => r.proname))}`,
    );
  });

  await test("旧い画面の呼び方が、当てた後のDBでも全部通る", async () => {
    // 本番は「DBを先に更新し、画面を後から差し替える」順で当てる。
    // その時間帯に旧い画面が投げる形を、そのまま投げてみる。
    const reader = await createUser(db, { anonymous: false });

    await asRole(db, { role: "anon", uid: null }, async (c) => {
      // 旧い一覧（5引数・名前付き。PostgREST が投げる形）
      await c.query(
        `select count(*) from public.get_public_works(
           p_division := null, p_sort := 'new', p_limit := 24,
           p_offset := 0, p_completeness := null)`,
      );
      // 旧いモード一覧（表を直に読む）
      await c.query(
        `select mode_key, label, candidate_count, max_rerolls,
                quiz_question_count, sort_order
           from public.draft_modes order by sort_order`,
      );
    });

    // 旧い「次の作品」（2引数・名前付き）
    await asRole(db, asMember(reader), async (c) => {
      await c.query(
        `select public.get_next_work(
           p_current_work_id := null, p_division := null)`,
      );
    });
  });

  await test("旧方式の作品も、一覧の「未回答のみ」に出る（まだ答えていない人には）", async () => {
    const fresh = await createUser(db, { anonymous: false });
    const ids = await asRole(db, asMember(fresh), async (c) => {
      const r = await c.query(
        `select id from public.get_public_works(null, 'new', 20, 0, null, true)`,
      );
      return r.rows.map((x) => x.id);
    });
    assert(ids.includes(workId), "旧方式の作品が「未回答のみ」から消えている");
  });

  await test("枠ごとの集計に、方式別の内訳が埋め戻される", async () => {
    const { rows } = await db.query(
      `select attempts, corrects, exact_attempts, exact_corrects,
              pair_attempts, pair_corrects
         from public.work_slot_stats where work_id = $1`,
      [workId],
    );
    assert(rows.length > 0, "古い作品の集計が消えている");
    for (const r of rows) {
      assert(
        r.exact_attempts === r.attempts && r.exact_corrects === r.corrects,
        "古い集計がビタ当てとして埋め戻されていない",
      );
      assert(r.pair_attempts === 0, "2択当てが0でない");
    }
  });

  await test("持ち出しの上限が、保存枠の数として入る", async () => {
    const { rows } = await db.query(
      `select policy_key, value, unit, is_provisional from public.carry_policy
        where policy_key in ('self_max','others_max') order by policy_key`,
    );
    assert(rows.length === 2, "上限の行が足りない");
    for (const r of rows) {
      assert(r.unit === "slot", `${r.policy_key} の単位が ${r.unit}（slot のはず）`);
    }
    assert(
      Number(rows.find((r) => r.policy_key === "self_max").value) === 5,
      "自分由来の上限が5枠になっていない",
    );
    assert(
      Number(rows.find((r) => r.policy_key === "others_max").value) === 3,
      "他者由来の上限が3枠になっていない",
    );
  });

  await test("カラーが抽選のカテゴリとして入る（旧プールの15語をそのまま使う）", async () => {
    const { rows } = await db.query(
      `select kind, max_per_prompt, pool_key from public.draw_categories
        where category_key = 'color'`,
    );
    assert(rows.length === 1, "カラーのカテゴリが入っていない");
    assert(rows[0].max_per_prompt === 1, "カラーの上限が1語になっていない");
    // **状態カテゴリの9番目にしない。**独立した上位種別として入る
    assert(rows[0].kind === "color", `カラーの上位種別が ${rows[0].kind}（color のはず）`);

    const { rows: kinds } = await db.query(
      `select count(*)::int as n from public.draw_categories
        where is_active and kind = 'state'`,
    );
    assert(kinds[0].n === 8, `状態カテゴリが ${kinds[0].n} 個（8個のはず）`);

    const { rows: n } = await db.query(
      `select count(*)::int as n from public.tags where pool_key = 'color' and is_active`,
    );
    assert(n[0].n === 15, `カラーの語が ${n[0].n} 語（旧プールの15語のはず）`);
  });

  await test("回答者×枠の集計にも、方式別の内訳が埋め戻される", async () => {
    const { rows } = await db.query(
      `select count(*)::int as bad from public.user_slot_stats
        where attempts > 0 and exact_attempts <> attempts`,
    );
    assert(
      rows[0].bad === 0,
      `古い回答者の枠別集計 ${rows[0].bad} 件が、ビタ当てとして埋め戻されていない`,
    );

    const { rows: pair } = await db.query(
      `select coalesce(sum(pair_attempts), 0)::int as n from public.user_slot_stats`,
    );
    assert(pair[0].n === 0, `2択当てがまだ無いはずなのに ${pair[0].n} 件ある`);
  });

  await test("語彙の出所と、承認の有無が記録される", async () => {
    const { rows } = await db.query(
      `select vocab_origin, count(*)::int as n from public.tags group by 1 order by 1`,
    );
    const byOrigin = Object.fromEntries(rows.map((r) => [r.vocab_origin, r.n]));
    assert(byOrigin.legacy === 156, `旧語彙が ${byOrigin.legacy} 語（156語のはず）`);
    assert(byOrigin.claude_new === 192, `Claude の新語が ${byOrigin.claude_new} 語（192語のはず）`);
    assert(byOrigin.moved === 126, `移した語が ${byOrigin.moved} 語（126語のはず）`);

    // **「検査済み」と「承認済み」を同じ列にしない。**承認はまだ1語も無い
    const { rows: approved } = await db.query(
      `select count(*)::int as n from public.tags where approved_by_user`,
    );
    assert(approved[0].n === 0, `承認済みが ${approved[0].n} 語（0語のはず）`);

    const { rows: fv } = await db.query(
      `select count(*)::int as n from public.flavor_vocab where vocab_origin = 'claude_new'`,
    );
    assert(fv[0].n === 90, `ヒント語が ${fv[0].n} 語（90語のはず）`);
  });

  await test("新方式のお題が、当てたあとのDBで作れる", async () => {
    const u = await createUser(db, { handle: "after-upgrade" });
    const state = await asRole(db, { role: "authenticated", uid: u }, async (c) => {
      const start = await c.query(`select public.start_draft('normal', 3600, null) as s`);
      let s = start.rows[0].s;
      for (const slot of s.slots) {
        const r = await c.query(`select public.choose_card($1, $2, 0) as s
           from (select public.reveal_card($1, $2, 0)) as r`, [
          s.session_id,
          slot.card_slot_key,
        ]);
        s = r.rows[0].s;
      }
      const done = await c.query(`select public.complete_draft($1) as s`, [s.session_id]);
      return done.rows[0].s;
    });
    assert(state.card_count >= 3 && state.card_count <= 4, "新方式の語数が範囲外");
  });

  /* =====================================================================
   * 本番へ出す順番そのものを試す（2026-09-07）
   *
   * 出所: ユーザー指示「旧フロント＋新DBの不整合時間をどう避けるか決めて
   * から作業してください」。
   *
   * 【何を確かめるか】
   *   本番は「DBを当てる」と「画面を入れ替える」を同時にできない。
   *   あいだに必ず、片方だけ新しい時間ができる。そこで壊れないことを、
   *   理屈ではなく実際に動かして確かめる。
   *
   *   当てる順番はこうする。
   *     1. 090000 / 093000 / 094000 を当てる … 画面はまだ古い
   *     2. 新しい画面を出す                   … DBはまだ 110000 を当てていない
   *     3. 110000 を当てる                    … ここで2段になる
   *
   *   1 のあとと 2 のあとで、それぞれ何が動くかを下で測る。
   * ===================================================================== */

  const { createTestDb } = await import("./harness.mjs");
  const mid = await createTestDb({ before: "20260907110000" });

  /** そのDBで、ドラフトを1つ始める */
  async function startOn(pg, handle) {
    const u = await createUser(pg, { handle });
    const state = await asRole(pg, { role: "authenticated", uid: u }, async (c) => {
      const r = await c.query(`select public.start_draft('normal', 3600, null) as s`);
      return r.rows[0].s;
    });
    return { uid: u, state };
  }

  await test("順番1: 3本を当てた時点では、いまの画面のやり方（めくる＝決まる）が動く", async () => {
    const { uid, state } = await startOn(mid, "stage-old-ui");
    const slot = state.slots[0];

    const after = await asRole(mid, { role: "authenticated", uid }, async (c) => {
      const r = await c.query(`select public.reveal_card($1, $2, 0) as s`, [
        state.session_id,
        slot.card_slot_key,
      ]);
      return r.rows[0].s;
    });

    const row = after.slots.find((x) => x.card_slot_key === slot.card_slot_key);
    assert(
      row.candidates.some((c) => c.is_chosen),
      "めくっただけでは決まらない（いまの画面はここで止まる）",
    );
    assert(
      after.chosen_count === 1,
      `めくったのに確定数が ${after.chosen_count}（1のはず）`,
    );
  });

  await test("順番2: 新しい画面が呼ぶ関数は、3本を当てた時点でもう全部ある", async () => {
    const { uid, state } = await startOn(mid, "stage-new-ui");

    // 「関数が無い」で落ちないことを見る。中身の正しさは run.mjs が見ている
    const missing = [];
    for (const sig of [
      `public.choose_card($1, $2, 0)`,
      `public.hold_card($1, $2, 0, true)`,
      `public.reveal_slot_pool($1, $2)`,
    ]) {
      try {
        await asRole(mid, { role: "authenticated", uid }, async (c) => {
          await c.query(`select ${sig}`, [state.session_id, state.slots[0].card_slot_key]);
        });
      } catch (e) {
        if (/does not exist|存在しません/.test(e.message)) missing.push(sig);
      }
    }
    for (const sig of [
      `public.abandon_prompt('00000000-0000-0000-0000-000000000000')`,
      `public.reveal_prompt_candidates('00000000-0000-0000-0000-000000000000')`,
    ]) {
      try {
        await asRole(mid, { role: "authenticated", uid }, async (c) => {
          await c.query(`select ${sig}`);
        });
      } catch (e) {
        if (/does not exist/.test(e.message)) missing.push(sig);
      }
    }

    assert(missing.length === 0, `新しい画面が呼ぶ関数が足りない: ${missing.join(", ")}`);
  });

  await test("順番3: 最後の1本を当てると、めくっても決まらなくなる", async () => {
    await applyMigrations(mid, { from: "20260907110000" });

    const { uid, state } = await startOn(mid, "stage-after-split");
    const slot = state.slots[0];

    const after = await asRole(mid, { role: "authenticated", uid }, async (c) => {
      const r = await c.query(`select public.reveal_card($1, $2, 0) as s`, [
        state.session_id,
        slot.card_slot_key,
      ]);
      return r.rows[0].s;
    });

    const row = after.slots.find((x) => x.card_slot_key === slot.card_slot_key);
    assert(
      !row.candidates.some((c) => c.is_chosen),
      "最後の1本を当てても、めくった時点で決まってしまう",
    );
    assert(
      after.chosen_count === 0,
      `めくっただけなのに確定数が ${after.chosen_count}（0のはず）`,
    );
    assert(
      row.candidates.some((c) => c.revealed_at !== null),
      "めくった印が残っていない",
    );
  });
}

await main().catch((e) => {
  results.push({ name: "試験そのものが止まった", ok: false, message: e.message });
});

console.log("");
for (const r of results) {
  console.log(`  ${r.ok ? "○" : "✗"} ${r.name}`);
  if (!r.ok) console.log(`      ${r.message}`);
}

const failed = results.filter((r) => !r.ok);
console.log("");
console.log(
  `合計 ${results.length} 件 / 合格 ${results.length - failed.length} 件 / 不合格 ${failed.length} 件`,
);

// 文書に書いた件数と突き合わせられるように、実測を残す
recordCount("アップグレード試験", results.length);

process.exit(failed.length === 0 ? 0 : 1);
