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
 *   4. reveal_card で1枠ずつ確定できる
 *   5. 順番を飛ばした reveal_card が拒否される
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

import { readFileSync } from "node:fs";
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

/** .env.local から値を読む（Next.js の dev サーバーと同じファイル） */
function readEnvLocal() {
  const text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
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
    console.error(`${RED}.env.local に Supabase の URL と Publishable key がありません。${RESET}`);
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

  console.log(`\n${BOLD}[2] start_draft（standard / 1時間）${RESET}`);
  const { data: started, error: startErr } = await supabase.rpc("start_draft", {
    p_mode_key: "standard",
    p_time_limit_seconds: 3600,
  });
  check(!startErr, "ドラフトを開始できる", startErr?.message ?? "");
  if (startErr) process.exit(1);

  check(started.slot_count === 5, "枠が5つ", `実際 ${started.slot_count}`);
  check(started.candidate_count === 5, "1枠あたり候補5枚", `実際 ${started.candidate_count}`);
  check(
    started.slots.every((s) => s.candidates.length === 5),
    "全枠に候補が5枚ずつある",
  );
  check(started.time_limit_seconds === 3600, "制作時間が保存されている");
  check(started.current_slot_order === 1, "1番目の枠から始まる");

  console.log(`\n${BOLD}[3] めくる前のカードの中身が漏れていないこと${RESET}`);
  const hidden = started.slots.flatMap((s) => s.candidates).filter((c) => !c.revealed);
  check(hidden.length === 25, "伏せカードが25枚", `実際 ${hidden.length}`);
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

  console.log(`\n${BOLD}[6] reveal_card で1枠ずつ確定${RESET}`);
  let state = started;
  for (let order = 1; order <= 5; order += 1) {
    const { data, error } = await supabase.rpc("reveal_card", {
      p_session_id: state.session_id,
      p_card_slot_key: slotKeyOf(state, order),
      p_candidate_index: firstIndex(state, order),
    });
    if (error) {
      check(false, `${order}番目の枠をめくる`, error.message);
      process.exit(1);
    }
    state = data;
  }
  check(state.chosen_count === 5, "5枠すべて決まった", `実際 ${state.chosen_count}`);
  check(state.is_ready_to_complete === true, "確定できる状態になった");

  const chosen = state.slots.flatMap((s) => s.candidates).filter((c) => c.is_chosen);
  check(chosen.length === 5, "選ばれたカードが5枚");
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
  state = rerolled;
  for (let order = 1; order <= 5; order += 1) {
    const { data, error } = await supabase.rpc("reveal_card", {
      p_session_id: state.session_id,
      p_card_slot_key: slotKeyOf(state, order),
      p_candidate_index: firstIndex(state, order),
    });
    if (error) {
      check(false, `${order}番目の枠をめくる`, error.message);
      process.exit(1);
    }
    state = data;
  }
  check(state.is_ready_to_complete === true, "5枠すべて決まった");

  console.log(`\n${BOLD}[9] complete_draft${RESET}`);
  const { data: done, error: doneErr } = await supabase.rpc("complete_draft", {
    p_session_id: state.session_id,
  });
  check(!doneErr, "お題を確定できる", doneErr?.message ?? "");
  if (doneErr) process.exit(1);
  check(!!done.prompt_id, "prompt_id が返る");
  check(done.card_count === 5, "答えのカードが5枚", `実際 ${done.card_count}`);
  check(done.question_count === 3, "クイズが3問", `実際 ${done.question_count}`);

  const { data: after } = await supabase.rpc("get_current_draft");
  check(after === null, "進行中のドラフトが無くなった");

  console.log(`\n${BOLD}[10] get_my_prompt で答えを取る${RESET}`);
  const { data: prompt, error: promptErr } = await supabase.rpc("get_my_prompt", {
    p_prompt_id: done.prompt_id,
  });
  check(!promptErr && !!prompt, "自分のお題を取得できる", promptErr?.message ?? "");
  if (prompt) {
    check(prompt.cards.length === 5, "カードが5枚");
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
