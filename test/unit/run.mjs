#!/usr/bin/env node
/**
 * run.mjs ／ 長押しと回答の組み立てを、時計を手で進めて確かめる
 *
 * 実行: npm run test:unit
 *
 * 【なぜブラウザを立てないのか】
 *   長押しは時間で決まる。ブラウザで試すと、1件ごとに本物の1.5秒を待つ。
 *   さらに機械が混んでいる日は 1.5 秒のつもりが 1.7 秒になり、
 *   **アプリは正しいのに検査が落ちる。**原因が分からない不合格が増える。
 *
 *   確定を決めている勘定（src/features/quiz/hold.ts）は、
 *   「いまが何ミリ秒か」を外から受け取る形にしてある。
 *   だからここでは 0 → 1499 → 1500 のように、時計を手で進められる。
 *   待ち時間は 0 で、結果は毎回同じになる。
 *
 * 【ここで確かめないこと】
 *   画面の見た目、指の操作、キーボード。それらはブラウザ試験（test:e2e）の担当。
 *   ここが見るのは「何秒で確定するか」「何語まで選べるか」だけ。
 *
 * 【複勝（2択当て）の操作方法は、まだ決まっていない】
 *   2語をそれぞれ長押しするのか、2語を選んでから1回長押しするのかは未確定。
 *   **だからここでは操作の順序を固定しない。**確かめるのは
 *   「2語まで」「同じ語は入らない」「4択なら6通りすべて表せる」という
 *   データの側だけで、これは操作方法がどちらに決まっても変わらない。
 */

import {
  HOLD_MS,
  IDLE,
  REWIND_MS,
  advance,
  cancel,
  gaugeFraction,
  press,
  release,
} from "../../src/features/quiz/hold.ts";
import {
  afterCommit,
  commitExact,
  commitPair,
  isComplete,
  missingQuestions,
  toggleTentative,
} from "../../src/features/quiz/answering.ts";
import { recordCount } from "../counts.mjs";

const results = [];

function test(group, name, fn) {
  try {
    fn();
    results.push({ group, name, ok: true });
    console.log(`  ○ [${group}] ${name}`);
  } catch (e) {
    results.push({ group, name, ok: false, why: e.message });
    console.log(`  ✗ [${group}] ${name}\n      ${e.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** 押しっぱなしで t ミリ秒経ったときの状態 */
function heldFor(ms) {
  return advance(press(IDLE, 0), ms);
}

console.log("\n長押しの時間");

test("長押し", "1.499 秒では確定しない", () => {
  const h = heldFor(HOLD_MS - 1);
  assert(h.phase === "holding", `phase が ${h.phase}`);
  assert(h.progress < 1, `progress が ${h.progress}`);
});

test("長押し", "1.500 秒ちょうどで確定する", () => {
  const h = heldFor(HOLD_MS);
  assert(h.phase === "done", `phase が ${h.phase}`);
  assert(h.progress === 1, `progress が ${h.progress}`);
});

test("長押し", "確定は離すのを待たない（押したまま満ちた時点で決まる）", () => {
  // 離す操作を一度もしていない
  const h = heldFor(HOLD_MS + 500);
  assert(h.phase === "done", `phase が ${h.phase}`);
});

test("長押し", "途中で離すと確定しない", () => {
  const h = release(heldFor(800), 800);
  assert(h.phase === "rewinding", `phase が ${h.phase}`);
  assert(Math.abs(h.progress - 800 / HOLD_MS) < 1e-9, `progress が ${h.progress}`);
});

test("長押し", "離したあと 2.3 秒で 0 に戻る", () => {
  const r = release(heldFor(1000), 1000);
  const almost = advance(r, 1000 + REWIND_MS * (r.progress - 0.001) / 1);
  assert(almost.progress > 0, "戻りきる前に 0 になっている");

  // 満タンから離した場合でも 2.3 秒あれば必ず 0
  const full = { phase: "rewinding", progress: 1, at: 0 };
  const end = advance(full, REWIND_MS);
  assert(end.phase === "idle" && end.progress === 0, `${end.phase} / ${end.progress}`);
});

test("長押し", "巻き戻しは即座に 0 にならない（離した直後は残っている）", () => {
  const r = release(heldFor(1200), 1200);
  const soon = advance(r, 1200 + 1);
  assert(soon.progress > 0.7, `離した 1 ミリ秒後に ${soon.progress} まで落ちている`);
});

test("長押し", "巻き戻しの途中で押し直すと、残っている量から続く", () => {
  //  0.8 秒押して離し、0.4 秒後に押し直す
  const held = heldFor(800);
  const r = release(held, 800);
  const mid = advance(r, 1200);
  const again = press(mid, 1200);

  assert(again.phase === "holding", `phase が ${again.phase}`);
  assert(
    Math.abs(again.progress - mid.progress) < 1e-9,
    `押し直した時点で ${again.progress}（残っていた ${mid.progress} のはず）`,
  );
  assert(again.progress > 0, "押し直しで 0 に戻っている");

  // 残りは「1 になるまでの分」だけで足りる。
  // 境目のちょうど 1 ミリ秒手前と 1 ミリ秒後で見る（小数の丸めを判定に持ち込まない）
  const need = (1 - again.progress) * HOLD_MS;
  assert(advance(again, 1200 + need - 1).phase === "holding", "1 ミリ秒早く確定した");
  assert(advance(again, 1200 + need + 1).phase === "done", "残りぶん押しても確定しない");

  // 最初から押した場合より短い時間で確定する＝押し直しで 0 に戻っていない
  assert(need < HOLD_MS - 1, `残り ${need} ミリ秒。最初からと変わらない`);
});

test("長押し", "押下が取り消されたら確定しない（pointercancel 相当）", () => {
  const c = cancel(heldFor(1400), 1400);
  assert(c.phase === "rewinding", `phase が ${c.phase}`);
  assert(c.progress < 1, `progress が ${c.progress}`);
  // そのまま時間が経っても done にならない
  assert(advance(c, 1400 + 5000).phase === "idle", "取り消したのに確定した");
});

test("長押し", "確定したあと、押しても離しても二度目の確定は起きない", () => {
  const done = heldFor(HOLD_MS);
  const again = press(done, 2000);
  assert(again.phase === "done", `押し直しで ${again.phase} になった`);
  assert(release(again, 2500).phase === "done", "離すと別の状態になった");
  // 何度触っても done のまま＝送信のきっかけは1回きり
  let h = done;
  for (let i = 0; i < 20; i += 1) h = press(release(h, 2000 + i), 2000 + i);
  assert(h.phase === "done", `連打で ${h.phase} になった`);
});

test("長押し", "速く押して離してを繰り返しても、進み方は経過時間どおり", () => {
  // 10 ミリ秒押して 10 ミリ秒離す、を 10 回。合計 100 ミリ秒しか押していない
  let h = IDLE;
  let t = 0;
  for (let i = 0; i < 10; i += 1) {
    h = press(h, t);
    t += 10;
    h = release(h, t);
    t += 10;
  }
  const held = advance(h, t);
  assert(held.phase !== "done", "押した合計 100 ミリ秒で確定した");
  assert(held.progress < 100 / HOLD_MS, `巻き戻しぶんが引かれていない（${held.progress}）`);
});

console.log("\n見た目の曲線（確定時刻を動かさないこと）");

test("曲線", "0 で 0、1 で 1（満ちた見た目と確定が同時に起きる）", () => {
  assert(gaugeFraction(0) === 0, `0 のとき ${gaugeFraction(0)}`);
  assert(gaugeFraction(1) === 1, `1 のとき ${gaugeFraction(1)}`);
});

test("曲線", "序盤ほど速く、終盤ほど遅い（ease-out）", () => {
  assert(gaugeFraction(0.5) > 0.5, `半分の時点で ${gaugeFraction(0.5)}`);
  const early = gaugeFraction(0.1) - gaugeFraction(0);
  const late = gaugeFraction(1) - gaugeFraction(0.9);
  assert(early > late, `序盤 ${early} / 終盤 ${late}`);
});

test("曲線", "曲線は確定の時刻に触らない", () => {
  // gaugeFraction を通しても、確定は 1.5 秒のまま
  assert(heldFor(HOLD_MS - 1).phase === "holding", "1 ミリ秒早く確定した");
  assert(heldFor(HOLD_MS).phase === "done", "1.5 秒で確定しない");
});

console.log("\nビタ当て");

test("ビタ当て", "1語だけが残る", () => {
  const m = commitExact({}, 7, 100);
  assert(m[7].mode === "exact", `mode が ${m[7].mode}`);
  assert(m[7].tags.length === 1 && m[7].tags[0] === 100, JSON.stringify(m[7].tags));
});

test("ビタ当て", "同じセクションで別の語を確定すると置き換わる（二重回答にならない）", () => {
  let m = commitExact({}, 7, 100);
  m = commitExact(m, 7, 101);
  assert(Object.keys(m).length === 1, `問が ${Object.keys(m).length} 件になった`);
  assert(m[7].tags.length === 1 && m[7].tags[0] === 101, JSON.stringify(m[7].tags));
});

test("ビタ当て", "他のセクションの回答を壊さない", () => {
  let m = commitExact({}, 7, 100);
  m = commitExact(m, 8, 200);
  m = commitExact(m, 7, 101);
  assert(m[8].tags[0] === 200, "隣のセクションが変わった");
});

test("ビタ当て", "複勝で確定したセクションを、ビタ当てで上書きできる", () => {
  let m = commitPair({}, 7, [100, 101]);
  m = commitExact(m, 7, 102);
  assert(m[7].mode === "exact" && m[7].tags.length === 1, JSON.stringify(m[7]));
});

console.log("\n複勝（データの側だけ。操作方法は未確定）");

test("複勝", "2語まで。3語目を選ぶと古いほうが押し出される", () => {
  let t = [];
  t = toggleTentative(t, 1);
  t = toggleTentative(t, 2);
  t = toggleTentative(t, 3);
  assert(t.length === 2, `${t.length} 語になった`);
  assert(t[0] === 2 && t[1] === 3, JSON.stringify(t));
});

test("複勝", "同じ語は2回入らない（もう一度押すと外れる）", () => {
  let t = toggleTentative([], 1);
  t = toggleTentative(t, 1);
  assert(t.length === 0, JSON.stringify(t));

  t = toggleTentative(toggleTentative([], 1), 2);
  t = toggleTentative(t, 2);
  assert(t.length === 1 && t[0] === 1, JSON.stringify(t));
});

test("複勝", "同じ語を2つ持つ回答は確定できない", () => {
  const m = commitPair({}, 7, [100, 100]);
  assert(m[7] === undefined, "同じ語2つで確定した");
});

test("複勝", "2語でないときは何も変えない（前の回答も消さない）", () => {
  const before = commitExact({}, 7, 100);
  assert(commitPair(before, 7, [200]) === before, "1語で状態が変わった");
  assert(commitPair(before, 7, []) === before, "0語で状態が変わった");
  assert(before[7].tags[0] === 100, "前の回答が消えた");
});

test("複勝", "4択なら 6 通りの組み合わせをすべて表せる", () => {
  const choices = [10, 11, 12, 13];
  const seen = new Set();

  for (const a of choices) {
    for (const b of choices) {
      if (a === b) continue;
      // 空から2語選ぶ操作をそのまま通す
      const t = toggleTentative(toggleTentative([], a), b);
      const m = commitPair({}, 1, t);
      assert(m[1] !== undefined, `${a},${b} で確定できない`);
      seen.add([...m[1].tags].sort((x, y) => x - y).join("-"));
    }
  }
  assert(seen.size === 6, `${seen.size} 通りしか作れない: ${[...seen].join(" / ")}`);
});

console.log("\nセクションの進み方と最終確認");

test("進み方", "最後のセクション以外は次へ進む", () => {
  const to = afterCommit(0, 5);
  assert(to.stage === "sections" && to.index === 1, JSON.stringify(to));
});

test("進み方", "最後のセクションを確定すると最終確認へ移る（そこでは送らない）", () => {
  const to = afterCommit(4, 5);
  assert(to.stage === "confirm", JSON.stringify(to));
  assert(to.index === 4, "最終確認へ移るときにセクション番号が動いた");
});

test("最終確認", "未回答のセクションが1つでもあれば送れない", () => {
  const ids = [1, 2, 3];
  let m = commitExact({}, 1, 10);
  m = commitExact(m, 2, 20);
  assert(isComplete(m, ids) === false, "未回答があるのに送れる判定になった");
  assert(missingQuestions(m, ids).join(",") === "3", missingQuestions(m, ids).join(","));

  m = commitExact(m, 3, 30);
  assert(isComplete(m, ids) === true, "全部答えても送れない判定になった");
  assert(missingQuestions(m, ids).length === 0, "未回答が残っている");
});

test("最終確認", "1つの問に1件しか入らない（送る内訳が重複しない）", () => {
  let m = commitExact({}, 1, 10);
  m = commitPair(m, 1, [11, 12]);
  m = commitExact(m, 1, 13);
  const ids = Object.keys(m);
  assert(ids.length === 1, `問が ${ids.length} 件になった`);
  assert(m[1].tags.length === 1, JSON.stringify(m[1].tags));
});

console.log("\n語ランキングの点");

/** 語1つぶんの数を作る */
function word(label, { exact = 0, pair = 0, shown = 0, correct = false } = {}) {
  return {
    tag_id: label.charCodeAt(0),
    label,
    is_correct: correct,
    exact_count: exact,
    pair_count: pair,
    shown_times: shown,
  };
}

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);

console.log(`\n合計 ${results.length} 件 / 合格 ${passed} 件 / 不合格 ${failed.length} 件`);
for (const f of failed) console.log(`  ✗ [${f.group}] ${f.name}: ${f.why}`);

recordCount("回答の単体試験", results.length);
process.exit(failed.length === 0 ? 0 : 1);
