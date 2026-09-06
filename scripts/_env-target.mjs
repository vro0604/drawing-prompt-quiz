/**
 * _env-target.mjs ／ 「いまローカルを見ているのか、本番を見ているのか」を決める1か所
 *
 * 【なぜ1か所にまとめるか】
 *   接続先の決め方が各スクリプトに散っていると、1本だけ .env.local を
 *   読んでしまう書きかたが混ざり、それが本番への通信になる。
 *   2026-09-05 に実際に起きた。
 *
 * 【どちらになるかの決め方】
 *   次の**2つが同時に**そろったときだけ本番。片方だけなら必ずローカル。
 *
 *     1. process.argv に --production がある
 *     2. 親プロセスが scripts/run-production-smoke.mjs である
 *        （その入口だけが DPQ_PRODUCTION_ENTRY を渡す）
 *
 *   環境変数だけで切り替わらないのは、環境変数が
 *     ・シェルの設定に残る
 *     ・親プロセスから引き継がれる
 *     ・.env ファイルから入り込む
 *   の3通りで「いつのまにか立っている」からで、それはまさに事故の形だった。
 *
 *   引数だけでも切り替わらないのは、`npm run smoke:draft -- --production` と
 *   打てば、ローカル専用のはずの入口から本番へ届いてしまうため。
 *   **入口を1つに保つには、引数と入口の印の両方が要る。**
 *   2つを同時に手で並べるのは、本番用のコマンドを打つのと同じ明示の操作になる。
 *
 * 【ローカルのとき何が起きるか】
 *   1. .env.local を**読まない**（readTargetEnv が空を返す）
 *   2. 本番への接続を止める柵が立つ（test/guard/no-production.mjs）
 *   3. 柵は環境変数では外せない
 *
 * 【本番のとき何が起きるか】
 *   .env.local を読む。柵は立たない。
 *   この経路に入れるのは、コマンド名に --production を書いたときだけ。
 */

import { readFileSync } from "node:fs";
import { installLocalOnlyGuard } from "../test/guard/no-production.mjs";

/**
 * 本番の入口から起動されたことを示す印。
 * **scripts/run-production-smoke.mjs だけがこれを子プロセスへ渡す。**
 */
export const PRODUCTION_ENTRY_MARK = "run-production-smoke";

/** 本番の経路か。引数と入口の印がそろったときだけ true */
export function isProductionRun(argv = process.argv, env = process.env) {
  return (
    argv.includes("--production") &&
    env.DPQ_PRODUCTION_ENTRY === PRODUCTION_ENTRY_MARK
  );
}

/**
 * 「--production は付いているのに、入口の印が無い」状態。
 *
 * これは打ち間違いではなく、**ローカル専用の入口から本番へ行こうとした**
 * ということなので、黙ってローカルに落とさず理由を出す。
 */
export function isMisdirectedProductionRun(argv = process.argv, env = process.env) {
  return (
    argv.includes("--production") &&
    env.DPQ_PRODUCTION_ENTRY !== PRODUCTION_ENTRY_MARK
  );
}

/** .env.local を読む（本番の経路だけが呼ぶ） */
function readEnvFile() {
  try {
    const text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    const out = {};
    for (const line of text.split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * このスクリプトが使う環境変数を返す。
 *
 * ローカルのときは .env.local を混ぜない。**混ぜないことが本体。**
 * 読み込み順を工夫するのではなく、そもそも読まない。
 */
export function readTargetEnv({ context = "ローカル試験" } = {}) {
  if (isProductionRun()) {
    return { ...readEnvFile(), ...process.env, __target: "production" };
  }

  if (isMisdirectedProductionRun()) {
    console.error("");
    console.error("--production が付いていますが、本番の入口から来ていません。");
    console.error("本番へ向けるときは次のコマンドを使ってください。");
    console.error("");
    console.error("  npm run smoke:prod -- <名前>");
    console.error("");
    console.error("ローカル専用の入口（npm run smoke:* / test:*）に");
    console.error("--production を足しても本番へは届きません。");
    console.error("");
    process.exit(2);
  }

  installLocalOnlyGuard(context);
  return { ...process.env, __target: "local" };
}

/** 本番の経路かどうかを画面へ1行で出す */
export function describeTarget() {
  return isProductionRun()
    ? "接続先: 本番（smoke:prod の入口から --production 付きで来ています）"
    : "接続先: ローカルのみ（本番への通信は柵で止まります）";
}
