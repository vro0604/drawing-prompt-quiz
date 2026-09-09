/**
 * run.mjs ／ 縦断試験（本番以外の実行可能な環境で回す）
 *
 * 実行: npm run test:db
 *
 * 【何を確かめるか】
 *   A. お題の組み立て   語数・モーフの最低と上限・カテゴリの重複
 *   B. 持ち出し         自動抽選の制限を上書きすること・出所が残ること
 *   C. ゲストの線       止めるものと、止めないもの
 *   D. 制作時間         更新前後・超過・猶予・二重更新・無制限
 *   E. フレーバー       正解漏洩の防止・ヒント使用別の集計・返歌
 *   F. 漏洩             回答していない人に正解が渡らないこと
 *   G. 回帰             旧方式のお題・既存の集計・既存の取得系
 *   W. 管理             通報の処理と作品の非表示（管理 v0）。権限・効き目・監査
 *   R. 持ち込み         既存絵から作るお題（art_first）。語の検査・出題・回答・
 *                       一覧・救済・ランキング・時間の扱い
 *   U. 形状アシスト     お題ではない発想補助（D191）。出題・正解・伝達率・
 *                       配給・回答者の画面へ1歩も漏れていないこと
 *   T. 回答の知らせ     作品に回答が来たことを作者へ伝える（D192）。表を
 *                       増やさず「最後に結果を開いた時刻」との差で出す。
 *                       件数と回答者を運んでいないことも数える
 *   S2. サブ指令        正式な語1つに添える制作の手がかり（D193）。
 *   S3. サブ指令の抽選  どの語に何を付けるかを決める、画面側の関数（D193）。
 *                       出題・正解・配給・回答者の画面へ1歩も漏れていないこと
 *
 * 【この試験が届かないところ】
 *   ・画面（HTML）の見た目と操作。ここは DB と RPC だけを通す
 *   ・Storage の実体（画像ファイル）。パスの規約だけを見る
 *   ・本番の環境変数・メール・外部サービス
 *   足りない範囲は最終報告に「未確認」として書く。
 */

import { installLocalOnlyGuard } from "../guard/no-production.mjs";
import { asRole, createTestDb, expectFailure } from "./harness.mjs";
import { recordCount } from "../counts.mjs";

// **最初のネットワーク要求より前に柵を立てる。**
// 本番のURL・project ref・ホスト名・鍵が環境にあれば、ここで異常終了する。
installLocalOnlyGuard("縦断試験（test:db）");
import {
  ANON,
  answerWork,
  asGuest,
  asMember,
  buildPromptWithTags,
  drawPrompt,
  finishDraft,
  rewindChallenge,
  startDraftOnly,
  makeGuest,
  makeMember,
  postWork,
  promptTags,
  saveCarrySlot,
  shiftDeadline,
  value,
  pickLegacyTag,
  pickTags,
  postArtFirstWork,
} from "./helpers.mjs";

const results = [];
let db;

async function test(group, name, fn) {
  try {
    await fn();
    results.push({ group, name, ok: true });
  } catch (e) {
    results.push({ group, name, ok: false, message: e.message ?? String(e) });
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** 実測値と期待値の差が許容の中にあるか。統計の検算に使う */
function assertNear(actual, expected, tolerance, label) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(
      `${label}: 実測 ${actual.toFixed(3)} / 期待 ${expected} ± ${tolerance}`,
    );
  }
}

/** カテゴリごとの語の数を数える */
function countByCategory(cards) {
  const m = new Map();
  for (const c of cards) m.set(c.category_key, (m.get(c.category_key) ?? 0) + 1);
  return m;
}

// ===========================================================================

async function main() {
  db = await createTestDb();

  const author = await makeMember(db, "author");
  const viewer = await makeMember(db, "viewer");
  const guest = await makeGuest(db);

  /* ---------------------------------------------------------------------
   * A. お題の組み立て（D158 / D159）
   * ------------------------------------------------------------------- */

  await test("A", "通常は3〜4語・モーフ1個以上", async () => {
    for (let i = 0; i < 20; i += 1) {
      const u = await makeMember(db, `norm-${i}`);
      const p = await drawPrompt(db, u, { mode: "normal" });
      const cards = await value(db, asMember(u), `select public.get_my_prompt($1)`, [
        p.prompt_id,
      ]);

      assert(
        cards.cards.length >= 3 && cards.cards.length <= 4,
        `通常の語数が ${cards.cards.length} 語（3〜4のはず）`,
      );

      const byCat = countByCategory(
        cards.cards.map((c) => ({ category_key: c.pool_key })),
      );
      const morphs = byCat.get("morph") ?? 0;
      assert(morphs >= 1, "モーフが0個のお題が出た（D158 違反）");
      assert(morphs <= 3, `通常でモーフが ${morphs} 個（上限3のはず）`);
    }
  });

  await test("A", "高難度は5〜6語・モーフ最大2個", async () => {
    for (let i = 0; i < 20; i += 1) {
      const u = await makeMember(db, `hard-${i}`);
      const p = await drawPrompt(db, u, { mode: "hard" });
      const cards = await value(db, asMember(u), `select public.get_my_prompt($1)`, [
        p.prompt_id,
      ]);

      assert(
        cards.cards.length >= 5 && cards.cards.length <= 6,
        `高難度の語数が ${cards.cards.length} 語（5〜6のはず）`,
      );

      const byCat = countByCategory(
        cards.cards.map((c) => ({ category_key: c.pool_key })),
      );
      const morphs = byCat.get("morph") ?? 0;
      assert(morphs >= 1, "モーフが0個のお題が出た（D158 違反）");
      assert(morphs <= 2, `高難度でモーフが ${morphs} 個（上限2のはず）`);
    }
  });

  await test("A", "暫定確率どおりに構成が出る（400回の検算）", async () => {
    // 構成の抽選だけを400回回す。カードは配らないので速い。
    const N = 400;
    const u = await makeMember(db, "stat-user");

    await db.query(
      `insert into public.draft_sessions
         (user_id, mode_key, candidate_count, max_rerolls)
       values ($1, 'normal', 5, 1)`,
      [u],
    );
    const { rows: s } = await db.query(
      `select id from public.draft_sessions where user_id = $1`,
      [u],
    );
    const sid = s[0].id;

    let words3 = 0;
    let morph1 = 0;
    let morph2 = 0;
    let morph3 = 0;
    let repeated = 0;

    for (let i = 1; i <= N; i += 1) {
      await db.query(`select public.draft_plan_slots($1, $2, 'normal')`, [sid, i]);
      const { rows } = await db.query(
        `select category_key from public.draft_session_slots
          where session_id = $1 and generation = $2`,
        [sid, i],
      );

      if (rows.length === 3) words3 += 1;

      const morphs = rows.filter((r) => r.category_key === "morph").length;
      if (morphs === 1) morph1 += 1;
      else if (morphs === 2) morph2 += 1;
      else if (morphs === 3) morph3 += 1;

      const states = rows.filter((r) => r.category_key !== "morph");
      if (new Set(states.map((r) => r.category_key)).size < states.length) repeated += 1;
    }

    // 期待値は draw_config の暫定初期値。**私が置いた値であって承認済みではない。**
    // ここで見ているのは「設定した値のとおりに引けているか」だけで、
    // 値そのものの良し悪しは見ていない。
    // 【許容の幅の決め方】
    //   400回引いたときの標準偏差は、確率0.5でおよそ 0.025。
    //   許容を 0.10（＝4標準偏差）にすると、正しく動いていても落ちる確率は
    //   1万回に1回未満になる。**狭くすると、直すところが無いのに赤くなる。**
    //   広すぎないかは、0.60 と 0.40 が区別できる幅かで見た（差 0.20 > 0.10）。
    //
    // 【2026-09-07 に直した（D170）】
    //   モーフ上限が2になり、確率も 0.60 / 0.40 へ配り直された。
    //   期待値を旧い 0.55 / 0.40 / 0.05 のままにしていたので、
    //   **正しく動いていても 50回に1回ほど落ちていた**（実測で1回観測）。
    //   モーフ3個は上限で塞がれたので、近さではなく **0件そのもの**を見る。
    assertNear(words3 / N, 0.5, 0.1, "通常で3語になる割合");
    assertNear(morph1 / N, 0.6, 0.1, "モーフ1個の割合");
    assertNear(morph2 / N, 0.4, 0.1, "モーフ2個の割合");
    assert(morph3 === 0, `モーフ3個が ${morph3} 回出た（上限2のはず）`);

    // 状態カテゴリの重複。通常は状態が1〜3個なので、重複が起きうる回数は少ない。
    // 「起きる」と「頻発しない」の2つを見る（D158）
    assert(repeated / N < 0.15, `カテゴリ重複が多すぎる（${repeated}/${N}）`);
  });

  await test("A", "同じ状態カテゴリが2回出る構成が作れる", async () => {
    const u = await makeMember(db, "rep-user");
    await db.query(
      `insert into public.draft_sessions
         (user_id, mode_key, candidate_count, max_rerolls)
       values ($1, 'hard', 5, 1)`,
      [u],
    );
    const { rows: s } = await db.query(
      `select id from public.draft_sessions where user_id = $1`,
      [u],
    );

    let seen = false;
    for (let i = 1; i <= 400 && !seen; i += 1) {
      await db.query(`select public.draft_plan_slots($1, $2, 'hard')`, [s[0].id, i]);
      const { rows } = await db.query(
        `select category_key, count(*) as n from public.draft_session_slots
          where session_id = $1 and generation = $2
            and category_key <> 'morph'
          group by category_key having count(*) > 1`,
        [s[0].id, i],
      );
      if (rows.length > 0) seen = true;
    }

    assert(seen, "400回引いても同じ状態カテゴリが2回出なかった（完全禁止になっている）");
  });

  await test("A", "枠の表示名が、モーフ同士の主従を示さない", async () => {
    // D158「複数のモーフに主対象・副対象の区別を設けない」。
    // 表示名に番号が入っていると、1番目が主だと読める。
    const { rows } = await db.query(
      `select card_slot_key, label from public.card_slots
        where card_slot_key like 'morph\\_%' order by card_slot_key`,
    );
    assert(rows.length === 3, `モーフの枠が ${rows.length} 個（3個のはず）`);
    for (const r of rows) {
      assert(
        r.label === "モーフ",
        `${r.card_slot_key} の表示名が「${r.label}」（順位を示さない「モーフ」のはず）`,
      );
    }
  });

  await test("A", "誤答に正解と同じ同義グループの語が並ばない", async () => {
    // 「膨張」と「肥大」は同じ同義グループ。正解が片方のとき、もう片方は誤答に出ない
    const u = await makeMember(db, "syn-user");
    const promptId = await buildPromptWithTags(db, u, ["傘", "膨張", "水中"]);

    const { rows } = await db.query(
      `select count(*)::int as n
         from public.quiz_choices qc
         join public.quiz_questions qq on qq.id = qc.question_id
         join public.tags t on t.id = qc.tag_id
        where qq.prompt_id = $1 and not qc.is_correct
          and t.synonym_group = 'swelling'`,
      [promptId],
    );
    assert(rows[0].n === 0, `同義グループの語が誤答に${rows[0].n}件混ざっている`);
  });

  /* ---------------------------------------------------------------------
   * B. 一部持ち出し（D161）
   * ------------------------------------------------------------------- */

  await test("B", "モーフ3個の持ち出しが通常の上限を上書きする", async () => {
    const u = await makeMember(db, "carry3m");
    const source = await buildPromptWithTags(db, u, ["傘", "蝶", "梟"]);

    const tagIds = (
      await db.query(`select tag_id from public.prompt_cards where prompt_id = $1`, [source])
    ).rows.map((r) => Number(r.tag_id));

    await value(db, asMember(u), `select public.save_prompt_elements('prompt', $1, $2)`, [
      source,
      tagIds,
    ]);

    const saved = (await value(db, asMember(u), `select public.list_saved_elements()`)).items;
    assert(saved.length === 3, `保存が ${saved.length} 件（3件のはず）`);

    const p = await drawPrompt(db, u, {
      mode: "normal",
      carried: saved.map((x) => x.id),
    });
    const detail = await value(db, asMember(u), `select public.get_my_prompt($1)`, [
      p.prompt_id,
    ]);

    const morphs = detail.cards.filter((c) => c.pool_key === "morph");
    assert(morphs.length === 3, `モーフが ${morphs.length} 個（持ち出した3個のはず）`);

    const labels = morphs.map((c) => c.tag_label).sort();
    assert(
      JSON.stringify(labels) === JSON.stringify(["傘", "蝶", "梟"].sort()),
      `持ち出した語が入っていない: ${labels.join(",")}`,
    );
  });

  await test("B", "状態3個の持ち出しにモーフが足されて4語以上になる", async () => {
    const u = await makeMember(db, "carry3s");
    const source = await buildPromptWithTags(db, u, ["傘", "怒り", "水中", "重い"]);

    const stateIds = (
      await db.query(
        `select pc.tag_id from public.prompt_cards pc
           join public.tags t on t.id = pc.tag_id
          where pc.prompt_id = $1 and t.pool_key <> 'morph'`,
        [source],
      )
    ).rows.map((r) => Number(r.tag_id));

    await value(db, asMember(u), `select public.save_prompt_elements('prompt', $1, $2)`, [
      source,
      stateIds,
    ]);
    const saved = (await value(db, asMember(u), `select public.list_saved_elements()`)).items;

    const p = await drawPrompt(db, u, {
      mode: "normal",
      carried: saved.map((x) => x.id),
    });
    const detail = await value(db, asMember(u), `select public.get_my_prompt($1)`, [
      p.prompt_id,
    ]);

    assert(detail.cards.length >= 4, `語数が ${detail.cards.length}（4語以上のはず）`);
    const morphs = detail.cards.filter((c) => c.pool_key === "morph");
    assert(morphs.length >= 1, "モーフが足されていない（D158 違反）");
  });

  await test("B", "他者作品からの持ち出しで元作品と元お題が残る", async () => {
    const p = await drawPrompt(db, author);
    const workId = await postWork(db, author, p.prompt_id, "派生元");
    await answerWork(db, viewer, workId);

    const revealed = await value(db, asMember(viewer), `select public.get_answered_prompt($1)`, [
      workId,
    ]);
    const tagId = revealed.cards[0].tag_id;

    await value(db, asMember(viewer), `select public.save_prompt_elements('work', $1, $2)`, [
      workId,
      [tagId],
    ]);

    const saved = (await value(db, asMember(viewer), `select public.list_saved_elements()`)).items;
    const picked = saved.find((x) => x.tag_id === tagId);
    assert(picked, "保存した要素が一覧に出ない");
    assert(picked.has_source_work === true, "元作品が記録されていない");

    const derived = await drawPrompt(db, viewer, { carried: [picked.id] });

    const { rows } = await db.query(
      `select source_prompt_id, source_work_id
         from public.prompt_element_origins where prompt_id = $1`,
      [derived.prompt_id],
    );
    assert(rows.length === 1, `派生の記録が ${rows.length} 件（1件のはず）`);
    assert(rows[0].source_work_id === workId, "元作品IDが違う");
    assert(rows[0].source_prompt_id !== null, "元お題IDが残っていない");

    const origin = await db.query(`select origin from public.prompts where id = $1`, [
      derived.prompt_id,
    ]);
    assert(origin.rows[0].origin === "saved", "持ち出しから作ったお題の印が付いていない");
  });

  await test("B", "派生したお題から、さらに持ち出せる", async () => {
    const u = await makeMember(db, "chain");
    const first = await buildPromptWithTags(db, u, ["傘", "怒り", "水中"]);
    const firstTag = Number(
      (
        await db.query(`select tag_id from public.prompt_cards where prompt_id = $1 limit 1`, [
          first,
        ])
      ).rows[0].tag_id,
    );

    await value(db, asMember(u), `select public.save_prompt_elements('prompt', $1, $2)`, [
      first,
      [firstTag],
    ]);
    let saved = (await value(db, asMember(u), `select public.list_saved_elements()`)).items;
    const second = await drawPrompt(db, u, { carried: [saved[0].id] });

    // 派生したお題から、また別の語を持ち出す
    const secondTag = Number(
      (
        await db.query(
          `select tag_id from public.prompt_cards
            where prompt_id = $1 and tag_id <> $2 limit 1`,
          [second.prompt_id, firstTag],
        )
      ).rows[0].tag_id,
    );

    await value(db, asMember(u), `select public.save_prompt_elements('prompt', $1, $2)`, [
      second.prompt_id,
      [secondTag],
    ]);
    saved = (await value(db, asMember(u), `select public.list_saved_elements()`)).items;
    assert(saved.length === 2, `手持ちが ${saved.length} 件（2件のはず）`);
  });

  await test("B", "自分のお題からの保存は5保存枠まで（上限に達したら保存しない）", async () => {
    const u = await makeMember(db, "cap-self");
    const limit = Number(
      (await db.query(`select value from public.carry_policy where policy_key='self_max'`))
        .rows[0].value,
    );
    const unit = (
      await db.query(`select unit from public.carry_policy where policy_key='self_max'`)
    ).rows[0].unit;
    assert(unit === "slot", `上限の単位が ${unit}（slot のはず）`);

    // **1回の保存操作が1つの保存枠になる。**要素の個数では数えない
    const labels = [
      ["傘", "蝶", "梟"],
      ["灯台", "三日月", "歯車"],
      ["風船", "花束"],
      ["古書"],
      ["万年筆", "砂時計", "折り鶴"],
      ["観覧車"],
    ];

    const idsOf = async (promptId) =>
      (await db.query(`select tag_id from public.prompt_cards where prompt_id = $1`, [promptId]))
        .rows.map((r) => Number(r.tag_id));

    for (let i = 0; i < 5; i += 1) {
      const src = await buildPromptWithTags(db, u, labels[i]);
      await value(db, asMember(u), `select public.save_prompt_elements('prompt', $1, $2, true)`, [
        src,
        await idsOf(src),
      ]);
    }

    const full = await value(db, asMember(u), `select public.list_saved_elements()`);
    assert(full.counts.self === 5, `保存枠が ${full.counts.self} 枠（5枠のはず）`);
    assert(full.limits.self === limit, "上限の値が一覧に出ていない");
    assert(full.limit_unit === "slot", "上限の単位が一覧に出ていない");
    // 要素は 3+3+2+1+3 = 12 個。**要素数で上限を判定していたら、とっくに超えている**
    assert(
      full.element_counts.self === 12,
      `要素が ${full.element_counts.self} 個（12個のはず）`,
    );

    const sixth = await buildPromptWithTags(db, u, labels[5]);
    const sixthIds = await idsOf(sixth);
    await expectFailure(
      () =>
        value(db, asMember(u), `select public.save_prompt_elements('prompt', $1, $2, true)`, [
          sixth,
          sixthIds,
        ]),
      "CARRY_LIMIT_REACHED",
    );

    const after = await value(db, asMember(u), `select public.list_saved_elements()`);
    assert(after.counts.self === 5, `上限を超える保存で枠が ${after.counts.self} になった`);
  });

  await test("B", "他者のお題からの保存は3個まで、自分の分とは別に数える", async () => {
    const u = await makeMember(db, "cap-others");

    // 他者の作品3件に回答して、1語ずつ持ち出す
    const picked = [];
    for (let i = 0; i < 4; i += 1) {
      const p = await drawPrompt(db, author);
      const w = await postWork(db, author, p.prompt_id, `上限用${i}`);
      await answerWork(db, u, w);
      const revealed = await value(db, asMember(u), `select public.get_answered_prompt($1)`, [w]);
      const tag = revealed.cards.find((c) => !picked.includes(Number(c.tag_id)));
      if (!tag) continue;
      picked.push(Number(tag.tag_id));

      if (picked.length <= 3) {
        await value(
          db,
          asMember(u),
          `select public.save_prompt_elements('work', $1, $2, true)`,
          [w, [Number(tag.tag_id)]],
        );
      } else {
        await expectFailure(
          () =>
            value(db, asMember(u), `select public.save_prompt_elements('work', $1, $2, true)`, [
              w,
              [Number(tag.tag_id)],
            ]),
          "CARRY_LIMIT_REACHED",
        );
      }
    }

    const saved = await value(db, asMember(u), `select public.list_saved_elements()`);
    assert(saved.counts.others === 3, `他者からの保存が ${saved.counts.others} 件（3件のはず）`);
    assert(saved.counts.self === 0, "自分の分に混ざって数えられている");
  });

  await test("B", "保存枠を捨てれば、また保存できる（破棄は利用者が行う）", async () => {
    const u = await makeMember(db, "cap-discard");
    const idsOf = async (promptId) =>
      (await db.query(`select tag_id from public.prompt_cards where prompt_id = $1`, [promptId]))
        .rows.map((r) => Number(r.tag_id));

    const sets = [["傘", "蝶"], ["灯台"], ["三日月"], ["歯車"], ["風船"], ["花束"]];
    let saved = null;
    for (let i = 0; i < 5; i += 1) {
      const src = await buildPromptWithTags(db, u, sets[i]);
      saved = await value(
        db,
        asMember(u),
        `select public.save_prompt_elements('prompt', $1, $2, true)`,
        [src, await idsOf(src)],
      );
    }
    assert(saved.counts.self === 5, `5枠にならなかった（${saved.counts.self}）`);

    // **枠の中の要素を1つ捨てても、枠が残る限り空きは増えない**
    const twoElementSlot = saved.slots.find((x) => x.element_count === 2);
    assert(twoElementSlot, "2要素の枠が見つからない");
    const partial = await value(db, asMember(u), `select public.delete_saved_element($1)`, [
      twoElementSlot.elements[0].id,
    ]);
    assert(
      partial.counts.self === 5,
      `要素を1つ捨てただけで枠が ${partial.counts.self} に減った`,
    );

    const sixth = await buildPromptWithTags(db, u, sets[5]);
    const sixthIds = await idsOf(sixth);
    await expectFailure(
      () =>
        value(db, asMember(u), `select public.save_prompt_elements('prompt', $1, $2, true)`, [
          sixth,
          sixthIds,
        ]),
      "CARRY_LIMIT_REACHED",
    );

    // 枠ごと捨てると空きができる
    await value(db, asMember(u), `select public.delete_saved_carry_slot($1)`, [
      partial.slots[0].id,
    ]);

    const after = await value(
      db,
      asMember(u),
      `select public.save_prompt_elements('prompt', $1, $2, true)`,
      [sixth, sixthIds],
    );
    assert(after.counts.self === 5, `捨てたあとの枠が ${after.counts.self}（5枠のはず）`);
  });

  await test("B", "セッション内の持ち出しは、期限を過ぎると使えず掃除で消える", async () => {
    const u = await makeMember(db, "session-ttl");
    const src = await buildPromptWithTags(db, u, ["傘", "怒り", "水中"]);
    const tagIds = (
      await db.query(`select tag_id from public.prompt_cards where prompt_id = $1 limit 1`, [src])
    ).rows.map((r) => Number(r.tag_id));

    const saved = await value(
      db,
      asMember(u),
      `select public.save_prompt_elements('prompt', $1, $2, false)`,
      [src, tagIds],
    );
    const id = saved.items[0].id;

    // 期限を過ぎさせる
    await db.query(
      `update public.saved_carry_slots set expires_at = clock_timestamp() - interval '1 hour'
        where id = (select carry_slot_id from public.saved_elements where id = $1)`,
      [id],
    );

    const listed = await value(db, asMember(u), `select public.list_saved_elements()`);
    assert(listed.counts.session === 0, "期限切れのセッション持ち出しが一覧に残っている");

    await expectFailure(
      () => value(db, asMember(u), `select public.start_draft('normal', 3600, $1)`, [[id]]),
      "ELEMENT_NOT_FOUND",
    );

    const removed = await value(
      db,
      { role: "service_role", uid: null },
      `select public.cleanup_expired_session_carry(1000)`,
    );
    assert(Number(removed) >= 1, "掃除が期限切れの持ち出しを消さなかった");
  });

  await test("B", "登録したあと、セッション内の持ち出しを永続へ移せる", async () => {
    const u = await makeMember(db, "promote");
    const src = await buildPromptWithTags(db, u, ["傘", "怒り", "水中"]);
    const tagIds = (
      await db.query(`select tag_id from public.prompt_cards where prompt_id = $1 limit 2`, [src])
    ).rows.map((r) => Number(r.tag_id));

    await value(db, asMember(u), `select public.save_prompt_elements('prompt', $1, $2, false)`, [
      src,
      tagIds,
    ]);

    const moved = await value(db, asMember(u), `select public.promote_session_carry(null)`);
    assert(moved.counts.session === 0, "セッション内の枠が残っている");
    assert(moved.counts.self === 1, `自分の枠が ${moved.counts.self} 枠（1枠のはず）`);
    assert(
      moved.element_counts.self === 2,
      `枠の中の要素が ${moved.element_counts.self} 個（2個のはず）`,
    );
    assert(
      moved.items.every((x) => x.expires_at === null),
      "永続へ移したのに期限が残っている",
    );
  });

  await test("B", "4個以上は持ち出せない", async () => {
    const u = await makeMember(db, "carry4");
    const source = await buildPromptWithTags(db, u, ["傘", "蝶", "梟", "怒り"]);
    const tagIds = (
      await db.query(`select tag_id from public.prompt_cards where prompt_id = $1`, [source])
    ).rows.map((r) => Number(r.tag_id));

    await expectFailure(
      () =>
        value(db, asMember(u), `select public.save_prompt_elements('prompt', $1, $2)`, [
          source,
          tagIds,
        ]),
      "BAD_ELEMENT_COUNT",
    );
  });

  await test("B", "回答していない作品からは持ち出せない", async () => {
    const p = await drawPrompt(db, author);
    const workId = await postWork(db, author, p.prompt_id, "未回答の作品");

    const stranger = await makeMember(db, "stranger");
    const tagId = Number(
      (
        await db.query(`select tag_id from public.prompt_cards where prompt_id = $1 limit 1`, [
          p.prompt_id,
        ])
      ).rows[0].tag_id,
    );

    await expectFailure(
      () =>
        value(db, asMember(stranger), `select public.save_prompt_elements('work', $1, $2)`, [
          workId,
          [tagId],
        ]),
      "SOURCE_NOT_AVAILABLE",
    );
  });

  /* ---------------------------------------------------------------------
   * C. ゲストの線（D164）
   * ------------------------------------------------------------------- */

  await test("C", "ゲストは通常のクイズに回答できる", async () => {
    const p = await drawPrompt(db, author);
    const workId = await postWork(db, author, p.prompt_id, "ゲスト回答用");

    const cards = await value(db, asMember(author), `select public.get_my_prompt($1)`, [
      p.prompt_id,
    ]);
    const answer = await answerWork(db, guest, workId, { guest: true });
    // **お題の全語が出題される（D165）。3で固定しない**
    assert(
      answer.items.length === cards.cards.length,
      `回答項目が ${answer.items.length} 件（お題の語数 ${cards.cards.length} と同じはず）`,
    );
    assert(
      answer.question_count === cards.cards.length,
      `question_count が ${answer.question_count}（${cards.cards.length} のはず）`,
    );
  });

  await test("C", "ゲストはセッション内の持ち出しだけできる（永続保存はできない）", async () => {
    const p = await drawPrompt(db, author);
    const workId = await postWork(db, author, p.prompt_id, "ゲスト持ち出し用");
    const g = await makeGuest(db);
    await answerWork(db, g, workId, { guest: true });

    const tagId = Number(
      (
        await db.query(`select tag_id from public.prompt_cards where prompt_id = $1 limit 1`, [
          p.prompt_id,
        ])
      ).rows[0].tag_id,
    );

    // 永続を望んで送っても、ゲストの保存はセッション内へ落ちる
    const saved = await value(
      db,
      asGuest(g),
      `select public.save_prompt_elements('work', $1, $2, true)`,
      [workId, [tagId]],
    );

    assert(saved.items.length === 1, `保存が ${saved.items.length} 件（1件のはず）`);
    assert(saved.items[0].scope === "session", `区分が ${saved.items[0].scope}（session のはず）`);
    assert(saved.items[0].expires_at !== null, "セッション内の持ち出しに期限が入っていない");
    assert(saved.can_persist === false, "ゲストに永続保存ができると出ている");
    assert(saved.counts.self === 0 && saved.counts.others === 0, "ゲストの永続保存が作られた");

    // 永続へ移すのは登録者だけ
    await expectFailure(
      () => value(db, asGuest(g), `select public.promote_session_carry(null)`),
      "GUEST_CANNOT_PERSIST",
    );
  });

  await test("C", "ゲストはセッション内の持ち出しでお題を引ける", async () => {
    const p = await drawPrompt(db, author);
    const workId = await postWork(db, author, p.prompt_id, "ゲスト持ち込み用");
    const g = await makeGuest(db);
    await answerWork(db, g, workId, { guest: true });

    const tagId = Number(
      (
        await db.query(
          `select pc.tag_id from public.prompt_cards pc
             join public.tags t on t.id = pc.tag_id
            where pc.prompt_id = $1 and t.pool_key = 'morph' limit 1`,
          [p.prompt_id],
        )
      ).rows[0].tag_id,
    );

    const saved = await value(
      db,
      asGuest(g),
      `select public.save_prompt_elements('work', $1, $2, false)`,
      [workId, [tagId]],
    );

    const drawn = await asRole(db, asGuest(g), async (c) => {
      const start = await c.query(`select public.start_draft('normal', 3600, $1) as s`, [
        [saved.items[0].id],
      ]);
      let state = start.rows[0].s;
      for (const slot of state.slots) {
        if (slot.candidates.some((x) => x.is_chosen)) continue;
        const r = await c.query(`select public.choose_card($1, $2, 0) as s
           from (select public.reveal_card($1, $2, 0)) as r`, [
          state.session_id,
          slot.card_slot_key,
        ]);
        state = r.rows[0].s;
      }
      const done = await c.query(`select public.complete_draft($1) as s`, [state.session_id]);
      return done.rows[0].s;
    });

    const detail = await value(db, asGuest(g), `select public.get_my_prompt($1)`, [
      drawn.prompt_id,
    ]);
    assert(
      detail.cards.some((c) => Number(c.tag_id) === tagId),
      "ゲストが持ち込んだ語がお題に入っていない",
    );

    // 流れが終わったので、セッション内の持ち出しは残らない
    const after = await value(db, asGuest(g), `select public.list_saved_elements()`);
    assert(
      after.counts.session === 0,
      `お題を確定したのにセッション内の持ち出しが ${after.counts.session} 件残っている`,
    );
  });

  await test("C", "ゲストはフレーバーを作れない・開けない・返歌できない", async () => {
    const p = await drawPrompt(db, author);
    const workId = await postWork(db, author, p.prompt_id, "ゲストのフレーバー用");
    const g = await makeGuest(db);
    await answerWork(db, g, workId, { guest: true });

    await expectFailure(
      () =>
        value(db, asGuest(g), `select public.set_flavor_text($1, array[1]::bigint[])`, [workId]),
      "GUEST_CANNOT_FLAVOR",
    );
    await expectFailure(
      () => value(db, asGuest(g), `select public.open_flavor_hint($1)`, [workId]),
      "GUEST_CANNOT_FLAVOR",
    );
    await expectFailure(
      () => value(db, asGuest(g), `select public.post_flavor_reply($1, '[]'::jsonb)`, [workId]),
      "GUEST_CANNOT_FLAVOR",
    );

    const flavor = await value(db, asGuest(g), `select public.get_work_flavor($1)`, [workId]);
    assert(flavor === null, "ゲストにフレーバーが返っている");
  });

  await test("C", "未サインインはフレーバーと持ち出しのRPCを実行できない", async () => {
    for (const call of [
      `select public.get_work_flavor('00000000-0000-0000-0000-000000000000')`,
      `select public.open_flavor_hint('00000000-0000-0000-0000-000000000000')`,
      `select public.save_prompt_elements('prompt','00000000-0000-0000-0000-000000000000',array[1]::bigint[])`,
      `select public.get_answered_prompt('00000000-0000-0000-0000-000000000000')`,
      `select public.list_saved_elements()`,
    ]) {
      await expectFailure(() => value(db, ANON, call), "permission denied");
    }
  });

  /* ---------------------------------------------------------------------
   * D. 制作時間（D163）
   * ------------------------------------------------------------------- */

  await test("D", "初期の期限は挑戦の開始時刻＋T", async () => {
    const u = await makeMember(db, "time-one");
    const p = await drawPrompt(db, u, { timeLimit: 3600 });
    const t = await value(db, asMember(u), `select public.get_prompt_timer($1)`, [p.prompt_id]);

    assert(t.has_deadline === true, "期限が入っていない");
    assert(t.seconds_left > 3500 && t.seconds_left <= 3600, `残り ${t.seconds_left} 秒`);
    assert(t.can_renew === false, "始めた直後から更新できてしまう");
  });

  await test("D", "残りが 0.25T になるまで更新できない", async () => {
    const u = await makeMember(db, "time-two");
    const p = await drawPrompt(db, u, { timeLimit: 3600 });

    await expectFailure(
      () => value(db, asMember(u), `select public.renew_prompt_deadline($1)`, [p.prompt_id]),
      "RENEW_TOO_EARLY",
    );

    // 残り 14分（0.25T = 15分 より少ない）へ進める
    await shiftDeadline(db, p.prompt_id, 3600 - 840);
    const t = await value(db, asMember(u), `select public.get_prompt_timer($1)`, [p.prompt_id]);
    assert(t.can_renew === true, "0.25T を切っても更新できない");
  });

  await test("D", "更新すると 更新時刻＋0.75T になり、残りは繰り越さない", async () => {
    const u = await makeMember(db, "time-three");
    const p = await drawPrompt(db, u, { timeLimit: 3600 });
    await shiftDeadline(db, p.prompt_id, 3600 - 840); // 残り14分

    const after = await value(db, asMember(u), `select public.renew_prompt_deadline($1)`, [
      p.prompt_id,
    ]);

    // 0.75 × 3600 = 2700秒。残っていた 840秒は足されない
    assert(
      after.seconds_left > 2600 && after.seconds_left <= 2700,
      `更新後の残りが ${after.seconds_left} 秒（2700秒前後のはず。繰り越していないか）`,
    );
    assert(after.renew_count === 1, "更新回数が増えていない");
  });

  await test("D", "続けて2回押しても2回ぶん増えない", async () => {
    const u = await makeMember(db, "time-four");
    const p = await drawPrompt(db, u, { timeLimit: 3600 });
    await shiftDeadline(db, p.prompt_id, 3600 - 840);

    await value(db, asMember(u), `select public.renew_prompt_deadline($1)`, [p.prompt_id]);
    await expectFailure(
      () => value(db, asMember(u), `select public.renew_prompt_deadline($1)`, [p.prompt_id]),
      "RENEW_TOO_EARLY",
    );

    const t = await value(db, asMember(u), `select public.get_prompt_timer($1)`, [p.prompt_id]);
    assert(t.renew_count === 1, `更新回数が ${t.renew_count}（1のはず）`);
  });

  await test("D", "0秒を過ぎても猶予の中なら投稿できる", async () => {
    const u = await makeMember(db, "time-five");
    const p = await drawPrompt(db, u, { timeLimit: 3600 });
    // 期限を1000秒過ぎた状態。猶予は 0.5T = 1800秒あるのでまだ中
    await shiftDeadline(db, p.prompt_id, 4600);

    const t = await value(db, asMember(u), `select public.get_prompt_timer($1)`, [p.prompt_id]);
    assert(t.seconds_left < 0, "超過になっていない");
    assert(t.overrun_seconds > 0, "超過時間が数えられていない");
    assert(t.is_expired === false, "猶予の中なのに終了扱いになっている");
    assert(t.can_renew === true, "猶予の中で更新できない");

    const workId = await postWork(db, u, p.prompt_id, "猶予中の投稿");
    assert(workId, "猶予の中で投稿できなかった");
  });

  await test("D", "猶予を使い切ると投稿できず、挑戦が失敗になる", async () => {
    const u = await makeMember(db, "time-six");
    const p = await drawPrompt(db, u, { timeLimit: 3600 });
    // 期限を 1801秒 過ぎた状態（猶予 1800秒 を超える）
    await shiftDeadline(db, p.prompt_id, 3600 + 1801);

    const before = await db.query(`select count(*)::int as n from public.works`);

    await expectFailure(
      () => postWork(db, u, p.prompt_id, "猶予切れの投稿"),
      "PROMPT_EXPIRED",
    );

    const after = await db.query(`select count(*)::int as n from public.works`);
    assert(after.rows[0].n === before.rows[0].n, "失敗したのに作品の行が増えている");

    // 投稿を断ったトランザクションは丸ごと巻き戻るので、
    // 断った瞬間に status までは書き換わらない。**書き換わったことにしない。**
    // 終了として扱われているかは、その場で計算する is_expired で見る。
    const t = await value(db, asMember(u), `select public.get_prompt_timer($1)`, [p.prompt_id]);
    assert(t.is_expired === true, "猶予を過ぎたのに終了扱いになっていない");
    assert(t.can_renew === false, "猶予を過ぎたのに更新できる");

    // status が 'failed' になるのは掃除が回ったあと
    const n = await value(
      db,
      { role: "service_role", uid: null },
      `select public.expire_overdue_prompts(500)`,
    );
    assert(n >= 1, "掃除が猶予切れのお題を拾わなかった");

    const status = await db.query(`select status, failed_at from public.prompts where id = $1`, [
      p.prompt_id,
    ]);
    assert(status.rows[0].status === "failed", "掃除のあとも失敗になっていない");
    assert(status.rows[0].failed_at !== null, "失敗した時刻が残っていない");

    // 失敗しても作品データには触れない（D163）
    const after2 = await db.query(`select count(*)::int as n from public.works`);
    assert(after2.rows[0].n === before.rows[0].n, "失敗の処理で作品の行が動いている");
  });

  await test("D", "猶予を使い切ったあとは更新できない", async () => {
    const u = await makeMember(db, "time-seven");
    const p = await drawPrompt(db, u, { timeLimit: 3600 });
    await shiftDeadline(db, p.prompt_id, 3600 + 1801);

    await expectFailure(
      () => value(db, asMember(u), `select public.renew_prompt_deadline($1)`, [p.prompt_id]),
      "RENEW_TOO_LATE",
    );
  });

  await test("D", "掃除が猶予切れのお題を失敗にする", async () => {
    const u = await makeMember(db, "time-eight");
    const p = await drawPrompt(db, u, { timeLimit: 3600 });
    await shiftDeadline(db, p.prompt_id, 3600 + 1801);

    const n = await value(db, { role: "service_role", uid: null }, `select public.expire_overdue_prompts(500)`);
    assert(n >= 1, `掃除が ${n} 件（1件以上のはず）`);

    const status = await db.query(`select status from public.prompts where id = $1`, [
      p.prompt_id,
    ]);
    assert(status.rows[0].status === "failed", "掃除で失敗にならなかった");
  });

  await test("D", "無制限には期限も更新も失敗も無い", async () => {
    const u = await makeMember(db, "time-nine");
    const p = await drawPrompt(db, u, { timeLimit: null });

    const t = await value(db, asMember(u), `select public.get_prompt_timer($1)`, [p.prompt_id]);
    assert(t.is_unlimited === true, "無制限として扱われていない");
    assert(t.has_deadline === false, "無制限に期限が入っている");
    assert(t.can_renew === false, "無制限で更新できてしまう");

    await expectFailure(
      () => value(db, asMember(u), `select public.renew_prompt_deadline($1)`, [p.prompt_id]),
      "UNLIMITED_NO_RENEW",
    );

    // 掃除の対象にもならない
    const before = await db.query(`select status from public.prompts where id = $1`, [
      p.prompt_id,
    ]);
    await value(db, { role: "service_role", uid: null }, `select public.expire_overdue_prompts(500)`);
    const after = await db.query(`select status from public.prompts where id = $1`, [
      p.prompt_id,
    ]);
    assert(
      before.rows[0].status === after.rows[0].status,
      "無制限のお題が掃除で状態を変えられた",
    );

    const workId = await postWork(db, u, p.prompt_id, "無制限の投稿");
    assert(workId, "無制限で投稿できなかった");
  });

  await test("D", "更新の回数に上限が無い（何度でも延ばせる）", async () => {
    // D163 は「更新回数は無制限」と決めている。**回数で止まらないこと**を見る。
    const u = await makeMember(db, "time-many");
    const p = await drawPrompt(db, u, { timeLimit: 3600 });

    for (let i = 1; i <= 5; i += 1) {
      // 残りを 0.25T 未満（14分）にしてから押す
      const t = await value(db, asMember(u), `select public.get_prompt_timer($1)`, [
        p.prompt_id,
      ]);
      await shiftDeadline(db, p.prompt_id, t.seconds_left - 840);

      const after = await value(db, asMember(u), `select public.renew_prompt_deadline($1)`, [
        p.prompt_id,
      ]);
      assert(after.renew_count === i, `${i}回目の更新で回数が ${after.renew_count}`);
      assert(
        after.seconds_left > 2600 && after.seconds_left <= 2700,
        `${i}回目の残りが ${after.seconds_left} 秒（毎回 0.75T のはず）`,
      );
    }
  });

  await test("D", "最終猶予の中でも延ばせる（超過してからでも間に合う）", async () => {
    const u = await makeMember(db, "time-grace-renew");
    const p = await drawPrompt(db, u, { timeLimit: 3600 });
    // 期限を1000秒過ぎた状態。猶予 1800秒 の中
    await shiftDeadline(db, p.prompt_id, 4600);

    const before = await value(db, asMember(u), `select public.get_prompt_timer($1)`, [
      p.prompt_id,
    ]);
    assert(before.seconds_left < 0 && before.is_expired === false, "猶予の中になっていない");

    const after = await value(db, asMember(u), `select public.renew_prompt_deadline($1)`, [
      p.prompt_id,
    ]);
    assert(after.renew_count === 1, "猶予の中で更新回数が増えていない");
    assert(
      after.seconds_left > 2600 && after.seconds_left <= 2700,
      `猶予中の更新後が ${after.seconds_left} 秒（0.75T のはず）`,
    );
    assert(after.is_expired === false, "更新したのに終了扱いのまま");

    // **総経過は減らない。**超過していた分も含めて数え続ける
    assert(
      after.elapsed_seconds >= before.elapsed_seconds,
      `総経過が ${before.elapsed_seconds} → ${after.elapsed_seconds} に減った`,
    );
  });

  await test("D", "挑戦に失敗しても、制作物も履歴も消えず、次のお題を引ける", async () => {
    const u = await makeMember(db, "time-after-fail");

    // 先に1件投稿しておく。**罰として消されないこと**を見るため
    const kept = await drawPrompt(db, u, { timeLimit: 3600 });
    const keptWork = await postWork(db, u, kept.prompt_id, "失敗前に投稿した作品");

    const p = await drawPrompt(db, u, { timeLimit: 3600 });
    await shiftDeadline(db, p.prompt_id, 3600 + 1801);
    await value(
      db,
      { role: "service_role", uid: null },
      `select public.expire_overdue_prompts(500)`,
    );

    const status = await db.query(`select status from public.prompts where id = $1`, [
      p.prompt_id,
    ]);
    assert(status.rows[0].status === "failed", "失敗になっていない");

    // 失敗したお題の行も、候補も履歴も残っている
    const stillThere = await db.query(
      `select count(*)::int as n from public.prompt_cards where prompt_id = $1`,
      [p.prompt_id],
    );
    assert(stillThere.rows[0].n > 0, "失敗したお題のカードが消えている");

    // 投稿済みの作品は無傷
    const work = await db.query(
      `select deleted_at, is_published from public.works where id = $1`,
      [keptWork],
    );
    assert(work.rows[0].deleted_at === null, "失敗の罰として作品が削除された");

    // そして新しいお題を引ける
    const next = await drawPrompt(db, u, { timeLimit: 3600 });
    assert(next.prompt_id !== p.prompt_id, "失敗したあと新しいお題を引けない");
  });

  await test("D", "読み直しても時計は進んだまま（画面に依存しない）", async () => {
    const u = await makeMember(db, "time-ten");
    const p = await drawPrompt(db, u, { timeLimit: 600 });

    const first = await value(db, asMember(u), `select public.get_prompt_timer($1)`, [
      p.prompt_id,
    ]);
    await shiftDeadline(db, p.prompt_id, 120);
    const second = await value(db, asMember(u), `select public.get_prompt_timer($1)`, [
      p.prompt_id,
    ]);

    assert(
      second.seconds_left < first.seconds_left,
      "読み直しても残り時間が減っていない（サーバー側で進んでいない）",
    );
  });

  /* ---------------------------------------------------------------------
   * H. 挑戦の時計（2026-09-05。ドラフト開始から一本で通す）
   * ------------------------------------------------------------------- */

  await test("H", "時計はドラフトを始めた瞬間から動く", async () => {
    const u = await makeMember(db, "clock-start");
    const state = await startDraftOnly(db, u, { timeLimit: 3600 });

    const ch = await value(db, asMember(u), `select public.get_active_challenge()`);
    assert(ch !== null, "始めた直後に挑戦が読めない");
    assert(ch.kind === "draft", `区分が ${ch.kind}（draft のはず）`);
    assert(ch.href === "/play", "戻り先が /play になっていない");
    assert(ch.has_deadline === true, "ドラフト中に期限が入っていない");
    assert(ch.seconds_left > 3500, `ドラフト開始直後の残りが ${ch.seconds_left} 秒`);
    assert(ch.elapsed_seconds >= 0 && ch.elapsed_seconds < 60, "経過時間が動いていない");
    assert(ch.session_id === undefined, "セッションIDが帯へ漏れている");
    assert(JSON.stringify(ch).includes("tag_label") === false, "お題の語が帯へ漏れている");
    assert(state.session_id, "ドラフトが始まっていない");
  });

  await test("H", "カードをめくっていた時間は、確定しても消えない", async () => {
    const u = await makeMember(db, "clock-carry");
    const state = await startDraftOnly(db, u, { timeLimit: 3600 });

    // 20分ぶんカードを眺めた
    await rewindChallenge(db, { sessionId: state.session_id }, 1200);

    const beforeDone = await value(db, asMember(u), `select public.get_active_challenge()`);
    assert(beforeDone.elapsed_seconds >= 1200, "ドラフト中の経過が数えられていない");

    const done = await finishDraft(db, u, state.session_id);
    const t = await value(db, asMember(u), `select public.get_prompt_timer($1)`, [done.prompt_id]);

    assert(
      t.elapsed_seconds >= 1200,
      `確定したら経過が ${t.elapsed_seconds} 秒に戻った（1200秒以上のはず）`,
    );
    assert(
      t.seconds_left <= 3600 - 1200 + 5,
      `確定で残り時間が ${t.seconds_left} 秒へ増えた（時計が取り直されている）`,
    );

    const started = await db.query(
      `select p.started_at = ds.started_at as same
         from public.prompts p join public.draft_sessions ds on ds.id = p.draft_session_id
        where p.id = $1`,
      [done.prompt_id],
    );
    assert(started.rows[0].same === true, "開始時刻が引き継がれていない");
  });

  await test("H", "開始時刻は書き換えられない（時計のリセットができない）", async () => {
    const u = await makeMember(db, "clock-immutable");
    const p = await drawPrompt(db, u, { timeLimit: 600 });

    let message = null;
    try {
      await db.query(
        `update public.prompts set started_at = clock_timestamp() where id = $1`,
        [p.prompt_id],
      );
    } catch (e) {
      message = e.message;
    }
    assert(message !== null, "開始時刻を書き換えられてしまった");
    assert(
      message.includes("STARTED_AT_IMMUTABLE"),
      `止まった理由が違う: ${message}`,
    );
  });

  await test("H", "ドラフト中でも更新でき、総経過は減らない", async () => {
    const u = await makeMember(db, "clock-renew");
    const state = await startDraftOnly(db, u, { timeLimit: 3600 });

    await expectFailure(
      () => value(db, asMember(u), `select public.renew_draft_deadline($1)`, [state.session_id]),
      "RENEW_TOO_EARLY",
    );

    // 残り10分（0.25T = 15分 を切っている）まで進める
    await rewindChallenge(db, { sessionId: state.session_id }, 3000);

    const before = await value(db, asMember(u), `select public.get_active_challenge()`);
    assert(before.can_renew === true, "0.25T を切ってもドラフト中に更新できない");

    const after = await value(db, asMember(u), `select public.renew_current_challenge()`);
    assert(
      after.seconds_left > 2600 && after.seconds_left <= 2700,
      `更新後の残りが ${after.seconds_left} 秒（0.75T = 2700秒のはず）`,
    );
    assert(
      after.elapsed_seconds >= before.elapsed_seconds,
      "更新で総経過時間が減った",
    );
    assert(after.renew_count === 1, `更新回数が ${after.renew_count}（1のはず）`);
  });

  await test("H", "ドラフトの猶予を使い切ると、めくれず確定もできない", async () => {
    const u = await makeMember(db, "clock-expire");
    const state = await startDraftOnly(db, u, { timeLimit: 600 });

    // 600秒 + 猶予300秒 を過ぎさせる
    await rewindChallenge(db, { sessionId: state.session_id }, 1000);

    const ch = await value(db, asMember(u), `select public.get_active_challenge()`);
    assert(ch.is_expired === true, "猶予を過ぎても終了になっていない");

    const slot = state.slots.find((x) => !x.candidates.some((c) => c.is_chosen));
    await expectFailure(
      () =>
        value(db, asMember(u), `select public.reveal_card($1, $2, 0)`, [
          state.session_id,
          slot.card_slot_key,
        ]),
      "DRAFT_EXPIRED",
    );

    await expectFailure(
      () => value(db, asMember(u), `select public.complete_draft($1)`, [state.session_id]),
      "DRAFT_EXPIRED",
    );

    await expectFailure(
      () => value(db, asMember(u), `select public.renew_draft_deadline($1)`, [state.session_id]),
      "RENEW_TOO_LATE",
    );

    const n = await value(
      db,
      { role: "service_role", uid: null },
      `select public.expire_overdue_drafts(500)`,
    );
    assert(Number(n) >= 1, "掃除が猶予切れのドラフトを拾わなかった");

    const st = await db.query(`select status from public.draft_sessions where id = $1`, [
      state.session_id,
    ]);
    assert(st.rows[0].status === "failed", `ドラフトの状態が ${st.rows[0].status}`);

    // 失敗したあとは、新しい挑戦を始められる
    const again = await startDraftOnly(db, u, { timeLimit: 600 });
    assert(again.session_id !== state.session_id, "失敗のあと新しく引けない");
  });

  await test("H", "投稿すると時計が止まり、かかった時間が残る", async () => {
    const u = await makeMember(db, "clock-finish");
    const p = await drawPrompt(db, u, { timeLimit: 3600 });
    await rewindChallenge(db, { promptId: p.prompt_id }, 900);

    const workId = await postWork(db, u, p.prompt_id, "時計を止める作品");

    const { rows } = await db.query(
      `select status, elapsed_seconds from public.prompts where id = $1`,
      [p.prompt_id],
    );
    assert(rows[0].status === "submitted", "投稿してもお題が submitted になっていない");
    assert(
      Number(rows[0].elapsed_seconds) >= 900,
      `記録された経過が ${rows[0].elapsed_seconds} 秒（900秒以上のはず）`,
    );

    const ch = await value(db, asMember(u), `select public.get_active_challenge()`);
    assert(ch.is_finished === true, "投稿後も進行中として返っている");
    assert(ch.work_id === workId, "終わった挑戦から作品へ戻れない");

    const first = ch.elapsed_seconds;
    const second = (await value(db, asMember(u), `select public.get_active_challenge()`))
      .elapsed_seconds;
    assert(first === second, "投稿後も経過時間が増え続けている（時計が止まっていない）");
  });

  await test("H", "無制限は経過だけ数え、期限も更新も無い", async () => {
    const u = await makeMember(db, "clock-unlimited");
    const state = await startDraftOnly(db, u, { timeLimit: null });

    const ch = await value(db, asMember(u), `select public.get_active_challenge()`);
    assert(ch.is_unlimited === true, "無制限として返っていない");
    assert(ch.has_deadline === false, "無制限に期限が入っている");
    assert(ch.deadline_at === null, "無制限に期限の時刻が入っている");
    assert(ch.can_renew === false, "無制限に更新ボタンが出る");
    assert(ch.is_expired === false, "無制限が時間切れになる");
    assert(typeof ch.elapsed_seconds === "number", "無制限で経過時間が出ない");

    await expectFailure(
      () => value(db, asMember(u), `select public.renew_current_challenge()`),
      "UNLIMITED_NO_RENEW",
    );

    const done = await finishDraft(db, u, state.session_id);
    const t = await value(db, asMember(u), `select public.get_prompt_timer($1)`, [done.prompt_id]);
    assert(t.is_unlimited === true, "確定したら無制限でなくなった");
  });

  await test("H", "延ばすたびに、そのときの経過と超過が履歴に残る", async () => {
    const u = await makeMember(db, "clock-history");
    const state = await startDraftOnly(db, u, { timeLimit: 3600 });

    // 1回目。期限内（残り10分）に押す
    await rewindChallenge(db, { sessionId: state.session_id }, 3000);
    await value(db, asMember(u), `select public.renew_current_challenge()`);

    // 2回目。期限を5分過ぎてから押す（猶予の中）
    await rewindChallenge(db, { sessionId: state.session_id }, 2700 + 300);
    await value(db, asMember(u), `select public.renew_current_challenge()`);

    const history = await value(db, asMember(u), `select public.get_my_renewals(50)`);
    assert(history.length === 2, `履歴が ${history.length} 件（2件のはず）`);

    const first = history.find((x) => x.renew_index === 1);
    const second = history.find((x) => x.renew_index === 2);

    assert(first.overrun_seconds === 0, `1回目の超過が ${first.overrun_seconds} 秒（0のはず）`);
    assert(
      second.overrun_seconds >= 290,
      `2回目の超過が ${second.overrun_seconds} 秒（300秒前後のはず）`,
    );
    assert(
      second.elapsed_seconds > first.elapsed_seconds,
      "2回目の総経過が1回目より小さい（経過が戻っている）",
    );
    assert(
      new Date(second.deadline_after) > new Date(second.deadline_before),
      "更新で期限が延びていない",
    );

    // 他人の履歴は見えない
    const other = await makeMember(db, "clock-history-other");
    const empty = await value(db, asMember(other), `select public.get_my_renewals(50)`);
    assert(empty.length === 0, "他人の更新履歴が見えている");
  });

  await test("H", "帯は他人の挑戦を返さない", async () => {
    const a = await makeMember(db, "clock-mine");
    const b = await makeMember(db, "clock-other");
    await startDraftOnly(db, a, { timeLimit: 600 });

    const seenByB = await value(db, asMember(b), `select public.get_active_challenge()`);
    assert(seenByB === null, "他人の挑戦が帯に出る");

    const seenByAnon = await value(db, ANON, `select public.get_active_challenge()`).catch(
      (e) => e.message,
    );
    assert(
      typeof seenByAnon === "string" && seenByAnon.includes("permission denied"),
      "未サインインが挑戦の帯を読める",
    );
  });

  await test("H", "進行中のお題があるときは、そのお題が帯に出る", async () => {
    const u = await makeMember(db, "clock-prompt");
    const p = await drawPrompt(db, u, { timeLimit: 1800 });

    const ch = await value(db, asMember(u), `select public.get_active_challenge()`);
    assert(ch.kind === "prompt", `区分が ${ch.kind}（prompt のはず）`);
    assert(ch.href === `/prompt/${p.prompt_id}`, "戻り先がお題のページになっていない");
    assert(ch.time_limit_seconds === 1800, "枠の長さが返っていない");
  });

  /* ---------------------------------------------------------------------
   * E. フレーバーテキスト（D162）
   * ------------------------------------------------------------------- */

  await test("E", "正解語を含む語・言い換えの語は候補に出ない", async () => {
    const u = await makeMember(db, "fl1");
    // 「暗闇」は明示的な禁止、「真新しい」は文字の重なり（新しい を含む）
    const promptId = await buildPromptWithTags(db, u, ["傘", "暗闇", "真新しい"]);
    const workId = await postWork(db, u, promptId, "フレーバー候補の作品");

    const set = await value(db, asMember(u), `select public.get_flavor_vocab($1)`, [workId]);
    const labels = set.vocab.map((v) => v.label);

    assert(!labels.includes("暗い"), "「暗闇」が正解なのに「暗い」が候補に出ている");
    assert(!labels.includes("新しい"), "「真新しい」が正解なのに「新しい」が候補に出ている");
    assert(labels.length > 40, `候補が ${labels.length} 語しか無い（絞りすぎ）`);
  });

  await test("E", "漢字とかなの言い換えを止める（馬とうま）", async () => {
    // いまの語彙には、読みが同じで表記だけ違う組が無い（vocab-audit.mjs で0組と実測）。
    // **無いことを「対応した」の根拠にしない。**その組を作って、止まることを確かめる。
    const tag = await db.query(
      `insert into public.tags (pool_key, label, reading) values ('morph', '馬', 'うま')
       returning id`,
    );
    const vocab = await db.query(
      `insert into public.flavor_vocab (label, kind, is_reviewed, reading)
       values ('うま', 'noun', true, 'うま') returning id`,
    );

    const reason = await db.query(`select public.flavor_block_reason($1, $2) as r`, [
      vocab.rows[0].id,
      tag.rows[0].id,
    ]);
    assert(
      reason.rows[0].r === "reading",
      `「うま」と「馬」が ${reason.rows[0].r} と判定された（reading のはず）`,
    );

    // 実際のお題でも候補から外れる
    const u = await makeMember(db, "kana-kanji");
    const promptId = await buildPromptWithTags(db, u, ["馬", "怒り", "水中"]);
    const workId = await postWork(db, u, promptId, "馬の作品");
    const list = (await value(db, asMember(u), `select public.get_flavor_vocab($1)`, [workId]))
      .vocab;
    assert(
      !list.some((x) => x.label === "うま"),
      "読みが同じ語が、そのお題の候補に出ている",
    );

    // 後片づけ。お題カードから参照されているタグは消せないので、
    // 抽選に出ないように is_active を落とすだけにする
    await db.query(`delete from public.flavor_vocab where id = $1`, [vocab.rows[0].id]);
    await db.query(`update public.tags set is_active = false where id = $1`, [tag.rows[0].id]);
  });

  await test("E", "漢字を共有する語も候補に出ない（古い と 古書）", async () => {
    const u = await makeMember(db, "kanji-share");
    const promptId = await buildPromptWithTags(db, u, ["古書", "怒り", "水中"]);
    const workId = await postWork(db, u, promptId, "古書の作品");
    const list = (await value(db, asMember(u), `select public.get_flavor_vocab($1)`, [workId]))
      .vocab;

    assert(
      !list.some((x) => x.label === "古い"),
      "「古書」が答えのお題に「古い」が候補として出ている",
    );
    assert(list.length > 60, `候補が ${list.length} 語しか残っていない（禁止しすぎ）`);
  });

  await test("E", "カタカナとひらがなの書き換えでもすり抜けない", async () => {
    // 「マント」が正解のとき、「まんと」は文字としては一致しないが同じ語。
    // 表記をそろえてから比べる関門が効いているかを見る。
    await db.query(
      `insert into public.flavor_vocab (label, kind, is_reviewed)
       values ('まんと', 'noun', true) on conflict (label) do nothing`,
    );

    const u = await makeMember(db, "fl-kana");
    const promptId = await buildPromptWithTags(db, u, ["マント", "怒り", "水中"]);
    const workId = await postWork(db, u, promptId, "表記ゆれの作品");

    const set = await value(db, asMember(u), `select public.get_flavor_vocab($1)`, [workId]);
    assert(
      !set.vocab.some((v) => v.label === "まんと"),
      "「マント」が正解なのに「まんと」が候補に出ている",
    );

    const id = Number(
      (await db.query(`select id from public.flavor_vocab where label = 'まんと'`)).rows[0].id,
    );
    await expectFailure(
      () => value(db, asMember(u), `select public.set_flavor_text($1, $2)`, [workId, [id]]),
      "FLAVOR_LEAK",
    );

    // 別のお題では、同じ語がふつうに使える（絞りすぎていないこと）
    const other = await buildPromptWithTags(db, u, ["梟", "郷愁", "深夜"]);
    const otherWork = await postWork(db, u, other, "別のお題");
    const otherSet = await value(db, asMember(u), `select public.get_flavor_vocab($1)`, [
      otherWork,
    ]);
    assert(
      otherSet.vocab.some((v) => v.label === "まんと"),
      "関係の無いお題でも「まんと」が使えなくなっている（絞りすぎ）",
    );
  });

  await test("E", "禁止された語は保存でも弾かれる（画面を通さなくても）", async () => {
    const u = await makeMember(db, "fl2");
    const promptId = await buildPromptWithTags(db, u, ["傘", "暗闇", "水中"]);
    const workId = await postWork(db, u, promptId, "直接送りの作品");

    const dark = Number(
      (await db.query(`select id from public.flavor_vocab where label = '暗い'`)).rows[0].id,
    );

    await expectFailure(
      () =>
        value(db, asMember(u), `select public.set_flavor_text($1, $2)`, [workId, [dark]]),
      "FLAVOR_LEAK",
    );
  });

  await test("E", "作者が文章を保存でき、回答後に開示される", async () => {
    const u = await makeMember(db, "fl3");
    const r = await makeMember(db, "fl3r");
    const promptId = await buildPromptWithTags(db, u, ["傘", "怒り", "水中"]);
    const workId = await postWork(db, u, promptId, "文章つきの作品");

    const set = await value(db, asMember(u), `select public.get_flavor_vocab($1)`, [workId]);
    const ids = set.vocab.slice(0, 4).map((v) => v.id);
    await value(db, asMember(u), `select public.set_flavor_text($1, $2)`, [workId, ids]);

    // 回答前は、開いていない人に返らない
    const before = await value(db, asMember(r), `select public.get_work_flavor($1)`, [workId]);
    assert(before === null, "回答も開封もしていない人に文章が返っている");

    // 「文章があること」だけは分かる
    const has = await value(db, asMember(r), `select public.work_has_flavor($1)`, [workId]);
    assert(has === true, "文章の有無が分からない");

    await answerWork(db, r, workId);

    const after = await value(db, asMember(r), `select public.get_work_flavor($1)`, [workId]);
    assert(after !== null && after.tokens.length === 4, "回答後に開示されない");
    assert(after.hint_used === false, "開いていないのにヒント扱いになっている");
  });

  await test("E", "ヒントを開いた人と開かなかった人で集計が分かれる", async () => {
    const u = await makeMember(db, "fl4");
    const promptId = await buildPromptWithTags(db, u, ["蝶", "歓喜", "強風"]);
    const workId = await postWork(db, u, promptId, "ヒント集計の作品");

    const set = await value(db, asMember(u), `select public.get_flavor_vocab($1)`, [workId]);
    await value(db, asMember(u), `select public.set_flavor_text($1, $2)`, [
      workId,
      set.vocab.slice(0, 3).map((v) => v.id),
    ]);

    const withHint = await makeMember(db, "fl4a");
    const without = await makeMember(db, "fl4b");

    await value(db, asMember(withHint), `select public.open_flavor_hint($1)`, [workId]);
    await answerWork(db, withHint, workId, { correct: true });
    await answerWork(db, without, workId, { wrong: true });

    const result = await value(db, asMember(u), `select public.get_my_work_hint_result($1)`, [
      workId,
    ]);

    const used = result.rows.find((x) => x.hint_used === true);
    const notUsed = result.rows.find((x) => x.hint_used === false);

    assert(used && used.answers_count === 1, "ヒントを使った回答が数えられていない");
    assert(notUsed && notUsed.answers_count === 1, "ヒントを使わなかった回答が数えられていない");
    assert(used.correct_items === 3, `ヒント側の正答が ${used.correct_items}（3のはず）`);
    assert(
      used.total_items === 3 && notUsed.total_items === 3,
      "項目数の集計が合わない",
    );

    // ヒント使用が減点になっていないこと（正答数がそのまま入っている）
    const answers = await db.query(
      `select hint_used, correct_count from public.answers where work_id = $1 order by hint_used`,
      [workId],
    );
    const hinted = answers.rows.find((x) => x.hint_used);
    assert(hinted.correct_count === 3, "ヒント使用で正答数が減らされている");
  });

  await test("E", "返歌に正解語を使え、正誤判定は付かない", async () => {
    const u = await makeMember(db, "fl5");
    const r = await makeMember(db, "fl5r");
    const promptId = await buildPromptWithTags(db, u, ["梟", "郷愁", "深夜"]);
    const workId = await postWork(db, u, promptId, "返歌の作品");

    const set = await value(db, asMember(u), `select public.get_flavor_vocab($1)`, [workId]);
    await value(db, asMember(u), `select public.set_flavor_text($1, $2)`, [
      workId,
      set.vocab.slice(0, 3).map((v) => v.id),
    ]);

    await answerWork(db, r, workId);

    const revealed = await value(db, asMember(r), `select public.get_answered_prompt($1)`, [
      workId,
    ]);
    const vocab = await value(db, asMember(r), `select public.get_reply_vocab()`);

    const tokens = [
      { tag_id: revealed.cards[0].tag_id },
      { vocab_id: vocab[0].id },
      { tag_id: revealed.cards[1].tag_id },
    ];

    const replies = await value(db, asMember(r), `select public.post_flavor_reply($1, $2::jsonb)`, [
      workId,
      JSON.stringify(tokens),
    ]);

    assert(replies.length === 1, `返歌が ${replies.length} 件（1件のはず）`);
    assert(replies[0].tokens.length === 3, "返歌の語が保存されていない");
    assert(
      replies[0].tokens.includes(revealed.cards[0].tag_label),
      "返歌に正解の語を置けていない",
    );

    // 採点の列が無いこと（正誤判定を設けない。D162）
    const cols = await db.query(
      `select column_name from information_schema.columns
        where table_schema='public' and table_name='flavor_replies'`,
    );
    const names = cols.rows.map((c) => c.column_name);
    assert(
      !names.some((n) => /correct|score|is_valid|grade/.test(n)),
      `返歌に採点らしき列がある: ${names.join(",")}`,
    );
  });

  await test("E", "返歌は回答していない人に見えない（正解が漏れるため）", async () => {
    const u = await makeMember(db, "fl6");
    const r = await makeMember(db, "fl6r");
    const outsider = await makeMember(db, "fl6o");

    const promptId = await buildPromptWithTags(db, u, ["鯨", "孤独", "水中"]);
    const workId = await postWork(db, u, promptId, "返歌の漏洩試験");

    await answerWork(db, r, workId);
    const revealed = await value(db, asMember(r), `select public.get_answered_prompt($1)`, [
      workId,
    ]);
    await value(db, asMember(r), `select public.post_flavor_reply($1, $2::jsonb)`, [
      workId,
      JSON.stringify([{ tag_id: revealed.cards[0].tag_id }]),
    ]);

    const seen = await value(db, asMember(outsider), `select public.get_flavor_replies($1)`, [
      workId,
    ]);
    assert(seen === null, "回答していない人に返歌が返っている");
  });

  /* ---------------------------------------------------------------------
   * F. 漏洩（回答前に正解が渡らないこと）
   * ------------------------------------------------------------------- */

  await test("F", "回答していない人にお題が返らない", async () => {
    const p = await drawPrompt(db, author);
    const workId = await postWork(db, author, p.prompt_id, "漏洩試験の作品");

    const outsider = await makeMember(db, "leak1");
    const seen = await value(db, asMember(outsider), `select public.get_answered_prompt($1)`, [
      workId,
    ]);
    assert(seen === null, "回答していない人にお題が返っている");

    const g = await makeGuest(db);
    const seenGuest = await value(db, asGuest(g), `select public.get_answered_prompt($1)`, [
      workId,
    ]);
    assert(seenGuest === null, "回答していないゲストにお題が返っている");
  });

  await test("F", "作者はお題を見られる（自分の答えなので）", async () => {
    const p = await drawPrompt(db, author);
    const workId = await postWork(db, author, p.prompt_id, "作者の確認");
    const seen = await value(db, asMember(author), `select public.get_answered_prompt($1)`, [
      workId,
    ]);
    assert(seen !== null && seen.is_author === true, "作者が自作のお題を見られない");
  });

  await test("F", "出題（get_work_quiz）に正解の印が含まれない", async () => {
    const p = await drawPrompt(db, author);
    const workId = await postWork(db, author, p.prompt_id, "出題の確認");
    const outsider = await makeMember(db, "leak2");

    const quiz = await value(db, asMember(outsider), `select public.get_work_quiz($1)`, [workId]);
    const text = JSON.stringify(quiz);
    assert(!text.includes("is_correct"), "出題に is_correct が含まれている");
    assert(!text.includes("prompt_id"), "出題に prompt_id が含まれている");
  });

  await test("F", "お題に触れる関数は、内部専用か本人確認つきのどちらか", async () => {
    // **本数を数えるだけの検査にしない。**本数は機能が増えれば増える。
    // 見るのは「外から呼べるなら、必ず呼んだ人を見ているか」の1点。
    //
    //   外から呼べる（anon か authenticated に EXECUTE がある）
    //     → 本文に auth.uid() があること
    //   外から呼べない
    //     → それだけで漏洩経路にならない
    const { rows } = await db.query(
      `select p.proname,
              p.prosrc,
              (has_function_privilege('anon', p.oid, 'EXECUTE')
               or has_function_privilege('authenticated', p.oid, 'EXECUTE')) as callable
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosrc like '%public.prompt_cards%'
        order by p.proname`,
    );

    assert(rows.length > 0, "お題に触れる関数が1本も見つからない（検査が空振りしている）");

    const bad = rows.filter((r) => r.callable && !r.prosrc.includes("auth.uid()"));
    assert(
      bad.length === 0,
      `外から呼べるのに呼んだ人を見ていない関数: ${bad.map((b) => b.proname).join(", ")}`,
    );

    // 外から呼べる関数の顔ぶれも記録しておく。増えたら気づけるようにする
    const callable = rows.filter((r) => r.callable).map((r) => r.proname).sort();
    const expected = [
      "complete_draft",
      // 2026-09-08 に足した。持ち込みの投稿（作者が選んだ語から お題を作る）。
      // 書き込み側で、返り値に答えも prompt_id も含めない。
      "create_art_first_work",
      "get_answered_prompt",
      "get_flavor_vocab",
      "get_my_answer",
      "get_my_prompt",
      "get_saved_works",
      "post_flavor_reply",
      "save_prompt_elements",
    ];
    assert(
      JSON.stringify(callable) === JSON.stringify(expected),
      `外から呼べる顔ぶれが変わった:\n  いま  ${callable.join(", ")}\n  想定  ${expected.join(", ")}`,
    );
  });

  await test("F", "内部専用の関数は authenticated から呼べない", async () => {
    const u = await makeMember(db, "priv-user");
    for (const call of [
      `select public.draft_plan_slots('00000000-0000-0000-0000-000000000000', 1, 'normal')`,
      `select public.prompt_timer_json('00000000-0000-0000-0000-000000000000')`,
      `select public.flavor_vocab_is_allowed(1, '00000000-0000-0000-0000-000000000000')`,
      `select public.build_quiz_for_prompt('00000000-0000-0000-0000-000000000000')`,
      `select public.flavor_normalize('あ')`,
      `select public.expire_overdue_prompts(1)`,
      `select public.get_usage_summary(30)`,
    ]) {
      await expectFailure(() => value(db, asMember(u), call), "permission denied");
    }
  });

  /* ---------------------------------------------------------------------
   * G. 回帰（前からあったものが壊れていないこと）
   * ------------------------------------------------------------------- */

  await test("G", "旧方式のモードでも、いままでどおりお題を確定できる", async () => {
    const u = await makeMember(db, "legacy");
    // easy は一般利用者から見えないが、行は残っている。
    // 過去のお題が指しているので、確定の道筋も壊れていないことを見る
    const state = await value(
      db,
      asMember(u),
      `select public.start_draft('easy', 3600, null)`,
    ).catch(() => null);

    // is_active = false のモードは start_draft が断る。断ることが正しい
    assert(state === null, "無効にしたモードでドラフトが始められてしまう");

    // 直接セッションを作って、旧方式の候補配りが動くことを見る
    const { rows } = await db.query(
      `insert into public.draft_sessions
         (user_id, mode_key, candidate_count, max_rerolls)
       values ($1, 'easy', 3, 1) returning id`,
      [u],
    );
    await db.query(`select public.draft_generate_candidates($1, 1, 'easy', 3)`, [rows[0].id]);

    const { rows: c } = await db.query(
      `select count(*)::int as n from public.draft_candidates where session_id = $1`,
      [rows[0].id],
    );
    assert(c[0].n === 9, `旧方式の候補が ${c[0].n} 枚（3枠×3枚＝9枚のはず）`);
  });

  await test("G", "既存の取得系RPCが動く", async () => {
    const p = await drawPrompt(db, author);
    const workId = await postWork(db, author, p.prompt_id, "回帰の作品");

    const list = await value(db, ANON, `select count(*)::int from public.get_public_works(null,'new',20,0)`);
    assert(list >= 1, "公開一覧に作品が出ない");

    const detail = await value(db, ANON, `select public.get_work_detail($1)`, [workId]);
    assert(detail !== null && detail.title === "回帰の作品", "作品詳細が取れない");
    assert(!JSON.stringify(detail).includes("prompt_id"), "作品詳細に prompt_id が出ている");

    const rank = await value(db, ANON, `select count(*)::int from public.get_rankings('popular','normal',null,5,0)`);
    assert(rank >= 0, "ランキングが取れない");
  });

  await test("G", "回答の集計（既存の3表）が壊れていない", async () => {
    const u = await makeMember(db, "reg1");
    const r1 = await makeMember(db, "reg1a");
    const r2 = await makeMember(db, "reg1b");

    const p = await drawPrompt(db, u);
    const workId = await postWork(db, u, p.prompt_id, "集計の作品");

    const first = await answerWork(db, r1, workId, { correct: true });
    await answerWork(db, r2, workId, { wrong: true });

    // **問数はお題の語数。3で固定しない（D165）**
    const n = first.question_count;
    assert(n >= 3 && n <= 6, `問数が ${n}（3〜6のはず）`);

    const { rows: w } = await db.query(
      `select answers_count from public.works where id = $1`,
      [workId],
    );
    assert(w[0].answers_count === 2, `回答数が ${w[0].answers_count}（2のはず）`);

    const { rows: s } = await db.query(
      `select sum(attempts)::int as a, sum(corrects)::int as c,
              sum(exact_attempts)::int as ea, sum(pair_attempts)::int as pa
         from public.work_slot_stats where work_id = $1`,
      [workId],
    );
    assert(s[0].a === n * 2, `枠ごとの挑戦が ${s[0].a}（2人×${n}問＝${n * 2}のはず）`);
    assert(s[0].c === n, `枠ごとの正答が ${s[0].c}（全問正解1人ぶん＝${n}のはず）`);
    assert(s[0].ea === n * 2, "ビタ当てとして数えられていない");
    assert(s[0].pa === 0, "2択当てが0のはずなのに数えられている");

    const { rows: us } = await db.query(
      `select total_answers, total_items, total_correct_items, exact_correct_items
         from public.user_stats where user_id = $1`,
      [r1],
    );
    assert(us[0].total_correct_items === n, "回答者の通算成績が入っていない");
    assert(us[0].exact_correct_items === n, "ビタ当ての通算が入っていない");
  });

  await test("G", "作者は自作に回答できない（D28）", async () => {
    const p = await drawPrompt(db, author);
    const workId = await postWork(db, author, p.prompt_id, "自作回答の確認");
    await expectFailure(
      () => answerWork(db, author, workId),
      "AUTHOR_CANNOT_ANSWER",
    );
  });

  await test("G", "1作品につき1回しか回答できない", async () => {
    const p = await drawPrompt(db, author);
    const workId = await postWork(db, author, p.prompt_id, "二重回答の確認");
    const r = await makeMember(db, "twice");
    await answerWork(db, r, workId);
    await expectFailure(() => answerWork(db, r, workId), "ALREADY_ANSWERED");
  });

  await test("G", "次の作品は、自作と回答済みを外して返る", async () => {
    const u = await makeMember(db, "next1");
    const p = await drawPrompt(db, u);
    const mine = await postWork(db, u, p.prompt_id, "自分の作品");

    const next = await value(db, asMember(u), `select public.get_next_work($1)`, [null]);
    assert(next.work_id !== mine, "次の作品に自作が返っている");

    if (next.has_next) {
      const answered = await db.query(
        `select count(*)::int as n from public.answers
          where work_id = $1 and user_id = $2`,
        [next.work_id, u],
      );
      assert(answered.rows[0].n === 0, "次の作品に回答済みのものが返っている");
    }
  });

  await test("G", "計測は2種類しか受け付けない", async () => {
    const u = await makeMember(db, "event-user");
    await value(db, asMember(u), `select public.record_usage_event('share_opened', null)`);
    await expectFailure(
      () => value(db, asMember(u), `select public.record_usage_event('page_view', null)`),
      "BAD_EVENT_KEY",
    );

    const summary = await value(
      db,
      { role: "service_role", uid: null },
      `select public.get_usage_summary(30)`,
    );
    assert(summary.share_opened >= 1, "共有の記録が数えられていない");
    assert(summary.answer_completed >= 1, "回答が数えられていない");
    assert(summary.draft_started >= 1, "制作開始が数えられていない");
    assert(summary.carryover_used >= 1, "持ち出しが数えられていない");
  });

  /* ---------------------------------------------------------------------
   * I. 保存枠（2026-09-05 に上限の単位が確定）
   * ------------------------------------------------------------------- */

  await test("I", "1回の持ち出しが1つの保存枠になり、1〜3要素をまとめる", async () => {
    const u = await makeMember(db, "slot-shape");
    const src = await buildPromptWithTags(db, u, ["傘", "蝶", "梟"]);
    const tags = await promptTags(db, src);

    const saved = await saveCarrySlot(db, u, src, tags.slice(0, 3).map((t) => t.tag_id));

    assert(saved.slots.length === 1, `保存枠が ${saved.slots.length} 枠（1枠のはず）`);
    assert(saved.slots[0].element_count === 3, "枠の中の要素が3個になっていない");
    assert(saved.counts.self === 1, "枠の数が1になっていない");
    assert(saved.element_counts.self === 3, "要素の数が3になっていない");
    assert(saved.max_per_slot === 3, "1枠あたりの上限が返っていない");

    // 同じ元お題から、もう1回持ち出すと**別の枠**になる
    const second = await saveCarrySlot(db, u, src, [tags[0].tag_id]);
    assert(second.counts.self === 2, `2回目で枠が ${second.counts.self}（2枠のはず）`);
  });

  await test("I", "1つの保存枠に4要素は入らない（表の側でも止まる）", async () => {
    const u = await makeMember(db, "slot-4");
    const src = await buildPromptWithTags(db, u, ["傘", "蝶", "梟", "怒り"]);
    const tags = await promptTags(db, src);

    await expectFailure(
      () => saveCarrySlot(db, u, src, tags.map((t) => t.tag_id)),
      "BAD_ELEMENT_COUNT",
    );

    // RPC を通さず直接入れても止まる
    const saved = await saveCarrySlot(db, u, src, tags.slice(0, 3).map((t) => t.tag_id));
    const slotId = saved.slots[0].id;
    await expectFailure(
      () =>
        db.query(
          `insert into public.saved_elements
             (user_id, tag_id, scope, source_is_own, carry_slot_id, position)
           values ($1, $2, 'self', true, $3, 3)`,
          [u, tags[3].tag_id, slotId],
        ),
      "CARRY_SLOT_TOO_LARGE",
    );
  });

  await test("I", "自分由来5枠と他者由来3枠は別々に数える（境界）", async () => {
    const u = await makeMember(db, "both-caps");

    const sets = [["傘"], ["灯台"], ["三日月"], ["歯車"], ["風船"]];
    for (const labels of sets) {
      const src = await buildPromptWithTags(db, u, labels);
      const tags = await promptTags(db, src);
      await saveCarrySlot(db, u, src, [tags[0].tag_id]);
    }

    // 他者の作品からは、まだ3枠ぶん入る
    for (let i = 0; i < 4; i += 1) {
      const p = await drawPrompt(db, author);
      const w = await postWork(db, author, p.prompt_id, `境界用${i}`);
      await answerWork(db, u, w);
      const revealed = await value(db, asMember(u), `select public.get_answered_prompt($1)`, [w]);
      const tagId = Number(revealed.cards[0].tag_id);

      const call = () =>
        value(db, asMember(u), `select public.save_prompt_elements('work', $1, $2, true)`, [
          w,
          [tagId],
        ]);

      if (i < 3) await call();
      else await expectFailure(call, "CARRY_LIMIT_REACHED");
    }

    const saved = await value(db, asMember(u), `select public.list_saved_elements()`);
    assert(saved.counts.self === 5, `自分由来が ${saved.counts.self} 枠（5枠のはず）`);
    assert(saved.counts.others === 3, `他者由来が ${saved.counts.others} 枠（3枠のはず）`);
  });

  await test("I", "保存枠から一部だけ使っても、使った要素が派生先に残る", async () => {
    const u = await makeMember(db, "partial-use");
    const src = await buildPromptWithTags(db, u, ["傘", "蝶", "梟"]);
    const tags = await promptTags(db, src);
    const saved = await saveCarrySlot(db, u, src, tags.map((t) => t.tag_id));

    const slot = saved.slots[0];
    const usedElement = slot.elements[1];

    const derived = await drawPrompt(db, u, { carried: [usedElement.id] });

    const origins = await value(
      db,
      asMember(u),
      `select public.get_my_prompt_carry_origins($1)`,
      [derived.prompt_id],
    );

    assert(origins.slots.length === 1, `枠の記録が ${origins.slots.length} 件（1件のはず）`);
    assert(origins.slots[0].carry_slot_id === slot.id, "枠IDが残っていない");
    assert(origins.slots[0].slot_size === 3, `枠の要素数が ${origins.slots[0].slot_size}`);
    assert(origins.slots[0].used_count === 1, `使った数が ${origins.slots[0].used_count}`);
    assert(origins.slots[0].partial === true, "一部利用の印が付いていない");

    assert(origins.elements.length === 1, "要素の記録が1件でない");
    assert(
      Number(origins.elements[0].tag_id) === usedElement.tag_id,
      "使った要素が記録されていない",
    );
    assert(
      Number(origins.elements[0].saved_element_id) === usedElement.id,
      "保存枠内要素のIDが残っていない",
    );
    assert(origins.elements[0].source_is_own === true, "自分由来の印が残っていない");

    // 他人のお題の出所は返らない
    const other = await value(
      db,
      asMember(author),
      `select public.get_my_prompt_carry_origins($1)`,
      [derived.prompt_id],
    );
    assert(other === null, "他人のお題の出所が返っている");
  });

  await test("I", "持ち出しを先に配置し、残りだけを抽選する", async () => {
    const u = await makeMember(db, "carry-first");
    const src = await buildPromptWithTags(db, u, ["傘", "蝶"]);
    const tags = await promptTags(db, src);
    const saved = await saveCarrySlot(db, u, src, tags.map((t) => t.tag_id));

    const state = await asRole(db, asMember(u), async (c) => {
      const r = await c.query(`select public.start_draft('normal', 3600, $1) as s`, [
        saved.slots[0].elements.map((e) => e.id),
      ]);
      return r.rows[0].s;
    });

    const { rows } = await db.query(
      `select slot_order, source, fixed_tag_id from public.draft_session_slots
        where session_id = $1 and generation = 1 order by slot_order`,
      [state.session_id],
    );

    assert(rows[0].source === "carried" && rows[1].source === "carried",
      "持ち出しが先頭に置かれていない");
    assert(
      rows.slice(2).every((r) => r.source === "lottery"),
      "持ち出しのあとに抽選以外の枠がある",
    );
    assert(rows.length > 2, "抽選で足される枠が1つも無い");
  });

  await test("I", "持ち出した要素はカテゴリの重複上限を超えられる（カラー2語）", async () => {
    const u = await makeMember(db, "carry-color2");
    const src = await buildPromptWithTags(db, u, ["赤", "青"]);
    const tags = await promptTags(db, src);
    assert(tags.length === 2, "カラー2語のお題が作れない");

    const saved = await saveCarrySlot(db, u, src, tags.map((t) => t.tag_id));
    const derived = await drawPrompt(db, u, {
      carried: saved.slots[0].elements.map((e) => e.id),
    });

    const cards = await value(db, asMember(u), `select public.get_my_prompt($1)`, [
      derived.prompt_id,
    ]);
    const colors = cards.cards.filter((c) => c.pool_key === "color");
    assert(colors.length === 2, `カラーが ${colors.length} 語（持ち出した2語のはず）`);
  });

  /* ---------------------------------------------------------------------
   * J. D165（全語出題・ビタ当てと2択当て・カラーのカテゴリ化）
   * ------------------------------------------------------------------- */

  await test("J", "お題の全語が出題される（3〜6問）", async () => {
    for (const mode of ["normal", "hard"]) {
      for (let i = 0; i < 6; i += 1) {
        const u = await makeMember(db, `allq-${mode}-${i}`);
        const p = await drawPrompt(db, u, { mode });
        const cards = await value(db, asMember(u), `select public.get_my_prompt($1)`, [
          p.prompt_id,
        ]);

        assert(
          p.question_count === cards.cards.length,
          `${mode}: 問数 ${p.question_count} ／ 語数 ${cards.cards.length}`,
        );

        const { rows } = await db.query(
          `select count(*)::int as n from public.quiz_questions where prompt_id = $1`,
          [p.prompt_id],
        );
        assert(rows[0].n === cards.cards.length, "quiz_questions の数が語数と違う");
      }
    }
  });

  await test("J", "選択肢は4つ（作れないときだけ3つ）で、正解はちょうど1つ", async () => {
    const u = await makeMember(db, "choice-shape");
    const p = await drawPrompt(db, u, { mode: "hard" });

    const { rows } = await db.query(
      `select qq.id, count(*)::int as n, sum((qc.is_correct)::int)::int as c
         from public.quiz_questions qq join public.quiz_choices qc on qc.question_id = qq.id
        where qq.prompt_id = $1 group by qq.id`,
      [p.prompt_id],
    );

    assert(rows.length >= 5, `問が ${rows.length} 件（5件以上のはず）`);
    for (const r of rows) {
      assert(r.n === 4, `選択肢が ${r.n} 個（いまの語彙なら4個のはず）`);
      assert(r.c === 1, `正解が ${r.c} 個（1個のはず）`);
    }
  });

  await test("J", "語彙が足りないときは3択へ落とす（出題は見送らない）", async () => {
    const u = await makeMember(db, "three-choice");
    // カラーを3語だけ残す。**この試験の中だけ。終わったら必ず戻す**
    const { rows: keep } = await db.query(
      `select id from public.tags where pool_key = 'color' order by id limit 3`,
    );
    const keepIds = keep.map((r) => Number(r.id));

    await db.query(
      `update public.tags set is_active = false where pool_key = 'color' and not (id = any($1))`,
      [keepIds],
    );

    try {
      const { rows: label } = await db.query(`select label from public.tags where id = $1`, [
        keepIds[0],
      ]);
      const src = await buildPromptWithTags(db, u, [label[0].label]);

      const { rows } = await db.query(
        `select count(*)::int as n
           from public.quiz_questions qq join public.quiz_choices qc on qc.question_id = qq.id
          where qq.prompt_id = $1`,
        [src],
      );
      assert(rows[0].n === 3, `選択肢が ${rows[0].n} 個（3択へ落ちるはず）`);
    } finally {
      await db.query(`update public.tags set is_active = true where pool_key = 'color'`);
    }
  });

  await test("J", "同じ表示名の枠が複数あっても、問ごとに正しく採点する", async () => {
    const u = await makeMember(db, "dup-label");
    const src = await buildPromptWithTags(db, u, ["傘", "蝶", "梟"]);
    const workId = await postWork(db, u, src, "モーフ3個の作品");

    const r = await makeMember(db, "dup-label-answer");
    const answer = await answerWork(db, r, workId, { correct: true });

    assert(answer.items.length === 3, `問が ${answer.items.length} 件（3件のはず）`);
    assert(
      answer.items.every((x) => x.card_slot_label === "モーフ"),
      "表示名がモーフになっていない",
    );
    assert(answer.correct_count === 3, `正解が ${answer.correct_count} 件（3件のはず）`);

    const { rows } = await db.query(
      `select card_slot_key, attempts, corrects from public.work_slot_stats
        where work_id = $1 order by card_slot_key`,
      [workId],
    );
    assert(rows.length === 3, `枠ごとの集計が ${rows.length} 件（3件のはず）`);
    assert(
      rows.every((x) => x.attempts === 1 && x.corrects === 1),
      "枠ごとの集計が問と対応していない",
    );
  });

  await test("J", "2択当ては2語のどちらかが正解なら的中する", async () => {
    const p = await drawPrompt(db, author);
    const workId = await postWork(db, author, p.prompt_id, "2択当ての作品");
    const r = await makeMember(db, "pair-hit");

    const answer = await answerWork(db, r, workId, { pair: "all", pairCorrect: true });

    assert(
      answer.items.every((x) => x.answer_mode === "pair"),
      "方式が pair になっていない",
    );
    assert(
      answer.items.every((x) => x.selected_label_2 !== null),
      "2語目が保存されていない",
    );
    assert(answer.correct_count === answer.question_count, "2択当てで的中していない");
    assert(answer.pair_attempts === answer.question_count, "2択当ての数が入っていない");
    assert(answer.exact_attempts === 0, "ビタ当てとして数えられている");
    assert(answer.scoring_version === "v2_all_words", "新方式の印が付いていない");
  });

  await test("J", "ビタ当てと2択当てを混ぜても、別々の数として集計される", async () => {
    const p = await drawPrompt(db, author, { mode: "hard" });
    const workId = await postWork(db, author, p.prompt_id, "混在の作品");
    const r = await makeMember(db, "pair-mix");

    const answer = await answerWork(db, r, workId, {
      correct: true,
      pair: "half",
      pairCorrect: true,
    });

    const exact = answer.items.filter((x) => x.answer_mode === "exact").length;
    const pair = answer.items.filter((x) => x.answer_mode === "pair").length;
    assert(exact > 0 && pair > 0, `混在していない（ビタ ${exact} ／2択 ${pair}）`);
    assert(answer.exact_attempts === exact, "ビタ当ての数が合わない");
    assert(answer.pair_attempts === pair, "2択当ての数が合わない");
    assert(
      answer.exact_corrects + answer.pair_corrects === answer.correct_count,
      "方式別の正答数の合計が正答数と合わない",
    );

    const result = await value(db, asMember(author), `select public.get_my_work_result($1)`, [
      workId,
    ]);
    assert(result.exact_items === exact, "作者向けの集計でビタ当てが分かれていない");
    assert(result.pair_items === pair, "作者向けの集計で2択当てが分かれていない");
    assert(
      result.total_items === answer.question_count,
      `分母が ${result.total_items}（出題数 ${answer.question_count} のはず）`,
    );

    // 枠ごとの方式別。**問数が可変でも枠の数だけ行が出る**
    assert(
      result.slots.length === answer.question_count,
      `枠ごとの内訳が ${result.slots.length} 件（${answer.question_count} 件のはず）`,
    );
    const slotExact = result.slots.reduce((n, x) => n + x.exact_attempts, 0);
    const slotPair = result.slots.reduce((n, x) => n + x.pair_attempts, 0);
    assert(slotExact === exact, "枠ごとのビタ当ての合計が合わない");
    assert(slotPair === pair, "枠ごとの2択当ての合計が合わない");
    assert(result.legacy_answers === 0, "新方式の回答が旧方式として数えられている");
  });

  await test("J", "2択当てで同じ語を2回は選べない・選択肢にない語も送れない", async () => {
    const p = await drawPrompt(db, author);
    const workId = await postWork(db, author, p.prompt_id, "不正な2択の作品");
    const r = await makeMember(db, "pair-bad");

    const quiz = await value(db, asMember(r), `select public.get_work_quiz($1)`, [workId]);
    const same = quiz.questions.map((q) => ({
      question_id: q.question_id,
      tag_id: Number(q.choices[0].tag_id),
      tag_id_2: Number(q.choices[0].tag_id),
    }));

    await expectFailure(
      () =>
        value(db, asMember(r), `select public.submit_answer($1, $2::jsonb)`, [
          workId,
          JSON.stringify(same),
        ]),
      "BAD_SELECTION",
    );

    const outside = quiz.questions.map((q, i) => ({
      question_id: q.question_id,
      tag_id: Number(q.choices[0].tag_id),
      tag_id_2: i === 0 ? 999999 : Number(q.choices[1].tag_id),
    }));

    await expectFailure(
      () =>
        value(db, asMember(r), `select public.submit_answer($1, $2::jsonb)`, [
          workId,
          JSON.stringify(outside),
        ]),
      "BAD_SELECTION",
    );
  });

  await test("J", "カラーは抽選のカテゴリで、1つのお題に最大1語", async () => {
    let sawColor = 0;
    for (let i = 0; i < 40; i += 1) {
      const u = await makeMember(db, `color-draw-${i}`);
      const p = await drawPrompt(db, u, { mode: i % 2 === 0 ? "normal" : "hard" });
      const cards = await value(db, asMember(u), `select public.get_my_prompt($1)`, [
        p.prompt_id,
      ]);
      const colors = cards.cards.filter((c) => c.pool_key === "color");
      assert(colors.length <= 1, `カラーが ${colors.length} 語（最大1語のはず）`);
      if (colors.length === 1) sawColor += 1;
    }
    assert(sawColor > 0, "40回引いてカラーが1度も出なかった（カテゴリに入っていない）");
  });

  await test("J", "カラーも出題される", async () => {
    const u = await makeMember(db, "color-quiz");
    const src = await buildPromptWithTags(db, u, ["傘", "赤"]);
    const workId = await postWork(db, u, src, "カラー出題の作品");

    const r = await makeMember(db, "color-quiz-answer");
    const quiz = await value(db, asMember(r), `select public.get_work_quiz($1)`, [workId]);

    assert(quiz.question_count === 2, `問数が ${quiz.question_count}（2のはず）`);
    const colorQuestion = quiz.questions.find((q) => q.card_slot_key.startsWith("color_"));
    assert(colorQuestion, "カラーの問が出ていない");
    assert(colorQuestion.card_slot_label === "カラー", "カラーの表示名が違う");
    assert(colorQuestion.choices.length === 4, "カラーの選択肢が4つでない");

    const answer = await answerWork(db, r, workId, { correct: true });
    assert(answer.correct_count === 2, "カラーを含む全問が採点されていない");
  });

  await test("J", "旧方式の回答と新方式の回答を見分けられる", async () => {
    const p = await drawPrompt(db, author);
    const workId = await postWork(db, author, p.prompt_id, "版の識別");
    const r = await makeMember(db, "version-mark");
    await answerWork(db, r, workId);

    const { rows } = await db.query(
      `select scoring_version, question_count from public.answers
        where work_id = $1`,
      [workId],
    );
    assert(rows[0].scoring_version === "v2_all_words", "新方式の印が付いていない");
    assert(rows[0].question_count > 0, "出題数が記録されていない");

    // 旧方式の行を1件作って、混ざらないことを見る
    await db.query(
      `update public.answers set scoring_version = 'v1_fixed_count' where work_id = $1`,
      [workId],
    );
    const result = await value(db, asMember(author), `select public.get_my_work_result($1)`, [
      workId,
    ]);
    assert(result.legacy_answers === 1, "旧方式の回答が数えられていない");
  });

  await test("J", "新方式は固定3問の列を参照していない（列は互換期間だけ残す）", async () => {
    // 見るのは「列が消えたこと」ではない。**新しい実装がその列を参照しないこと**。
    // 列そのものは、旧い画面がモード一覧で読むあいだだけ残す（D165 の 3b）。
    // 触ってよいのは draft_state_json 1本だけで、そこでも
    // 「旧い画面へ返す鍵」として出すだけ（D165 の 3b）。
    const { rows: refs } = await db.query(
      `select p.proname from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prokind = 'f'
          and p.proname <> 'draft_state_json'
          and pg_get_functiondef(p.oid) like '%quiz_question_count%'`,
    );
    assert(
      refs.length === 0,
      `新方式が quiz_question_count を参照している: ${JSON.stringify(refs)}`,
    );

    // 互換のために列は残っていること
    const { rows: cols } = await db.query(
      `select table_name from information_schema.columns
        where table_schema = 'public' and column_name = 'quiz_question_count'
        order by table_name`,
    );
    assert(
      cols.map((r) => r.table_name).join(",") === "draft_modes,draft_sessions",
      `互換期間に残すはずの旧列が揃っていない: ${JSON.stringify(cols)}`,
    );

    // 旧い画面のモード一覧が読めること
    const { rows: priv } = await db.query(
      `select has_column_privilege('anon', 'public.draft_modes',
                                   'quiz_question_count', 'select') as ok`,
    );
    assert(priv[0].ok === true, "anon が draft_modes.quiz_question_count を読めない");

    const { rows: fn } = await db.query(
      `select p.oid::regprocedure::text as sig from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'build_quiz_for_prompt'`,
    );
    assert(fn.length === 1, `build_quiz_for_prompt が ${fn.length} 本ある`);
    assert(
      fn[0].sig === "build_quiz_for_prompt(uuid)",
      `問数の引数が残っている: ${fn[0].sig}`,
    );
  });

  /* ---------------------------------------------------------------------
   * K. カラーは状態ではない（独立した上位種別）
   *
   *   出所: ユーザー発言「カラーは状態ではありません。
   *   状態カテゴリは8つのまま維持してください」（2026-09-05）。
   * ------------------------------------------------------------------- */

  await test("K", "上位種別は モーフ1・状態8・カラー1", async () => {
    const { rows } = await db.query(
      `select kind, count(*)::int as n from public.draw_categories
        where is_active group by kind order by kind`,
    );
    const byKind = new Map(rows.map((r) => [r.kind, r.n]));
    assert(byKind.get("morph") === 1, `モーフが ${byKind.get("morph")} 件`);
    assert(byKind.get("state") === 8, `状態が ${byKind.get("state")} 件（8のはず）`);
    assert(byKind.get("color") === 1, `カラーが ${byKind.get("color")} 件`);
    assert(byKind.size === 3, `上位種別が ${byKind.size} 種類ある`);
  });

  await test("K", "状態カテゴリの一覧にカラーが混ざらない", async () => {
    const { rows } = await db.query(
      `select category_key from public.draw_categories
        where is_active and kind = 'state' order by sort_order`,
    );
    const keys = rows.map((r) => r.category_key);
    assert(!keys.includes("color"), `状態の一覧にカラーがある: ${keys.join(",")}`);
    assert(
      keys.join(",") ===
        "emotion,action,body_state,change,environment,relation,property,social_state",
      `状態カテゴリの並びが違う: ${keys.join(",")}`,
    );
  });

  await test("K", "状態カテゴリの重複確率はカラーに当たらない", async () => {
    // 重複させる確率を 1.0 にしても、カラーは2語にならない。
    // **値ではなく、引く側の条件で外れていること**を見る。
    await db.query(
      `update public.draw_config set config_value = 1.0
        where config_key = 'state_category_repeat_ratio'`,
    );
    try {
      for (let i = 0; i < 30; i += 1) {
        const u = await makeMember(db, `color-repeat-${i}`);
        const p = await drawPrompt(db, u, { mode: i % 2 === 0 ? "normal" : "hard" });
        const cards = await promptTags(db, p.prompt_id);
        const colors = cards.filter((c) => c.pool_key === "color");
        assert(
          colors.length <= 1,
          `重複確率1.0でカラーが ${colors.length} 語になった`,
        );
      }
    } finally {
      await db.query(
        `update public.draw_config set config_value = 0.10
          where config_key = 'state_category_repeat_ratio'`,
      );
    }
  });

  await test("K", "開示したお題のカードが上位種別を持つ（カラーは color）", async () => {
    const u = await makeMember(db, "kind-reveal");
    const src = await buildPromptWithTags(db, u, ["傘", "赤"]);
    const workId = await postWork(db, u, src, "上位種別の作品");

    const revealed = await value(db, asMember(u), `select public.get_answered_prompt($1)`, [
      workId,
    ]);
    const kinds = new Map(revealed.cards.map((c) => [c.tag_label, c.element_kind]));
    assert(kinds.get("傘") === "morph", `傘が ${kinds.get("傘")}`);
    assert(kinds.get("赤") === "color", `赤が ${kinds.get("赤")}（color のはず）`);
  });

  await test("K", "手持ちの一覧でもカラーは color として返る", async () => {
    const u = await makeMember(db, "kind-saved");
    const src = await buildPromptWithTags(db, u, ["傘", "赤"]);
    const tags = await promptTags(db, src);
    const colorTag = tags.find((t) => t.pool_key === "color");

    const saved = await saveCarrySlot(db, u, src, [colorTag.tag_id]);
    const item = saved.items.find((x) => Number(x.tag_id) === colorTag.tag_id);
    assert(item.category_kind === "color", `カラーが ${item.category_kind} で返った`);
  });

  await test("K", "カラーのビタ当てと2択当てが、別々に保存・集計される", async () => {
    const u = await makeMember(db, "color-modes");
    const src = await buildPromptWithTags(db, u, ["傘", "赤"]);
    const workId = await postWork(db, u, src, "カラーの方式別");

    const a = await makeMember(db, "color-exact");
    await answerWork(db, a, workId, { correct: true });
    const b = await makeMember(db, "color-pair");
    await answerWork(db, b, workId, { correct: true, pair: "all" });

    // 回答の内訳に、カラーの枠のビタ当てと2択当てが1件ずつある
    const { rows: items } = await db.query(
      `select ai.answer_mode, ai.is_correct
         from public.answer_items ai
         join public.answers an on an.id = ai.answer_id
        where an.work_id = $1 and ai.card_slot_key like 'color\\_%'
        order by ai.answer_mode`,
      [workId],
    );
    assert(items.length === 2, `カラーの回答が ${items.length} 件（2件のはず）`);
    assert(items[0].answer_mode === "exact" && items[0].is_correct, "カラーのビタ当てが的中していない");
    assert(items[1].answer_mode === "pair" && items[1].is_correct, "カラーの2択当てが的中していない");

    // 集計もカラーの枠で方式別に分かれている
    const { rows: st } = await db.query(
      `select card_slot_key, exact_attempts, exact_corrects, pair_attempts, pair_corrects
         from public.work_slot_stats
        where work_id = $1 and card_slot_key like 'color\\_%'`,
      [workId],
    );
    assert(st.length === 1, `カラーの集計行が ${st.length} 件`);
    assert(st[0].exact_attempts === 1 && st[0].exact_corrects === 1, "カラーのビタ当てが積まれていない");
    assert(st[0].pair_attempts === 1 && st[0].pair_corrects === 1, "カラーの2択当てが積まれていない");

    // 作者へ返す結果でも、カラーは「状態」にまとめられず枠として出る
    const result = await value(db, asMember(u), `select public.get_my_work_result($1)`, [workId]);
    const colorSlot = result.slots.find((x) => x.card_slot_key.startsWith("color_"));
    assert(colorSlot, "作者向けの結果にカラーの枠が無い");
    assert(colorSlot.card_slot_label === "カラー", `カラーの呼び名が ${colorSlot.card_slot_label}`);
    assert(colorSlot.exact_attempts === 1 && colorSlot.pair_attempts === 1, "方式別が分かれていない");
  });

  await test("K", "語彙の棚卸しでもカラーは state ではない", async () => {
    const { rows } = await db.query(
      `select distinct element_kind from public.vocab_inventory()
        where category_key = 'color'`,
    );
    assert(rows.length === 1, `カラーの上位種別が ${rows.length} 種類ある`);
    assert(rows[0].element_kind === "color", `カラーが ${rows[0].element_kind}`);
  });

  /* ---------------------------------------------------------------------
   * L. 持ち出しの出所は、申告ではなく DB で決まる
   * ------------------------------------------------------------------- */

  await test("L", "自分の作品からの持ち出しは、何を送っても self になる", async () => {
    const me = await makeMember(db, "carry-self-owner");
    const p = await drawPrompt(db, me);
    const workId = await postWork(db, me, p.prompt_id, "自分の作品");
    const tags = await promptTags(db, p.prompt_id);

    const saved = await value(
      db,
      asMember(me),
      `select public.save_prompt_elements('work', $1, $2, true)`,
      [workId, [tags[0].tag_id]],
    );
    const item = saved.items[0];
    assert(item.scope === "self", `区分が ${item.scope}（self のはず）`);
    assert(item.source_is_own === true, "自分由来として記録されていない");
  });

  await test("L", "他人の作品からの持ち出しは、何を送っても others になる", async () => {
    const owner = await makeMember(db, "carry-other-owner");
    const p = await drawPrompt(db, owner);
    const workId = await postWork(db, owner, p.prompt_id, "他人の作品");

    const reader = await makeMember(db, "carry-other-reader");
    await answerWork(db, reader, workId);
    const tags = await promptTags(db, p.prompt_id);

    const saved = await value(
      db,
      asMember(reader),
      `select public.save_prompt_elements('work', $1, $2, true)`,
      [workId, [tags[0].tag_id]],
    );
    const item = saved.items[0];
    assert(item.scope === "others", `区分が ${item.scope}（others のはず）`);
    assert(item.source_is_own === false, "他者由来として記録されていない");
  });

  await test("L", "他人のお題を 'prompt' として送っても保存できない", async () => {
    const owner = await makeMember(db, "carry-prompt-owner");
    const p = await drawPrompt(db, owner);
    const thief = await makeMember(db, "carry-prompt-thief");
    const tags = await promptTags(db, p.prompt_id);

    await expectFailure(
      () =>
        value(
          db,
          asMember(thief),
          `select public.save_prompt_elements('prompt', $1, $2, true)`,
          [p.prompt_id, [tags[0].tag_id]],
        ),
      "SOURCE_NOT_FOUND",
    );
  });

  await test("L", "未回答の他人の作品からは持ち出せない", async () => {
    const owner = await makeMember(db, "carry-noans-own");
    const p = await drawPrompt(db, owner);
    const workId = await postWork(db, owner, p.prompt_id, "未回答の作品");
    const stranger = await makeMember(db, "carry-noans-str");
    const tags = await promptTags(db, p.prompt_id);

    await expectFailure(
      () =>
        value(
          db,
          asMember(stranger),
          `select public.save_prompt_elements('work', $1, $2, true)`,
          [workId, [tags[0].tag_id]],
        ),
      "SOURCE_NOT_AVAILABLE",
    );
  });

  await test("L", "非公開・削除済みの作品からは、回答済みでも持ち出せない", async () => {
    const owner = await makeMember(db, "carry-hidden-owner");
    const p = await drawPrompt(db, owner);
    const workId = await postWork(db, owner, p.prompt_id, "あとで隠す作品");
    const reader = await makeMember(db, "carry-hidden-reader");
    await answerWork(db, reader, workId);
    const tags = await promptTags(db, p.prompt_id);

    await db.query(`update public.works set is_published = false where id = $1`, [workId]);
    await expectFailure(
      () =>
        value(db, asMember(reader), `select public.save_prompt_elements('work', $1, $2, true)`, [
          workId,
          [tags[0].tag_id],
        ]),
      "SOURCE_NOT_AVAILABLE",
    );

    await db.query(
      `update public.works set is_published = true, deleted_at = now() where id = $1`,
      [workId],
    );
    await expectFailure(
      () =>
        value(db, asMember(reader), `select public.save_prompt_elements('work', $1, $2, true)`, [
          workId,
          [tags[0].tag_id],
        ]),
      "SOURCE_NOT_AVAILABLE",
    );
  });

  await test("L", "そのお題に無い語・存在しない語は混ぜられない", async () => {
    const me = await makeMember(db, "carry-foreign-tag");
    const mine = await buildPromptWithTags(db, me, ["傘", "赤"]);
    const otherPrompt = await buildPromptWithTags(db, me, ["蝶", "青"]);

    const mineTags = await promptTags(db, mine);
    const otherTags = await promptTags(db, otherPrompt);

    // 別のお題の語を混ぜる ＝ 1つの枠に2つのお題が入る
    await expectFailure(
      () => saveCarrySlot(db, me, mine, [mineTags[0].tag_id, otherTags[0].tag_id]),
      "ELEMENT_NOT_IN_PROMPT",
    );

    // 存在しない語
    await expectFailure(
      () => saveCarrySlot(db, me, mine, [mineTags[0].tag_id, 99999999]),
      "ELEMENT_NOT_IN_PROMPT",
    );
  });

  await test("L", "ゲストが永続を求めても、永続の行はできない", async () => {
    const g = await makeGuest(db);
    const src = await buildPromptWithTags(db, g, ["傘", "赤"]);
    const tags = await promptTags(db, src);

    const saved = await value(
      db,
      asGuest(g),
      `select public.save_prompt_elements('prompt', $1, $2, true)`,
      [src, [tags[0].tag_id]],
    );

    assert(saved.items.every((i) => i.scope === "session"), "ゲストの持ち出しが session でない");
    assert(saved.can_persist === false, "ゲストに永続できると返している");

    const { rows } = await db.query(
      `select count(*)::int as n from public.saved_carry_slots
        where user_id = $1 and scope <> 'session'`,
      [g],
    );
    assert(rows[0].n === 0, `ゲストの永続枠が ${rows[0].n} 件できている`);
  });

  /* ---------------------------------------------------------------------
   * M. ビタ当てと2択当てを、同じ割合に混ぜない
   * ------------------------------------------------------------------- */

  await test("M", "回答者×枠の集計も方式別に積まれる", async () => {
    const owner = await makeMember(db, "mode-uss-owner");
    const p = await drawPrompt(db, owner);
    const workId = await postWork(db, owner, p.prompt_id, "方式別の集計");

    const r = await makeMember(db, "mode-uss-reader");
    await answerWork(db, r, workId, { correct: true, pair: "all" });

    const { rows } = await db.query(
      `select sum(exact_attempts)::int as e, sum(pair_attempts)::int as p,
              sum(pair_corrects)::int as pc
         from public.user_slot_stats where user_id = $1`,
      [r],
    );
    assert(rows[0].e === 0, `ビタ当てが ${rows[0].e} 件（0のはず）`);
    assert(rows[0].p > 0, "2択当てが積まれていない");
    assert(rows[0].pc === rows[0].p, "2択当ての的中が積まれていない");
  });

  await test("M", "作品の項目別に、方式別の数がそろって出る", async () => {
    const owner = await makeMember(db, "mode-detail-owner");
    const p = await drawPrompt(db, owner);
    const workId = await postWork(db, owner, p.prompt_id, "方式別の項目");

    const a = await makeMember(db, "mode-detail-a");
    await answerWork(db, a, workId, { correct: true });
    const b = await makeMember(db, "mode-detail-b");
    await answerWork(db, b, workId, { correct: true, pair: "all" });

    const detail = await value(db, ANON, `select public.get_work_detail($1)`, [workId]);
    for (const st of detail.slot_stats) {
      assert(st.exact_attempts === 1, `${st.card_slot_key} のビタ当てが ${st.exact_attempts}`);
      assert(st.pair_attempts === 1, `${st.card_slot_key} の2択当てが ${st.pair_attempts}`);
      assert(
        st.attempts === st.exact_attempts + st.pair_attempts,
        "合計が内訳と合わない",
      );
    }
  });

  await test("M", "作者の伝わりやすさは、2択当てだけでは埋まらない", async () => {
    const owner = await makeMember(db, "mode-profile-owner");
    const p = await drawPrompt(db, owner);
    const workId = await postWork(db, owner, p.prompt_id, "2択だけの作品");

    // 5人が全問2択当てで的中する（伝わりやすさの対象は回答5人以上）
    for (let i = 0; i < 5; i += 1) {
      const r = await makeMember(db, `mode-profile-r${i}`);
      await answerWork(db, r, workId, { correct: true, pair: "all" });
    }

    await db.query(
      `update public.profiles set show_creator_stats = true where id = $1`,
      [owner],
    );

    const profile = await value(db, ANON, `select public.get_public_profile($1)`, [
      "mode-profile-owner",
    ]);

    assert(
      profile.creator.accuracy === null,
      `ビタ当てが0件なのに伝わりやすさが ${profile.creator.accuracy} と出ている`,
    );
    assert(
      Number(profile.creator.pair_accuracy) === 1,
      `2択当ての割合が ${profile.creator.pair_accuracy}（1のはず）`,
    );

    // ランキングの伝達率も、ビタ当てだけで見る
    const { rows } = await db.query(
      `select accuracy from public.get_rankings('accuracy', 'normal', null, 50, 0)
        where id = $1`,
      [workId],
    );
    assert(
      rows.length === 0,
      "2択当てだけの作品が伝達率ランキングに並んでいる（混ぜている）",
    );
  });

  /* ---------------------------------------------------------------------
   * N. 次の作品の配給と、一覧の「未回答のみ」（D169）
   *
   * 【この節が見ているもの】
   *   1. 候補の資格   … 自作・回答済み・非公開・審査未通過・削除・別部門を外す
   *   2. 部門の引き継ぎ … いま答えた作品と同じ部門しか出ない
   *   3. 救済帯       … 回答0件があればその中だけ。無ければ回答1件以上
   *   4. 一覧の絞り込み … 回答済みを、ページを切る前に外す
   *
   * 【乱数の試し方】
   *   「何回か引いて両方出たら合格」にはしない。それは確率に頼る試験で、
   *   落ちるときも通るときも理由が分からない。ここで見るのは
   *   **候補の集合と帯**という、引く前に決まっているもの。
   *   引いた結果については「その帯の中に属すること」だけを見る。
   * ------------------------------------------------------------------- */

  /** 部門を指定して作品を1件作る（お題を引くところから） */
  async function makeWorkIn(uid, division, title) {
    const p = await drawPrompt(db, uid);
    return postWork(db, uid, p.prompt_id, title ?? `${division} の作品`, { division });
  }

  /** その人にとっての候補（work_id → band） */
  async function candidatesFor(uid, currentWorkId, { guest = false } = {}) {
    const who = guest ? asGuest(uid) : asMember(uid);
    const { rows } = await asRole(db, who, async (c) =>
      c.query(`select work_id, band from public.next_work_candidates($1)`, [currentWorkId]),
    );
    return new Map(rows.map((r) => [r.work_id, Number(r.band)]));
  }

  async function nextWorkFor(uid, currentWorkId, { guest = false } = {}) {
    const who = guest ? asGuest(uid) : asMember(uid);
    return value(db, who, `select public.get_next_work($1)`, [currentWorkId]);
  }

  await test("N", "次の作品の候補から、自作・回答済み・現在作品が外れる", async () => {
    const me = await makeMember(db, "n-self");
    const other = await makeMember(db, "n-other-1");

    const mine = await makeWorkIn(me, "original", "自分の作品");
    const current = await makeWorkIn(other, "original", "いま見ている作品");
    const answered = await makeWorkIn(other, "original", "もう答えた作品");
    const fresh = await makeWorkIn(other, "original", "まだ答えていない作品");

    await answerWork(db, me, answered);

    const cand = await candidatesFor(me, current);
    assert(!cand.has(mine), "自分の作品が候補に入っている");
    assert(!cand.has(current), "いま見ている作品が候補に入っている");
    assert(!cand.has(answered), "回答済みの作品が候補に入っている");
    assert(cand.has(fresh), "まだ答えていない作品が候補に入っていない");
  });

  await test("N", "非公開・審査未通過・削除済みの作品は候補に入らない", async () => {
    const me = await makeMember(db, "n-vis");
    const other = await makeMember(db, "n-other-2");

    const current = await makeWorkIn(other, "original", "いま見ている作品");
    const hidden = await makeWorkIn(other, "original", "非公開");
    const flagged = await makeWorkIn(other, "original", "審査未通過");
    const deleted = await makeWorkIn(other, "original", "削除済み");

    // 表を直接触るのは試験の準備。アプリにこの経路は無い
    await db.query(`update public.works set is_published = false where id = $1`, [hidden]);
    await db.query(`update public.works set review_status = 'flagged' where id = $1`, [flagged]);
    await db.query(`update public.works set deleted_at = now() where id = $1`, [deleted]);

    const cand = await candidatesFor(me, current);
    assert(!cand.has(hidden), "非公開の作品が候補に入っている");
    assert(!cand.has(flagged), "審査未通過の作品が候補に入っている");
    assert(!cand.has(deleted), "削除済みの作品が候補に入っている");
  });

  await test("N", "部門を引き継ぐ（オリジナル→オリジナル／ファンアート→ファンアート／AI→AI）", async () => {
    const me = await makeMember(db, "n-div");
    const other = await makeMember(db, "n-other-3");

    const currentByDivision = {};
    const targetByDivision = {};
    for (const d of ["original", "fanart", "ai"]) {
      currentByDivision[d] = await makeWorkIn(other, d, `${d} いま見ている`);
      targetByDivision[d] = await makeWorkIn(other, d, `${d} 次の候補`);
    }

    for (const d of ["original", "fanart", "ai"]) {
      const cand = await candidatesFor(me, currentByDivision[d]);
      assert(cand.size > 0, `${d} の候補が0件（作ったはずの作品が出ていない）`);

      const { rows } = await db.query(
        `select id, division from public.works where id = any($1::uuid[])`,
        [[...cand.keys()]],
      );
      const wrong = rows.filter((r) => r.division !== d);
      assert(
        wrong.length === 0,
        `${d} の次の作品に別部門が ${wrong.length} 件混ざっている: ` +
          wrong.map((r) => r.division).join(","),
      );
      assert(cand.has(targetByDivision[d]), `${d} の候補が拾えていない`);
    }
  });

  await test("N", "新しい入口には部門の引数が無い（旧い入口は互換のためだけに残る）", async () => {
    // **画面やURLを書き換えて別部門を取る、という道をふさげているか。**
    // 新しい入口は引数が1つ（現在作品のID）しか無いので、渡す値が存在しない。
    // 旧い入口（2引数）は互換期間だけ残すが、部門は受け取っても使わない。
    const { rows } = await db.query(
      `select p.pronargs::int as n, p.pronargdefaults::int as d
         from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
        where ns.nspname = 'public' and p.proname = 'get_next_work'
        order by p.pronargs`,
    );
    assert(rows.length === 2, `get_next_work が ${rows.length} 個ある（新旧の2個のはず）`);
    assert(rows[0].n === 1, `新しい get_next_work の引数が ${rows[0].n} 個（1個のはず）`);
    assert(rows[1].n === 2, `旧い get_next_work の引数が ${rows[1].n} 個（2個のはず）`);

    // 旧い入口に既定値があると、引数1個の呼び出しが両方に当てはまって
    // **新旧どちらの画面も落ちる。**既定値が0個であることが並存の条件。
    assert(
      rows[1].d === 0,
      `旧い get_next_work に既定値が ${rows[1].d} 個ある（0個でないと呼び出しが曖昧になる）`,
    );

    const cnd = await db.query(
      `select p.pronargs::int as n
         from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
        where ns.nspname = 'public' and p.proname = 'next_work_candidates'`,
    );
    assert(cnd.rows[0].n === 1, "next_work_candidates も引数は現在作品のIDだけのはず");
  });

  /* ---------------------------------------------------------------------
   * N-互換. 旧い画面が新しいDBを叩いても壊れない
   *
   *   本番は「DBを先に更新し、そのあと画面を差し替える」順で当てる。
   *   その間、旧い画面と新しいDBが同時に動く。ここはその時間帯の試験。
   * ------------------------------------------------------------------- */

  await test("N", "旧い呼び方（2引数）でも次の作品が返る", async () => {
    const me = await makeMember(db, "compat-next-me");
    const other = await makeMember(db, "compat-next-other");
    const current = await makeWorkIn(other, "original", "互換 いま見ている");
    await makeWorkIn(other, "original", "互換 次の候補");

    const r = await value(
      db,
      asMember(me),
      `select public.get_next_work($1, $2)`,
      [current, null],
    );
    assert(r.has_next === true, "旧い呼び方で次の作品が返らない");
  });

  await test("N", "旧い呼び方で部門を改ざんしても、同じ部門しか返らない", async () => {
    const me = await makeMember(db, "compat-tamper-me");
    const other = await makeMember(db, "compat-tamper-other");

    // いま見ているのはファンアート。別部門の作品も用意しておく
    const current = await makeWorkIn(other, "fanart", "改ざん いま見ている");
    await makeWorkIn(other, "fanart", "改ざん 同部門の候補");
    await makeWorkIn(other, "original", "改ざん 別部門");
    await makeWorkIn(other, "ai", "改ざん AI部門");

    // 旧い画面のふりをして、別部門を要求する
    for (const tampered of ["original", "ai", "all", null, "でたらめ"]) {
      const r = await value(
        db,
        asMember(me),
        `select public.get_next_work($1, $2)`,
        [current, tampered],
      );
      assert(r.has_next === true, `部門 ${tampered} を渡したら候補が消えた`);

      const { rows } = await db.query(
        `select division from public.works where id = $1`,
        [r.work_id],
      );
      assert(
        rows[0].division === "fanart",
        `部門 ${tampered} を渡したら ${rows[0].division} の作品が返った（fanart のはず）`,
      );
    }
  });

  await test("N", "一覧は旧5引数でも新6引数でも呼べる（呼び先が1つに決まる）", async () => {
    const sigs = await db.query(
      `select p.pronargs::int as n, p.pronargdefaults::int as d
         from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
        where ns.nspname = 'public' and p.proname = 'get_public_works'
        order by p.pronargs`,
    );
    assert(sigs.rows.length === 2, `get_public_works が ${sigs.rows.length} 個ある（2個のはず）`);
    assert(sigs.rows[0].n === 5, "旧5引数版が無い（旧い画面の一覧が落ちる）");
    assert(sigs.rows[1].n === 6, "新6引数版が無い");
    // 新6引数版に既定値があると、5引数の呼び出しが曖昧になる
    assert(
      sigs.rows[1].d === 0,
      `新6引数版に既定値が ${sigs.rows[1].d} 個ある（0個でないと呼び出しが曖昧になる）`,
    );

    // 実際に呼べること。**曖昧かどうかは呼んでみないと分からない。**
    await asRole(db, ANON, async (c) => {
      await c.query(`select count(*) from public.get_public_works(null,'new',5,0)`);
      await c.query(`select count(*) from public.get_public_works(null,'new',5,0,null)`);
      await c.query(
        `select count(*) from public.get_public_works(
           p_division := null, p_sort := 'new', p_limit := 5,
           p_offset := 0, p_completeness := null)`,
      );
      await c.query(`select count(*) from public.get_public_works(null,'new',5,0,null,false)`);
      await c.query(
        `select count(*) from public.get_public_works(
           p_division := null, p_sort := 'new', p_limit := 5,
           p_offset := 0, p_completeness := null, p_unanswered_only := true)`,
      );
    });
  });

  await test("N", "旧5引数の一覧は、未回答フィルタを掛けない従来表示になる", async () => {
    const author = await makeMember(db, "compat-list-author");
    const reader = await makeMember(db, "compat-list-reader");
    const answered = await makeWorkIn(author, "original", "互換一覧 回答済み");
    await answerWork(db, reader, answered, { correct: true });

    const oldWay = await asRole(db, asMember(reader), async (c) => {
      const r = await c.query(`select id from public.get_public_works(null,'new',50,0,null)`);
      return r.rows.map((x) => x.id);
    });
    assert(
      oldWay.includes(answered),
      "旧5引数の一覧から回答済み作品が消えている（従来表示が変わっている）",
    );

    const newWay = await asRole(db, asMember(reader), async (c) => {
      const r = await c.query(
        `select id from public.get_public_works(null,'new',50,0,null,true)`,
      );
      return r.rows.map((x) => x.id);
    });
    assert(
      !newWay.includes(answered),
      "新6引数の未回答フィルタが効いていない",
    );
  });

  await test("N", "AI部門で候補が0件でも、通常部門へは落ちない", async () => {
    const me = await makeMember(db, "n-ai-empty");
    const other = await makeMember(db, "n-other-4");

    // AI は「いま見ている1件」だけにする。ほかの AI 作品は全部答えておく
    const currentAi = await makeWorkIn(other, "ai", "AI いま見ている");
    const { rows: aiRows } = await db.query(
      `select id from public.works
        where division = 'ai' and is_published and review_status = 'ok'
          and deleted_at is null and id <> $1 and user_id <> $2`,
      [currentAi, me],
    );
    for (const r of aiRows) await answerWork(db, me, r.id);

    const cand = await candidatesFor(me, currentAi);
    assert(cand.size === 0, `AI の候補が ${cand.size} 件残っている（0件にしたはず）`);

    const next = await nextWorkFor(me, currentAi);
    assert(next.has_next === false, "AI の候補が0件なのに次の作品が返っている");
    assert(next.work_id === null, `AI から ${next.work_id} が返った（通常部門へ落ちている）`);
  });

  await test("N", "回答0件の作品があるときは、回答1件以上が候補集合に残らない", async () => {
    const me = await makeMember(db, "n-band1");
    const other = await makeMember(db, "n-other-5");
    const answerers = [];
    for (let i = 0; i < 3; i += 1) answerers.push(await makeMember(db, `n-ans-${i}`));

    const current = await makeWorkIn(other, "fanart", "帯の試験・いま見ている");
    const zero = await makeWorkIn(other, "fanart", "回答0件");
    const one = await makeWorkIn(other, "fanart", "回答1件");
    const many = await makeWorkIn(other, "fanart", "回答3件");

    await answerWork(db, answerers[0], one);
    for (const a of answerers) await answerWork(db, a, many);

    const cand = await candidatesFor(me, current);
    assert(cand.get(zero) === 1, `回答0件の作品の帯が ${cand.get(zero)}（1のはず）`);
    assert(cand.get(one) === 2, `回答1件の作品の帯が ${cand.get(one)}（2のはず）`);
    assert(cand.get(many) === 2, `回答3件の作品の帯が ${cand.get(many)}（2のはず）`);

    // **1件と3件が同じ帯にいる。**回答数の少ない順に並べていない証拠
    assert(
      cand.get(one) === cand.get(many),
      "回答1件と回答3件が別の帯に入っている（回答数で順位を付けている）",
    );

    // 第1帯があるあいだ、返るのは必ず第1帯の中
    const band1 = [...cand.entries()].filter(([, b]) => b === 1).map(([id]) => id);
    for (let i = 0; i < 12; i += 1) {
      const next = await nextWorkFor(me, current);
      assert(next.has_next === true, "候補があるのに次の作品が返らない");
      assert(
        band1.includes(next.work_id),
        `第1帯があるのに、第1帯の外（${next.work_id}）が返った`,
      );
    }
  });

  await test("N", "回答0件が無いときだけ、回答1件以上から返る", async () => {
    const me = await makeMember(db, "n-band2");
    const other = await makeMember(db, "n-other-6");
    const a1 = await makeMember(db, "n-ans-b1");

    const current = await makeWorkIn(other, "ai", "帯2の試験・いま見ている");
    const one = await makeWorkIn(other, "ai", "AI 回答1件");
    const ten = await makeWorkIn(other, "ai", "AI 回答10件");

    await answerWork(db, a1, one);
    for (let i = 0; i < 10; i += 1) {
      const r = await makeMember(db, `n-ans-ten-${i}`);
      await answerWork(db, r, ten);
    }

    // 同じ部門の回答0件を全部つぶす（この人にとっての第1帯を空にする）
    const before = await candidatesFor(me, current);
    for (const [id, band] of before) {
      if (band === 1) {
        const filler = await makeMember(db, `n-fill-${id.slice(0, 8)}`);
        await answerWork(db, filler, id);
      }
    }

    const cand = await candidatesFor(me, current);
    const bands = new Set(cand.values());
    assert(!bands.has(1), "第1帯を空にしたのに、まだ第1帯の作品が残っている");
    assert(cand.get(one) === 2 && cand.get(ten) === 2, "1回答と10回答が第2帯にいない");

    // **1回答へ固定されない。**引いた結果は必ず第2帯の中にある
    const pool = [...cand.keys()];
    for (let i = 0; i < 12; i += 1) {
      const next = await nextWorkFor(me, current);
      assert(next.has_next === true, "第2帯に候補があるのに返らない");
      assert(pool.includes(next.work_id), "候補集合の外の作品が返った");
    }
  });

  await test("N", "両方の帯に候補が無ければ、行き止まりを示して返る", async () => {
    const me = await makeMember(db, "n-empty");
    const other = await makeMember(db, "n-other-7");
    const current = await makeWorkIn(other, "fanart", "候補なしの試験");

    // 同じ部門の候補を全部つぶす
    let cand = await candidatesFor(me, current);
    for (const id of cand.keys()) await answerWork(db, me, id);
    cand = await candidatesFor(me, current);
    assert(cand.size === 0, `候補が ${cand.size} 件残っている`);

    const next = await nextWorkFor(me, current);
    assert(next.has_next === false, "候補0件なのに has_next が true");
    assert(next.work_id === null, "候補0件なのに作品IDが返っている");
  });

  await test("N", "存在しない・見えない作品IDを渡しても、中身を漏らさず行き止まりで返る", async () => {
    const me = await makeMember(db, "n-unknown");
    const other = await makeMember(db, "n-other-8");
    const hidden = await makeWorkIn(other, "original", "非公開の現在作品");
    await db.query(`update public.works set is_published = false where id = $1`, [hidden]);

    for (const id of ["00000000-0000-0000-0000-000000000000", hidden]) {
      const next = await nextWorkFor(me, id);
      assert(
        next.has_next === false && next.work_id === null,
        `見えない作品IDに対して ${JSON.stringify(next)} が返った`,
      );
    }
  });

  await test("N", "一覧の「未回答のみ」が、回答済みだけを外す", async () => {
    const me = await makeMember(db, "n-list");
    const other = await makeMember(db, "n-other-9");

    const answered = await makeWorkIn(other, "original", "一覧・回答済み");
    const notYet = await makeWorkIn(other, "original", "一覧・未回答");
    await answerWork(db, me, answered);

    const listed = async (only) => {
      const { rows } = await asRole(db, asMember(me), async (c) =>
        c.query(
          `select id from public.get_public_works(null, 'new', 50, 0, null, $1)`,
          [only],
        ),
      );
      return rows.map((r) => r.id);
    };

    const on = await listed(true);
    const off = await listed(false);

    assert(!on.includes(answered), "「未回答のみ」に回答済みの作品が出ている");
    assert(on.includes(notYet), "「未回答のみ」に未回答の作品が出ていない");
    assert(off.includes(answered), "OFF なのに回答済みの作品が消えている");
    assert(off.includes(notYet), "OFF で未回答の作品が消えている");
  });

  await test("N", "「未回答のみ」は、部門・完成度・並び順と同時に使える", async () => {
    const me = await makeMember(db, "n-list-mix");
    const other = await makeMember(db, "n-other-10");

    const made = {};
    for (const d of ["original", "fanart", "ai"]) {
      made[`${d}-answered`] = await makeWorkIn(other, d, `併用・${d}・回答済み`);
      made[`${d}-fresh`] = await makeWorkIn(other, d, `併用・${d}・未回答`);
      await answerWork(db, me, made[`${d}-answered`]);
    }

    // 完成度は投稿後に付ける（set_work_completeness を通す経路が既にある）
    await db.query(
      `update public.works set completeness = 'sketch' where id = any($1::uuid[])`,
      [[made["original-fresh"], made["original-answered"]]],
    );

    const listed = async (division, sort, completeness) => {
      const { rows } = await asRole(db, asMember(me), async (c) =>
        c.query(
          `select id from public.get_public_works($1, $2, 50, 0, $3, true)`,
          [division, sort, completeness],
        ),
      );
      return rows.map((r) => r.id);
    };

    for (const d of ["original", "fanart", "ai"]) {
      for (const sort of ["new", "likes", "answers"]) {
        const ids = await listed(d, sort, null);
        assert(
          !ids.includes(made[`${d}-answered`]),
          `部門 ${d} ／並び ${sort} で、回答済みの作品が出ている`,
        );
        assert(
          ids.includes(made[`${d}-fresh`]),
          `部門 ${d} ／並び ${sort} で、未回答の作品が出ていない`,
        );
      }
    }

    const sketch = await listed("original", "new", "sketch");
    assert(
      sketch.includes(made["original-fresh"]) && !sketch.includes(made["original-answered"]),
      "完成度と併用したときに、未回答の絞り込みが効いていない",
    );
  });

  await test("N", "「未回答のみ」は、ページを切る前に外している", async () => {
    // **画面で捨てる作りだと、ここが崩れる。**
    // 1ページ3件で2ページぶん取り、どのページにも回答済みが混ざらないこと、
    // かつ件数が欠けないことを見る。
    const me = await makeMember(db, "n-page");
    const other = await makeMember(db, "n-other-11");

    const fresh = [];
    const answered = [];
    for (let i = 0; i < 7; i += 1) {
      const w = await makeWorkIn(other, "fanart", `ページ試験 ${i}`);
      // 1つおきに回答済みにする。**新着順で交互に並ぶ**ので、
      // 取ってから捨てる作りなら1ページの件数がばらつく
      if (i % 2 === 0) {
        await answerWork(db, me, w);
        answered.push(w);
      } else {
        fresh.push(w);
      }
    }

    const page = async (offset) => {
      const { rows } = await asRole(db, asMember(me), async (c) =>
        c.query(
          `select id from public.get_public_works('fanart', 'new', 3, $1, null, true)`,
          [offset],
        ),
      );
      return rows.map((r) => r.id);
    };

    const p1 = await page(0);
    const p2 = await page(3);

    assert(p1.length === 3, `1ページ目が ${p1.length} 件（3件のはず）`);
    for (const id of [...p1, ...p2]) {
      assert(!answered.includes(id), "ページ送りの先に回答済みの作品が混ざっている");
    }
    assert(
      new Set([...p1, ...p2]).size === p1.length + p2.length,
      "1ページ目と2ページ目に同じ作品が出ている",
    );
  });

  await test("N", "匿名の利用者でも、その人の回答で「未回答のみ」が効く", async () => {
    const guest = await makeGuest(db);
    const other = await makeMember(db, "n-other-12");

    const answered = await makeWorkIn(other, "original", "ゲストが答えた作品");
    const notYet = await makeWorkIn(other, "original", "ゲストが答えていない作品");
    await answerWork(db, guest, answered, { guest: true });

    const { rows } = await asRole(db, asGuest(guest), async (c) =>
      c.query(`select id from public.get_public_works(null, 'new', 50, 0, null, true)`),
    );
    const ids = rows.map((r) => r.id);
    assert(!ids.includes(answered), "ゲストが答えた作品が「未回答のみ」に出ている");
    assert(ids.includes(notYet), "ゲストがまだ答えていない作品が出ていない");
  });

  await test("N", "誰か分からないときは絞り込まず、全件を返す", async () => {
    // **0件にしない。**「作品が1件も無い」と読めてしまうため。
    // 画面側は、この状態では絞り込みを押せないようにしている。
    const { rows: all } = await asRole(db, ANON, async (c) =>
      c.query(`select id from public.get_public_works(null, 'new', 50, 0, null, false)`),
    );
    const { rows: filtered } = await asRole(db, ANON, async (c) =>
      c.query(`select id from public.get_public_works(null, 'new', 50, 0, null, true)`),
    );
    assert(
      all.length === filtered.length && all.length > 0,
      `未サインインで件数が変わった（${all.length} → ${filtered.length}）`,
    );
  });

  await test("N", "作品を開いただけでは、一覧からも次の作品の候補からも消えない", async () => {
    // D118（見た作品を回答対象から外すか）は未確定のまま。
    // **ここで見ているのは回答の行だけ**であることを、実際に開いて確かめる。
    const me = await makeMember(db, "n-open");
    const other = await makeMember(db, "n-other-13");

    const current = await makeWorkIn(other, "original", "開くだけの試験・現在作品");
    const opened = await makeWorkIn(other, "original", "開くだけの作品");

    // アプリと同じ経路で「開く」（詳細と出題を読む。回答は送らない）
    await asRole(db, asMember(me), async (c) => {
      await c.query(`select public.get_work_detail($1)`, [opened]);
      await c.query(`select public.get_work_quiz($1)`, [opened]);
    });

    const { rows } = await asRole(db, asMember(me), async (c) =>
      c.query(`select id from public.get_public_works(null, 'new', 50, 0, null, true)`),
    );
    assert(
      rows.map((r) => r.id).includes(opened),
      "開いただけの作品が「未回答のみ」から消えている（D118 を先取りしている）",
    );

    const cand = await candidatesFor(me, current);
    assert(cand.has(opened), "開いただけの作品が次の作品の候補から消えている");
  });

  // ==========================================================================
  // O ／ D170 候補の配分・ドローと確定の分離・枠内の保持と開示
  // ==========================================================================

  /** 進行中のドラフトの状態を読む */
  async function draftState(uid) {
    return value(db, asMember(uid), `select public.get_current_draft() as s`);
  }

  await test("O", "配分の合計が総ドラフト基数と一致し、各枠2〜5枚に収まる", async () => {
    const u = await makeMember(db, "alloc1");
    for (let i = 0; i < 30; i++) {
      const st = await startDraftOnly(db, u, { mode: i % 2 ? "hard" : "normal" });
      const lots = st.slots.filter((x) => !x.is_carried);
      const counts = lots.map((x) => x.candidates.length);
      const total = counts.reduce((a, b) => a + b, 0);
      assert(total === lots.length * 3, `合計 ${total}（枠 ${lots.length} なら ${lots.length * 3}）`);
      assert(st.draft_base === total, `draft_base ${st.draft_base} と実数 ${total} が違う`);
      for (const n of counts) assert(n >= 2 && n <= 5, `枠に ${n} 枚配られた`);
      await asRole(db, asMember(u), (c) =>
        c.query(`select public.abandon_draft($1)`, [st.session_id]));
    }
  });

  await test("O", "3枠なら9枚、4枠なら12枚（枠数×3で決まる）", async () => {
    const u = await makeMember(db, "alloc2");
    const seen = new Map();
    for (let i = 0; i < 40; i++) {
      const st = await startDraftOnly(db, u, { mode: "normal" });
      const lots = st.slots.filter((x) => !x.is_carried);
      const total = lots.reduce((a, x) => a + x.candidates.length, 0);
      seen.set(lots.length, total);
      await asRole(db, asMember(u), (c) =>
        c.query(`select public.abandon_draft($1)`, [st.session_id]));
    }
    for (const [n, total] of seen) {
      assert(total === n * 3, `${n}枠のとき合計 ${total}（期待 ${n * 3}）`);
    }
    assert(seen.size >= 1, "枠数が1通りも観測できなかった");
  });

  await test("O", "配分が毎回同じ形に固定されていない", async () => {
    const u = await makeMember(db, "alloc3");
    const shapes = new Set();
    for (let i = 0; i < 40; i++) {
      const st = await startDraftOnly(db, u, { mode: "hard" });
      const lots = st.slots.filter((x) => !x.is_carried);
      shapes.add(lots.map((x) => x.candidates.length).join("/"));
      await asRole(db, asMember(u), (c) =>
        c.query(`select public.abandon_draft($1)`, [st.session_id]));
    }
    assert(shapes.size >= 2, `40回引いて配分が ${shapes.size} 通りしか出ていない`);
  });

  await test("O", "モーフは最低1枠・最大2枠（通常も高難度も）", async () => {
    const u = await makeMember(db, "morphcap");
    for (let i = 0; i < 60; i++) {
      const st = await startDraftOnly(db, u, { mode: i % 2 ? "hard" : "normal" });
      const morphs = st.slots.filter((x) => x.card_slot_key.startsWith("morph_")).length;
      assert(morphs >= 1, "モーフが0枠のお題が出た");
      assert(morphs <= 2, `モーフが ${morphs} 枠出た（上限2）`);
      await asRole(db, asMember(u), (c) =>
        c.query(`select public.abandon_draft($1)`, [st.session_id]));
    }
  });

  await test("O", "カラーは最大1枠。必須ではない", async () => {
    const u = await makeMember(db, "colorcap");
    let without = 0;
    for (let i = 0; i < 60; i++) {
      const st = await startDraftOnly(db, u, { mode: "normal" });
      const colors = st.slots.filter((x) => x.card_slot_key.startsWith("color_")).length;
      assert(colors <= 1, `カラーが ${colors} 枠出た（上限1）`);
      if (colors === 0) without++;
      await asRole(db, asMember(u), (c) =>
        c.query(`select public.abandon_draft($1)`, [st.session_id]));
    }
    assert(without > 0, "60回すべてにカラーが入った（必須になっている疑い）");
  });

  await test("O", "めくっただけでは決まらず、次の枠へも進まない", async () => {
    const u = await makeMember(db, "reveal1");
    const st = await startDraftOnly(db, u, { mode: "normal" });
    const slot = st.slots.find((x) => !x.is_carried);
    const after = await value(db, asMember(u),
      `select public.reveal_card($1, $2, 0) as s`, [st.session_id, slot.card_slot_key]);
    const s2 = after.slots.find((x) => x.card_slot_key === slot.card_slot_key);
    assert(s2.candidates[0].revealed === true, "めくった印が付いていない");
    assert(s2.candidates[0].is_chosen === false, "めくっただけで確定になった");
    assert(after.current_slot_order === st.current_slot_order, "枠が進んでしまった");
    assert(after.chosen_count === st.chosen_count, "確定数が増えた");
  });

  await test("O", "めくったあと読み込み直しても、同じカードがめくれたまま残る", async () => {
    const u = await makeMember(db, "reveal2");
    const st = await startDraftOnly(db, u, { mode: "normal" });
    const slot = st.slots.find((x) => !x.is_carried);
    await value(db, asMember(u), `select public.reveal_card($1, $2, 0) as s`,
      [st.session_id, slot.card_slot_key]);
    const again = await draftState(u);
    const s2 = again.slots.find((x) => x.card_slot_key === slot.card_slot_key);
    assert(s2.candidates[0].revealed === true, "読み込み直したらめくった印が消えた");
    assert(s2.candidates[0].is_chosen === false, "読み込み直したら確定になっていた");
  });

  await test("O", "同じドローを二重に送っても別の候補に変わらない", async () => {
    const u = await makeMember(db, "reveal3");
    const st = await startDraftOnly(db, u, { mode: "normal" });
    const slot = st.slots.find((x) => !x.is_carried);
    const a = await value(db, asMember(u), `select public.reveal_card($1, $2, 0) as s`,
      [st.session_id, slot.card_slot_key]);
    const b = await value(db, asMember(u), `select public.reveal_card($1, $2, 0) as s`,
      [st.session_id, slot.card_slot_key]);
    const pick = (x) => x.slots.find((y) => y.card_slot_key === slot.card_slot_key)
      .candidates[0].tag_id;
    assert(pick(a) === pick(b), "二度めくったら別の語になった");
  });

  await test("O", "決めて初めて次の枠へ進む。二重確定でも壊れない", async () => {
    const u = await makeMember(db, "choose1");
    const st = await startDraftOnly(db, u, { mode: "normal" });
    const slot = st.slots.find((x) => !x.is_carried);
    await value(db, asMember(u), `select public.reveal_card($1, $2, 0) as s`,
      [st.session_id, slot.card_slot_key]);
    const c1 = await value(db, asMember(u), `select public.choose_card($1, $2, 0) as s`,
      [st.session_id, slot.card_slot_key]);
    assert(c1.chosen_count === st.chosen_count + 1, "確定数が増えていない");
    assert(c1.current_slot_order > st.current_slot_order, "枠が進んでいない");
    const c2 = await value(db, asMember(u), `select public.choose_card($1, $2, 0) as s`,
      [st.session_id, slot.card_slot_key]);
    assert(c2.chosen_count === c1.chosen_count, "二重確定で数が動いた");
  });

  await test("O", "めくっていないカードは決められない", async () => {
    const u = await makeMember(db, "choose2");
    const st = await startDraftOnly(db, u, { mode: "normal" });
    const slot = st.slots.find((x) => !x.is_carried);
    await expectFailure(
      () => value(db, asMember(u), `select public.choose_card($1, $2, 1) as s`,
        [st.session_id, slot.card_slot_key]),
      "NOT_REVEALED",
    );
  });

  await test("O", "残せるのは min(2, 候補数 - 1) 枚まで。全部は残せない", async () => {
    const u = await makeMember(db, "hold1");
    const st = await startDraftOnly(db, u, { mode: "hard" });
    const slot = st.slots.find((x) => !x.is_carried);
    const n = slot.candidates.length;
    const limit = Math.min(2, n - 1);
    assert(slot.held_limit === limit, `held_limit が ${slot.held_limit}（期待 ${limit}）`);

    for (let i = 0; i < limit; i++) {
      await value(db, asMember(u), `select public.hold_card($1, $2, $3, true) as s
           from (select public.reveal_card($1, $2, $3)) as r`,
        [st.session_id, slot.card_slot_key, i]);
    }
    await expectFailure(
      () => value(db, asMember(u), `select public.hold_card($1, $2, $3, true) as s
             from (select public.reveal_card($1, $2, $3)) as r`,
        [st.session_id, slot.card_slot_key, limit]),
      "HOLD_LIMIT",
    );
  });

  await test("O", "残した候補があるときだけ、残りを開示できる", async () => {
    const u = await makeMember(db, "pool1");
    const st = await startDraftOnly(db, u, { mode: "hard" });
    const slot = st.slots.find((x) => !x.is_carried);
    await expectFailure(
      () => value(db, asMember(u), `select public.reveal_slot_pool($1, $2) as s`,
        [st.session_id, slot.card_slot_key]),
      "NOTHING_HELD",
    );
    await value(db, asMember(u), `select public.hold_card($1, $2, 0, true) as s
         from (select public.reveal_card($1, $2, 0)) as r`,
      [st.session_id, slot.card_slot_key]);
    const after = await value(db, asMember(u), `select public.reveal_slot_pool($1, $2) as s`,
      [st.session_id, slot.card_slot_key]);
    const s2 = after.slots.find((x) => x.card_slot_key === slot.card_slot_key);
    assert(s2.pool_revealed === true, "開示の印が付いていない");
    assert(s2.candidates.every((x) => x.revealed), "開示したのに伏せたままの候補がある");
  });

  await test("O", "開示しても候補は1枚も増えず、総ドラフト基数を超えない", async () => {
    const u = await makeMember(db, "pool2");
    const st = await startDraftOnly(db, u, { mode: "hard" });
    const before = st.slots.reduce((a, x) => a + x.candidates.length, 0);
    const slot = st.slots.find((x) => !x.is_carried);
    const n = slot.candidates.length;
    await value(db, asMember(u), `select public.hold_card($1, $2, 0, true) as s
         from (select public.reveal_card($1, $2, 0)) as r`,
      [st.session_id, slot.card_slot_key]);
    const after = await value(db, asMember(u), `select public.reveal_slot_pool($1, $2) as s`,
      [st.session_id, slot.card_slot_key]);
    const total = after.slots.reduce((a, x) => a + x.candidates.length, 0);
    assert(total === before, `候補が ${before} 枚から ${total} 枚に変わった`);
    const s2 = after.slots.find((x) => x.card_slot_key === slot.card_slot_key);
    assert(s2.candidates.length === n, "その枠の候補数が変わった");
  });

  await test("O", "開示した枠からも、ふつうに1枚選んで確定できる", async () => {
    const u = await makeMember(db, "pool3");
    const st = await startDraftOnly(db, u, { mode: "hard" });
    const slot = st.slots.find((x) => !x.is_carried);
    await value(db, asMember(u), `select public.hold_card($1, $2, 0, true) as s
         from (select public.reveal_card($1, $2, 0)) as r`,
      [st.session_id, slot.card_slot_key]);
    await value(db, asMember(u), `select public.reveal_slot_pool($1, $2) as s`,
      [st.session_id, slot.card_slot_key]);
    const last = slot.candidates.length - 1;
    const done = await value(db, asMember(u), `select public.choose_card($1, $2, $3) as s`,
      [st.session_id, slot.card_slot_key, last]);
    assert(done.chosen_count === st.chosen_count + 1, "開示後に確定できなかった");
  });

  await test("O", "カテゴリの表示名が、2つの表でずれていない", async () => {
    const { rows } = await db.query(`select * from public.category_label_mismatches()`);
    assert(rows.length === 0,
      `表示名がずれているカテゴリがある: ${rows.map((r) => r.category_key).join(", ")}`);
  });

  await test("O", "表示名は1回の呼び出しで抽選側も画面側も変わる", async () => {
    await db.query(`select public.set_category_label('color', '色あい')`);
    const { rows } = await db.query(
      `select dc.label as a, tp.label as b
         from public.draw_categories dc
         join public.tag_pools tp on tp.pool_key = dc.pool_key
        where dc.category_key = 'color'`);
    assert(rows[0].a === "色あい" && rows[0].b === "色あい",
      `片方しか変わっていない（${rows[0].a} / ${rows[0].b}）`);
    // 元に戻す。**この試験で最終名称を決めない**
    await db.query(`select public.set_category_label('color', 'カラー')`);
  });

  await test("O", "未開示なら、これまでどおり引き直せる", async () => {
    const u = await makeMember(db, "reroll-ok");
    const st = await startDraftOnly(db, u, { mode: "normal" });
    const after = await value(db, asMember(u), `select public.reroll_draft($1) as s`,
      [st.session_id]);
    assert(after.generation === st.generation + 1, "世代が進んでいない");
    assert(after.rerolls_left === st.rerolls_left - 1, "引き直しの残りが減っていない");
  });

  await test("O", "残りを開示した枠があると、引き直しを断る（RPCを直に叩いても）", async () => {
    const u = await makeMember(db, "reroll-ng");
    const st = await startDraftOnly(db, u, { mode: "hard" });
    const slot = st.slots.find((x) => !x.is_carried);
    await value(db, asMember(u), `select public.hold_card($1, $2, 0, true) as s
         from (select public.reveal_card($1, $2, 0)) as r`,
      [st.session_id, slot.card_slot_key]);
    await value(db, asMember(u), `select public.reveal_slot_pool($1, $2) as s`,
      [st.session_id, slot.card_slot_key]);
    await expectFailure(
      () => value(db, asMember(u), `select public.reroll_draft($1) as s`, [st.session_id]),
      "POOL_ALREADY_REVEALED",
    );
  });

  await test("O", "開示のあと読み込み直しても、開示済みのまま残る", async () => {
    const u = await makeMember(db, "reroll-keep");
    const st = await startDraftOnly(db, u, { mode: "hard" });
    const slot = st.slots.find((x) => !x.is_carried);
    await value(db, asMember(u), `select public.hold_card($1, $2, 0, true) as s
         from (select public.reveal_card($1, $2, 0)) as r`,
      [st.session_id, slot.card_slot_key]);
    await value(db, asMember(u), `select public.reveal_slot_pool($1, $2) as s`,
      [st.session_id, slot.card_slot_key]);
    const again = await draftState(u);
    const s2 = again.slots.find((x) => x.card_slot_key === slot.card_slot_key);
    assert(s2.pool_revealed === true, "読み込み直したら開示の印が消えた");
    assert(s2.candidates.every((x) => x.revealed), "読み込み直したら伏せ札が戻った");
  });

  await test("O", "開示しても、そのセッションで見られる候補の総数は増えない", async () => {
    const u = await makeMember(db, "reroll-cap");
    const st = await startDraftOnly(db, u, { mode: "hard" });
    const base = st.draft_base;
    const slot = st.slots.find((x) => !x.is_carried);
    await value(db, asMember(u), `select public.hold_card($1, $2, 0, true) as s
         from (select public.reveal_card($1, $2, 0)) as r`,
      [st.session_id, slot.card_slot_key]);
    await value(db, asMember(u), `select public.reveal_slot_pool($1, $2) as s`,
      [st.session_id, slot.card_slot_key]);
    const { rows } = await db.query(
      `select count(*)::int as n from public.draft_candidates where session_id = $1`,
      [st.session_id]);
    assert(rows[0].n === base, `候補の行が ${rows[0].n} 件（総数 ${base} のはず）`);
  });

  await test("O", "お題を放棄すると、未選択候補が開く（理由は abandoned）", async () => {
    const u = await makeMember(db, "abandon1");
    const { prompt_id: promptId } = await drawPrompt(db, u, {});
    const b = await db.query(
      `select candidates_revealed_at from public.prompts where id = $1`, [promptId]);
    assert(b.rows[0].candidates_revealed_at === null,
      "投稿も放棄もしていないのに開示済みになっている");

    await value(db, asMember(u), `select public.abandon_prompt($1) as s`, [promptId]);
    const row = (await db.query(
      `select reveal_reason as r, candidates_revealed_at as a, status as s
         from public.prompts where id = $1`, [promptId])).rows[0];
    assert(row.r === "abandoned", `理由が ${row.r}（abandoned のはず）`);
    assert(row.a !== null, "放棄したのに開示されていない");
    assert(row.s === "abandoned", `状態が ${row.s}`);
  });

  await test("O", "放棄したお題は、他人からは見えないまま", async () => {
    const mine = await makeMember(db, "abandon2");
    const other = await makeMember(db, "abandon3");
    const { prompt_id: promptId } = await drawPrompt(db, mine, {});
    await value(db, asMember(mine), `select public.abandon_prompt($1) as s`, [promptId]);
    const seen = await value(db, asMember(other),
      `select public.get_my_prompt($1) as s`, [promptId]);
    assert(seen === null, "他人に放棄済みのお題が見えた");
  });

  await test("O", "放棄は二度押しても壊れず、投稿済みのお題は放棄できない", async () => {
    const u = await makeMember(db, "abandon4");
    const { prompt_id: promptId } = await drawPrompt(db, u, {});
    await value(db, asMember(u), `select public.abandon_prompt($1) as s`, [promptId]);
    await value(db, asMember(u), `select public.abandon_prompt($1) as s`, [promptId]);

    const u2 = await makeMember(db, "abandon5");
    const { prompt_id: p2 } = await drawPrompt(db, u2, {});
    await postWork(db, u2, p2, {});
    await expectFailure(
      () => value(db, asMember(u2), `select public.abandon_prompt($1) as s`, [p2]),
      "ALREADY_SUBMITTED",
    );
  });

  await test("O", "「他の候補を見る」で開くと理由は manual。投稿は続けられる", async () => {
    const u = await makeMember(db, "manual1");
    const { prompt_id: promptId } = await drawPrompt(db, u, {});
    await value(db, asMember(u),
      `select public.reveal_prompt_candidates($1) as s`, [promptId]);
    const row = (await db.query(
      `select reveal_reason as r, status as s from public.prompts where id = $1`,
      [promptId])).rows[0];
    assert(row.r === "manual", `理由が ${row.r}（manual のはず）`);
    assert(row.s === "active", `状態が ${row.s}（active のはず）`);
    // 開いたあとでも投稿できる（仮定A9）
    await postWork(db, u, promptId, {});
  });

  await test("O", "投稿後の開示は work_submitted のまま。制作中開示で上書きされない", async () => {
    const u = await makeMember(db, "reason1");
    const { prompt_id: promptId } = await drawPrompt(db, u, {});
    await postWork(db, u, promptId, {});
    const row = (await db.query(
      `select reveal_reason as r from public.prompts where id = $1`, [promptId])).rows[0].r;
    assert(row === "work_submitted", `理由が ${row}（work_submitted のはず）`);
  });

  await test("O", "ゲストも同じ上限で残せる（登録の有無で差を付けない）", async () => {
    const g = await makeGuest(db);
    const st = await asRole(db, asGuest(g), async (c) =>
      (await c.query(`select public.start_draft('hard', 3600, null) as s`)).rows[0].s);
    const slot = st.slots.find((x) => !x.is_carried);
    const limit = Math.min(2, slot.candidates.length - 1);
    assert(slot.held_limit === limit, "ゲストの上限が登録者と違う");
    await asRole(db, asGuest(g), (c) =>
      c.query(`select public.hold_card($1, $2, 0, true)
                 from (select public.reveal_card($1, $2, 0)) as r`,
        [st.session_id, slot.card_slot_key]));
  });

  /* ---------------------------------------------------------------------
   * R. 持ち込み（art_first）。既に描いてある絵を持ち込み、
   *    作者が正式なクイズ項目を選ぶ経路（2026-09-08 のユーザー確定）
   * ------------------------------------------------------------------- */

  /** 分類を並べて、そのぶんの語のIDを1本の配列にする */
  async function pickIds(spec) {
    const ids = [];
    for (const [category, n] of spec) {
      for (const t of await pickTags(db, category, n)) ids.push(t.id);
    }
    return ids;
  }

  await test("R", "3語で作れる。出どころ・枠・問数・時間がそろう", async () => {
    const u = await makeMember(db, "af-basic");
    const ids = await pickIds([["morph", 1], ["emotion", 1], ["color", 1]]);
    const { workId, question_count } = await postArtFirstWork(db, u, ids);

    assert(question_count === 3, `問数が ${question_count}（3のはず）`);

    const row = (await db.query(
      `select p.origin, p.draft_session_id, p.time_limit_seconds, p.deadline_at,
              p.status, p.mode_key,
              (select count(*)::int from public.prompt_cards pc
                where pc.prompt_id = p.id) as cards,
              (select count(*)::int from public.quiz_questions q
                where q.prompt_id = p.id) as questions
         from public.works w join public.prompts p on p.id = w.prompt_id
        where w.id = $1`,
      [workId],
    )).rows[0];

    assert(row.origin === "art_first", `出どころが ${row.origin}`);
    assert(row.mode_key === "art_first", `モードが ${row.mode_key}`);
    assert(row.draft_session_id === null, "ドラフトに紐づいている");
    assert(row.time_limit_seconds === null, "制限時間が入っている");
    assert(row.deadline_at === null, "期限が入っている");
    assert(row.status === "submitted", `状態が ${row.status}（submitted のはず）`);
    assert(row.cards === 3, `答えのカードが ${row.cards} 枚`);
    assert(row.questions === 3, `出題が ${row.questions} 問`);
  });

  await test("R", "選んだ語が、選んだ順にそのまま入る", async () => {
    const u = await makeMember(db, "af-order");
    const picked = [
      ...(await pickTags(db, "morph", 1)),
      ...(await pickTags(db, "action", 1)),
      ...(await pickTags(db, "color", 1)),
    ];
    const { workId } = await postArtFirstWork(db, u, picked.map((t) => t.id));

    const promptId = (await db.query(
      `select prompt_id from public.works where id = $1`, [workId])).rows[0].prompt_id;
    const cards = await promptTags(db, promptId);

    assert(cards.length === picked.length, `カードが ${cards.length} 枚`);
    for (let i = 0; i < picked.length; i += 1) {
      assert(
        cards[i].tag_id === picked[i].id,
        `${i + 1}枚目が「${cards[i].label}」（「${picked[i].label}」のはず）`,
      );
    }
  });

  await test("R", "4語・5語・6語。語の数がそのまま問の数になる", async () => {
    for (const n of [4, 5, 6]) {
      const u = await makeMember(db, `af-count-${n}`);
      const spec = [["morph", 1], ["emotion", 1], ["action", 1], ["color", 1],
                    ["environment", 1], ["property", 1]].slice(0, n);
      const { question_count } = await postArtFirstWork(db, u, await pickIds(spec));
      assert(question_count === n, `${n}語で ${question_count} 問になった`);
    }
  });

  await test("R", "モーフが0件でも作れる（抽選の必須条件を持ち込まない）", async () => {
    const u = await makeMember(db, "af-nomorph");
    const ids = await pickIds([["emotion", 1], ["color", 1], ["environment", 1]]);
    const { workId, question_count } = await postArtFirstWork(db, u, ids);

    assert(question_count === 3, `問数が ${question_count}`);

    const morphs = (await db.query(
      `select count(*)::int as n
         from public.works w
         join public.prompt_cards pc on pc.prompt_id = w.prompt_id
         join public.tags t on t.id = pc.tag_id
        where w.id = $1 and t.pool_key = 'morph'`,
      [workId],
    )).rows[0].n;

    assert(morphs === 0, `モーフが ${morphs} 件入っている（0のはず）`);
  });

  await test("R", "同じ分類の2語は、1つ目と2つ目の枠へ分かれて入る", async () => {
    const u = await makeMember(db, "af-samecat");
    const ids = await pickIds([["morph", 2], ["color", 1]]);
    const { workId } = await postArtFirstWork(db, u, ids);

    const keys = (await db.query(
      `select pc.card_slot_key as k
         from public.works w join public.prompt_cards pc on pc.prompt_id = w.prompt_id
        where w.id = $1 order by pc.slot_order`,
      [workId],
    )).rows.map((r) => r.k);

    assert(keys.includes("morph_1") && keys.includes("morph_2"),
      `枠が ${keys.join(" / ")}（morph_1 と morph_2 のはず）`);
  });

  await test("R", "カラーは1件まで。枠の数を超えると断る", async () => {
    const u = await makeMember(db, "af-color2");
    const ids = await pickIds([["morph", 1], ["color", 2]]);
    await expectFailure(
      () => postArtFirstWork(db, u, ids),
      "CATEGORY_OVER_CAPACITY",
    );
  });

  await test("R", "2語と7語は断る（3〜6語）", async () => {
    const u = await makeMember(db, "af-range");
    const two = await pickIds([["morph", 1], ["color", 1]]);
    const seven = await pickIds([
      ["morph", 2], ["emotion", 1], ["action", 1], ["color", 1],
      ["environment", 1], ["property", 1],
    ]);

    await expectFailure(() => postArtFirstWork(db, u, two), "BAD_ELEMENT_COUNT");
    await expectFailure(() => postArtFirstWork(db, u, seven), "BAD_ELEMENT_COUNT");
  });

  await test("R", "同じ語を2回は断る", async () => {
    const u = await makeMember(db, "af-dup");
    const [m] = await pickTags(db, "morph", 1);
    const [c] = await pickTags(db, "color", 1);
    await expectFailure(
      () => postArtFirstWork(db, u, [m.id, m.id, c.id]),
      "DUPLICATE_ELEMENT",
    );
  });

  await test("R", "無い語のIDは断る", async () => {
    const u = await makeMember(db, "af-badid");
    const ids = await pickIds([["morph", 1], ["emotion", 1]]);
    await expectFailure(
      () => postArtFirstWork(db, u, [...ids, 999999999]),
      "ELEMENT_NOT_FOUND",
    );
  });

  await test("R", "旧語彙（生成分類を持たない語）は選べない", async () => {
    const u = await makeMember(db, "af-legacy");
    const ids = await pickIds([["morph", 1], ["emotion", 1]]);
    const legacy = await pickLegacyTag(db);
    await expectFailure(
      () => postArtFirstWork(db, u, [...ids, legacy]),
      "ELEMENT_NOT_FOUND",
    );
  });

  await test("R", "ゲストは持ち込みでも投稿できない", async () => {
    const g = await makeGuest(db);
    const ids = await pickIds([["morph", 1], ["emotion", 1], ["color", 1]]);
    await expectFailure(
      () => postArtFirstWork(db, g, ids, { guest: true }),
      "GUEST_CANNOT_POST",
    );
  });

  await test("R", "投稿が断られたら、お題も答えのカードも残らない", async () => {
    const u = await makeMember(db, "af-rollback");
    const ids = await pickIds([["morph", 1], ["emotion", 1], ["color", 1]]);

    const before = (await db.query(
      `select count(*)::int as n from public.prompts`)).rows[0].n;

    // 画像の置き場所が規約と違う（create_work の検査6）。
    // **お題を作ったあとで断られる**ので、巻き戻っていなければ行が残る
    await expectFailure(
      () => postArtFirstWork(db, u, ids, { imagePath: "someone-else/x.png" }),
      "BAD_IMAGE_PATH",
    );

    const after = (await db.query(
      `select count(*)::int as n from public.prompts`)).rows[0].n;

    assert(after === before, `お題が ${after - before} 件残った（0のはず）`);
  });

  await test("R", "他の人が、通常の作品と同じ経路で全語に答えられる", async () => {
    const u = await makeMember(db, "af-answer");
    const v = await makeMember(db, "af-answer-v");
    const ids = await pickIds([["morph", 1], ["emotion", 1], ["action", 1], ["color", 1]]);
    const { workId } = await postArtFirstWork(db, u, ids);

    const quiz = await value(db, asMember(v), `select public.get_work_quiz($1)`, [workId]);
    assert(quiz.questions.length === 4, `出題が ${quiz.questions.length} 問（4のはず）`);

    const answer = await answerWork(db, v, workId, { correct: true });
    assert(answer.correct_count === 4, `正解数が ${answer.correct_count}（4のはず）`);
  });

  await test("R", "2択当ても通常どおり使える", async () => {
    const u = await makeMember(db, "af-pair");
    const v = await makeMember(db, "af-pair-v");
    const ids = await pickIds([["morph", 1], ["emotion", 1], ["color", 1]]);
    const { workId } = await postArtFirstWork(db, u, ids);

    await answerWork(db, v, workId, { pair: "all", pairCorrect: true });

    const stats = (await db.query(
      `select coalesce(sum(pair_attempts), 0)::int as pair,
              coalesce(sum(exact_attempts), 0)::int as exact
         from public.work_slot_stats where work_id = $1`,
      [workId],
    )).rows[0];

    assert(stats.pair === 3, `2択当てが ${stats.pair} 問（3のはず）`);
    assert(stats.exact === 0, `ビタ当てが ${stats.exact} 問（0のはず）`);
  });

  await test("R", "回答した人には、作者が設定した項目がそのまま開示される", async () => {
    const u = await makeMember(db, "af-reveal");
    const v = await makeMember(db, "af-reveal-v");
    const picked = [
      ...(await pickTags(db, "morph", 1)),
      ...(await pickTags(db, "emotion", 1)),
      ...(await pickTags(db, "color", 1)),
    ];
    const { workId } = await postArtFirstWork(db, u, picked.map((t) => t.id));

    const before = await value(db, asMember(v),
      `select public.get_answered_prompt($1)`, [workId]);
    assert(before === null, "回答する前から開示されている");

    await answerWork(db, v, workId, {});

    const after = await value(db, asMember(v),
      `select public.get_answered_prompt($1)`, [workId]);
    assert(after !== null, "回答したのに開示されない");
    assert(after.cards.length === 3, `開示が ${after.cards.length} 件`);

    const labels = after.cards.map((c) => c.tag_label).sort();
    const expected = picked.map((t) => t.label).sort();
    assert(
      labels.join(",") === expected.join(","),
      `開示された語が ${labels.join(",")}（${expected.join(",")} のはず）`,
    );
  });

  await test("R", "作品一覧に、通常の作品と混ざって出る", async () => {
    const u = await makeMember(db, "af-list");
    const ids = await pickIds([["morph", 1], ["emotion", 1], ["color", 1]]);
    const { workId } = await postArtFirstWork(db, u, ids);

    const rows = await asRole(db, ANON, async (c) =>
      (await c.query(`select id from public.get_public_works(null, 'new', 50, 0)`)).rows);

    assert(rows.some((r) => r.id === workId), "一覧に出てこない");
  });

  await test("R", "次の作品の配給に入る（回答0件の帯）", async () => {
    const u = await makeMember(db, "af-next");
    const v = await makeMember(db, "af-next-v");
    const ids = await pickIds([["morph", 1], ["emotion", 1], ["color", 1]]);
    const { workId } = await postArtFirstWork(db, u, ids);

    const rows = await asRole(db, asMember(v), async (c) =>
      (await c.query(`select work_id, band from public.next_work_candidates(null)`)).rows);

    const hit = rows.find((r) => r.work_id === workId);
    assert(hit !== undefined, "候補に入っていない");
    assert(hit.band === 1, `救済帯が ${hit.band}（回答0件なので1のはず）`);
  });

  await test("R", "時間別ランキングには出ない。人気には出る", async () => {
    const u = await makeMember(db, "af-rank");
    const ids = await pickIds([["morph", 1], ["emotion", 1], ["color", 1]]);
    const { workId } = await postArtFirstWork(db, u, ids);

    const inList = async (type, bucket) =>
      (await asRole(db, ANON, async (c) =>
        (await c.query(
          `select id, time_limit_bucket from public.get_rankings($1, 'normal', $2, 50, 0)`,
          [type, bucket],
        )).rows)).some((r) => r.id === workId);

    assert(await inList("popular", null), "人気ランキングに出てこない");
    assert(!(await inList("duration", "unlimited")), "無制限の時間別に出ている");
    assert(!(await inList("duration", null)), "区分なしの時間別に出ている");
  });

  await test("R", "作品の詳細で、制作時間が空のまま出どころが分かる", async () => {
    const u = await makeMember(db, "af-detail");
    const ids = await pickIds([["morph", 1], ["emotion", 1], ["color", 1]]);
    const { workId } = await postArtFirstWork(db, u, ids);

    const detail = await value(db, ANON, `select public.get_work_detail($1)`, [workId]);
    assert(detail.origin === "art_first", `出どころが ${detail.origin}`);
    assert(detail.time_limit_seconds === null, "制限時間が入っている");
    assert(detail.prompt_id === undefined, "prompt_id が漏れている（D23 違反）");

    const mine = await value(db, asMember(u), `select public.get_my_work($1)`, [workId]);
    assert(mine.origin === "art_first", `自分の作品の出どころが ${mine.origin}`);
  });

  await test("R", "お題から描いた作品は、これまでどおり時間別に出る（弱めていない）", async () => {
    const u = await makeMember(db, "af-regress");
    const { prompt_id: promptId } = await drawPrompt(db, u, { timeLimit: 3600 });
    const workId = await postWork(db, u, promptId, "通常の作品");

    const rows = await asRole(db, ANON, async (c) =>
      (await c.query(
        `select id, time_limit_bucket from public.get_rankings('duration','normal','long',50,0)`,
      )).rows);

    const hit = rows.find((r) => r.id === workId);
    assert(hit !== undefined, "通常の作品が時間別から消えた");
    assert(hit.time_limit_bucket === "long", `区分が ${hit.time_limit_bucket}`);
  });

  /* =========================================================================
   * W. 管理（通報の処理と作品の非表示）
   * =========================================================================
   *
   * 【何を確かめるか】
   *   1. 一般の役から管理の入口へ手が届かないこと
   *   2. 非表示にすると、公開の取得経路から実際に消えること
   *   3. 消えても、行・回答・画像の場所は残っていること
   *   4. 危険な書き込みと監査記録が、必ず一緒に増える／一緒に増えないこと
   *
   * 【service_role で表を直接読まない理由】
   *   本番の Supabase では service_role に広い表権限が付いているが、
   *   この検査用DBの土台（harness.mjs）は migration が与えた権限しか持たない。
   *   **結果の確認は所有者として読む**（db.query を直に呼ぶ）。
   *   確かめたいのは「RPC が何をしたか」で、「service_role が何を読めるか」
   *   ではない。
   */

  const SVC = { role: "service_role", uid: null };

  /** 監査記録の件数。所有者として数える */
  async function auditCount() {
    const r = await db.query(`select count(*)::int n from public.admin_audit_log`);
    return r.rows[0].n;
  }

  /** 通報を1件作り、作品と作者と通報IDを返す */
  async function makeReported(label) {
    const author = await makeMember(db, null);
    const reporter = await makeMember(db, null);
    const p = await drawPrompt(db, author);
    const workId = await postWork(db, author, p.prompt_id, label);
    const res = await value(
      db,
      asMember(reporter),
      `select public.create_report($1, 'spam', null)`,
      [workId],
    );
    return { author, reporter, workId, reportId: res.report_id };
  }

  const ADMIN_RPCS = [
    ["admin_list_reports", `select public.admin_list_reports('open', 10, 0)`],
    ["admin_get_report", `select public.admin_get_report(1)`],
    [
      "admin_hide_work",
      `select public.admin_hide_work('00000000-0000-0000-0000-000000000001'::uuid,
                                     '00000000-0000-0000-0000-000000000002'::uuid, 'x')`,
    ],
    [
      "admin_resolve_report",
      `select public.admin_resolve_report('00000000-0000-0000-0000-000000000001'::uuid,
                                          1, 'resolved', 'x')`,
    ],
  ];

  await test("W", "未サインインは管理RPCを4本とも呼べない", async () => {
    for (const [name, sql] of ADMIN_RPCS) {
      await expectFailure(() => value(db, ANON, sql), "permission denied");
      void name;
    }
  });

  await test("W", "登録利用者は管理RPCを4本とも呼べない", async () => {
    const u = await makeMember(db, null);
    for (const [name, sql] of ADMIN_RPCS) {
      await expectFailure(() => value(db, asMember(u), sql), "permission denied");
      void name;
    }
  });

  await test("W", "ゲストは管理RPCを4本とも呼べない", async () => {
    const g = await makeGuest(db);
    for (const [name, sql] of ADMIN_RPCS) {
      await expectFailure(() => value(db, asGuest(g), sql), "permission denied");
      void name;
    }
  });

  await test("W", "監査記録の表は、未サインインからも登録利用者からも読めない", async () => {
    const u = await makeMember(db, null);
    await expectFailure(
      () => value(db, ANON, `select count(*) from public.admin_audit_log`),
      "permission denied",
    );
    await expectFailure(
      () => value(db, asMember(u), `select count(*) from public.admin_audit_log`),
      "permission denied",
    );
  });

  await test("W", "非表示にすると、公開一覧・ランキング・作品詳細から消える", async () => {
    const { author, reporter, workId } = await makeReported("管理検査：消える");
    await answerWork(db, reporter, workId);

    const inList = async () =>
      value(
        db,
        ANON,
        `select count(*)::int from public.get_public_works(null, null, 100, 0, null, false)
          where id = $1`,
        [workId],
      );
    const inRanking = async () =>
      value(
        db,
        ANON,
        `select count(*)::int from public.get_rankings('popular', 'normal', null, 100, 0)
          where id = $1`,
        [workId],
      );

    assert((await inList()) === 1, "非表示にする前から公開一覧に出ていない");
    assert((await inRanking()) === 1, "非表示にする前からランキングに出ていない");
    assert(
      (await value(db, ANON, `select public.get_work_detail($1)`, [workId])) !== null,
      "非表示にする前から作品詳細が取れない",
    );

    await value(db, SVC, `select public.admin_hide_work($1, $2, '検査：不適切')`, [
      author,
      workId,
    ]);

    assert((await inList()) === 0, "非表示にしたのに公開一覧に残っている");
    assert((await inRanking()) === 0, "非表示にしたのにランキングに残っている");
    assert(
      (await value(db, ANON, `select public.get_work_detail($1)`, [workId])) === null,
      "非表示にしたのに作品詳細が取れる",
    );
  });

  await test("W", "非表示にしても、行・回答・画像の場所・掃除の対象は変わらない", async () => {
    const { author, reporter, workId } = await makeReported("管理検査：残る");
    await answerWork(db, reporter, workId);

    const before = (
      await db.query(
        `select image_path, image_deleted_at, deleted_at, is_published, answers_count
           from public.works where id = $1`,
        [workId],
      )
    ).rows[0];
    const answersBefore = (
      await db.query(`select count(*)::int n from public.answers where work_id = $1`, [workId])
    ).rows[0].n;
    const queueBefore = (
      await db.query(`select count(*)::int n from public.storage_cleanup_queue`)
    ).rows[0].n;

    await value(db, SVC, `select public.admin_hide_work($1, $2, '検査：残ることの確認')`, [
      author,
      workId,
    ]);

    const after = (
      await db.query(
        `select review_status, image_path, image_deleted_at, deleted_at, is_published, answers_count
           from public.works where id = $1`,
        [workId],
      )
    ).rows[0];

    assert(after.review_status === "hidden", `review_status が ${after.review_status}`);
    assert(after.image_path === before.image_path, "画像の場所が書き換わった");
    assert(after.image_deleted_at === before.image_deleted_at, "画像を消したことにされた");
    assert(after.deleted_at === before.deleted_at, "deleted_at が立った（本人の削除と混ざる）");
    assert(after.is_published === before.is_published, "is_published が書き換わった");
    assert(after.answers_count === before.answers_count, "回答数のカウンタが変わった");

    const answersAfter = (
      await db.query(`select count(*)::int n from public.answers where work_id = $1`, [workId])
    ).rows[0].n;
    assert(answersAfter === answersBefore, `回答が ${answersBefore} → ${answersAfter} 件に減った`);

    const queueAfter = (
      await db.query(`select count(*)::int n from public.storage_cleanup_queue`)
    ).rows[0].n;
    assert(queueAfter === queueBefore, "画像の掃除待ちに積まれた（非表示は削除ではない）");
  });

  await test("W", "非表示にした作品は、作者本人には状態つきで見える", async () => {
    const { author, workId } = await makeReported("管理検査：作者には見える");
    await value(db, SVC, `select public.admin_hide_work($1, $2, '検査')`, [author, workId]);

    const mine = await value(db, asMember(author), `select public.get_my_work($1)`, [workId]);
    assert(mine !== null, "作者本人からも見えなくなっている");
    assert(
      mine.review_status === "hidden",
      `作者に返る review_status が ${mine.review_status}`,
    );
  });

  await test("W", "非表示にすると監査記録が1件だけ増え、何から何へかが残る", async () => {
    const { author, workId } = await makeReported("管理検査：監査");
    const before = await auditCount();

    const res = await value(db, SVC, `select public.admin_hide_work($1, $2, '検査：理由あり')`, [
      author,
      workId,
    ]);

    assert((await auditCount()) === before + 1, "監査記録が1件増えていない");

    const row = (
      await db.query(`select * from public.admin_audit_log where id = $1`, [res.audit_id])
    ).rows[0];
    assert(row.action === "hide_work", `action が ${row.action}`);
    assert(row.target_type === "work", `target_type が ${row.target_type}`);
    assert(row.target_id === workId, "target_id が対象の作品を指していない");
    assert(row.old_value === "ok", `old_value が ${row.old_value}`);
    assert(row.new_value === "hidden", `new_value が ${row.new_value}`);
    assert(row.reason === "検査：理由あり", "理由が残っていない");
    assert(row.admin_user_id === author, "操作した人が残っていない");
  });

  await test("W", "二度目の非表示は断られ、監査記録も増えない", async () => {
    const { author, workId } = await makeReported("管理検査：二度目");
    await value(db, SVC, `select public.admin_hide_work($1, $2, '検査')`, [author, workId]);

    const before = await auditCount();
    await expectFailure(
      () => value(db, SVC, `select public.admin_hide_work($1, $2, '検査')`, [author, workId]),
      "WORK_ALREADY_HIDDEN",
    );
    assert((await auditCount()) === before, "断られたのに監査記録が増えた");
  });

  await test("W", "理由が空白だけなら断られ、作品も監査も変わらない", async () => {
    const { author, workId } = await makeReported("管理検査：理由なし");
    const before = await auditCount();

    await expectFailure(
      () => value(db, SVC, `select public.admin_hide_work($1, $2, '   ')`, [author, workId]),
      "REASON_REQUIRED",
    );

    const status = (
      await db.query(`select review_status from public.works where id = $1`, [workId])
    ).rows[0].review_status;
    assert(status === "ok", `断られたのに review_status が ${status}`);
    assert((await auditCount()) === before, "断られたのに監査記録が増えた");
  });

  await test("W", "存在しない作品の非表示は断られ、監査記録も増えない", async () => {
    const before = await auditCount();
    await expectFailure(
      () =>
        value(
          db,
          SVC,
          `select public.admin_hide_work($1, '00000000-0000-0000-0000-000000000009'::uuid, '検査')`,
          ["00000000-0000-0000-0000-000000000001"],
        ),
      "WORK_NOT_FOUND",
    );
    assert((await auditCount()) === before, "断られたのに監査記録が増えた");
  });

  await test("W", "通報を対応済みにすると、状態と日時が対で入る", async () => {
    const { author, reportId } = await makeReported("管理検査：resolve");
    const before = await auditCount();

    const res = await value(
      db,
      SVC,
      `select public.admin_resolve_report($1, $2, 'resolved', '検査：作品を下げた')`,
      [author, reportId],
    );
    assert(res.status === "resolved", `status が ${res.status}`);

    const row = (
      await db.query(`select status, resolved_at from public.reports where id = $1`, [reportId])
    ).rows[0];
    assert(row.status === "resolved", `DB の status が ${row.status}`);
    assert(row.resolved_at !== null, "resolved_at が入っていない（CHECK と食い違う）");

    assert((await auditCount()) === before + 1, "監査記録が1件増えていない");
    const audit = (
      await db.query(`select * from public.admin_audit_log where id = $1`, [res.audit_id])
    ).rows[0];
    assert(audit.action === "resolve_report", `action が ${audit.action}`);
    assert(audit.target_type === "report", `target_type が ${audit.target_type}`);
    assert(audit.old_value === "open" && audit.new_value === "resolved", "何から何へが残っていない");
  });

  await test("W", "通報を却下しても、対象の作品は1列も変わらない", async () => {
    const { author, workId, reportId } = await makeReported("管理検査：reject");

    const before = (
      await db.query(
        `select review_status, is_published, deleted_at from public.works where id = $1`,
        [workId],
      )
    ).rows[0];

    const res = await value(
      db,
      SVC,
      `select public.admin_resolve_report($1, $2, 'rejected', '検査：理由に当たらない')`,
      [author, reportId],
    );
    assert(res.status === "rejected", `status が ${res.status}`);

    const row = (
      await db.query(`select status, resolved_at from public.reports where id = $1`, [reportId])
    ).rows[0];
    assert(row.status === "rejected", `DB の status が ${row.status}`);
    assert(row.resolved_at !== null, "resolved_at が入っていない");

    const after = (
      await db.query(
        `select review_status, is_published, deleted_at from public.works where id = $1`,
        [workId],
      )
    ).rows[0];
    assert(after.review_status === before.review_status, "却下で作品の審査状態が変わった");
    assert(after.is_published === before.is_published, "却下で作品の公開設定が変わった");
    assert(after.deleted_at === before.deleted_at, "却下で作品が削除された");

    const audit = (
      await db.query(`select action from public.admin_audit_log where id = $1`, [res.audit_id])
    ).rows[0];
    assert(audit.action === "reject_report", `action が ${audit.action}`);
  });

  await test("W", "一度閉じた通報は開き直せず、監査記録も増えない", async () => {
    const { author, reportId } = await makeReported("管理検査：二度閉じ");
    await value(
      db,
      SVC,
      `select public.admin_resolve_report($1, $2, 'resolved', '検査')`,
      [author, reportId],
    );

    const before = await auditCount();
    await expectFailure(
      () =>
        value(db, SVC, `select public.admin_resolve_report($1, $2, 'rejected', '検査')`, [
          author,
          reportId,
        ]),
      "REPORT_ALREADY_RESOLVED",
    );
    assert((await auditCount()) === before, "断られたのに監査記録が増えた");
  });

  await test("W", "処理の種類が違う・通報が無い・理由が空は、それぞれ別の合図で断られる", async () => {
    const { author, reportId } = await makeReported("管理検査：入力");
    const before = await auditCount();

    await expectFailure(
      () =>
        value(db, SVC, `select public.admin_resolve_report($1, $2, 'maybe', '検査')`, [
          author,
          reportId,
        ]),
      "INVALID_RESOLUTION",
    );
    await expectFailure(
      () =>
        value(db, SVC, `select public.admin_resolve_report($1, 99999999, 'resolved', '検査')`, [
          author,
        ]),
      "REPORT_NOT_FOUND",
    );
    await expectFailure(
      () =>
        value(db, SVC, `select public.admin_resolve_report($1, $2, 'resolved', '  ')`, [
          author,
          reportId,
        ]),
      "REASON_REQUIRED",
    );

    assert((await auditCount()) === before, "断られたのに監査記録が増えた");
  });

  await test("W", "一覧は未処理だけを返し、区切りと総数が合う", async () => {
    const made = [];
    for (let i = 0; i < 3; i += 1) made.push(await makeReported(`管理検査：一覧 ${i}`));

    const openTotal = (
      await db.query(`select count(*)::int n from public.reports where status = 'open'`)
    ).rows[0].n;

    const page1 = await value(db, SVC, `select public.admin_list_reports('open', 2, 0)`);
    assert(page1.total === openTotal, `total が ${page1.total}（実際は ${openTotal}）`);
    assert(page1.rows.length === 2, `1ページ目が ${page1.rows.length} 件`);
    assert(
      page1.rows.every((r) => r.status === "open"),
      "未処理を指定したのに、閉じた通報が混ざっている",
    );

    const page2 = await value(db, SVC, `select public.admin_list_reports('open', 2, 2)`);
    const ids1 = page1.rows.map((r) => r.report_id);
    const ids2 = page2.rows.map((r) => r.report_id);
    assert(
      ids2.every((id) => !ids1.includes(id)),
      "2ページ目に1ページ目と同じ通報が出ている",
    );

    // 閉じたものは open の一覧から外れる
    const target = made[0];
    await value(
      db,
      SVC,
      `select public.admin_resolve_report($1, $2, 'resolved', '検査')`,
      [target.author, target.reportId],
    );
    const after = await value(db, SVC, `select public.admin_list_reports('open', 100, 0)`);
    assert(
      !after.rows.some((r) => r.report_id === target.reportId),
      "閉じた通報が未処理の一覧に残っている",
    );
  });

  await test("W", "一覧も詳細も、通報者とお題の ID を1つも返さない", async () => {
    const { workId, reportId } = await makeReported("管理検査：漏れ");

    const list = await value(db, SVC, `select public.admin_list_reports('open', 100, 0)`);
    const detail = await value(db, SVC, `select public.admin_get_report($1)`, [reportId]);

    const promptId = (
      await db.query(`select prompt_id from public.works where id = $1`, [workId])
    ).rows[0].prompt_id;
    const reporterId = (
      await db.query(`select reporter_id from public.reports where id = $1`, [reportId])
    ).rows[0].reporter_id;

    for (const [label, payload] of [
      ["一覧", JSON.stringify(list)],
      ["詳細", JSON.stringify(detail)],
    ]) {
      assert(!payload.includes("reporter"), `${label}に reporter という語が出ている`);
      assert(!payload.includes(reporterId), `${label}に通報者の ID が入っている`);
      assert(!payload.includes(promptId), `${label}にお題の ID が入っている`);
      assert(!payload.includes("prompt_id"), `${label}に prompt_id という語が出ている`);
    }
  });

  await test("W", "詳細は同じ作品への他の通報を並べ、未処理の件数を数える", async () => {
    const { workId, reportId } = await makeReported("管理検査：同一作品");
    const other = await makeMember(db, null);
    const second = await value(db, asMember(other), `select public.create_report($1,'other','検査の補足')`, [
      workId,
    ]);

    const detail = await value(db, SVC, `select public.admin_get_report($1)`, [reportId]);
    assert(detail.report.report_id === reportId, "違う通報が返っている");
    assert(detail.work.work_id === workId, "違う作品が返っている");
    assert(
      detail.same_work_reports.some((r) => r.report_id === second.report_id),
      "同じ作品への2件目が並んでいない",
    );
    assert(
      !detail.same_work_reports.some((r) => r.report_id === reportId),
      "自分自身が「他の通報」に混ざっている",
    );
    assert(detail.same_work_open_count === 2, `未処理の件数が ${detail.same_work_open_count}`);
  });

  /* ---------------------------------------------------------------------
   * Y. プロフィールの拡張（D176）。アイコンと、自己申告の得意分野
   *
   * 【ここで見ないもの】
   *   得意分野は自己申告であって成績ではない。**正答率も、次の作品の
   *   配られ方（D169）も変わらない**ことは、下の2件で確かめる。
   * ------------------------------------------------------------------- */

  /** その利用者のフォルダを指す、形の正しいアイコンの置き場所を1つ作る */
  function avatarPath(uid) {
    return `${uid}/avatar/${crypto.randomUUID()}.png`;
  }

  /** 分類ごとに語をn件ずつ取り、IDだけを1本の配列にする */
  async function specialtyIds(spec) {
    const ids = [];
    for (const [category, n] of spec) {
      for (const t of await pickTags(db, category, n)) ids.push(t.id);
    }
    return ids;
  }

  await test("Y", "アイコンを設定できて、公開プロフィールに出る", async () => {
    const u = await makeMember(db, "av-set");
    const path = avatarPath(u);

    const result = await value(db, asMember(u), `select public.set_my_avatar($1::text)`, [path]);
    assert(result.avatar_path === path, `設定した置き場所が ${result.avatar_path}`);
    assert(result.previous_path === null, "前の置き場所が空でない");

    const pub = await value(db, ANON, `select public.get_public_profile($1::text)`, ["av-set"]);
    assert(pub.avatar_path === path, `公開プロフィールの置き場所が ${pub.avatar_path}`);
  });

  await test("Y", "差し替えると、前の置き場所が返る（消す相手が分かる）", async () => {
    const u = await makeMember(db, "av-swap");
    const first = avatarPath(u);
    const second = avatarPath(u);

    await value(db, asMember(u), `select public.set_my_avatar($1::text)`, [first]);
    const result = await value(db, asMember(u), `select public.set_my_avatar($1::text)`, [second]);

    assert(result.avatar_path === second, "新しい置き場所が入っていない");
    assert(
      result.previous_path === first,
      `前の置き場所が ${result.previous_path}（${first} のはず）`,
    );
  });

  await test("Y", "アイコンを外せる。外すと既定の表示になる", async () => {
    const u = await makeMember(db, "av-clear");
    const path = avatarPath(u);
    await value(db, asMember(u), `select public.set_my_avatar($1::text)`, [path]);

    const result = await value(db, asMember(u), `select public.set_my_avatar(null::text)`);
    assert(result.avatar_path === null, "外したのに置き場所が残っている");
    assert(result.previous_path === path, "外すときに前の置き場所が返らない");

    const pub = await value(db, ANON, `select public.get_public_profile($1::text)`, ["av-clear"]);
    assert(pub.avatar_path === null, "公開プロフィールに置き場所が残っている");
  });

  await test("Y", "他人のフォルダを指すアイコンは受け付けない", async () => {
    const owner = await makeMember(db, "av-owner");
    const other = await makeMember(db, "av-other");

    await expectFailure(
      () =>
        value(db, asMember(other), `select public.set_my_avatar($1::text)`, [avatarPath(owner)]),
      "AVATAR_PATH_FOREIGN",
    );

    const pub = await value(db, ANON, `select public.get_public_profile($1::text)`, ["av-other"]);
    assert(pub.avatar_path === null, "断ったのに置き場所が入っている");
  });

  await test("Y", "アイコンの列は、利用者から直接更新できない", async () => {
    const u = await makeMember(db, "av-direct");
    await expectFailure(
      () =>
        value(db, asMember(u), `update public.profiles set avatar_path = $1::text where id = $2::uuid`, [
          avatarPath(u),
          u,
        ]),
      "permission denied",
    );
  });

  await test("Y", "ゲストはアイコンも得意分野も設定できない", async () => {
    const g = await makeGuest(db);
    await expectFailure(
      () => value(db, asGuest(g), `select public.set_my_avatar($1::text)`, [avatarPath(g)]),
      "ANONYMOUS_NOT_ALLOWED",
    );
    // 語のIDは先に用意する。**expectFailure へ渡す関数の中で await しない**
    // （非 async の関数の中では書けない）。
    const ids = await specialtyIds([["morph", 1]]);
    await expectFailure(
      () =>
        value(db, asGuest(g), `select public.set_my_specialties($1::bigint[], null::bigint[])`, [
          ids,
        ]),
      "ANONYMOUS_NOT_ALLOWED",
    );
  });

  await test("Y", "得意分野を、描く側5件・見る側5件まで保存できる", async () => {
    const u = await makeMember(db, "sp-five");
    const drawing = await specialtyIds([["morph", 3], ["emotion", 2]]);
    const viewing = await specialtyIds([["action", 3], ["environment", 2]]);

    const saved = await value(
      db,
      asMember(u),
      `select public.set_my_specialties($1::bigint[], $2::bigint[])`,
      [drawing, viewing],
    );
    assert(saved.drawing.length === 5, `描く側が ${saved.drawing.length} 件`);
    assert(saved.viewing.length === 5, `見る側が ${saved.viewing.length} 件`);

    // 語と分類の表示名が添えて返ること（画面がタグの名前を組み立て直さない）
    assert(
      typeof saved.drawing[0].label === "string" && saved.drawing[0].label.length > 0,
      "語の表示名が入っていない",
    );
    assert(
      typeof saved.drawing[0].category_label === "string",
      "分類の表示名が入っていない",
    );

    const read = await value(db, asMember(u), `select public.get_my_specialties()`);
    assert(read.drawing.length === 5 && read.viewing.length === 5, "読み直すと件数が違う");
  });

  await test("Y", "0件でも保存できる。0件は0件として返る", async () => {
    const u = await makeMember(db, "sp-zero");
    await value(
      db,
      asMember(u),
      `select public.set_my_specialties($1::bigint[], null::bigint[])`,
      [await specialtyIds([["morph", 2]])],
    );

    const cleared = await value(
      db,
      asMember(u),
      `select public.set_my_specialties(null::bigint[], null::bigint[])`,
    );
    assert(cleared.drawing.length === 0 && cleared.viewing.length === 0, "0件にできない");

    const pub = await value(db, ANON, `select public.get_public_profile($1::text)`, ["sp-zero"]);
    assert(
      pub.specialties.drawing.length === 0 && pub.specialties.viewing.length === 0,
      "公開プロフィールに残っている",
    );
  });

  await test("Y", "6件目は受け付けない", async () => {
    const u = await makeMember(db, "sp-six");
    const six = await specialtyIds([["morph", 3], ["emotion", 3]]);
    assert(six.length === 6, `語が ${six.length} 件（6件のはず）`);

    await expectFailure(
      () =>
        value(db, asMember(u), `select public.set_my_specialties($1::bigint[], null::bigint[])`, [
          six,
        ]),
      "SPECIALTY_LIMIT",
    );

    const read = await value(db, asMember(u), `select public.get_my_specialties()`);
    assert(read.drawing.length === 0, "断ったのに入っている");
  });

  await test("Y", "同じ種類の中で同じ語を2回は登録できない", async () => {
    const u = await makeMember(db, "sp-dup");
    const [tag] = await pickTags(db, "morph", 1);

    await expectFailure(
      () =>
        value(
          db,
          asMember(u),
          `select public.set_my_specialties(array[$1::bigint, $1::bigint], null::bigint[])`,
          [tag.id],
        ),
      "SPECIALTY_DUPLICATE",
    );
  });

  await test("Y", "描く側と見る側に同じ語を入れられる（独立している）", async () => {
    const u = await makeMember(db, "sp-both");
    const [tag] = await pickTags(db, "morph", 1);

    const saved = await value(
      db,
      asMember(u),
      `select public.set_my_specialties(array[$1::bigint], array[$1::bigint])`,
      [tag.id],
    );
    assert(saved.drawing.length === 1 && saved.viewing.length === 1, "両方に入らない");
    assert(
      saved.drawing[0].tag_id === saved.viewing[0].tag_id,
      "両方に入ったが別の語になっている",
    );
  });

  await test("Y", "いま選べない語（旧語彙・存在しない語）は受け付けない", async () => {
    const u = await makeMember(db, "sp-bad");
    // pickLegacyTag は語のIDそのもの（数）を返す。オブジェクトではない
    const legacy = await pickLegacyTag(db);

    await expectFailure(
      () =>
        value(db, asMember(u), `select public.set_my_specialties(array[$1::bigint], null::bigint[])`, [
          legacy,
        ]),
      "SPECIALTY_TAG_INVALID",
    );

    await expectFailure(
      () =>
        value(
          db,
          asMember(u),
          `select public.set_my_specialties(array[999999999::bigint], null::bigint[])`,
        ),
      "SPECIALTY_TAG_INVALID",
    );
  });

  await test("Y", "得意分野の表は、利用者から直接読み書きできない", async () => {
    const u = await makeMember(db, "sp-seal");
    await expectFailure(
      () => value(db, asMember(u), `select count(*) from public.profile_specialties`),
      "permission denied",
    );
    await expectFailure(
      () =>
        value(
          db,
          asMember(u),
          `insert into public.profile_specialties (user_id, specialty_type, tag_id)
             values ($1::uuid, 'drawing', 1)`,
          [u],
        ),
      "permission denied",
    );
  });

  await test("Y", "他人の得意分野は変えられない（引数に利用者を取らない）", async () => {
    const victim = await makeMember(db, "sp-victim");
    const attacker = await makeMember(db, "sp-attacker");

    const ids = await specialtyIds([["morph", 1]]);
    await value(db, asMember(victim), `select public.set_my_specialties($1::bigint[], null::bigint[])`, [ids]);

    // 攻撃側が自分の設定を変えても、相手のものは動かない
    await value(
      db,
      asMember(attacker),
      `select public.set_my_specialties($1::bigint[], null::bigint[])`,
      [await specialtyIds([["emotion", 2]])],
    );

    const pub = await value(db, ANON, `select public.get_public_profile($1::text)`, ["sp-victim"]);
    assert(pub.specialties.drawing.length === 1, "他人の設定が変わった");
    assert(
      Number(pub.specialties.drawing[0].tag_id) === Number(ids[0]),
      "他人の設定の中身が変わった",
    );
  });

  await test("Y", "得意分野は公開プロフィールに出る。既存の項目も残っている", async () => {
    const u = await makeMember(db, "sp-public");
    await value(db, asMember(u), `select public.update_my_profile(null, $1, $2, $3::jsonb)`, [
      "得意な人",
      "自己紹介の文",
      JSON.stringify({ x: "https://example.com/x" }),
    ]);
    await value(
      db,
      asMember(u),
      `select public.set_my_specialties($1::bigint[], $2::bigint[])`,
      [await specialtyIds([["morph", 2]]), await specialtyIds([["emotion", 1]])],
    );

    const pub = await value(db, ANON, `select public.get_public_profile($1::text)`, ["sp-public"]);
    assert(pub.specialties.drawing.length === 2, "描く側が出ていない");
    assert(pub.specialties.viewing.length === 1, "見る側が出ていない");
    // 既存の欄が消えていないこと
    assert(pub.display_name === "得意な人", "表示名が消えた");
    assert(pub.bio === "自己紹介の文", "自己紹介が消えた");
    assert(pub.links.x === "https://example.com/x", "外部リンクが消えた");
    assert(pub.show_saved_works === false, "公開設定の既定が変わった");
    assert(typeof pub.creator === "object", "描き手の記録が消えた");
  });

  await test("Y", "次の作品の配り方（D169）が、得意分野を1文字も見ていない", async () => {
    // 出所: ユーザー指示（2026-09-08）「『見るのが得意』をD169の次作品配給へ
    // 使用しない」。使うと「一般の回答者にどう伝わったか」ではなく
    // 「その表現を得意とする回答者にどう伝わったか」へ回答が偏る。
    //
    // **2回呼んで同じ作品が返ることでは確かめられない。**配る相手は
    // 回答の有無や帯で変わるので、同じ結果になる保証がそもそも無い。
    // 定義文そのものに、得意分野の表も関数も出てこないことを見る。
    const rows = (
      await db.query(
        `select p.proname, pg_get_functiondef(p.oid) as def
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname in ('get_next_work', 'get_public_works')`,
      )
    ).rows;
    // 引数違いの同名関数（オーバーロード）があるので、本数は決め打ちにしない。
    // **1本も見つからないことだけを失格にする**（名前を変えられたら気づく）。
    assert(rows.length >= 2, `見るべき関数が ${rows.length} 本（2本以上のはず）`);

    for (const r of rows) {
      assert(
        !r.def.includes("profile_specialties"),
        `${r.proname} が得意分野の表を見ている`,
      );
      assert(
        !r.def.includes("app_specialty_rows"),
        `${r.proname} が得意分野の読み出しを呼んでいる`,
      );
    }
  });

  await test("Y", "得意分野を入れた人にも、これまでどおり次の作品が配られる", async () => {
    const author = await makeMember(db, "sp-feed-a");
    const drawn = await drawPrompt(db, author);
    const workId = await postWork(db, author, drawn.prompt_id);

    const viewer = await makeMember(db, "sp-feed-v");
    await value(
      db,
      asMember(viewer),
      `select public.set_my_specialties(null::bigint[], $1::bigint[])`,
      [await specialtyIds([["morph", 2]])],
    );

    const next = await value(db, asMember(viewer), `select public.get_next_work($1)`, [null]);
    assert(next !== null, "得意分野を入れたら、作品が1件も配られなくなった");
    assert(workId !== null, "作品が作れていない");
  });

  await test("Y", "失敗した更新は、いまの得意分野を壊さない", async () => {
    // 出所: ユーザー指示（2026-09-09）「失敗した更新が旧設定を壊さないこと」。
    // set_my_specialties は「全部消してから入れ直す」ので、途中で落ちたときに
    // 0件や半端な件数が残らないことを確かめる。
    const u = await makeMember(db, "sp-atomic");
    const five = await specialtyIds([["morph", 3], ["emotion", 2]]);
    await value(db, asMember(u), `select public.set_my_specialties($1::bigint[], null::bigint[])`, [
      five,
    ]);

    const six = await specialtyIds([["morph", 3], ["emotion", 3]]);
    const [dup] = await pickTags(db, "action", 1);
    const legacy = await pickLegacyTag(db);

    // 断られる送り方を3通り。**どれもいまの5件を壊してはいけない。**
    await expectFailure(
      () =>
        value(db, asMember(u), `select public.set_my_specialties($1::bigint[], null::bigint[])`, [
          six,
        ]),
      "SPECIALTY_LIMIT",
    );
    await expectFailure(
      () =>
        value(
          db,
          asMember(u),
          `select public.set_my_specialties(array[$1::bigint, $1::bigint], null::bigint[])`,
          [dup.id],
        ),
      "SPECIALTY_DUPLICATE",
    );
    await expectFailure(
      () =>
        value(db, asMember(u), `select public.set_my_specialties(array[$1::bigint], null::bigint[])`, [
          legacy,
        ]),
      "SPECIALTY_TAG_INVALID",
    );

    const now = await value(db, asMember(u), `select public.get_my_specialties()`);
    assert(now.drawing.length === 5, `失敗のあとで ${now.drawing.length} 件になっている`);
    assert(
      now.drawing.map((x) => Number(x.tag_id)).join(",") === five.map(Number).join(","),
      "中身か並びが変わっている",
    );
  });

  await test("Y", "5件→3件・3件→0件と減らせる（減らす途中で消えない）", async () => {
    const u = await makeMember(db, "sp-shrink");
    const five = await specialtyIds([["morph", 3], ["emotion", 2]]);
    await value(db, asMember(u), `select public.set_my_specialties($1::bigint[], null::bigint[])`, [
      five,
    ]);

    const three = await value(
      db,
      asMember(u),
      `select public.set_my_specialties($1::bigint[], null::bigint[])`,
      [five.slice(0, 3)],
    );
    assert(three.drawing.length === 3, `5件→3件で ${three.drawing.length} 件`);

    const zero = await value(
      db,
      asMember(u),
      `select public.set_my_specialties(null::bigint[], null::bigint[])`,
    );
    assert(zero.drawing.length === 0, `3件→0件で ${zero.drawing.length} 件`);
  });

  await test("Y", "消せなかったアイコンを、掃除の待ち行列へ渡せる", async () => {
    // Storage と DB はまとめて巻き戻せない。DB は書けたのに古いファイルだけ
    // 消せなかったとき、そのファイルを増えっぱなしにしないための出口。
    const u = await makeMember(db, "av-orphan");
    const path = avatarPath(u);

    await value(db, asMember(u), `select public.enqueue_my_avatar_cleanup($1::text)`, [path]);

    const { rows } = await db.query(
      `select bucket, path, deleted_at from public.storage_cleanup_queue where path = $1`,
      [path],
    );
    assert(rows.length === 1, `待ち行列に ${rows.length} 件（1件のはず）`);
    assert(rows[0].bucket === "works", `バケットが ${rows[0].bucket}`);
    assert(rows[0].deleted_at === null, "入れた直後なのに片づけ済みになっている");

    // 二度渡しても増えない（同じ操作を繰り返しても壊れない）
    await value(db, asMember(u), `select public.enqueue_my_avatar_cleanup($1::text)`, [path]);
    const again = (
      await db.query(`select count(*)::int as n from public.storage_cleanup_queue where path = $1`, [
        path,
      ])
    ).rows[0].n;
    assert(again === 1, `二度渡すと ${again} 件になった`);
  });

  await test("Y", "他人のアイコンを掃除の対象にはできない", async () => {
    const owner = await makeMember(db, "av-orphan-o");
    const other = await makeMember(db, "av-orphan-x");
    await expectFailure(
      () =>
        value(db, asMember(other), `select public.enqueue_my_avatar_cleanup($1::text)`, [
          avatarPath(owner),
        ]),
      "AVATAR_PATH_FOREIGN",
    );
  });

  await test("Y", "退会すると、アイコンは消す対象に入り、得意分野の行は消える", async () => {
    const u = await makeMember(db, "sp-leave");
    const path = avatarPath(u);
    await value(db, asMember(u), `select public.set_my_avatar($1::text)`, [path]);
    await value(
      db,
      asMember(u),
      `select public.set_my_specialties($1::bigint[], null::bigint[])`,
      [await specialtyIds([["morph", 2]])],
    );

    const result = await value(db, asMember(u), `select public.start_account_deletion($1::text)`, [
      "sp-leave",
    ]);

    const paths = (result.objects ?? []).map((o) => o.path);
    assert(paths.includes(path), `消す対象にアイコンが入っていない（${paths.join(", ")}）`);

    const left = (
      await db.query(
        `select (select count(*)::int from public.profile_specialties s where s.user_id = $1) as rows,
                (select p.avatar_path from public.profiles p where p.id = $1) as avatar`,
        [u],
      )
    ).rows[0];
    assert(left.rows === 0, `得意分野が ${left.rows} 行残っている`);
    assert(left.avatar === null, "プロフィールに置き場所が残っている");
  });


  // =========================================================================
  // U. 形状アシスト（D191）
  //
  //    お題を引く前に、作者が「どういう形として描くか」の取っかかりを
  //    1つだけ持てるようにしたもの。**正式なお題ではない。**
  //    ここで確かめるのは、それが正式なお題の側へ1歩も漏れていないこと。
  //
  //    漏れる先は5つ。出題（問の数と選択肢）、正解、伝達率の集計、
  //    次の作品の配り方（D169）、回答者の画面。**全部を毎回数える。**
  // =========================================================================

  /** 形状アシストを指定してドラフトを始め、確定まで進める */
  async function drawWithAssist(uid, assistKey) {
    return asRole(db, asMember(uid), async (c) => {
      const start = await c.query(
        `select public.start_draft('normal', 3600, null, $1) as s`,
        [assistKey],
      );
      let state = start.rows[0].s;
      for (const slot of state.slots) {
        if (slot.candidates.some((x) => x.is_chosen)) continue;
        const r = await c.query(
          `select public.choose_card($1, $2, 0) as s
             from (select public.reveal_card($1, $2, 0)) as r`,
          [state.session_id, slot.card_slot_key],
        );
        state = r.rows[0].s;
      }
      const done = await c.query(`select public.complete_draft($1) as s`, [
        state.session_id,
      ]);
      return { state, ...done.rows[0].s };
    });
  }

  await test("U", "使わないときは、これまでと何も変わらない", async () => {
    const u = await makeMember(db, "sa-none");
    const drawn = await drawWithAssist(u, null);

    assert(
      drawn.state.shape_assist_key === null,
      `使わないのに ${drawn.state.shape_assist_key} が入っている`,
    );

    const mine = await value(db, asMember(u), `select public.get_my_prompt($1::uuid)`, [
      drawn.prompt_id,
    ]);
    assert(mine.shape_assist_key === null, "確定したお題に値が入っている");
    assert(mine.cards.length >= 3, `語が ${mine.cards.length} 語しかない`);
  });

  await test("U", "選んだものが盤面に入り、確定したお題からも読める", async () => {
    const u = await makeMember(db, "sa-pick");
    const drawn = await drawWithAssist(u, "humanoid");

    assert(
      drawn.state.shape_assist_key === "humanoid",
      `盤面の値が ${drawn.state.shape_assist_key}`,
    );

    const mine = await value(db, asMember(u), `select public.get_my_prompt($1::uuid)`, [
      drawn.prompt_id,
    ]);
    assert(
      mine.shape_assist_key === "humanoid",
      `確定したお題の値が ${mine.shape_assist_key}`,
    );
  });

  await test("U", "形が合わない指定は受け付けない", async () => {
    const u = await makeMember(db, "sa-bad");
    await expectFailure(
      () =>
        value(db, asMember(u), `select public.start_draft('normal', 3600, null, $1)`, [
          "人型 <script>",
        ]),
      "BAD_SHAPE_ASSIST",
    );
  });

  await test("U", "引き直しても、選んだものは残る", async () => {
    const u = await makeMember(db, "sa-reroll");
    const state = await asRole(db, asMember(u), async (c) => {
      const start = await c.query(
        `select public.start_draft('normal', 3600, null, 'monster') as s`,
      );
      const r = await c.query(`select public.reroll_draft($1) as s`, [
        start.rows[0].s.session_id,
      ]);
      return r.rows[0].s;
    });
    assert(
      state.shape_assist_key === "monster",
      `引き直したら ${state.shape_assist_key} になった`,
    );
  });

  await test("U", "出題の数も語の数も、形状アシストで変わらない", async () => {
    const a = await makeMember(db, "sa-count-a");
    const b = await makeMember(db, "sa-count-b");
    const without = await drawWithAssist(a, null);
    const withOne = await drawWithAssist(b, "vehicle");

    assert(
      without.card_count === without.question_count,
      `使わない側で語 ${without.card_count} / 問 ${without.question_count}`,
    );
    assert(
      withOne.card_count === withOne.question_count,
      `使う側で語 ${withOne.card_count} / 問 ${withOne.question_count}`,
    );

    // 形状アシストのぶんだけ問が増えていないこと。
    // **語数そのものはモードの抽選で毎回変わる**ので、
    // 「語と問が一致していること」を両方で見る（D165）。
    const rows = await db.query(
      `select (select count(*)::int from public.quiz_questions q where q.prompt_id = $1) as q_without,
              (select count(*)::int from public.prompt_cards c where c.prompt_id = $1) as c_without,
              (select count(*)::int from public.quiz_questions q where q.prompt_id = $2) as q_with,
              (select count(*)::int from public.prompt_cards c where c.prompt_id = $2) as c_with`,
      [without.prompt_id, withOne.prompt_id],
    );
    const r = rows.rows[0];
    assert(r.q_without === r.c_without, `使わない側で問 ${r.q_without} / 札 ${r.c_without}`);
    assert(r.q_with === r.c_with, `使う側で問 ${r.q_with} / 札 ${r.c_with}`);
  });

  await test("U", "選択肢にも正解にも、形状アシストの語は出ない", async () => {
    const u = await makeMember(db, "sa-choices");
    const drawn = await drawWithAssist(u, "landscape");

    // 選択肢はすべて正式語彙（tags）の語であること。
    // 形状アシストは tags に1行も入れていないので、ここに出ようが無い。
    const bad = (
      await db.query(
        `select count(*)::int as n
           from public.quiz_choices ch
           join public.quiz_questions q on q.id = ch.question_id
      left join public.tags t on t.id = ch.tag_id
          where q.prompt_id = $1 and t.id is null`,
        [drawn.prompt_id],
      )
    ).rows[0].n;
    assert(bad === 0, `正式語彙にない選択肢が ${bad} 件`);

    const named = (
      await db.query(
        `select count(*)::int as n from public.tags
          where label in ('人型','動物型','植物型','怪物型','道具型',
                          '建造物型','乗物型','景観型','気象型')`,
      )
    ).rows[0].n;
    assert(named === 0, `形状アシストの語が正式語彙に ${named} 件入っている`);
  });

  await test("U", "他人の確定したお題からは読めない", async () => {
    const owner = await makeMember(db, "sa-owner");
    const other = await makeMember(db, "sa-other");
    const drawn = await drawWithAssist(owner, "plant");

    const seen = await value(db, asMember(other), `select public.get_my_prompt($1::uuid)`, [
      drawn.prompt_id,
    ]);
    assert(seen === null, "他人のお題が読めてしまう");
  });

  await test("U", "回答者へ渡る取得系に、形状アシストの鍵が1つも無い", async () => {
    const author = await makeMember(db, "sa-author");
    const reader = await makeMember(db, "sa-reader");
    const drawn = await drawWithAssist(author, "weather");
    const work = await postWork(db, author, drawn.prompt_id);

    const detail = await value(db, asMember(reader), `select public.get_work_detail($1::uuid)`, [
      work,
    ]);
    const quiz = await value(db, asMember(reader), `select public.get_work_quiz($1::uuid)`, [work]);
    const list = await value(
      db,
      ANON,
      `select jsonb_agg(to_jsonb(w)) from public.get_public_works(null,'new',20,0) w`,
    );

    for (const [name, payload] of [
      ["get_work_detail", detail],
      ["get_work_quiz", quiz],
      ["get_public_works", list],
    ]) {
      const text = JSON.stringify(payload ?? null);
      assert(
        !text.includes("shape_assist") && !text.includes("weather"),
        `${name} の戻り値に形状アシストが出ている`,
      );
    }
  });

  await test("U", "出題と配給の関数が、形状アシストを1文字も見ていない", async () => {
    // **思い出す形にしない。**定義文を毎回数える。
    // 将来この列を読む行を足したら、ここで落ちる。
    const rows = await db.query(
      `select p.proname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('build_quiz_for_prompt','next_work_candidates',
                            'get_next_work','get_work_detail','get_work_quiz',
                            'get_public_works','create_work','create_art_first_work')
          and pg_get_functiondef(p.oid) like '%shape_assist%'`,
    );
    assert(
      rows.rows.length === 0,
      `形状アシストを見ている関数がある: ${rows.rows.map((r) => r.proname).join(", ")}`,
    );

    const counted = (
      await db.query(
        `select count(*)::int as n
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname in ('build_quiz_for_prompt','next_work_candidates','get_work_detail')`,
      )
    ).rows[0].n;
    assert(counted >= 3, `見るべき関数が ${counted} 本しか無い（数え漏れ）`);
  });

  await test("U", "持ち込み（art_first）では必ず空になる", async () => {
    const u = await makeMember(db, "sa-artfirst");
    const ids = [
      ...(await pickTags(db, "morph", 1)),
      ...(await pickTags(db, "action", 1)),
      ...(await pickTags(db, "color", 1)),
    ].map((t) => t.id);
    const made = await postArtFirstWork(db, u, ids);
    const promptId = (
      await db.query(`select prompt_id from public.works where id = $1`, [made.workId])
    ).rows[0].prompt_id;

    const mine = await value(db, asMember(u), `select public.get_my_prompt($1::uuid)`, [
      promptId,
    ]);
    assert(mine !== null, "持ち込みのお題が読めない");
    assert(
      mine.shape_assist_key === null,
      `持ち込みなのに ${mine.shape_assist_key} が入っている`,
    );
  });

  await test("U", "列そのものは、利用者から直接読み書きできない", async () => {
    const granted = (
      await db.query(
        `select count(*)::int as n
           from information_schema.column_privileges
          where table_schema = 'public'
            and table_name   = 'draft_sessions'
            and column_name  = 'shape_assist_key'
            and grantee in ('anon','authenticated','PUBLIC')`,
      )
    ).rows[0].n;
    assert(granted === 0, `列に権限が ${granted} 件ある`);

    const u = await makeMember(db, "sa-direct");
    const session = await startDraftOnly(db, u);
    await expectFailure(
      () =>
        value(
          db,
          asMember(u),
          `update public.draft_sessions set shape_assist_key = 'humanoid' where id = $1`,
          [session.session_id],
        ),
      "permission denied",
    );
  });

  // =========================================================================
  // T. 回答の知らせ（D192）
  //
  //    作品に回答が来たことを作者へ伝えるしくみ。**表は増やしていない。**
  //    「その作品の結果を最後に開いた時刻」と「回答が来た時刻」の差だけで、
  //    未確認かどうかを出している。
  //
  //    ここで確かめるのは4つ。回答が成立したときだけ知らせになること、
  //    他人の作品と混ざらないこと、回答者が誰かを1文字も返さないこと、
  //    そして結果を実際に開くまで消えないこと。
  // =========================================================================

  /** その人から見て、未確認の回答があるか */
  async function hasUnseen(uid) {
    return value(db, asMember(uid), `select public.has_unseen_results()`);
  }

  /** その人の、未確認の回答がある作品の一覧 */
  async function unseenWorks(uid) {
    return asRole(db, asMember(uid), async (c) => {
      const r = await c.query(`select * from public.list_unseen_result_works(50)`);
      return r.rows;
    });
  }

  /** 作者として結果を開く（開いた時刻が記録される） */
  async function openResult(uid, workId) {
    return value(db, asMember(uid), `select public.open_my_work_result($1::uuid)`, [workId]);
  }

  /** 作品を1件出して、別の人に1回答えてもらう */
  async function workWithOneAnswer(authorHandle, viewerHandle) {
    const author = await makeMember(db, authorHandle);
    const viewer = await makeMember(db, viewerHandle);
    const p = await drawPrompt(db, author);
    const workId = await postWork(db, author, p.prompt_id);
    await answerWork(db, viewer, workId);
    return { author, viewer, workId };
  }

  await test("T", "回答が来ると、作者に未確認として出る", async () => {
    const author = await makeMember(db, "nt-a1");
    const viewer = await makeMember(db, "nt-v1");
    const p = await drawPrompt(db, author);
    const workId = await postWork(db, author, p.prompt_id);

    assert((await hasUnseen(author)) === false, "誰も答えていないのに未確認になっている");
    assert((await unseenWorks(author)).length === 0, "答えが無いのに一覧に出ている");

    await answerWork(db, viewer, workId);

    assert((await hasUnseen(author)) === true, "回答が来たのに未確認にならない");
    const list = await unseenWorks(author);
    assert(list.length === 1, `一覧が ${list.length} 件（1件のはず）`);
    assert(list[0].work_id === workId, "別の作品が出ている");
  });

  await test("T", "回答が失敗したときは、知らせにならない", async () => {
    const author = await makeMember(db, "nt-a2");
    const viewer = await makeMember(db, "nt-v2");
    const p = await drawPrompt(db, author);
    const workId = await postWork(db, author, p.prompt_id);

    // 全問そろっていない回答。submit_answer が例外で止める。
    // **止まった以上、answers に行は残らない。**だから知らせにもならない。
    await expectFailure(
      () =>
        value(db, asMember(viewer), `select public.submit_answer($1, '[]'::jsonb)`, [workId]),
      "INCOMPLETE_ANSWER",
    );

    assert((await hasUnseen(author)) === false, "失敗した回答で未確認になっている");
    assert((await unseenWorks(author)).length === 0, "失敗した回答が一覧に出ている");
  });

  await test("T", "自分の作品に自分で答えることはできない（知らせも出ない）", async () => {
    const author = await makeMember(db, "nt-a3");
    const p = await drawPrompt(db, author);
    const workId = await postWork(db, author, p.prompt_id);

    await expectFailure(
      () => answerWork(db, author, workId),
      "AUTHOR_CANNOT_ANSWER",
    );

    assert((await hasUnseen(author)) === false, "自分の回答で未確認になっている");
  });

  await test("T", "他の作者の知らせに混ざらない", async () => {
    const first = await workWithOneAnswer("nt-a4", "nt-v4");
    const other = await makeMember(db, "nt-a5");
    const p = await drawPrompt(db, other);
    await postWork(db, other, p.prompt_id);

    assert((await hasUnseen(first.author)) === true, "回答を受けた側が未確認でない");
    assert((await hasUnseen(other)) === false, "関係のない作者が未確認になっている");

    const list = await unseenWorks(other);
    assert(list.length === 0, `他人の作品が ${list.length} 件出ている`);
  });

  await test("T", "同じ作品に何人が答えても、知らせは1件にまとまる", async () => {
    const author = await makeMember(db, "nt-a6");
    const p = await drawPrompt(db, author);
    const workId = await postWork(db, author, p.prompt_id);

    for (const handle of ["nt-v6a", "nt-v6b", "nt-v6c"]) {
      const viewer = await makeMember(db, handle);
      await answerWork(db, viewer, workId);
    }

    // 数えるのは所有者の立場（役を通さない）。ここは試験の準備であって、
    // アプリがこの経路を持っているわけではない。
    const answers = (
      await db.query(`select count(*)::int as n from public.answers where work_id = $1`, [workId])
    ).rows[0].n;
    assert(answers === 3, `回答が ${answers} 件（3件のはず）`);

    const list = await unseenWorks(author);
    assert(list.length === 1, `知らせが ${list.length} 件（作品ごとに1件のはず）`);
  });

  await test("T", "知らせに、回答者も件数も出てこない", async () => {
    const { author, viewer, workId } = await workWithOneAnswer("nt-a7", "nt-v7");
    const list = await unseenWorks(author);
    const dump = JSON.stringify(list);

    assert(!dump.includes(viewer), "回答者のIDが知らせに入っている");

    const columns = Object.keys(list[0]);
    for (const bad of ["user_id", "answer_id", "answers_count", "unseen_count", "count"]) {
      assert(!columns.includes(bad), `知らせに ${bad} が入っている`);
    }
    assert(list[0].work_id === workId, "作品が違う");
  });

  await test("T", "一覧を見ただけでは、確認済みにならない", async () => {
    const { author } = await workWithOneAnswer("nt-a8", "nt-v8");

    await unseenWorks(author);
    await unseenWorks(author);

    assert((await hasUnseen(author)) === true, "一覧を見ただけで消えている");
  });

  await test("T", "結果を開くと消え、次の回答でまた出る", async () => {
    const author = await makeMember(db, "nt-a9");
    const p = await drawPrompt(db, author);
    const workId = await postWork(db, author, p.prompt_id);

    const first = await makeMember(db, "nt-v9a");
    await answerWork(db, first, workId);
    assert((await hasUnseen(author)) === true, "1人目の回答が知らせにならない");

    const opened = await openResult(author, workId);
    assert(opened !== null, "結果が返ってこない");
    assert((await hasUnseen(author)) === false, "結果を開いても消えない");

    // **開いたあとに来た回答は、また未確認になる。**
    const second = await makeMember(db, "nt-v9b");
    await answerWork(db, second, workId);
    assert((await hasUnseen(author)) === true, "開いたあとの回答が知らせにならない");
  });

  await test("T", "他人の作品の結果は開けないし、時刻も動かない", async () => {
    const { author, viewer, workId } = await workWithOneAnswer("nt-a10", "nt-v10");

    const stolen = await openResult(viewer, workId);
    assert(stolen === null, "他人が結果を読めている");

    const seenAt = (
      await db.query(`select result_seen_at from public.works where id = $1`, [workId])
    ).rows[0].result_seen_at;
    assert(seenAt === null, "他人が開いたのに時刻が入っている");
    assert((await hasUnseen(author)) === true, "他人の操作で作者の知らせが消えた");
  });

  await test("T", "持ち込み（art_first）の作品でも知らせが出る", async () => {
    const author = await makeMember(db, "nt-a11");
    const viewer = await makeMember(db, "nt-v11");
    const ids = [];
    for (const category of ["morph", "emotion", "color"]) {
      const picked = await pickTags(db, category, 1);
      ids.push(picked[0].id);
    }
    const { workId } = await postArtFirstWork(db, author, ids);

    await answerWork(db, viewer, workId);

    assert((await hasUnseen(author)) === true, "持ち込みだと知らせが出ない");
    const list = await unseenWorks(author);
    assert(list.length === 1, `一覧が ${list.length} 件`);
    assert(list[0].work_id === workId, "別の作品が出ている");
  });

  await test("T", "消した作品は知らせに出ない", async () => {
    const { author, workId } = await workWithOneAnswer("nt-a12", "nt-v12");
    assert((await hasUnseen(author)) === true, "消す前から知らせが出ていない");

    await value(db, asMember(author), `select public.delete_work($1::uuid)`, [workId]);

    assert((await hasUnseen(author)) === false, "消した作品の知らせが残っている");
    assert((await unseenWorks(author)).length === 0, "消した作品が一覧に出ている");
  });

  await test("T", "知らせの3本は、サインインしていない人には配られていない", async () => {
    const granted = (
      await db.query(
        `select p.proname
           from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
          where ns.nspname = 'public'
            and p.proname in ('has_unseen_results','list_unseen_result_works','open_my_work_result')
            and has_function_privilege('anon', p.oid, 'EXECUTE')`,
      )
    ).rows;
    assert(granted.length === 0, `anon が呼べる: ${granted.map((r) => r.proname).join(", ")}`);

    const ok = (
      await db.query(
        `select count(*)::int as n
           from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
          where ns.nspname = 'public'
            and p.proname in ('has_unseen_results','list_unseen_result_works','open_my_work_result')
            and has_function_privilege('authenticated', p.oid, 'EXECUTE')`,
      )
    ).rows[0].n;
    assert(ok === 3, `authenticated が呼べるのが ${ok} 本（3本のはず）`);
  });

  await test("T", "足した列は、利用者から直接読み書きできない", async () => {
    const granted = (
      await db.query(
        `select count(*)::int as n
           from information_schema.column_privileges
          where table_schema = 'public'
            and table_name   = 'works'
            and column_name  = 'result_seen_at'
            and grantee in ('anon','authenticated','PUBLIC')`,
      )
    ).rows[0].n;
    assert(granted === 0, `列に権限が ${granted} 件ある`);

    const { author, workId } = await workWithOneAnswer("nt-a13", "nt-v13");
    await expectFailure(
      () =>
        value(
          db,
          asMember(author),
          `update public.works set result_seen_at = now() where id = $1`,
          [workId],
        ),
      "permission denied",
    );
  });

  await test("T", "回答・出題・配給・順位の関数は、知らせの列を1文字も見ていない", async () => {
    const rows = (
      await db.query(
        `select p.proname
           from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
          where ns.nspname = 'public' and p.prokind = 'f'
            and p.proname in ('submit_answer','build_quiz_for_prompt','get_work_quiz',
                              'get_next_work','next_work_candidates','get_rankings',
                              'get_work_detail','get_public_works')
            and pg_get_functiondef(p.oid) like '%result_seen_at%'`,
      )
    ).rows;
    assert(rows.length === 0, `混ざっている: ${rows.map((r) => r.proname).join(", ")}`);
  });

  await test("T", "回答者の画面には、知らせも確認時刻も出てこない", async () => {
    const { viewer, workId } = await workWithOneAnswer("nt-a14", "nt-v14");

    const detail = await value(db, asMember(viewer), `select public.get_work_detail($1::uuid)`, [
      workId,
    ]);
    const dump = JSON.stringify(detail);
    assert(!dump.includes("result_seen"), "作品の詳細に確認時刻が入っている");
    assert(!dump.includes("unseen"), "作品の詳細に知らせが入っている");

    const quiz = await value(db, asMember(viewer), `select public.get_work_quiz($1::uuid)`, [
      workId,
    ]);
    const quizDump = JSON.stringify(quiz);
    assert(!quizDump.includes("result_seen"), "出題に確認時刻が入っている");
  });

  // =========================================================================
  // S2. サブ指令（D193）
  //
  //    お題に出た正式な語1つに、「どう表現するか」の手がかりを添えるもの。
  //    **正式なお題ではない。**
  //
  //    ここで確かめることは2つある。
  //
  //    (1) 正式なお題の側へ1歩も漏れていないこと。漏れる先は5つ。
  //        出題（問の数と選択肢）、正解、伝達率の集計、
  //        次の作品の配り方（D169）、回答者の画面。
  //
  //    (2) **利用者が好きな値を書き込めないこと。**
  //        最初の作りでは、カードを決める窓口の引数として鍵を渡していた。
  //        あの窓口はサインイン済みなら誰でも直接叩けるので、
  //        画面を通さずに好きな鍵を自分のドラフトへ書けた。
  //        いまは書く窓口を分け、サーバーだけが呼べるようにしてある。
  //        出所: ユーザー指示（2026-09-10）「今回発見した穴を
  //        回帰試験として必ず残す。画面経由だけ確認して終わらせない。」
  //
  //    【対応表を DB が持っていないこと】
  //      どの語にどれが付くかは画面側（TypeScript）にある。DB は形だけを見る。
  //      だから、この試験は**鍵を直接渡して**確かめる。
  //      画面側の抽選そのものは、その言語の側で確かめる（S3 群）。
  // =========================================================================

  /**
   * サブ指令を書く。**サーバーだけが呼べる窓口を通る。**
   * 利用者の役では呼べないので、ここは service_role になる。
   */
  async function putDirective(uid, sessionId, generation, cardSlotKey, tagId, key) {
    return asRole(db, { role: "service_role" }, async (c) => {
      const r = await c.query(
        `select public.set_draft_slot_sub_directive($1::uuid, $2::uuid, $3::int, $4, $5::bigint, $6) as ok`,
        [uid, sessionId, generation, cardSlotKey, tagId, key],
      );
      return r.rows[0].ok;
    });
  }

  /** いまその枠で決まっている語の id を読む */
  async function chosenTagId(sessionId, generation, cardSlotKey) {
    const r = await db.query(
      `select tag_id from public.draft_candidates
        where session_id = $1 and generation = $2 and card_slot_key = $3 and is_chosen`,
      [sessionId, generation, cardSlotKey],
    );
    return r.rows[0]?.tag_id ?? null;
  }

  /**
   * ドラフトを始め、最初の枠を1つだけ決めて、
   * 「どのセッションの・どの世代の・どの枠に・どの語が入ったか」を返す。
   * サブ指令はまだ付けていない。
   */
  async function chooseOneSlot(db2, uid) {
    const st = await startDraftOnly(db2, uid);
    const slot = st.slots.find((s) => !s.candidates.some((x) => x.is_chosen));

    await value(db2, asMember(uid), `select public.reveal_card($1, $2, 0)`, [
      st.session_id,
      slot.card_slot_key,
    ]);
    const after = await value(db2, asMember(uid), `select public.choose_card($1, $2, 0)`, [
      st.session_id,
      slot.card_slot_key,
    ]);

    return {
      sessionId: st.session_id,
      generation: after.generation,
      cardSlotKey: slot.card_slot_key,
      tagId: await chosenTagId(st.session_id, after.generation, slot.card_slot_key),
    };
  }

  /** サブ指令を付けながら1枠ずつ決めて、確定まで進める */
  async function drawWithDirectives(uid, keyFor) {
    let state = await startDraftOnly(db, uid);

    for (const slot of state.slots) {
      if (slot.candidates.some((x) => x.is_chosen)) continue;

      await value(db, asMember(uid), `select public.reveal_card($1, $2, 0)`, [
        state.session_id,
        slot.card_slot_key,
      ]);
      const seen = await value(db, asMember(uid), `select public.get_current_draft()`);
      const here = seen.slots.find((x) => x.card_slot_key === slot.card_slot_key);
      const label = here.candidates.find((x) => x.candidate_index === 0)?.label ?? null;

      // カードを決める窓口は、サブ指令を知らない（3引数のまま）
      state = await value(db, asMember(uid), `select public.choose_card($1, $2, 0)`, [
        state.session_id,
        slot.card_slot_key,
      ]);

      const key = keyFor(label, slot.card_slot_key);
      if (key !== null) {
        const tagId = await chosenTagId(state.session_id, state.generation, slot.card_slot_key);
        await putDirective(uid, state.session_id, state.generation, slot.card_slot_key, tagId, key);
      }
    }

    state = await value(db, asMember(uid), `select public.get_current_draft()`);
    const done = await value(db, asMember(uid), `select public.complete_draft($1)`, [
      state.session_id,
    ]);
    return { state, ...done };
  }

  await test("S2", "使わないときは、これまでと何も変わらない", async () => {
    const u = await makeMember(db, "sd-none");
    const drawn = await drawWithDirectives(u, () => null);

    for (const s of drawn.state.slots) {
      assert(
        s.sub_directive_key === null,
        `使っていないのに ${s.card_slot_key} に ${s.sub_directive_key} が入っている`,
      );
    }

    const mine = await value(db, asMember(u), `select public.get_my_prompt($1::uuid)`, [
      drawn.prompt_id,
    ]);
    for (const c of mine.cards) {
      assert(c.sub_directive_key === null, `確定したお題の ${c.card_slot_key} に値が入っている`);
    }
  });

  await test("S2", "決めた枠に入り、確定したお題からも読める", async () => {
    const u = await makeMember(db, "sd-set");
    const drawn = await drawWithDirectives(u, () => "test_directive");

    const inBoard = drawn.state.slots.filter((s) => s.sub_directive_key === "test_directive");
    assert(inBoard.length === drawn.state.slots.length,
      `盤面に入ったのが ${inBoard.length} / ${drawn.state.slots.length} 枠`);

    const mine = await value(db, asMember(u), `select public.get_my_prompt($1::uuid)`, [
      drawn.prompt_id,
    ]);
    const inPrompt = mine.cards.filter((c) => c.sub_directive_key === "test_directive");
    assert(inPrompt.length === mine.cards.length,
      `確定したお題に入ったのが ${inPrompt.length} / ${mine.cards.length} 枚`);
  });

  await test("S2", "枠ごとに別のものを入れられる（1枠に1つ）", async () => {
    const u = await makeMember(db, "sd-each");
    const drawn = await drawWithDirectives(u, (_label, key) =>
      key.startsWith("morph") ? "for_morph" : "for_other");

    const mine = await value(db, asMember(u), `select public.get_my_prompt($1::uuid)`, [
      drawn.prompt_id,
    ]);
    for (const c of mine.cards) {
      const expected = c.card_slot_key.startsWith("morph") ? "for_morph" : "for_other";
      assert(c.sub_directive_key === expected,
        `${c.card_slot_key} が ${c.sub_directive_key}（${expected} のはず）`);
    }
  });

  await test("S2", "読み込み直しても残る", async () => {
    const u = await makeMember(db, "sd-reload");
    const st = await chooseOneSlot(db, u);
    await putDirective(u, st.sessionId, st.generation, st.cardSlotKey, st.tagId, "kept_directive");

    // 開き直す（get_current_draft は毎回 DB から作り直す）
    const again = await value(db, asMember(u), `select public.get_current_draft()`);
    const here = again.slots.find((s) => s.card_slot_key === st.cardSlotKey);
    assert(here.sub_directive_key === "kept_directive",
      `読み込み直したら ${here.sub_directive_key} になっている`);
  });

  await test("S2", "引き直すと、古いサブ指令は正式な語ごと捨てられる", async () => {
    const u = await makeMember(db, "sd-reroll");
    const st = await chooseOneSlot(db, u);
    await putDirective(u, st.sessionId, st.generation, st.cardSlotKey, st.tagId, "old_directive");

    const after = await value(db, asMember(u), `select public.reroll_draft($1)`, [st.sessionId]);

    // 引き直すと世代が変わり、枠ごと作り直される。**古い値は1つも残らない。**
    for (const s of after.slots) {
      assert(s.sub_directive_key === null,
        `引き直したのに ${s.card_slot_key} に ${s.sub_directive_key} が残っている`);
    }
  });

  await test("S2", "引き直しが割り込んだら、古い世代あての鍵は書かれない", async () => {
    // サーバーが語を読んでから書きに来るまでの間に、
    // 利用者が引き直すことがある。そのとき古い語に対して決めた鍵を書くと、
    // いまの語と噛み合わないサブ指令が残る。**書かれないこと。**
    const u = await makeMember(db, "sd-race");
    const st = await chooseOneSlot(db, u);

    // ここで引き直しが割り込む
    await value(db, asMember(u), `select public.reroll_draft($1)`, [st.sessionId]);

    // 遅れて届いた書き込み。世代も語も古い
    const wrote = await putDirective(
      u, st.sessionId, st.generation, st.cardSlotKey, st.tagId, "stale_directive");
    assert(wrote === false, "古い世代あての鍵が書けてしまった");

    const rows = (
      await db.query(
        `select count(*)::int as n from public.draft_session_slots
          where session_id = $1 and sub_directive_key is not null`,
        [st.sessionId],
      )
    ).rows[0].n;
    assert(rows === 0, `引き直した後に ${rows} 件のサブ指令が残っている`);
  });

  await test("S2", "決めたときと違う語あての鍵は書かれない", async () => {
    const u = await makeMember(db, "sd-wrongtag");
    const st = await chooseOneSlot(db, u);

    // 語の id だけを別のものにして送る（他はすべて正しい）
    const other = (
      await db.query(`select id from public.tags where id <> $1 limit 1`, [st.tagId])
    ).rows[0].id;

    const wrote = await putDirective(
      u, st.sessionId, st.generation, st.cardSlotKey, other, "wrong_tag_directive");
    assert(wrote === false, "違う語あての鍵が書けてしまった");
  });

  await test("S2", "他人のドラフトへは書けない", async () => {
    const owner = await makeMember(db, "sd-owner");
    const other = await makeMember(db, "sd-intruder");
    const st = await chooseOneSlot(db, owner);

    // サーバーの窓口であっても、持ち主が違えば1行も書かない
    const wrote = await putDirective(
      other, st.sessionId, st.generation, st.cardSlotKey, st.tagId, "not_yours");
    assert(wrote === false, "他人のドラフトへ書けてしまった");

    const rows = (
      await db.query(
        `select count(*)::int as n from public.draft_session_slots
          where session_id = $1 and sub_directive_key is not null`,
        [st.sessionId],
      )
    ).rows[0].n;
    assert(rows === 0, `他人が ${rows} 件書き込めている`);
  });

  await test("S2", "一度入った枠へは上書きできない", async () => {
    const u = await makeMember(db, "sd-once");
    const st = await chooseOneSlot(db, u);

    const first = await putDirective(
      u, st.sessionId, st.generation, st.cardSlotKey, st.tagId, "first_directive");
    assert(first === true, "1回目が書けていない");

    const second = await putDirective(
      u, st.sessionId, st.generation, st.cardSlotKey, st.tagId, "second_directive");
    assert(second === false, "2回目で上書きできてしまった");

    const now = await value(db, asMember(u), `select public.get_current_draft()`);
    const here = now.slots.find((s) => s.card_slot_key === st.cardSlotKey);
    assert(here.sub_directive_key === "first_directive",
      `${here.sub_directive_key} になっている`);
  });

  await test("S2", "形が合わない指定は受け付けない", async () => {
    const u = await makeMember(db, "sd-bad");
    const st = await chooseOneSlot(db, u);

    for (const bad of ["Uppercase", "with space", "日本語", "x".repeat(40)]) {
      await expectFailure(
        () => putDirective(u, st.sessionId, st.generation, st.cardSlotKey, st.tagId, bad),
        "BAD_SUB_DIRECTIVE",
      );
    }
  });

  // ── ここから、今回見つけた穴そのものの回帰試験 ──────────────

  await test("S2", "カードを決める窓口は、サブ指令を受け取らない", async () => {
    // 4引数の choose_card は**そもそも存在しない。**
    const n = (
      await db.query(
        `select count(*)::int as n
           from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
          where ns.nspname = 'public' and p.proname = 'choose_card' and p.pronargs = 4`,
      )
    ).rows[0].n;
    assert(n === 0, `4引数の choose_card が ${n} 本ある`);

    const three = (
      await db.query(
        `select count(*)::int as n
           from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
          where ns.nspname = 'public' and p.proname = 'choose_card' and p.pronargs = 3`,
      )
    ).rows[0].n;
    assert(three === 1, `3引数の choose_card が ${three} 本（1本のはず）`);

    // 定義そのものにサブ指令の文字が1つも無い
    const leaked = (
      await db.query(
        `select count(*)::int as n
           from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
          where ns.nspname = 'public' and p.proname = 'choose_card'
            and pg_get_functiondef(p.oid) like '%sub_directive%'`,
      )
    ).rows[0].n;
    assert(leaked === 0, "choose_card にサブ指令が入っている");
  });

  await test("S2", "サインイン済みの利用者は、書く窓口を直接呼べない", async () => {
    const u = await makeMember(db, "sd-nocall");
    const st = await chooseOneSlot(db, u);

    // 自分のドラフト・自分の語・正しい世代。**それでも呼べない。**
    await expectFailure(
      () =>
        value(
          db,
          asMember(u),
          `select public.set_draft_slot_sub_directive($1::uuid, $2::uuid, $3::int, $4, $5::bigint, $6)`,
          [u, st.sessionId, st.generation, st.cardSlotKey, st.tagId, "fake_modifier"],
        ),
      "permission denied",
    );

    // 未サインインでも呼べない
    await expectFailure(
      () =>
        value(
          db,
          { role: "anon" },
          `select public.set_draft_slot_sub_directive($1::uuid, $2::uuid, $3::int, $4, $5::bigint, $6)`,
          [u, st.sessionId, st.generation, st.cardSlotKey, st.tagId, "fake_modifier"],
        ),
      "permission denied",
    );
  });

  await test("S2", "形の合う偽の鍵でも、利用者は自分のドラフトへ書けない", async () => {
    const u = await makeMember(db, "sd-forge");
    const st = await chooseOneSlot(db, u);

    // fake_modifier は形（小文字と下線）としては正しい。
    // それでも、利用者の側からは1つも書き込む口が無いこと。
    //
    //   1つめ  表そのものへ直接書く
    //   2つめ  書く窓口を自分で呼ぶ
    //   3つめ  昔あった「カードを決めながら渡す」形で送る
    await expectFailure(
      () =>
        value(db, asMember(u),
          `update public.draft_session_slots set sub_directive_key = 'fake_modifier'
            where session_id = $1`, [st.sessionId]),
      "permission denied",
    );
    await expectFailure(
      () =>
        value(db, asMember(u),
          `select public.set_draft_slot_sub_directive($1::uuid, $2::uuid, $3::int, $4, $5::bigint, 'fake_modifier')`,
          [u, st.sessionId, st.generation, st.cardSlotKey, st.tagId]),
      "permission denied",
    );
    await expectFailure(
      () =>
        value(db, asMember(u),
          `select public.choose_card($1, $2, 0, 'fake_modifier')`, [st.sessionId, st.cardSlotKey]),
      "does not exist",
    );

    const rows = (
      await db.query(
        `select count(*)::int as n from public.draft_session_slots
          where session_id = $1 and sub_directive_key is not null`,
        [st.sessionId],
      )
    ).rows[0].n;
    assert(rows === 0, `偽の鍵が ${rows} 件書き込まれた`);
  });

  await test("S2", "書く窓口の権限が、サーバーだけに配られている", async () => {
    const rows = (
      await db.query(
        `select
           count(*) filter (where has_function_privilege('anon', p.oid, 'EXECUTE'))::int as anon,
           count(*) filter (where has_function_privilege('authenticated', p.oid, 'EXECUTE'))::int as auth,
           count(*) filter (where has_function_privilege('service_role', p.oid, 'EXECUTE'))::int as svc
           from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
          where ns.nspname = 'public' and p.proname = 'set_draft_slot_sub_directive'`,
      )
    ).rows[0];
    assert(rows.anon === 0, `anon に ${rows.anon} 件配られている`);
    assert(rows.auth === 0, `authenticated に ${rows.auth} 件配られている`);
    assert(rows.svc === 1, `service_role に ${rows.svc} 件（1件のはず）`);
  });

  // ── ここから、正式なお題の側へ漏れていないこと ──────────────

  await test("S2", "出題の数も語の数も、サブ指令で変わらない", async () => {
    const plain = await drawWithDirectives(await makeMember(db, "sd-plain"), () => null);
    const withIt = await drawWithDirectives(await makeMember(db, "sd-with"), () => "test_directive");

    // 語の顔ぶれは抽選で変わるので、2つのお題の語数を突き合わせても意味がない。
    // 見るのは「そのお題の中で、出題数が出題対象の枠数と合っているか」。
    for (const drawn of [plain, withIt]) {
      const rows = (
        await db.query(
          `select count(*) filter (where cs.is_quiz_eligible)::int eligible,
                  (select count(*)::int from public.quiz_questions q
                    where q.prompt_id = $1) as questions
             from public.prompt_cards pc
             join public.card_slots cs on cs.card_slot_key = pc.card_slot_key
            where pc.prompt_id = $1`,
          [drawn.prompt_id],
        )
      ).rows[0];
      assert(rows.questions === rows.eligible,
        `出題 ${rows.questions} 問 / 枠 ${rows.eligible}`);
    }
  });

  await test("S2", "選択肢にも正解にも、サブ指令は出ない", async () => {
    const u = await makeMember(db, "sd-quiz");
    const drawn = await drawWithDirectives(u, () => "test_directive");
    const workId = await postWork(db, u, drawn.prompt_id, "サブ指令の作品");

    const viewer = await makeMember(db, "sd-viewer");
    const quiz = await value(db, asMember(viewer), `select public.get_work_quiz($1::uuid)`, [
      workId,
    ]);
    const dump = JSON.stringify(quiz);
    assert(!dump.includes("sub_directive"), "出題にサブ指令の鍵が入っている");
    assert(!dump.includes("test_directive"), "出題にサブ指令の値が入っている");
  });

  await test("S2", "他人の確定したお題からは読めない", async () => {
    const u = await makeMember(db, "sd-mine");
    const drawn = await drawWithDirectives(u, () => "test_directive");

    const other = await makeMember(db, "sd-other");
    const stolen = await value(db, asMember(other), `select public.get_my_prompt($1::uuid)`, [
      drawn.prompt_id,
    ]);
    assert(stolen === null, "他人が確定したお題を読めている");
  });

  await test("S2", "回答者へ渡る取得系に、サブ指令の鍵が1つも無い", async () => {
    const u = await makeMember(db, "sd-leak");
    const drawn = await drawWithDirectives(u, () => "test_directive");
    const workId = await postWork(db, u, drawn.prompt_id, "漏れの検査");

    const viewer = await makeMember(db, "sd-leak-v");
    for (const sql of [
      `select public.get_work_detail($1::uuid)`,
      `select public.get_work_quiz($1::uuid)`,
    ]) {
      const got = await value(db, asMember(viewer), sql, [workId]);
      const dump = JSON.stringify(got);
      assert(!dump.includes("sub_directive"), `${sql} にサブ指令が入っている`);
      assert(!dump.includes("test_directive"), `${sql} にサブ指令の値が入っている`);
    }

    // 答えたあとに開く側にも出ない
    await answerWork(db, viewer, workId, { correct: true });
    const revealed = await value(db, asMember(viewer), `select public.get_answered_prompt($1::uuid)`, [
      workId,
    ]);
    const dump = JSON.stringify(revealed);
    assert(!dump.includes("sub_directive"), "回答後の開示にサブ指令が入っている");
    assert(!dump.includes("test_directive"), "回答後の開示にサブ指令の値が入っている");
  });

  await test("S2", "出題・配給・順位の関数が、サブ指令を1文字も見ていない", async () => {
    const rows = (
      await db.query(
        `select p.proname
           from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
          where ns.nspname = 'public' and p.prokind = 'f'
            and p.proname in ('build_quiz_for_prompt','get_work_quiz','submit_answer',
                              'next_work_candidates','get_next_work','get_work_detail',
                              'get_public_works','get_rankings','create_art_first_work',
                              'create_work','get_answered_prompt','get_public_answers')
            and pg_get_functiondef(p.oid) like '%sub_directive%'`,
      )
    ).rows;
    assert(rows.length === 0, `混ざっている: ${rows.map((r) => r.proname).join(", ")}`);
  });

  await test("S2", "持ち込み（art_first）では必ず空になる", async () => {
    const u = await makeMember(db, "sd-af");
    const ids = [];
    for (const category of ["morph", "emotion", "color"]) {
      const picked = await pickTags(db, category, 1);
      ids.push(picked[0].id);
    }
    const { workId } = await postArtFirstWork(db, u, ids);

    const promptId = (
      await db.query(`select prompt_id from public.works where id = $1`, [workId])
    ).rows[0].prompt_id;

    const cards = (
      await db.query(
        `select card_slot_key, sub_directive_key from public.prompt_cards where prompt_id = $1`,
        [promptId],
      )
    ).rows;
    assert(cards.length > 0, "持ち込みのカードが1枚も無い");
    for (const c of cards) {
      assert(c.sub_directive_key === null,
        `持ち込みなのに ${c.card_slot_key} に ${c.sub_directive_key} が入っている`);
    }
  });

  await test("S2", "列そのものは、利用者から直接読み書きできない", async () => {
    const granted = (
      await db.query(
        `select count(*)::int as n
           from information_schema.column_privileges
          where table_schema = 'public'
            and column_name  = 'sub_directive_key'
            and grantee in ('anon','authenticated','PUBLIC')`,
      )
    ).rows[0].n;
    assert(granted === 0, `列に権限が ${granted} 件ある`);
  });

  // =========================================================================
  // S3. サブ指令の抽選（画面側）
  //
  //    どの語にどれが付くかと、付けるかどうかの決め方は DB ではなく
  //    TypeScript 側にある。ここではその関数を直に呼んで確かめる。
  //
  //    【何千回も引かない】
  //      「1万回引いたら 69.8% だった」という形の試験にしない。
  //      それは実装が正しいことの証明にならず、たまに落ちる試験になる。
  //      代わりに**乱数の値そのものを渡して**、どの枝を通るかを1回で見る。
  //      出所: ユーザー指示（2026-09-10）「大量乱数試験で70%前後になることを
  //      E2Eの合否条件にしない。固定乱数入力等で決定論的に試験する。」
  //
  //    【1回目が「付けるか」、2回目が「どれを付けるか」】
  //      渡した数列が、その順で使われる。
  // =========================================================================

  const MOD = await import("../../src/features/modifier/types.ts");

  /** 決めた順に返す「乱数」。試験のためだけのもの */
  function fixedRandom(...values) {
    let i = 0;
    return () => values[i++ % values.length];
  }

  await test("S3", "対応表は24語・72候補で、鍵が重複していない", async () => {
    const byTag = new Map();
    for (const d of MOD.SUB_DIRECTIVES) {
      for (const t of d.forTagLabels) {
        if (!byTag.has(t)) byTag.set(t, []);
        byTag.get(t).push(d.key);
      }
    }
    assert(byTag.size === 24, `対応する語が ${byTag.size} 語（24語のはず）`);
    assert(MOD.SUB_DIRECTIVES.length === 72,
      `候補が ${MOD.SUB_DIRECTIVES.length} 件（72件のはず）`);

    for (const [tag, keys] of byTag) {
      assert(keys.length === 3, `${tag} の候補が ${keys.length} 件（3件のはず）`);
    }

    const keys = MOD.SUB_DIRECTIVES.map((d) => d.key);
    assert(new Set(keys).size === keys.length, "同じ鍵が2回出ている");
  });

  await test("S3", "鍵の形と表示文の長さが、決めた範囲に収まっている", async () => {
    for (const d of MOD.SUB_DIRECTIVES) {
      assert(MOD.SUB_DIRECTIVE_KEY_PATTERN.test(d.key), `${d.key} は形が合わない`);
      // 4〜15字。長い設定文にしない
      assert(d.label.length >= 4 && d.label.length <= 15,
        `「${d.label}」は ${d.label.length} 字（4〜15字のはず）`);
      assert(d.weight > 0, `${d.key} の重みが ${d.weight}`);
    }
  });

  await test("S3", "対応表の語が、すべて実在して抽選に出る", async () => {
    // 存在しない語や、いまの抽選に出ない語に付けても、一生出番が来ない
    const tags = new Set(
      (
        await db.query(
          `select t.label from public.tags t
             join public.draw_categories dc on dc.pool_key = t.pool_key
            where t.is_active and dc.is_active`,
        )
      ).rows.map((r) => r.label),
    );

    for (const d of MOD.SUB_DIRECTIVES) {
      for (const t of d.forTagLabels) {
        assert(tags.has(t), `「${t}」は抽選に出る語ではない（${d.key}）`);
      }
    }
  });

  await test("S3", "候補が無い語には、乱数が何であっても付かない", async () => {
    // 「必ず付ける」寄りの乱数を渡しても付かないこと
    for (const label of ["ドラゴン", "騒がしい", "水色ではない何か", "", null]) {
      if (MOD.subDirectivesFor(label).length > 0) continue;
      const got = MOD.pickSubDirective(label, { attachRate: 1 }, fixedRandom(0, 0));
      assert(got === null, `「${label}」に ${got} が付いた`);
    }
  });

  await test("S3", "1段目が 0.7 以上なら、必ず付かない（30%側）", async () => {
    for (const r of [0.7, 0.70001, 0.9, 0.999]) {
      const got = MOD.pickSubDirective("恐怖", MOD.SUB_DIRECTIVE_POLICY, fixedRandom(r, 0));
      assert(got === null, `1段目 ${r} で ${got} が付いた`);
    }
  });

  await test("S3", "1段目が 0.7 未満なら、必ず付く（70%側）", async () => {
    for (const r of [0, 0.3, 0.699]) {
      const got = MOD.pickSubDirective("恐怖", MOD.SUB_DIRECTIVE_POLICY, fixedRandom(r, 0));
      assert(got !== null, `1段目 ${r} で何も付かなかった`);
      assert(MOD.isSubDirectiveKey(got), `${got} は対応表に無い`);
    }
  });

  await test("S3", "2段目の値で、3候補のどれになるかが決まる", async () => {
    const cands = MOD.subDirectivesFor("恐怖");
    assert(cands.length === 3, `恐怖の候補が ${cands.length} 件`);

    // 重みはすべて1なので、0〜1 を3等分した位置がそれぞれの候補になる
    const cases = [
      [0, cands[0].key],
      [0.32, cands[0].key],
      [0.34, cands[1].key],
      [0.65, cands[1].key],
      [0.67, cands[2].key],
      [0.999, cands[2].key],
    ];
    for (const [r, expected] of cases) {
      const got = MOD.pickSubDirective("恐怖", MOD.SUB_DIRECTIVE_POLICY, fixedRandom(0, r));
      assert(got === expected, `2段目 ${r} で ${got}（${expected} のはず）`);
    }
  });

  await test("S3", "候補の数が変わっても、付かない率は 30% のまま", async () => {
    // 「付けない」を候補と一緒に抽選すると、候補2つの語と4つの語で
    // 付かない率が変わってしまう。2段に分けてあるので変わらないこと。
    const two = [
      { key: "a_one", label: "ひとつめ", forTagLabels: ["架空"], weight: 1 },
      { key: "a_two", label: "ふたつめ", forTagLabels: ["架空"], weight: 1 },
    ];
    const saved = MOD.SUB_DIRECTIVES.slice();
    try {
      MOD.SUB_DIRECTIVES.length = 0;
      MOD.SUB_DIRECTIVES.push(...two);
      assert(MOD.pickSubDirective("架空", MOD.SUB_DIRECTIVE_POLICY, fixedRandom(0.699, 0)) !== null,
        "候補2つのとき、0.699 で付かなかった");
      assert(MOD.pickSubDirective("架空", MOD.SUB_DIRECTIVE_POLICY, fixedRandom(0.7, 0)) === null,
        "候補2つのとき、0.7 で付いた");
    } finally {
      MOD.SUB_DIRECTIVES.length = 0;
      MOD.SUB_DIRECTIVES.push(...saved);
    }
  });

  await test("S3", "保存された鍵から表示文が引ける。知らない鍵は何も出さない", async () => {
    const one = MOD.SUB_DIRECTIVES[0];
    assert(MOD.subDirectiveLabel(one.key) === one.label,
      `${one.key} から表示文が引けない`);
    for (const unknown of ["fake_modifier", "", null, "not_in_table"]) {
      assert(MOD.subDirectiveLabel(unknown) === null,
        `知らない鍵 ${unknown} から表示文が出た`);
    }
  });


}

// ===========================================================================

await main().catch((e) => {
  results.push({ group: "!", name: "試験そのものが止まった", ok: false, message: e.message });
});

const failed = results.filter((r) => !r.ok);
const groups = [...new Set(results.map((r) => r.group))];

console.log("");
for (const g of groups) {
  console.log(`── ${g} ──`);
  for (const r of results.filter((x) => x.group === g)) {
    console.log(`  ${r.ok ? "○" : "✗"} ${r.name}`);
    if (!r.ok) console.log(`      ${r.message}`);
  }
}

console.log("");
console.log(`合計 ${results.length} 件 / 合格 ${results.length - failed.length} 件 / 不合格 ${failed.length} 件`);

// 文書に書いた件数と突き合わせられるように、実測を残す
recordCount("縦断試験", results.length);

process.exit(failed.length === 0 ? 0 : 1);
