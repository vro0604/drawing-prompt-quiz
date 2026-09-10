#!/usr/bin/env node
/**
 * check-doc-counts.mjs ／ 文書に書いた件数が、実測と合っているかを見る
 *
 * 実行: npm run check:docs
 *
 * 【なぜ要るか】
 *   文書には「migration 39 本」「ブラウザ試験 51 件」のような数を書く。
 *   その数は**書いた日の実測**なので、翌週には合わなくなる。
 *   実際 2026-09-06 に、README と検証記録の4か所が古いまま残っていた
 *   （migration 30本と書いてあったが実際は39本、など）。
 *
 *   数を書くのをやめるのではなく、**書いた数が実測と合っているかを
 *   検査できるようにする。**合わなくなったらここで落ちる。
 *
 * 【どう書くか】
 *   数のうしろに、見えない印を1つ付ける。
 *
 *     ブラウザ試験 51 件<!--count:ブラウザ試験-->
 *
 *   数のうしろの単位（件・本・語・個・項目・組）は付けても付けなくてもよい。
 *
 *   Markdown では表示されない。**印の付いた数だけ**を照合するので、
 *   過去の記録（そのとき正しかった数）を書き換えずに済む。
 *
 * 【どこから実測を取るか】
 *   ・migration の本数 … supabase/migrations の .sql を数える
 *   ・そのほか        … 各検査が終わるときに .test-logs/counts.json へ
 *                       書き留めた実測（test/counts.mjs）
 *
 *   まだ一度も走らせていない検査は「未計測」になる。そのときは
 *   何を走らせればよいかを書いて落とす。**古い数のまま通さない。**
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readCounts } from "../test/counts.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** その印を出す検査。未計測のときに「何を走らせればよいか」を書く */
const SOURCES = {
  migration: {
    measure: () =>
      readdirSync(join(ROOT, "supabase", "migrations")).filter((f) => f.endsWith(".sql"))
        .length,
    how: "（ファイルを数えるので、いつでも測れます）",
  },
  "柵の自己試験": { how: "npm run test:guard" },
  "道具の自己試験": { how: "npm run test:tools" },
  "縦断試験": { how: "npm run test:db" },
  "アップグレード試験": { how: "npm run test:db:upgrade" },
  "DB構造の検査": { how: "npm run db:verify:local" },
  "語彙": { how: "npm run check:vocab" },
  "ブラウザ試験": { how: "npm run test:e2e" },
  "スモーク": { how: "npm run test:smoke:local" },
};

/** 印を探す文書。**過去の記録は入れない**（そのとき正しかった数を守るため） */
const DOCS = [
  "README.md",
  "docs/spec.md",
  "docs/test-layers.md",
  "docs/launch-checklist.md",
  "docs/GPT_HANDOFF.md",
  "docs/decisions.md",
  "docs/verify-2026-09-05.md",
];

const counts = readCounts();
const measured = {};
for (const [key, src] of Object.entries(SOURCES)) {
  measured[key] = src.measure ? src.measure() : (counts[key]?.value ?? null);
}

const MARK = /(\d[\d,]*)\s*(?:項目|件|本|語|個|組)?\s*<!--\s*count:([^\s>]+?)\s*-->/g;

const problems = [];
const okLines = [];
let found = 0;

for (const rel of DOCS) {
  const path = join(ROOT, rel);
  try {
    statSync(path);
  } catch {
    continue;   // まだ無い文書は飛ばす
  }
  const text = readFileSync(path, "utf8");

  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(MARK)) {
      found += 1;
      const written = Number(m[1].replace(/,/g, ""));
      const key = m[2];
      const where = `${relative(ROOT, path)}:${i + 1}`;

      if (!(key in SOURCES)) {
        problems.push(`${where} 知らない印です: count:${key}`);
        continue;
      }
      const actual = measured[key];
      if (actual === null || actual === undefined) {
        problems.push(
          `${where} ${key} は未計測です（文書には ${written} と書いてあります）。` +
            `\n      先に ${SOURCES[key].how} を走らせてください`,
        );
        continue;
      }
      if (actual !== written) {
        problems.push(
          `${where} ${key} が食い違います。文書 ${written} / 実測 ${actual}` +
            `\n      実測に合わせて文書を直してください`,
        );
        continue;
      }
      okLines.push(`  ${GREEN}OK${RESET} ${where} ${key} ${written}`);
    }
  });
}

console.log("文書に書いた件数と、実測の突き合わせ");
console.log("");
for (const l of okLines) console.log(l);
if (found === 0) console.log(`  ${DIM}（印の付いた数が1つもありません）${RESET}`);
console.log("");
for (const p of problems) console.log(`  ${RED}NG${RESET} ${p}`);

console.log("");
console.log(
  `照合 ${found} 件 / 一致 ${okLines.length} 件 / 食い違い・未計測 ${problems.length} 件`,
);
if (Object.values(counts).length > 0) {
  const when = Object.entries(counts)
    .map(([k, v]) => `${k}=${v.value}`)
    .join(" / ");
  console.log(`${DIM}実測の出どころ: .test-logs/counts.json（${when}）${RESET}`);
}

process.exit(problems.length === 0 ? 0 : 1);
