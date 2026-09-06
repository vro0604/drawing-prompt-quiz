/**
 * counts.mjs ／ 検査が「何件を確かめたか」を、実行のたびに書き留める
 *
 * 【なぜ要るか】
 *   文書には「縦断試験 100 件」「migration 39 本」のような数を書く。
 *   その数は**書いた日の実測**であって、次の週には合わなくなる。
 *   実際、2026-09-05 の記録は migration 30本・縦断63件のまま古くなっていて、
 *   翌日に数え直して直した（README と検証記録の4か所）。
 *
 *   数を手で書き写すのをやめるのではなく、**書いた数が実測と合っているかを
 *   検査できるようにする。**そのために、各検査が終わるときに自分の件数を
 *   ここへ残す。照合するのは scripts/check-doc-counts.mjs。
 *
 * 【残す場所】
 *   .test-logs/counts.json。Git には入れない（この計算機の実測なので）。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const COUNTS_FILE = join(ROOT, ".test-logs", "counts.json");

export function readCounts() {
  try {
    return JSON.parse(readFileSync(COUNTS_FILE, "utf8"));
  } catch {
    return {};
  }
}

/**
 * 1つ書き留める。**失敗しても検査そのものは止めない。**
 * 数を残せなかったことで検査が落ちるのは、順序が逆。
 */
export function recordCount(key, value) {
  try {
    mkdirSync(join(ROOT, ".test-logs"), { recursive: true });
    const all = readCounts();
    all[key] = { value, at: new Date().toISOString() };
    writeFileSync(COUNTS_FILE, JSON.stringify(all, null, 2));
  } catch {
    /* 書けなくても、検査の結果は変わらない */
  }
}
