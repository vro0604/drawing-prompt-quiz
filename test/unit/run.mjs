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

import { createDecipheriv, createECDH, createHmac, randomBytes } from "node:crypto";
import { hhmm, spanLabel } from "../../src/features/challenge/types.ts";
import { isInterrupting, unacknowledged } from "../../src/features/notify/types.ts";
import { encryptPayload } from "../../src/features/notify/push.ts";
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
import {
  allPatterns,
  countOnes,
  cumulativeMatches,
  patternTable,
  rankWords,
  filtersUpTo,
  mismatchPositions,
  parseFilters,
  rarityLabel,
  scoreRate,
  serializeFilters,
  sectionPatternCount,
  sharePercent,
  totalAnswerPatterns,
  weightedPoints,
  withFilter,
} from "../../src/features/quiz/results.ts";
import {
  GRANT_SOURCE_LABEL,
  NOTICE_LABEL,
  canDrillDown,
  remainingPercent,
} from "../../src/features/quiz/capacity.ts";
import {
  addToken,
  countBreaks,
  fromSaved,
  moveDown,
  moveUp,
  removeAt,
  renderSentences,
  sentenceCount,
  toPayload,
  toSentences,
  toggleBreak,
} from "../../src/features/flavor/compose.ts";
import {
  THRESHOLDS,
  isWorse,
  shouldBlink,
  warnAnnouncement,
  warnLabel,
  warnLevel,
} from "../../src/features/challenge/warning.ts";
import { hasUnseenResults } from "../../src/features/notice/unseen.ts";
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

test("語の点", "ビタ当ては1.0、複勝は1語あたり0.5", () => {
  assert(weightedPoints(word("A", { exact: 18, pair: 26 })) === 31, "18 + 26×0.5 が 31 にならない");
  assert(weightedPoints(word("A", { exact: 0, pair: 1 })) === 0.5, "複勝1件が0.5にならない");
  assert(weightedPoints(word("A", { exact: 1, pair: 0 })) === 1, "ビタ1件が1にならない");
});

test("語の点", "順位は「出された回数あたりの点」で決める", () => {
  // 10回出て5回ビタ当て（0.5）と、2回出て2回ビタ当て（1.0）
  const many = word("よく出た", { exact: 5, shown: 10 });
  const few = word("たまに出た", { exact: 2, shown: 2 });
  assert(scoreRate(many) === 0.5, `${scoreRate(many)}`);
  assert(scoreRate(few) === 1, `${scoreRate(few)}`);

  const ranked = rankWords([many, few]);
  assert(ranked[0].label === "たまに出た", `1位が ${ranked[0].label}`);
});

test("語の点", "一度も出ていない語で 0 で割らない", () => {
  const never = word("出ていない", { exact: 0, pair: 0, shown: 0 });
  assert(scoreRate(never) === null, `${scoreRate(never)}`);

  const shown = word("出た", { exact: 1, shown: 4 });
  const ranked = rankWords([never, shown]);
  assert(ranked[0].label === "出た", "出ていない語が上に来た");
  assert(ranked[1].label === "出ていない", "出ていない語が消えた");
});

test("語の点", "素の数はそのまま残る（割ったあとの値で上書きしない）", () => {
  const w = word("寄生", { exact: 18, pair: 26, shown: 50 });
  const ranked = rankWords([w]);
  assert(ranked[0].exact_count === 18, `ビタが ${ranked[0].exact_count}`);
  assert(ranked[0].pair_count === 26, `複勝が ${ranked[0].pair_count}`);
  assert(ranked[0].shown_times === 50, `提示が ${ranked[0].shown_times}`);
  assert(Math.abs(scoreRate(w) - 31 / 50) < 1e-12, `${scoreRate(w)}`);
});

test("語の点", "同じ点ならビタ当ての多いほうが上", () => {
  const a = word("断定された", { exact: 2, pair: 0, shown: 4 });
  const b = word("絞られた", { exact: 1, pair: 2, shown: 4 });
  assert(scoreRate(a) === scoreRate(b), "前提が崩れている（同点ではない）");
  assert(rankWords([b, a])[0].label === "断定された", "同点でビタ当てが上に来ない");
});

console.log("\n正解を含んだかの並び");

test("並び", "5問なら 32 通りをすべて作れる", () => {
  const all = allPatterns(5);
  assert(all.length === 32, `${all.length} 通り`);
  assert(new Set(all).size === 32, "同じ並びが重複している");
  assert(all.includes("00000"), "全部外した並びが無い");
  assert(all.includes("11111"), "全部当てた並びが無い");
  assert(all.every((p) => p.length === 5), "長さが5でない並びがある");
});

test("並び", "正解を含んだ数が多い順に並ぶ", () => {
  const all = allPatterns(3);
  assert(all[0] === "111", `先頭が ${all[0]}`);
  assert(all[all.length - 1] === "000", `末尾が ${all[all.length - 1]}`);
  assert(countOnes("11010") === 3, `${countOnes("11010")}`);
  assert(countOnes("00000") === 0, `${countOnes("00000")}`);
});

test("並び", "誰も答えなかった並びも 0 人として表に出る", () => {
  const table = patternTable([{ pattern: "111", count: 4 }], 3);
  assert(table.length === 8, `${table.length} 行`);
  const zero = table.find((r) => r.pattern === "000");
  assert(zero !== undefined && zero.count === 0, "全部外した行が無い");
  const hit = table.find((r) => r.pattern === "111");
  assert(hit.count === 4, `${hit.count}人`);
});

test("並び", "問が多すぎるときは、観測した並びだけにする", () => {
  const table = patternTable([{ pattern: "1".repeat(8), count: 1 }], 8);
  assert(table.length === 1, `${table.length} 行（256行に膨らんでいる）`);
});

test("並び", "割合は母数0で落ちない", () => {
  assert(sharePercent(0, 0) === null, `${sharePercent(0, 0)}`);
  assert(sharePercent(1, 4) === 25, `${sharePercent(1, 4)}`);
});

console.log("\n回答の似かた");

test("似かた", "k問以上一致した人を、上から積み上げる", () => {
  // 5問。5一致が1人、4一致が2人、2一致が3人、0一致が4人
  const hist = [
    { matches: 5, count: 1 },
    { matches: 4, count: 2 },
    { matches: 2, count: 3 },
    { matches: 0, count: 4 },
  ];
  const cum = cumulativeMatches(hist, 5, 10);
  const at = (k) => cum.find((c) => c.atLeast === k);

  assert(cum.length === 5, `${cum.length} 段（5段のはず）`);
  assert(at(5).count === 1, `5以上が ${at(5).count}人`);
  assert(at(4).count === 3, `4以上が ${at(4).count}人`);
  assert(at(3).count === 3, `3以上が ${at(3).count}人`);
  assert(at(2).count === 6, `2以上が ${at(2).count}人`);
  assert(at(1).count === 6, `1以上が ${at(1).count}人`);
  assert(at(4).percent === 30, `4以上が ${at(4).percent}%`);
});

test("似かた", "1問も一致しなかった人も母数に入る", () => {
  const cum = cumulativeMatches([{ matches: 0, count: 9 }, { matches: 5, count: 1 }], 5, 10);
  const at5 = cum.find((c) => c.atLeast === 5);
  assert(at5.count === 1, `${at5.count}人`);
  assert(at5.percent === 10, `${at5.percent}%（0一致の9人を母数から外している）`);
});

test("似かた", "他に誰もいなければ割合は出さない（0%とは書かない）", () => {
  const cum = cumulativeMatches([], 5, 0);
  assert(cum.every((c) => c.percent === null), JSON.stringify(cum));
  assert(cum.every((c) => c.count === 0), "誰もいないのに人数が入っている");
});

console.log("\n組み合わせ上の希少度");

test("希少度", "4択なら1セクション10通り（ビタ4 + 複勝6）", () => {
  assert(sectionPatternCount(4) === 10, `${sectionPatternCount(4)}`);
});

test("希少度", "3択なら6通り。選択肢の数から出す", () => {
  assert(sectionPatternCount(3) === 6, `${sectionPatternCount(3)}`);
  assert(sectionPatternCount(2) === 3, `${sectionPatternCount(2)}`);
  assert(sectionPatternCount(1) === 1, `${sectionPatternCount(1)}`);
});

test("希少度", "4択5問で 100,000。数を直接書いていない", () => {
  assert(totalAnswerPatterns([4, 4, 4, 4, 4]) === 100000, `${totalAnswerPatterns([4, 4, 4, 4, 4])}`);
  assert(rarityLabel([4, 4, 4, 4, 4]) === "1 / 100,000", rarityLabel([4, 4, 4, 4, 4]));
});

test("希少度", "問数や選択肢が変わると数も変わる", () => {
  assert(totalAnswerPatterns([4, 4, 4]) === 1000, `${totalAnswerPatterns([4, 4, 4])}`);
  assert(totalAnswerPatterns([3, 3, 3, 3, 3]) === 7776, `${totalAnswerPatterns([3, 3, 3, 3, 3])}`);
  assert(totalAnswerPatterns([4, 3, 4, 4, 4]) === 60000, `${totalAnswerPatterns([4, 3, 4, 4, 4])}`);
  assert(totalAnswerPatterns([]) === 0, "問が無いのに組み合わせがある");
  assert(rarityLabel([]) === null, "問が無いのに希少度が出る");
});

console.log("\n掘り下げの条件（P3）");

test("条件", "URL から条件を読み取る。読めない形は捨てる", () => {
  const f = parseFilters(["12:345", "こわれた", "13:", ":9", "14:678"]);
  assert(f.length === 2, `${f.length} 件`);
  assert(f[0].question_id === 12 && f[0].tag_id === 345, JSON.stringify(f[0]));
  assert(f[1].question_id === 14 && f[1].tag_id === 678, JSON.stringify(f[1]));

  assert(parseFilters(undefined).length === 0, "何も無いときに条件が出る");
  assert(parseFilters("12:345").length === 1, "1件だけのときに読めない");
});

test("条件", "同じ項目に2つの条件は残らない（先に来たほうを残す）", () => {
  const f = parseFilters(["12:345", "12:999", "13:1"]);
  assert(f.length === 2, `${f.length} 件`);
  assert(f[0].tag_id === 345, `残ったのが ${f[0].tag_id}`);
});

test("条件", "URL へ戻して、読み直すと同じになる", () => {
  const f = [
    { question_id: 12, tag_id: 345 },
    { question_id: 13, tag_id: 678 },
  ];
  assert(JSON.stringify(parseFilters(serializeFilters(f))) === JSON.stringify(f), "往復で変わる");
});

test("条件", "新しい項目の語を選ぶと、条件が1段増える", () => {
  const f = withFilter([{ question_id: 12, tag_id: 345 }], 13, 678);
  assert(f.length === 2, `${f.length} 段`);
  assert(f[1].question_id === 13 && f[1].tag_id === 678, JSON.stringify(f[1]));
});

test("条件", "同じ項目の別の語を選ぶと、その段を置き換えて後ろを落とす", () => {
  const before = [
    { question_id: 12, tag_id: 345 },
    { question_id: 13, tag_id: 678 },
    { question_id: 14, tag_id: 900 },
  ];
  const after = withFilter(before, 13, 111);

  assert(after.length === 2, `${after.length} 段（2段のはず）`);
  assert(after[0].tag_id === 345, "前の段まで消えている");
  assert(after[1].question_id === 13 && after[1].tag_id === 111, JSON.stringify(after[1]));
  // 同じ項目に2つ並ばない＝0人になる条件を作らない
  assert(
    new Set(after.map((x) => x.question_id)).size === after.length,
    "同じ項目が2回入っている",
  );
});

test("条件", "途中の段まで戻せる。0段まで戻すと全部解除", () => {
  const f = [
    { question_id: 12, tag_id: 1 },
    { question_id: 13, tag_id: 2 },
    { question_id: 14, tag_id: 3 },
  ];
  assert(filtersUpTo(f, 2).length === 2, "2段まで戻せない");
  assert(filtersUpTo(f, 0).length === 0, "全部解除できない");
  assert(filtersUpTo(f, 9).length === 3, "段数を超えて指定すると壊れる");
});

test("条件", "掘り下げる項目は、正解を含まなかったところだけ", () => {
  assert(JSON.stringify(mismatchPositions("11100")) === "[3,4]", mismatchPositions("11100").join(","));
  assert(mismatchPositions("11111").length === 0, "全部当てた並びに対象が出る");
  assert(mismatchPositions("00000").length === 5, "全部外した並びの対象が5つでない");
});

console.log("\n取り込み枠（P4）");

test("枠", "残りの割合は、いまの世代が始まったときの残量を分母にする", () => {
  assert(remainingPercent({ remaining: 20, epoch_base: 100 }) === 20, "20/100 が2割にならない");
  assert(remainingPercent({ remaining: 5, epoch_base: 100 }) === 5, "5/100 が5%にならない");
  assert(remainingPercent({ remaining: 4, epoch_base: 20 }) === 20, "4/20 が2割にならない");
  assert(remainingPercent({ remaining: 0, epoch_base: 20 }) === 0, "0のときに0%にならない");
});

test("枠", "一度も枠を足していなければ割合を出さない（0%とは書かない）", () => {
  assert(remainingPercent({ remaining: 0, epoch_base: 0 }) === null, "分母0で割っている");
});

test("枠", "掘り下げを始められるかは、取り込んだ回答の数で決まる", () => {
  assert(canDrillDown(0) === false, "取り込み0件で始められることになっている");
  assert(canDrillDown(1) === true, "1件あるのに始められない");
  // 枠が残っていても、取り込むまでは始まらない（枠の数は見ていない）
  assert(canDrillDown(0) === false, "枠の有無で判定している");
});

test("枠", "目盛りと出どころの呼び名が全部そろっている", () => {
  for (const kind of ["remaining_20", "remaining_5", "exhausted"]) {
    assert(typeof NOTICE_LABEL[kind] === "string" && NOTICE_LABEL[kind] !== "",
      `${kind} の呼び名が無い`);
  }
  for (const src of ["checkout", "admin", "promotion", "test"]) {
    assert(typeof GRANT_SOURCE_LABEL[src] === "string" && GRANT_SOURCE_LABEL[src] !== "",
      `${src} の呼び名が無い`);
  }
});

console.log("\n文章の組み立て（P5）");

/** 語の並びを手早く作る。上限は呼ぶ側が渡す */
function words(...labels) {
  return labels.map((l, i) => ({ id: i + 1, label: l, breakAfter: false }));
}

test("文", "語は上限まで足せる。上限を超えると足さない", () => {
  let t = [];
  for (let i = 0; i < 5; i += 1) t = addToken(t, { id: i + 1, label: `語${i}` }, 3);
  assert(t.length === 3, `${t.length} 語入った（3語のはず）`);
});

test("文", "同じ語を2回置ける（助詞は何度も出る）", () => {
  let t = addToken([], { id: 7, label: "が" }, 24);
  t = addToken(t, { id: 7, label: "が" }, 24);
  assert(t.length === 2, "同じ語が2回置けない");
  assert(toPayload(t).vocabIds.join(",") === "7,7", "送る並びから2つ目が消えている");
});

test("文", "上へ・下へで語順が変わる。端では動かない", () => {
  const t = words("影", "が", "消える");
  assert(moveUp(t, 1).map((x) => x.label).join("") === "が影消える", "上へが効かない");
  assert(moveDown(t, 0).map((x) => x.label).join("") === "が影消える", "下へが効かない");
  assert(moveUp(t, 0).map((x) => x.label).join("") === "影が消える", "先頭が上へ動いた");
  assert(moveDown(t, 2).map((x) => x.label).join("") === "影が消える", "末尾が下へ動いた");
});

test("文", "外すと、その語だけが消える", () => {
  const t = removeAt(words("影", "が", "消える"), 1);
  assert(t.map((x) => x.label).join("") === "影消える", t.map((x) => x.label).join(""));
  assert(removeAt(words("影"), 5).length === 1, "範囲の外を指して壊れた");
});

test("文", "文は上限までしか切れない（3文なら印は2つまで）", () => {
  let t = words("a", "b", "c", "d", "e");
  t = toggleBreak(t, 0, 3);
  t = toggleBreak(t, 1, 3);
  assert(countBreaks(t) === 2, `印が ${countBreaks(t)} 個`);
  t = toggleBreak(t, 2, 3);
  assert(countBreaks(t) === 2, "上限を超えて切れた");
  assert(sentenceCount(t) === 3, `${sentenceCount(t)} 文になった`);
});

test("文", "最後の語のあとには印を付けられない", () => {
  const t = toggleBreak(words("a", "b"), 1, 3);
  assert(countBreaks(t) === 0, "最後の語に印が付いた");
});

test("文", "語を動かすと、印も語について動く", () => {
  // 「a。b c」の状態から a を後ろへ送る
  let t = toggleBreak(words("a", "b", "c"), 0, 3);
  t = moveDown(t, 0);
  assert(t[1].breakAfter === true, "印が語について来ていない");
  assert(t[0].breakAfter === false, "印が置き去りになっている");
  assert(renderSentences(t).length === 2, "文の数が変わってしまった");
});

test("文", "最後の語を外すと、新しい最後の語の印が落ちる", () => {
  // 「a b。c」から c を外すと、b が最後になる
  let t = toggleBreak(words("a", "b", "c"), 1, 3);
  t = removeAt(t, 2);
  assert(countBreaks(t) === 0, "1文しか無いのに印が残っている");
  assert(sentenceCount(t) === 1, `${sentenceCount(t)} 文と数えている`);
});

test("文", "文ごとに分かれ、終わりに「。」が付く", () => {
  const t = toggleBreak(words("影", "が", "消える", "音", "も", "消える"), 2, 3);
  assert(toSentences(t).length === 2, "2つに分かれていない");
  const lines = renderSentences(t);
  assert(lines[0] === "影 が 消える。", lines[0]);
  assert(lines[1] === "音 も 消える。", lines[1]);
});

test("文", "語が0なら0文。1文と数えない", () => {
  assert(sentenceCount([]) === 0, "空でも1文と数えている");
  assert(renderSentences([]).length === 0, "空なのに行が出た");
});

test("文", "保存した形から作り直せる", () => {
  const t = fromSaved([3, 9, 4], ["影", "が", "消える"], [1]);
  assert(t.map((x) => x.label).join(" ") === "影 が 消える", "語順が復元できない");
  assert(t[1].breakAfter === true, "印が復元できない");
  const back = toPayload(t);
  assert(back.vocabIds.join(",") === "3,9,4", back.vocabIds.join(","));
  assert(back.breaks.join(",") === "1", back.breaks.join(","));
});

console.log("\n残り時間の危険度（P5）");

test("時計", "期限が無いときは平常のまま", () => {
  assert(warnLevel(null, null) === "calm", "期限なしで警告が出た");
  assert(warnLevel(null, 3600) === "calm", "無制限で警告が出た");
});

test("時計", "割合だけでも、秒だけでも段階は上がらない（両方が要る）", () => {
  const day = 24 * 3600;
  // 24時間枠の残り72分＝ちょうど5%。割合は最終段階だが、秒はまだ遠い
  assert(warnLevel(72 * 60, day) === "calm", warnLevel(72 * 60, day));
  // 5分枠の残り4分。秒は「15分以内」に当たるが、割合はまだ8割ある
  assert(warnLevel(240, 300) === "calm", warnLevel(240, 300));
});

test("時計", "枠の長さで、実際の切り替え点が変わる", () => {
  const day = 24 * 3600;
  // 短い枠は割合が効く。5分枠の半分・2割・5%
  assert(warnLevel(150, 300) === "notice", warnLevel(150, 300));
  assert(warnLevel(60, 300) === "warn", warnLevel(60, 300));
  assert(warnLevel(15, 300) === "danger", warnLevel(15, 300));
  // 長い枠は秒が効く。15分・5分・1分
  assert(warnLevel(14 * 60, day) === "notice", warnLevel(14 * 60, day));
  assert(warnLevel(4 * 60, day) === "warn", warnLevel(4 * 60, day));
  assert(warnLevel(30, day) === "danger", warnLevel(30, day));
});

test("時計", "枠の長さが分からないときは、秒だけで見る", () => {
  assert(warnLevel(30, null) === "danger", warnLevel(30, null));
  assert(warnLevel(20 * 60, null) === "calm", warnLevel(20 * 60, null));
});

test("時計", "超過と自動破棄は別の段階（2026-09-09）", () => {
  // 超過は失敗ではない。**挑戦は続いていて、投稿も延長もできる**
  assert(warnLevel(-10, 3600) === "over", "超過が別扱いになっていない");

  // 自動破棄は「長いあいだ操作が無かった」ときだけ。超過では立たない
  assert(warnLevel(-10, 3600, true) === "discarded", "自動破棄が別扱いになっていない");
  assert(warnLevel(100, 3600, true) === "discarded", "残りがあっても自動破棄が優先されない");
  assert(
    warnLevel(-100000, 3600) === "over",
    "どれだけ超過しても自動破棄にはならないはず",
  );
});

test("時計", "点滅するのは最終段階と超過だけ", () => {
  assert(shouldBlink("danger") === true, "最終段階で点滅しない");
  assert(shouldBlink("over") === true, "超過で点滅しない");
  assert(shouldBlink("warn") === false, "警告の段階で点滅している");
  assert(shouldBlink("calm") === false, "平常で点滅している");
});

test("時計", "段階が危険側へ進んだときだけ知らせる", () => {
  assert(isWorse("danger", "warn") === true, "進んだのに知らせない");
  assert(isWorse("warn", "danger") === false, "戻ったのに知らせる");
  assert(isWorse("calm", "calm") === false, "同じ段階で知らせる");
});

test("時計", "色以外にも、段階ごとの言葉がある", () => {
  for (const level of ["notice", "warn", "danger", "over", "discarded"]) {
    assert(typeof warnLabel(level) === "string" && warnLabel(level) !== "",
      `${level} に見える言葉が無い`);
    assert(typeof warnAnnouncement(level) === "string" && warnAnnouncement(level) !== "",
      `${level} に読み上げる言葉が無い`);
  }
  assert(warnLabel("calm") === null, "平常なのに警告の言葉が出る");
  assert(warnAnnouncement("calm") === null, "平常なのに読み上げる");
});

test("時計", "しきい値は1か所にあり、危険なほど小さい", () => {
  assert(THRESHOLDS.notice.ratio > THRESHOLDS.warn.ratio, "割合の順が逆");
  assert(THRESHOLDS.warn.ratio > THRESHOLDS.danger.ratio, "割合の順が逆");
  assert(THRESHOLDS.notice.seconds > THRESHOLDS.warn.seconds, "秒の順が逆");
  assert(THRESHOLDS.warn.seconds > THRESHOLDS.danger.seconds, "秒の順が逆");
});

/* ===========================================================================
 * 超過の言い方と、プッシュ通知の封（2026-09-09）
 * ========================================================================= */

test("超過", "延ばした量を、人が読める言い方にする", () => {
  assert(spanLabel(1350) === "22分30秒" || spanLabel(1350) === "22分",
    `1350秒が「${spanLabel(1350)}」になっている`);
  assert(spanLabel(2700) === "45分", `2700秒が「${spanLabel(2700)}」`);
  assert(spanLabel(3600) === "1時間", `3600秒が「${spanLabel(3600)}」`);
  assert(spanLabel(5400) === "1時間30分", `5400秒が「${spanLabel(5400)}」`);
  assert(spanLabel(0) === "0秒", `0秒が「${spanLabel(0)}」`);
  assert(spanLabel(-5) === "0秒", "負の秒が0秒になっていない");
});

test("超過", "新しい終了予定を時刻の形にする", () => {
  const iso = new Date(2026, 8, 9, 17, 4, 0).toISOString();
  assert(hhmm(iso) === "17:04", `「${hhmm(iso)}」になっている`);
  assert(hhmm(null) === "", "時刻が無いときに空にならない");
  assert(hhmm("これは時刻ではない") === "", "読めない値で落ちている");
});

test("知らせ", "未確認だけを前へ出し、延長の成功は割り込ませない", () => {
  const list = [
    { id: 1, kind: "inactivity_discard", acknowledged_at: null },
    { id: 2, kind: "deadline_overrun", acknowledged_at: null },
    { id: 3, kind: "deadline_extended", acknowledged_at: null },
    { id: 4, kind: "inactivity_warning", acknowledged_at: "2026-09-09T00:00:00Z" },
  ];

  const open = unacknowledged(list);
  assert(open.length === 3, `未確認が ${open.length} 件（3件のはず）`);
  assert(open.every((n) => n.id !== 4), "確認済みが混ざっている");

  const shown = open.filter(isInterrupting);
  assert(shown.length === 2, `前へ出すのが ${shown.length} 件（2件のはず）`);
  assert(shown.every((n) => n.kind !== "deadline_extended"),
    "延長の成功が割り込んでいる");
});

test("プッシュ", "封をした中身は、受け取る端末の鍵だけで開く", () => {
  // ブラウザの代わりに、その場で鍵を作る
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const authSecret = randomBytes(16);

  const message = JSON.stringify({ title: "題", body: "本文", url: "/", tag: "t" });
  const sealed = encryptPayload(
    message,
    ua.getPublicKey().toString("base64url"),
    authSecret.toString("base64url"),
  );

  // 受け取る側の手順（RFC 8291 / RFC 8188）をそのままなぞる
  const salt = sealed.subarray(0, 16);
  const idlen = sealed[20];
  const asPublic = sealed.subarray(21, 21 + idlen);
  const body = sealed.subarray(21 + idlen);

  const shared = ua.computeSecret(asPublic);
  const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(
    prkKey,
    Buffer.concat([
      Buffer.from("WebPush: info\0", "utf8"),
      ua.getPublicKey(),
      asPublic,
      Buffer.from([1]),
    ]),
  );
  const prk = hmac(salt, ikm);
  const cek = hmac(
    prk,
    Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), Buffer.from([1])]),
  ).subarray(0, 16);
  const nonce = hmac(
    prk,
    Buffer.concat([Buffer.from("Content-Encoding: nonce\0", "utf8"), Buffer.from([1])]),
  ).subarray(0, 12);

  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(body.subarray(body.length - 16));
  const opened = Buffer.concat([
    decipher.update(body.subarray(0, body.length - 16)),
    decipher.final(),
  ]);

  // 最後の1バイトは詰め物の目印
  const text = opened.subarray(0, opened.length - 1).toString("utf8");
  assert(text === message, `開けた中身が違う: ${text}`);
});

test("プッシュ", "封は毎回違う（同じ文でも同じ形にならない）", () => {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const pub = ua.getPublicKey().toString("base64url");
  const auth = randomBytes(16).toString("base64url");

  const a = encryptPayload("同じ文", pub, auth);
  const b = encryptPayload("同じ文", pub, auth);
  assert(!a.equals(b), "毎回同じ形になっている（塩か使い捨ての鍵が固定）");
});

// ============================================================================
// 回答の知らせ：未サインインなら DB に聞かない（2026-09-11）
// ============================================================================
//
// has_unseen_results は authenticated にだけ配ってある（DB 検査 A44）。
// 以前は未サインインでも呼んでいて、本番でページを開くたびに 401 が出ていた。

console.log("\n回答の知らせ（has_unseen_results を呼ぶかどうか）");

/** 待つ試験用。test() と同じ記録の仕方 */
async function testAsync(group, name, fn) {
  try {
    await fn();
    results.push({ group, name, ok: true });
    console.log(`  ○ [${group}] ${name}`);
  } catch (e) {
    results.push({ group, name, ok: false, why: e.message });
    console.log(`  ✗ [${group}] ${name}\n      ${e.message}`);
  }
}

/** 偽の相手。セッションの読み取りと DB の呼び出しを数える */
function fakeUnseen({ session = null, rpcResult = { data: false, error: null }, sessionThrows = false, rpcThrows = false } = {}) {
  const calls = { session: 0, rpc: [] };
  return {
    calls,
    client: {
      getSession: async () => {
        calls.session += 1;
        if (sessionThrows) throw new Error("Cookie を読めない");
        return { data: { session } };
      },
      rpc: async (fn) => {
        calls.rpc.push(fn);
        if (rpcThrows) throw new Error("回線が切れた");
        return rpcResult;
      },
    },
  };
}

const MEMBER_SESSION = { access_token: "t", user: { id: "u1", is_anonymous: false } };
const GUEST_SESSION = { access_token: "t", user: { id: "g1", is_anonymous: true } };

await testAsync("知らせ", "未サインインなら DB を1回も呼ばず、false", async () => {
  const f = fakeUnseen({ session: null, rpcResult: { data: true, error: null } });
  const got = await hasUnseenResults(f.client);
  assert(got === false, `結果が ${got}`);
  assert(f.calls.rpc.length === 0, `DB を ${f.calls.rpc.length} 回呼んだ`);
  assert(f.calls.session === 1, `セッションを ${f.calls.session} 回読んだ`);
});

await testAsync("知らせ", "セッションを読めなければ DB を呼ばず、false（投げない）", async () => {
  const f = fakeUnseen({ sessionThrows: true, rpcResult: { data: true, error: null } });
  const got = await hasUnseenResults(f.client);
  assert(got === false, `結果が ${got}`);
  assert(f.calls.rpc.length === 0, `DB を ${f.calls.rpc.length} 回呼んだ`);
});

await testAsync("知らせ", "サインイン済みなら従来どおり has_unseen_results を1回呼ぶ", async () => {
  const yes = fakeUnseen({ session: MEMBER_SESSION, rpcResult: { data: true, error: null } });
  assert((await hasUnseenResults(yes.client)) === true, "未確認ありが true にならない");
  assert(yes.calls.rpc.join() === "has_unseen_results", `呼んだもの: ${yes.calls.rpc.join()}`);

  const no = fakeUnseen({ session: MEMBER_SESSION, rpcResult: { data: false, error: null } });
  assert((await hasUnseenResults(no.client)) === false, "未確認なしが false にならない");
  assert(no.calls.rpc.length === 1, `DB を ${no.calls.rpc.length} 回呼んだ`);
});

await testAsync("知らせ", "匿名のゲストもセッションがあるので従来どおり呼ぶ", async () => {
  const f = fakeUnseen({ session: GUEST_SESSION, rpcResult: { data: true, error: null } });
  assert((await hasUnseenResults(f.client)) === true, "ゲストの未確認ありが true にならない");
  assert(f.calls.rpc.length === 1, `DB を ${f.calls.rpc.length} 回呼んだ`);
});

await testAsync("知らせ", "サインイン済みで DB がエラーを返したら false（従来どおり）", async () => {
  const f = fakeUnseen({
    session: MEMBER_SESSION,
    rpcResult: { data: null, error: { code: "42501", message: "permission denied" } },
  });
  assert((await hasUnseenResults(f.client)) === false, "エラーなのに true");
  assert(f.calls.rpc.length === 1, `DB を ${f.calls.rpc.length} 回呼んだ`);
});

await testAsync("知らせ", "サインイン済みで DB の呼び出しが投げても false（全ページを落とさない）", async () => {
  const f = fakeUnseen({ session: MEMBER_SESSION, rpcThrows: true });
  assert((await hasUnseenResults(f.client)) === false, "投げたのに true");
});

await testAsync("知らせ", "true 以外の値は true と見なさない", async () => {
  for (const data of [null, "true", 1, {}]) {
    const f = fakeUnseen({ session: MEMBER_SESSION, rpcResult: { data, error: null } });
    assert((await hasUnseenResults(f.client)) === false, `${JSON.stringify(data)} を true と見なした`);
  }
});


const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);

console.log(`\n合計 ${results.length} 件 / 合格 ${passed} 件 / 不合格 ${failed.length} 件`);
for (const f of failed) console.log(`  ✗ [${f.group}] ${f.name}: ${f.why}`);

recordCount("回答の単体試験", results.length);
process.exit(failed.length === 0 ? 0 : 1);
