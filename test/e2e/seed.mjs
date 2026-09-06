/**
 * seed.mjs ／ 画面検証のための下ごしらえ
 *
 * 本番の作品は0件なので、**画面を開いても何も出ない。**
 * 検証用のDBへ、作者・公開作品・回答済みの人を入れておく。
 *
 * 入れ方はアプリと同じ経路（RPC）を通す。表へ直接 insert すると、
 * アプリが通らない状態を作ってしまい、検証にならない。
 */

import { asRole } from "../db/harness.mjs";

function member(uid) {
  return { role: "authenticated", uid, isAnonymous: false };
}

async function createUser(db, { email = null, anonymous = false, handle = null } = {}) {
  const { rows } = await db.query(
    `insert into auth.users (email, is_anonymous) values ($1, $2) returning id`,
    [email, anonymous],
  );
  if (handle) {
    await db.query(`update public.profiles set handle = $2 where id = $1`, [rows[0].id, handle]);
  }
  return rows[0].id;
}

async function agree(db, uid) {
  const { rows } = await db.query(
    `select (select version from public.terms_versions   where is_current) as t,
            (select version from public.privacy_versions where is_current) as p`,
  );
  await asRole(db, member(uid), async (c) => {
    await c.query(`select public.agree_to_documents($1, $2)`, [rows[0].t, rows[0].p]);
  });
}

/** お題を1件引き終える */
async function drawPrompt(db, uid, timeLimit = 3600, mode = "normal") {
  return asRole(db, member(uid), async (c) => {
    const start = await c.query(`select public.start_draft($2, $1, null) as s`, [timeLimit, mode]);
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
    return done.rows[0].s;
  });
}

/**
 * 作品を1件投稿する。
 *
 * 部門を指定できる。ファンアートは原作名が要る（create_work の検査）ので、
 * 指定が無ければこちらで埋める。AI生成は原作名を持てないので渡さない。
 */
async function postWork(db, uid, promptId, title, { division = "original" } = {}) {
  const workId = (await db.query(`select gen_random_uuid() as id`)).rows[0].id;
  const sourceTitle = division === "fanart" ? "検証用の原作" : null;
  await asRole(db, member(uid), async (c) => {
    await c.query(`select public.create_work($1, $2, $3, $4, 800, 600, $5, $6)`, [
      workId,
      promptId,
      title,
      `${uid}/${workId}.png`,
      division,
      sourceTitle,
    ]);
  });
  return workId;
}

/**
 * 検証用の一式を作る。
 *
 * 返すもの: 公開作品6件、作者、フレーバー付きの作品1件。
 */
export async function seedForE2E(db, { memberEmail = "e2e-member@example.test" } = {}) {
  // フレーバーの検証に、回答する人がもう2人要る（開く人・開かない人）
  const hintReaderEmail = "e2e-hint-reader@example.test";
  const plainAnswererEmail = "e2e-plain@example.test";
  const author = await createUser(db, { email: "e2e-author@example.test", handle: "e2e-author" });
  await agree(db, author);

  // 画面を確かめる人（登録者）。メールでサインインできるようにしておく
  const viewer = await createUser(db, { email: memberEmail, handle: "e2e-viewer" });
  await agree(db, viewer);

  const works = [];
  for (let i = 0; i < 6; i += 1) {
    const p = await drawPrompt(db, author, 3600);
    const w = await postWork(db, author, p.prompt_id, `検証用の作品 ${i + 1}`);
    works.push({ workId: w, promptId: p.prompt_id });
  }

  // 高難度のお題を1件。**語数が5〜6語になるので、出題も5〜6問になる**（D165）。
  // 問数が増えてもスマホで操作できることを、この作品で見る。
  const hardPrompt = await drawPrompt(db, author, 3600, "hard");
  const hardWork = await postWork(db, author, hardPrompt.prompt_id, "検証用の高難度作品");

  // 1件だけ、作者のフレーバーテキストを付ける（ヒントの分離集計を見るため）
  const flavorWork = works[0].workId;
  await asRole(db, member(author), async (c) => {
    const list = await c.query(`select public.get_flavor_vocab($1) as v`, [flavorWork]);
    const ids = list.rows[0].v.vocab.slice(0, 4).map((x) => x.id);
    await c.query(`select public.set_flavor_text($1, $2)`, [flavorWork, ids]);
  });

  /* --- 部門ごとの作品（D169 の12・11 を画面から確かめるため）-----------------
   *
   * これまでの検証用データは**全部オリジナル部門**だった。それだと
   * 「ファンアートから次へ進むとファンアートが出る」を画面で確かめられない。
   * 部門ごとに3件ずつ置く。3件なのは、
   *   ・いま見ている作品      1件
   *   ・回答0件（第1救済帯）  1件
   *   ・回答1件以上（第2帯）  1件
   * を1つの部門の中で作り分けられる最小の数だから。
   *
   * オリジナルは既存の6件があるので、ここで足すのはファンアートとAI生成だけ。
   */
  const divisionWorks = { original: works.map((w) => w.workId), fanart: [], ai: [] };
  for (const division of ["fanart", "ai"]) {
    for (let i = 0; i < 3; i += 1) {
      const p = await drawPrompt(db, author, 3600);
      divisionWorks[division].push(
        await postWork(db, author, p.prompt_id, `検証用の${division}作品 ${i + 1}`, {
          division,
        }),
      );
    }
  }

  // 完成度の絞り込みと「未回答のみ」を同時に使えることを見るために、
  // オリジナルの1件だけ落書きにしておく（既定はすべて仕上げ）
  const sketchWork = divisionWorks.original[1];
  await asRole(db, member(author), async (c) => {
    await c.query(`select public.update_work_completeness($1, 'sketch')`, [sketchWork]);
  });

  const hintReader = await createUser(db, { email: hintReaderEmail, handle: "e2e-hint" });
  await agree(db, hintReader);
  const plainAnswerer = await createUser(db, { email: plainAnswererEmail, handle: "e2e-plain" });
  await agree(db, plainAnswerer);

  return {
    author,
    authorEmail: "e2e-author@example.test",
    viewer,
    works,
    divisionWorks,
    sketchWork,
    hardWork,
    hardPromptId: hardPrompt.prompt_id,
    flavorWork,
    memberEmail,
    hintReader,
    hintReaderEmail,
    plainAnswerer,
    plainAnswererEmail,
  };
}
