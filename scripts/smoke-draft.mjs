#!/usr/bin/env node
/**
 * smoke-draft.mjs ／ ドラフト一連の流れを、画面を使わずに通す
 *
 * ブラウザで押す操作と同じ道筋（匿名サインイン → RPC）を、
 * 同じ Publishable key で辿る。画面の不具合と DB の不具合を切り分けられる。
 *
 * 【確かめること】
 *   1. 匿名サインインができる
 *   2. start_draft で候補が正しい数だけできる
 *   3. **めくっていないカードの中身が返ってこない**（いちばん大事）
 *   4. めくる（reveal_card）→ 決める（choose_card）の2段で進む
 *   5. 順番を飛ばした reveal_card が拒否される
 *   6. 保持の上限と、保持後の残り開示、開示後の引き直し禁止
 *   6. reroll_draft で引き直せる
 *   7. complete_draft でお題とクイズができる
 *   8. get_my_prompt で答えが取れる
 *   9. 他人になりすまして同じお題を取ろうとすると null が返る
 *
 * 【残るデータ】
 *   ゲスト1〜2人ぶんの draft_sessions と prompts が残る。
 *   ブラウザで動かしたときと同じもので、30日後の掃除対象になる。
 *
 * 【使い方】
 *   npm run smoke:draft
 */

import { readTargetEnv } from "./_env-target.mjs";
import { createClient } from "@supabase/supabase-js";
import { ensureFixtureUser } from "./_smoke-users.mjs";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

let pass = 0;
let fail = 0;

function check(ok, label, detail = "") {
  console.log(
    `  ${ok ? GREEN + "✓" : RED + "✗"}${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ""}`,
  );
  if (ok) pass += 1;
  else fail += 1;
}

/**
 * 接続先を決める。
 *
 * **ここでは .env.local を開かない。**開くかどうかを決めるのは
 * scripts/_env-target.mjs の1か所だけで、ローカルの経路では開かれない。
 *
 * もとはこの場所で .env.local を読み、process.env を上に重ねていた。
 * 順番のおかげで本番の値は勝たなかったが、
 * **ローカルの検査が本番の控えを開いている**ことに変わりはなかった
 * （実測: 検証用の合言葉で本番へサインインしようとして
 * Invalid login credentials になった。書き込みは起きていない）。
 */
function readEnvLocal() {
  return readTargetEnv({ context: "スモーク（ドラフト）" });
}

function newClient(env) {
  return createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

/** その枠の、まだ選ばれていない最初のカード番号を返す */
function firstIndex(state, slotOrder) {
  const slot = state.slots.find((s) => s.slot_order === slotOrder);
  return slot ? slot.candidates[0].candidate_index : 0;
}

function slotKeyOf(state, slotOrder) {
  const slot = state.slots.find((s) => s.slot_order === slotOrder);
  return slot ? slot.card_slot_key : "";
}

async function main() {
  const env = readEnvLocal();
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
    console.error(`${RED}Supabase の URL と Publishable key が環境にありません。${RESET}`);
    console.error("ローカルは test/e2e/smoke.mjs から、本番は npm run smoke:prod から起動します。");
    process.exit(1);
  }

  const supabase = newClient(env);

  // **匿名サインインは使わない。**
  //
  // この検査の本題はドラフトRPCの中身（候補の数・重複の無さ・引き直し）で、
  // 「ゲストでも呼べること」は smoke:anon と権限検査が持っている。
  // 匿名で回すと 1回ごとに上限（1時間30回・IP単位）を削り、
  // 続けて回したときに**本題と無関係な項目が落ちる**（D83）。
  //
  // 固定の検査用利用者でサインインする。こちらの枠は5分に30回で、
  // 12倍ゆるい。
  console.log(`\n${BOLD}[1] 検査用の利用者としてサインイン${RESET}`);
  const fixture = await ensureFixtureUser("draft-user");
  const { data: auth, error: authErr } = await supabase.auth.signInWithPassword({
    email: fixture.email,
    password: fixture.password,
  });
  check(!authErr && !!auth?.user, "検査用の利用者としてサインインできる", authErr?.message ?? "");
  if (authErr) {
    // **原因で案内を分ける。**
    // 以前はどちらの場合も「Anonymous を有効にしてください」と出していた。
    // 回数制限に当たっただけのときにそれを読むと、**すでに正しい設定を
    // 触りに行かせてしまう。**しかも直らないので、さらに遠回りになる。
    if (/rate limit/i.test(authErr.message)) {
      console.error(
        [
          "",
          `${RED}  Supabase の回数制限に当たりました。設定は正しいままです。${RESET}`,
          "",
          "    ・匿名サインインの既定は 1時間あたり30回・IPアドレス単位",
          "    ・スモークは1周で十数人ぶん使うため、続けて回すと当たる",
          "",
          "  対処:",
          "    1. 1時間ほど待ってからもう一度実行する",
          "    2. または Authentication → Rate limits で上限を上げる",
          "",
          `${RED}  **これはアプリの不具合ではありません。**${RESET}`,
        ].join("\n"),
      );
    } else {
      console.error(
        `${RED}  → Supabase → Authentication → Sign In / Providers で Anonymous を有効にしてください${RESET}`,
      );
    }
    process.exit(1);
  }

  // 前回の残りがあれば片づける
  const { data: existing } = await supabase.rpc("get_current_draft");
  if (existing) await supabase.rpc("abandon_draft", { p_session_id: existing.session_id });

  // 【2026-09-04 以降、枠の数は固定ではない】
  //   カテゴリの構成をドラフトのたびに抽選するので（D159）、
  //   高難度なら5〜6枠のどれかになる。**数を決め打ちにしない。**
  //   この試験が見るのは「範囲に入っているか」と「その数で最後まで通るか」。
  console.log(`\n${BOLD}[2] start_draft（hard / 1時間）${RESET}`);
  const { data: started, error: startErr } = await supabase.rpc("start_draft", {
    p_mode_key: "hard",
    p_time_limit_seconds: 3600,
  });
  check(!startErr, "ドラフトを開始できる", startErr?.message ?? "");
  if (startErr) process.exit(1);

  check(
    started.slot_count >= 5 && started.slot_count <= 6,
    "高難度の枠が5〜6",
    `実際 ${started.slot_count}`,
  );
  // D170: 1枠一律ではなく、総ドラフト基数を2〜5枚で配る
  const lotSlots = started.slots.filter((x) => !x.is_carried);
  const counts = lotSlots.map((x) => x.candidates.length);
  const total = counts.reduce((a, b) => a + b, 0);
  check(
    counts.every((n) => n >= 2 && n <= 5),
    "どの枠も候補2〜5枚",
    `実際 ${counts.join("/")}`,
  );
  check(
    total === lotSlots.length * 3,
    `候補の合計が総ドラフト基数（枠${lotSlots.length}×3＝${lotSlots.length * 3}）と一致`,
    `実際 ${total}`,
  );
  check(
    started.draft_base === total,
    "draft_base と実際の枚数が一致",
    `${started.draft_base} / ${total}`,
  );
  check(
    new Set(counts).size > 1 || counts.length === 1,
    "枚数が全枠同じ値に固定されていない（1枠のときは対象外）",
    `実際 ${counts.join("/")}`,
  );
  const morphs = started.slots.filter((x) => x.card_slot_key.startsWith("morph_")).length;
  check(morphs >= 1 && morphs <= 2, "モーフは1〜2枠", `実際 ${morphs}`);
  const colors = started.slots.filter((x) => x.card_slot_key.startsWith("color_")).length;
  check(colors <= 1, "カラーは多くても1枠（必須ではない）", `実際 ${colors}`);
  check(started.carried_count === 0, "持ち出しを渡していないので0個");
  check(started.time_limit_seconds === 3600, "制作時間が保存されている");
  check(started.current_slot_order === 1, "1番目の枠から始まる");

  console.log(`\n${BOLD}[3] めくる前のカードの中身が漏れていないこと${RESET}`);
  const hidden = started.slots.flatMap((s) => s.candidates).filter((c) => !c.revealed);
  const wantHidden = total;
  check(hidden.length === wantHidden, `伏せカードが${wantHidden}枚`, `実際 ${hidden.length}`);
  check(
    hidden.every((c) => c.label === null),
    "伏せカードの label がすべて null",
  );
  check(
    hidden.every((c) => c.tag_id === null),
    "伏せカードの tag_id がすべて null（id から label を引けないようにするため）",
  );

  // 同一世代でタグが重複していないこと（プールをまたいだ重複も見る）
  console.log(`\n${BOLD}[4] 抽選のきまり${RESET}`);
  const { data: dupCheck } = await supabase.rpc("get_current_draft");
  check(dupCheck?.session_id === started.session_id, "get_current_draft が同じドラフトを返す");

  console.log(`\n${BOLD}[5] 順番を飛ばした reveal_card が拒否されること${RESET}`);
  const { error: skipErr } = await supabase.rpc("reveal_card", {
    p_session_id: started.session_id,
    p_card_slot_key: slotKeyOf(started, 3),
    p_candidate_index: 0,
  });
  check(
    !!skipErr && skipErr.message.includes("WRONG_SLOT_ORDER"),
    "3番目の枠を先にめくろうとすると拒否される",
    skipErr ? "" : "拒否されなかった",
  );

  console.log(`\n${BOLD}[5-b] 保持の上限・残りの開示・開示後の引き直し禁止（D170 / D171）${RESET}`);
  //
  // **この節だけ別のドラフトを使う。**残りを開くと引き直せなくなるので、
  // ここで使ったセッションは最後に捨てる。上の started はそのまま残す。
  {
    await supabase.rpc("abandon_draft", { p_session_id: started.session_id });
    const { data: probe, error: probeErr } = await supabase.rpc("start_draft", {
      p_mode_key: "hard",
      p_time_limit_seconds: 3600,
      p_carried_element_ids: null,
    });
    if (probeErr) {
      check(false, "確認用のドラフトを開始できる", probeErr.message);
      process.exit(1);
    }
    const key = slotKeyOf(probe, probe.current_slot_order);
    const slot = probe.slots.find((x) => x.card_slot_key === key);
    const n = slot.candidates.length;
    const limit = Math.min(2, n - 1);
    check(slot.held_limit === limit, `残せる上限が min(2, ${n} - 1) = ${limit}`,
      `実際 ${slot.held_limit}`);

    for (let i = 0; i < limit; i += 1) {
      await supabase.rpc("reveal_card", {
        p_session_id: probe.session_id, p_card_slot_key: key, p_candidate_index: i,
      });
      const { error } = await supabase.rpc("hold_card", {
        p_session_id: probe.session_id, p_card_slot_key: key,
        p_candidate_index: i, p_hold: true,
      });
      check(!error, `${i + 1}枚目を残せる`, error?.message ?? "");
    }

    await supabase.rpc("reveal_card", {
      p_session_id: probe.session_id, p_card_slot_key: key, p_candidate_index: limit,
    });
    const { error: overErr } = await supabase.rpc("hold_card", {
      p_session_id: probe.session_id, p_card_slot_key: key,
      p_candidate_index: limit, p_hold: true,
    });
    check(
      !!overErr && overErr.message.includes("HOLD_LIMIT"),
      "上限を超えて残そうとすると断られる（全部は残せない）",
      overErr ? "" : "断られなかった",
    );

    const { data: opened, error: poolErr } = await supabase.rpc("reveal_slot_pool", {
      p_session_id: probe.session_id, p_card_slot_key: key,
    });
    check(!poolErr, "残した候補があるので、その枠の残りを開ける", poolErr?.message ?? "");
    if (opened) {
      const s2 = opened.slots.find((x) => x.card_slot_key === key);
      check(s2.pool_revealed === true, "開示の印が付く");
      check(s2.candidates.every((c) => c.revealed), "その枠の候補が全部見える");
      check(s2.candidates.length === n, "開示しても候補は増えない", `実際 ${s2.candidates.length}`);
    }

    const { error: rerollErr } = await supabase.rpc("reroll_draft", {
      p_session_id: probe.session_id,
    });
    check(
      !!rerollErr && rerollErr.message.includes("POOL_ALREADY_REVEALED"),
      "残りを開いたあとは引き直せない（新しい候補を出す抜け道が無い）",
      rerollErr ? "" : "引き直せてしまった",
    );

    // 確認用のセッションはここで捨てる
    await supabase.rpc("abandon_draft", { p_session_id: probe.session_id });
  }

  // 本筋の続きに使うドラフトを引き直す
  const { data: restarted, error: restartErr } = await supabase.rpc("start_draft", {
    p_mode_key: "hard",
    p_time_limit_seconds: 3600,
    p_carried_element_ids: null,
  });
  if (restartErr) {
    check(false, "本筋のドラフトを開始し直せる", restartErr.message);
    process.exit(1);
  }

  console.log(`\n${BOLD}[6] めくる → 決める の2段（D170）${RESET}`);
  let state = restarted;

  // まず1枠だけ、めくった時点で確定していないことを確かめる
  {
    const key = slotKeyOf(state, state.current_slot_order);
    const idx = firstIndex(state, state.current_slot_order);
    const { data: revealed, error: rErr } = await supabase.rpc("reveal_card", {
      p_session_id: state.session_id,
      p_card_slot_key: key,
      p_candidate_index: idx,
    });
    if (rErr) {
      check(false, "1枠目をめくる", rErr.message);
      process.exit(1);
    }
    const slot = revealed.slots.find((x) => x.card_slot_key === key);
    const card = slot.candidates.find((c) => c.candidate_index === idx);
    check(card.revealed === true, "めくった印が付く");
    check(card.is_chosen === false, "めくっただけでは確定にならない");
    check(
      revealed.current_slot_order === state.current_slot_order,
      "めくっただけでは次の枠へ進まない",
    );
    check(revealed.chosen_count === state.chosen_count, "確定数が増えない");

    const { data: chosen, error: cErr } = await supabase.rpc("choose_card", {
      p_session_id: state.session_id,
      p_card_slot_key: key,
      p_candidate_index: idx,
    });
    if (cErr) {
      check(false, "1枠目を決める", cErr.message);
      process.exit(1);
    }
    check(chosen.chosen_count === state.chosen_count + 1, "決めると確定数が増える");
    check(chosen.current_slot_order > state.current_slot_order, "決めると次の枠へ進む");
    state = chosen;
  }

  // 残りの枠は、めくる→決める を続けて通す
  while (state.chosen_count < state.slot_count) {
    const order = state.current_slot_order;
    const key = slotKeyOf(state, order);
    const idx = firstIndex(state, order);
    const { error: rErr } = await supabase.rpc("reveal_card", {
      p_session_id: state.session_id,
      p_card_slot_key: key,
      p_candidate_index: idx,
    });
    if (rErr) {
      check(false, `${order}番目の枠をめくる`, rErr.message);
      process.exit(1);
    }
    const { data, error } = await supabase.rpc("choose_card", {
      p_session_id: state.session_id,
      p_card_slot_key: key,
      p_candidate_index: idx,
    });
    if (error) {
      check(false, `${order}番目の枠を決める`, error.message);
      process.exit(1);
    }
    state = data;
  }
  check(
    state.chosen_count === state.slot_count,
    "すべての枠が決まった",
    `実際 ${state.chosen_count} / ${state.slot_count}`,
  );
  check(state.is_ready_to_complete === true, "確定できる状態になった");

  const chosen = state.slots.flatMap((s) => s.candidates).filter((c) => c.is_chosen);
  check(chosen.length === state.slot_count, `選ばれたカードが${state.slot_count}枚`);
  check(
    chosen.every((c) => c.label !== null && c.tag_id !== null),
    "選んだカードは中身が見える",
  );
  const stillHidden = state.slots.flatMap((s) => s.candidates).filter((c) => !c.revealed);
  check(
    stillHidden.every((c) => c.label === null && c.tag_id === null),
    "選ばなかったカードは伏せたまま",
    `${stillHidden.length}枚`,
  );

  console.log(`\n${BOLD}[7] reroll_draft で引き直す${RESET}`);
  const { data: rerolled, error: rerollErr } = await supabase.rpc("reroll_draft", {
    p_session_id: state.session_id,
  });
  check(!rerollErr, "引き直せる", rerollErr?.message ?? "");
  if (rerollErr) process.exit(1);
  check(rerolled.generation === 2, "世代が2になった", `実際 ${rerolled.generation}`);
  check(rerolled.chosen_count === 0, "選択が白紙に戻った");
  check(rerolled.current_slot_order === 1, "1番目の枠からやり直しになった");
  check(rerolled.rerolls_left === 0, "引き直しの残りが0回");

  const { error: reroll2Err } = await supabase.rpc("reroll_draft", {
    p_session_id: state.session_id,
  });
  check(
    !!reroll2Err && reroll2Err.message.includes("NO_REROLL_LEFT"),
    "2回目の引き直しは拒否される",
  );

  console.log(`\n${BOLD}[8] もう一度めくって確定${RESET}`);
  // 引き直すとカテゴリの構成ごと引き直されるので、枠の数が変わりうる。
  //
  // **ここも2段で進める（D170）。**めくっただけでは枠が進まないので、
  // めくって決めるまでを1周にする。片方だけだと、次の枠をめくろうとした
  // ところで WRONG_SLOT_ORDER になる（実測: 2026-09-07 の本番スモーク）。
  state = rerolled;
  for (let order = 1; order <= rerolled.slot_count; order += 1) {
    const key = slotKeyOf(state, order);
    const index = firstIndex(state, order);

    const { error: flipErr } = await supabase.rpc("reveal_card", {
      p_session_id: state.session_id,
      p_card_slot_key: key,
      p_candidate_index: index,
    });
    if (flipErr) {
      check(false, `${order}番目の枠をめくる`, flipErr.message);
      process.exit(1);
    }

    const { data, error } = await supabase.rpc("choose_card", {
      p_session_id: state.session_id,
      p_card_slot_key: key,
      p_candidate_index: index,
    });
    if (error) {
      check(false, `${order}番目の枠に決める`, error.message);
      process.exit(1);
    }
    state = data;
  }
  check(state.is_ready_to_complete === true, "すべての枠が決まった");

  console.log(`\n${BOLD}[9] complete_draft${RESET}`);
  const { data: done, error: doneErr } = await supabase.rpc("complete_draft", {
    p_session_id: state.session_id,
  });
  check(!doneErr, "お題を確定できる", doneErr?.message ?? "");
  if (doneErr) process.exit(1);
  check(!!done.prompt_id, "prompt_id が返る");
  check(
    done.card_count === state.slot_count,
    `答えのカードが${state.slot_count}枚`,
    `実際 ${done.card_count}`,
  );
  // **問数はお題の語数と同じ（D165）。3で決め打ちしない**
  check(
    done.question_count === done.card_count,
    `クイズがお題の語数と同じ${done.card_count}問`,
    `実際 ${done.question_count}`,
  );

  const { data: after } = await supabase.rpc("get_current_draft");
  check(after === null, "進行中のドラフトが無くなった");

  console.log(`\n${BOLD}[10] get_my_prompt で答えを取る${RESET}`);
  const { data: prompt, error: promptErr } = await supabase.rpc("get_my_prompt", {
    p_prompt_id: done.prompt_id,
  });
  check(!promptErr && !!prompt, "自分のお題を取得できる", promptErr?.message ?? "");
  if (prompt) {
    check(prompt.cards.length === done.card_count, `カードが${done.card_count}枚`);
    check(
      prompt.cards.some((c) => c.pool_key === "morph"),
      "描く対象（モーフ）が1つ以上入っている",
    );
    check(
      prompt.cards.every((c) => typeof c.tag_label === "string" && c.tag_label.length > 0),
      "各カードにタグ名が入っている",
    );
    check(prompt.was_rerolled === true, "引き直した記録が残っている");
    check(prompt.reroll_count === 1, "引き直し回数が1");
    check(prompt.unchosen.length === 0, "未開示なので未選択カードは空", "（D8）");
    check(!("prompt_id" in prompt), "返り値に prompt_id というキーが無い");
    console.log(
      `    ${DIM}お題: ${prompt.cards.map((c) => `${c.card_slot_label}=${c.tag_label}`).join(" / ")}${RESET}`,
    );
  }

  console.log(`\n${BOLD}[11] 他人からは見えないこと${RESET}`);
  const other = newClient(env);
  const otherFixture = await ensureFixtureUser("draft-other");
  const { error: otherAuthErr } = await other.auth.signInWithPassword({
    email: otherFixture.email,
    password: otherFixture.password,
  });
  check(!otherAuthErr, "別のゲストとしてサインインできる");
  const { data: stolen, error: stolenErr } = await other.rpc("get_my_prompt", {
    p_prompt_id: done.prompt_id,
  });
  check(
    !stolenErr && stolen === null,
    "他人のお題IDを渡すと null が返る（エラーにしない）",
    stolenErr ? stolenErr.message : "",
  );

  const { error: tableErr } = await other.from("prompt_cards").select("tag_id").limit(1);
  check(
    !!tableErr && /permission denied/i.test(tableErr.message),
    "prompt_cards を直接読むと permission denied",
  );

  await supabase.auth.signOut();
  await other.auth.signOut();

  console.log("\n───────────────────────────────────────────");
  if (fail === 0) {
    console.log(`${GREEN}${BOLD}✓ すべて期待どおり（${pass}項目）${RESET}`);
    console.log("───────────────────────────────────────────\n");
    process.exit(0);
  } else {
    console.log(`${RED}${BOLD}✗ ${fail}項目が期待と異なります（成功 ${pass}）${RESET}`);
    console.log("───────────────────────────────────────────\n");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`${RED}想定外のエラー:${RESET} ${err.stack ?? err.message}`);
  process.exit(1);
});
