import { asRole, createUser } from "./harness.mjs";

/**
 * helpers.mjs ／ 縦断試験で毎回使う手順
 *
 * 「お題を引いて、投稿して、別の人が答える」までを1本ずつ書くと、
 * どの試験も同じ40行で始まることになる。ここにまとめる。
 *
 * **判定はここに書かない。**ここがやるのは「その状態を作ること」だけで、
 * 何が正しいかは run.mjs 側が決める。
 */

/** 登録ユーザーを1人作り、規約に同意させる（未同意では投稿できないため） */
export async function makeMember(db, handle) {
  const uid = await createUser(db, { handle });

  // いま公開中の規約とポリシーの版に同意させる。
  // 未同意のままだと create_work が止まる（DB検査67）
  const { rows } = await db.query(
    `select (select version from public.terms_versions   where is_current) as t,
            (select version from public.privacy_versions where is_current) as p`,
  );

  await asRole(db, { role: "authenticated", uid }, async (c) => {
    await c.query(`select public.agree_to_documents($1, $2)`, [rows[0].t, rows[0].p]);
  });

  return uid;
}

/** ゲスト（匿名）を1人作る */
export async function makeGuest(db) {
  return createUser(db, { anonymous: true });
}

/** 指定の役として1つの式を評価して値を返す */
export async function value(db, who, sql, params = []) {
  return asRole(db, who, async (c) => {
    const r = await c.query(sql, params);
    return r.rows[0] ? Object.values(r.rows[0])[0] : null;
  });
}

/** 登録ユーザーとして評価する近道 */
export function asMember(uid) {
  return { role: "authenticated", uid, isAnonymous: false };
}

/** ゲストとして評価する近道 */
export function asGuest(uid) {
  return { role: "authenticated", uid, isAnonymous: true };
}

/** 未サインインとして評価する近道 */
export const ANON = { role: "anon", uid: null };

/**
 * お題を1件引き終える。持ち出しを渡せる。
 *
 * 伏せカードは毎回 index 0 をめくる。**どれをめくるかは試験の対象ではない**
 * （どれをめくっても1枚が確定するだけ）。
 */
export async function drawPrompt(db, uid, {
  mode = "normal",
  timeLimit = 3600,
  carried = null,
} = {}) {
  return asRole(db, asMember(uid), async (c) => {
    const start = await c.query(`select public.start_draft($1, $2, $3) as s`, [
      mode,
      timeLimit,
      carried,
    ]);
    let state = start.rows[0].s;

    for (const slot of state.slots) {
      if (slot.candidates.some((x) => x.is_chosen)) continue;
      const r = await c.query(`select public.reveal_card($1, $2, 0) as s`, [
        state.session_id,
        slot.card_slot_key,
      ]);
      state = r.rows[0].s;
    }

    const done = await c.query(`select public.complete_draft($1) as s`, [state.session_id]);
    return { state, ...done.rows[0].s };
  });
}

/**
 * 作品を1件投稿する。画像の実体は無いので、規約どおりのパスだけ渡す。
 *
 * 【部門】
 *   既定はオリジナル。ファンアートは**原作名が必須**なので
 *   （create_work の検査。20260803025753）、渡されなければこちらで埋める。
 *   AI生成は原作名を持てないので、渡さない。
 */
export async function postWork(
  db,
  uid,
  promptId,
  title = "テスト作品",
  { division = "original" } = {},
) {
  const workId = await value(
    db,
    asMember(uid),
    `select gen_random_uuid()`,
  );

  const sourceTitle = division === "fanart" ? "検査用の原作" : null;

  await asRole(db, asMember(uid), async (c) => {
    await c.query(
      `select public.create_work($1, $2, $3, $4, 800, 600, $5, $6)`,
      [workId, promptId, title, `${uid}/${workId}.png`, division, sourceTitle],
    );
  });

  return workId;
}

/**
 * その作品のクイズに答える。
 *
 * 【何を選ぶか】
 *   既定は各問の position 0。正解かどうかは分からないまま選ぶので、
 *   実際の回答と同じ形になる。
 *   correct = true を渡したときだけ、DB から正解を読んで正解を選ぶ
 *   （**そのために prompt_cards を直接読む。試験の準備であって、
 *   アプリの経路ではない。**）
 */
export async function answerWork(
  db,
  uid,
  workId,
  { correct = false, wrong = false, guest = false, pair = "none", pairCorrect = true } = {},
) {
  const who = guest ? asGuest(uid) : asMember(uid);

  // 1. 出題を読む（役の中で）。ここで問のIDが分かる
  const quiz = await asRole(db, who, async (c) => {
    const q = await c.query(`select public.get_work_quiz($1) as q`, [workId]);
    return q.rows[0].q;
  });

  // 2. 正解を選ぶ場合だけ、**役を抜けてから** quiz_choices を覗く。
  //    この表には誰にも権限が無い（正解そのものなので）。
  //    覗けるのは所有者の立場に戻ったときだけで、
  //    アプリがこの経路を持っているわけではない。
  const correctByQuestion = new Map();
  if (correct || wrong || pair !== "none") {
    for (const question of quiz.questions) {
      const r = await db.query(
        `select qc.tag_id from public.quiz_choices qc
          where qc.question_id = $1 and qc.is_correct`,
        [question.question_id],
      );
      correctByQuestion.set(question.question_id, Number(r.rows[0].tag_id));
    }
  }

  // 3. 回答を送る（また役の中で）
  //
  // 【ビタ当てと2択当て（D165）】
  //   pair = "none" … 全問ビタ当て（1語）
  //   pair = "all"  … 全問2択当て（2語）
  //   pair = "half" … 偶数番の問だけ2択当て
  //   pairCorrect が false なら、2択の2語とも正解を外す
  const selections = quiz.questions.map((question, index) => {
    const right = correctByQuestion.get(question.question_id);
    const usePair =
      pair === "all" || (pair === "half" && index % 2 === 0);

    if (usePair) {
      const others = question.choices
        .map((c) => Number(c.tag_id))
        .filter((t) => t !== right);

      const picked = pairCorrect ? [right, others[0]] : [others[0], others[1]];
      return {
        question_id: question.question_id,
        tag_id: picked[0],
        tag_id_2: picked[1],
      };
    }

    // wrong のときは「正解ではない選択肢」を選ぶ。
    // 既定（choices[0]）だと**たまたま正解を引くことがある**ので、
    // 集計の試験では数が揺れて意味を持たない。
    const tagId = correct
      ? right
      : wrong
        ? Number(question.choices.find((c) => Number(c.tag_id) !== right).tag_id)
        : Number(question.choices[0].tag_id);

    return { question_id: question.question_id, tag_id: tagId };
  });

  return asRole(db, who, async (c) => {
    const a = await c.query(`select public.submit_answer($1, $2::jsonb) as a`, [
      workId,
      JSON.stringify(selections),
    ]);
    return a.rows[0].a;
  });
}

/** その作品のお題の語を、正解ごと直接読む（試験の準備。アプリの経路ではない） */
export async function promptTags(db, promptId) {
  const { rows } = await db.query(
    `select pc.card_slot_key, pc.tag_id, t.label, t.pool_key
       from public.prompt_cards pc join public.tags t on t.id = pc.tag_id
      where pc.prompt_id = $1 order by pc.slot_order`,
    [promptId],
  );
  return rows.map((r) => ({ ...r, tag_id: Number(r.tag_id) }));
}

/** 1回の持ち出しで1つの保存枠を作る近道 */
export async function saveCarrySlot(db, uid, promptId, tagIds, persist = true) {
  return value(
    db,
    asMember(uid),
    `select public.save_prompt_elements('prompt', $1, $2, $3)`,
    [promptId, tagIds, persist],
  );
}

/** 準備用。特定の語を含むお題を直接組み立てる（アプリの経路ではない） */
export async function buildPromptWithTags(db, uid, tagLabels, { timeLimit = 3600 } = {}) {
  const { rows } = await db.query(
    `select id, pool_key, label from public.tags
      where label = any($1) and pool_key in (
        select pool_key from public.draw_categories where is_active)
      order by array_position($1, label)`,
    [tagLabels],
  );

  if (rows.length !== tagLabels.length) {
    throw new Error(
      `準備に使う語が見つかりません: 期待 ${tagLabels.length} 件 / 実際 ${rows.length} 件`,
    );
  }

  const { rows: p } = await db.query(
    `insert into public.prompts
       (created_by, mode_key, time_limit_seconds, status, origin)
     values ($1, 'normal', $2, 'active', 'draft')
     returning id`,
    [uid, timeLimit],
  );
  const promptId = p[0].id;

  const seen = new Map();
  let order = 0;

  for (const row of rows) {
    order += 1;
    const n = (seen.get(row.pool_key) ?? 0) + 1;
    seen.set(row.pool_key, n);

    await db.query(
      `insert into public.prompt_cards (prompt_id, card_slot_key, slot_order, tag_id)
       values ($1, $2, $3, $4)`,
      [promptId, `${row.pool_key}_${n}`, order, row.id],
    );
  }

  // 出題と4択は、確定と**同じ関数**に作らせる。
  // ここに同じSQLを書き写すと、規則を直したときに試験だけ古いまま通ってしまう。
  await db.query(`select public.build_quiz_for_prompt($1)`, [promptId]);

  return promptId;
}

/** 期限を過去へずらす。時間を待たずに境界を試すための準備 */
export async function shiftDeadline(db, promptId, seconds) {
  await db.query(
    `update public.prompts
        set deadline_at = deadline_at - make_interval(secs => $2)
      where id = $1`,
    [promptId, seconds],
  );
}

/**
 * ドラフトの期限を過去へずらす。時間を待たずに境界を試すための準備。
 */
export async function shiftDraftDeadline(db, sessionId, seconds) {
  await db.query(
    `update public.draft_sessions
        set deadline_at = deadline_at - make_interval(secs => $2)
      where id = $1`,
    [sessionId, seconds],
  );
}

/**
 * 挑戦そのものを過去へ巻き戻す（開始時刻と期限を同じ秒数だけ古くする）。
 *
 * **開始時刻は本番では書き換えられない**（トリガーが止める）。
 * ここでは試験の準備としてトリガーを外し、終わったら必ず戻す。
 * アプリの経路ではないので、この関数は helpers にしか無い。
 */
export async function rewindChallenge(db, { promptId = null, sessionId = null }, seconds) {
  const table = promptId ? "prompts" : "draft_sessions";
  const trigger = promptId ? "prompts_started_at_immutable" : "draft_sessions_started_at_immutable";
  const id = promptId ?? sessionId;

  await db.exec(`alter table public.${table} disable trigger ${trigger}`);
  try {
    await db.query(
      `update public.${table}
          set started_at  = started_at - make_interval(secs => $2),
              deadline_at = deadline_at - make_interval(secs => $2)
        where id = $1`,
      [id, seconds],
    );
  } finally {
    await db.exec(`alter table public.${table} enable trigger ${trigger}`);
  }
}

/**
 * ドラフトを始めてカードを1枚もめくらずに返す（時計の試験用）。
 */
export async function startDraftOnly(db, uid, { mode = "normal", timeLimit = 3600 } = {}) {
  return asRole(db, asMember(uid), async (c) => {
    const r = await c.query(`select public.start_draft($1, $2, null) as s`, [mode, timeLimit]);
    return r.rows[0].s;
  });
}

/**
 * 進行中のドラフトを、カードをめくって確定まで進める。
 */
export async function finishDraft(db, uid, sessionId) {
  return asRole(db, asMember(uid), async (c) => {
    let state = (await c.query(`select public.get_current_draft() as s`)).rows[0].s;
    for (const slot of state.slots) {
      if (slot.candidates.some((x) => x.is_chosen)) continue;
      const r = await c.query(`select public.reveal_card($1, $2, 0) as s`, [
        sessionId,
        slot.card_slot_key,
      ]);
      state = r.rows[0].s;
    }
    const done = await c.query(`select public.complete_draft($1) as s`, [sessionId]);
    return done.rows[0].s;
  });
}
