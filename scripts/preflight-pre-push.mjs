#!/usr/bin/env node
/**
 * preflight-pre-push.mjs ／ pre-push hook の中身。main への push だけを確かめる
 *
 * 呼ばれかた: `.git/hooks/pre-push` が、git から受けた標準入力をそのまま渡す。
 * 手で打つものではない。入れるのは `npm run guard:hooks:install`。
 *
 * 【なぜ hook が要るか】
 *   `npm run deploy:main` は柵を通る。しかし手で
 *     git push origin main
 *     git push origin feature/foo:main
 *   と打てば、その柵を通らずに本番へ出せてしまう。**ここが最後の穴だった。**
 *   hook は git そのものの通り道にあるので、どの入口から打っても通る。
 *
 * 【main 以外は1文字も邪魔しない】
 *   `git push origin feature/foo` のような、main を更新しない push では
 *   何も表示せず、何も確かめずに通す。別の窓の作業を止めないため。
 *
 * 【ref の読みかた】
 *   git は1行に4つの値を渡す。
 *     <送る側の ref> <送る側の sha> <送り先の ref> <送り先の sha>
 *   **4番目までを区切りで分けて、3番目が refs/heads/main と完全に一致するか**で
 *   判定する。行の中に main という字が含まれるか、では見ない
 *   （`refs/heads/main-backup` や `refs/heads/feature/main-nav` が引っかかる）。
 *   1行でも main 行があれば、その push は本番への変更として扱う。
 *
 * 【判定は1か所から借りる】
 *   遅れ・汚れ・migration の判定は scripts/_preflight.mjs にある同じものを呼ぶ。
 *   ここに書き写さない。書き写すと、直したときに片方だけ古くなる。
 *
 * 【分からないときは通さない】
 *   判定器を読み込めない・ref を読めない・遠くの main を引けない、のどれでも
 *   終了コード 1 で終わる。「分からないから通す」はしない。
 */

import { readFileSync } from "node:fs";

/** git が渡す全ゼロの sha（作成・削除の印） */
const ZERO = /^0{40,64}$/;

/** 本番の枝。ここと完全一致する送り先だけを確かめる */
export const PRODUCTION_REF = "refs/heads/main";

/**
 * pre-push の標準入力を、行ごとの4つ組に分ける。
 * 4つに分けられない行は捨てずに残し、呼び出し側が「読めなかった」と扱えるようにする。
 */
export function parsePrePushInput(text) {
  const lines = [];
  const malformed = [];
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const parts = line.split(/\s+/);
    if (parts.length !== 4) {
      malformed.push(line);
      continue;
    }
    const [localRef, localSha, remoteRef, remoteSha] = parts;
    lines.push({
      localRef,
      localSha,
      remoteRef,
      remoteSha,
      deleting: ZERO.test(localSha),
      creating: ZERO.test(remoteSha),
    });
  }
  return { lines, malformed };
}

/** その push が main を更新するか。**送り先の ref の完全一致だけで見る** */
export function productionLines(parsed) {
  return parsed.lines.filter((l) => l.remoteRef === PRODUCTION_REF);
}

/* ── ここから下は、hook として呼ばれたときだけ動く ───────────── */

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("preflight-pre-push.mjs");

if (invokedDirectly) {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    raw = "";
  }

  const parsed = parsePrePushInput(raw);
  const targets = productionLines(parsed);

  // main を触らない push は、何も言わずに通す。
  if (targets.length === 0 && parsed.malformed.length === 0) {
    process.exit(0);
  }

  // 形の読めない行があったときは、main 行が無くても通さない。
  // 読めていないものを「main ではない」と決められないため。
  if (parsed.malformed.length > 0 && targets.length === 0) {
    console.error("");
    console.error("✗ push を止めました（pre-push が渡した行を読めませんでした）。");
    for (const m of parsed.malformed) console.error(`    読めなかった行: ${m}`);
    console.error("  main への push かどうかを判定できないので、通しません。");
    process.exit(1);
  }

  let preflight;
  try {
    preflight = await import("./_preflight.mjs");
  } catch (e) {
    console.error("");
    console.error("✗ push を止めました（確認の道具を読み込めませんでした）。");
    console.error(`    ${e.message}`);
    console.error("");
    console.error("  この作業木には scripts/_preflight.mjs が無いか、壊れています。");
    console.error("  main への push は、最新の origin/main から作った作業木から行ってください。");
    console.error("    git fetch origin");
    console.error("    git worktree add -b <枝の名前> ../dpq-<名前> origin/main");
    process.exit(1);
  }

  const { collectFacts, judge, formatReport } = preflight;

  const facts = collectFacts({ cwd: process.cwd() });
  // 1回の push で main 行が2つ来ることはないが、来たら1行目だけを見るのではなく
  // 全部を見て、1つでも通らなければ止める。
  let ok = true;
  for (const line of targets) {
    const verdict = judge(facts, { mode: "push", push: line });
    console.error(formatReport(facts, verdict));
    if (!verdict.ok) ok = false;
  }

  if (!ok) {
    console.error("");
    console.error("✗ main への push を止めました。本番は変わっていません。");
    console.error("  この柵を外す環境変数や引数はありません。");
    console.error("  ふだんの出しかたは `npm run deploy:main -- --apply` です。");
    process.exit(1);
  }

  console.error("");
  console.error("○ main への push を通します。");
  process.exit(0);
}
