/**
 * 回答を組み立てる途中の勘定。**画面を持たない。**
 *
 * 【なぜ画面から出すか】
 *   「2語まで」「同じ語を2回選べない」「答え直したら置き換える」は
 *   決まりごとであって、見た目ではない。画面の中に書くと、
 *   確かめるのにブラウザを立ち上げることになる。
 *   ここに置けば、そのまま数式のように試せる。
 *
 * 【ここに無いもの】
 *   正解。採点。保存。どれも DB の中だけで起きる。
 *   ここが扱うのは「利用者がいま何を選んでいるか」だけ。
 */

// 型だけを借りる。**値は1つも持ってこない。**
// 型だけの取り込みは実行時に丸ごと消えるので、この部品は
// ブラウザも Next.js の置き換え規則も無しに、そのまま試せる。
import type { AnswerMode } from "./types";

/** セクション1つぶんの確定した回答。tags は1語（ビタ当て）か2語（複勝） */
export type Picked = { mode: AnswerMode; tags: number[] };

/** 問のID → 確定した回答 */
export type PickedMap = Record<number, Picked>;

/** 複勝で選べる語の上限。**2語まで**（D165 の2択当て） */
export const PAIR_SIZE = 2;

/**
 * 複勝の仮選択を切り替える。
 *
 * すでに入っている語をもう一度押すと外れる。
 * 2語入っているところへ3語目を押すと、**古いほうが押し出される。**
 * 押しても何も起きない形にしないのは、「上限に当たった」ことが
 * 無反応として現れると、壊れているのか上限なのか区別できないため。
 *
 * 同じ語が2回入ることはない（入っていれば外す側へ倒れる）。
 */
export function toggleTentative(current: number[], tagId: number): number[] {
  if (current.includes(tagId)) return current.filter((t) => t !== tagId);
  if (current.length >= PAIR_SIZE) return [...current.slice(1), tagId];
  return [...current, tagId];
}

/**
 * ビタ当てを確定する。
 *
 * すでにそのセクションに回答があれば**置き換える。**足さない。
 * 1つの問に2つの回答が並ぶことは、この関数からは起こらない。
 */
export function commitExact(map: PickedMap, questionId: number, tagId: number): PickedMap {
  return { ...map, [questionId]: { mode: "exact", tags: [tagId] } };
}

/**
 * 複勝を確定する。
 *
 * ちょうど2語で、かつ違う語のときだけ通す。
 * 満たさないときは**何も変えない**（前の回答も消さない）。
 */
export function commitPair(map: PickedMap, questionId: number, tags: number[]): PickedMap {
  if (tags.length !== PAIR_SIZE) return map;
  if (tags[0] === tags[1]) return map;
  return { ...map, [questionId]: { mode: "pair", tags: [tags[0], tags[1]] } };
}

/** まだ答えていない問のIDを返す。空なら送れる */
export function missingQuestions(map: PickedMap, questionIds: number[]): number[] {
  return questionIds.filter((id) => !map[id]);
}

/** 全部のセクションに回答があるか */
export function isComplete(map: PickedMap, questionIds: number[]): boolean {
  return missingQuestions(map, questionIds).length === 0;
}

/**
 * 1つ確定したあと、どこへ行くか。
 *
 * 最後のセクションだったら最終確認へ。そうでなければ次のセクションへ。
 * **確定しただけでは送らない。**送るのは最終確認の1回だけ。
 */
export function afterCommit(
  index: number,
  total: number,
): { index: number; stage: "sections" | "confirm" } {
  if (index + 1 >= total) return { index, stage: "confirm" };
  return { index: index + 1, stage: "sections" };
}
