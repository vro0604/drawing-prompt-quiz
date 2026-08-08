#!/usr/bin/env node
/**
 * check-contrast.mjs ／ 文字と枠線のコントラストの下限を見張る
 *
 * 【なぜ機械に見張らせるか】
 *   下限を決めただけでは戻る。もともと 11 段あった濃さのうち
 *   97 箇所が AA（4.5:1）に届いていなかったのは、誰かが手を抜いたからではなく
 *   **薄いグレーを置くのがいちばん簡単だから**である。
 *
 *   このプロジェクトは漏洩経路の本数を db:verify に数えさせている（D52）。
 *   同じ作法をここにも当てる。**レビューで気をつける、ではなく、
 *   下回ったら落ちる形にする。**
 *
 * 【2つ見る】
 *   1. globals.css に書いた値が、明るいとき・暗いときの両方で下限を満たすか
 *   2. 画面側に生の色が復活していないか
 *      （`text-ink/40` のような書き方を許すと、1 をすり抜けられる）
 *
 * 【使い方】
 *   npm run check:contrast
 */
import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CSS = "src/app/globals.css";

// --- 下限 -------------------------------------------------------------------
//
// 本文は 12px なので「大きな文字は 3:1 でよい」は使えない
// （24px 以上、または太字 18.66px 以上が条件）。
const TEXT_MIN = 4.5; // WCAG 2.2 AA・本文
const NONTEXT_MIN = 3.0; // WCAG 2.2 AA・部品の輪郭（1.4.11）

/** 見張る対象。decor は「情報を持たない飾り」なので下限を課さない */
const TARGETS = [
  { name: "muted", min: TEXT_MIN, what: "文字（強い注記）" },
  { name: "faint", min: TEXT_MIN, what: "文字（注記）" },
  { name: "field", min: NONTEXT_MIN, what: "入力欄の枠" },
];

// --- 色の計算 ---------------------------------------------------------------
const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const L = ([r, g, b]) => 0.2126 * lin(r / 255) + 0.7152 * lin(g / 255) + 0.0722 * lin(b / 255);
const contrast = (a, b) => {
  const [hi, lo] = [L(a), L(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};
const over = (fg, bg, alpha) => bg.map((c, i) => fg[i] * alpha + c * (1 - alpha));

const hex = (s) => {
  const h = s.replace("#", "");
  const w = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(w.slice(i, i + 2), 16));
};

/** `rgb(0 0 0 / 0.55)` を読む */
function parseRgba(value) {
  const m = /rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([0-9.]+)\s*\)/.exec(value);
  if (!m) return null;
  return { rgb: [+m[1], +m[2], +m[3]], alpha: +m[4] };
}

// --- globals.css を読む -----------------------------------------------------
//
// コメントを先に落とす。**説明文の中に "@media" と書いてあるので、
// そのままだと明るいときと暗いときの境目を取り違える**（実際に踏んだ）。
const css = readFileSync(CSS, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * 明るいときの :root と、暗いときの上書きを分けて取り出す。
 * 暗いほうに無い変数は、明るいほうの値がそのまま効く。
 */
function blockOf(source, dark) {
  if (!dark) return source.slice(0, source.indexOf("@media"));
  const i = source.indexOf("@media");
  return i < 0 ? "" : source.slice(i);
}
const varsIn = (block) => {
  const out = new Map();
  for (const m of block.matchAll(/--([a-z-]+):\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
};
const light = varsIn(blockOf(css, false));
const dark = new Map([...light, ...varsIn(blockOf(css, true))]);

let bad = 0;
const log = (ok, text, extra = "") => {
  if (!ok) bad += 1;
  console.log(`  ${ok ? "✓" : "✗"} ${text}${extra ? "  " + extra : ""}`);
};

// --- 1. 値そのものを確かめる ------------------------------------------------
console.log("\n1. globals.css の値が下限を満たすか");

for (const { name, min, what } of TARGETS) {
  for (const [themeName, vars] of [
    ["明るい", light],
    ["暗い", dark],
  ]) {
    const value = vars.get(name);
    if (!value) {
      log(false, `--${name} が ${themeName}ときの定義に無い`);
      continue;
    }
    const parsed = parseRgba(value);
    if (!parsed) {
      log(false, `--${name} が rgb(... / a) の形ではない`, value);
      continue;
    }

    // 背景は「その文字が乗るいちばん明るい／暗い面」で見る。
    // カードの面（surface）はページの地より内側にあるので、そちらで測る。
    const page = hex(vars.get("background"));
    const s = parseRgba(vars.get("surface"));
    const cardFace = s ? over(s.rgb, page, s.alpha) : page;

    const ratio = contrast(over(parsed.rgb, cardFace, parsed.alpha), cardFace);
    log(
      ratio >= min,
      `${what} --${name}（${themeName}）が ${min}:1 以上`,
      `実測 ${ratio.toFixed(2)}:1`,
    );
  }
}

// --- 2. 画面側に生の色が戻っていないか --------------------------------------
console.log("\n2. 画面側に生の色が復活していないか");

const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".tsx")) files.push(p);
  }
})("src/app");

/**
 * 禁じ手。
 *
 * `text-ink/NN` を許すと 1 をすり抜けて薄い文字を置けるので、
 * **文字の濃さは muted / faint / decor の3つしか書けない**ようにする。
 * 線と地の ink は濃さ指定でよい（文字ではないので下限が別）。
 */
const BANNED = [
  { re: /\btext-ink\/\d+\b/g, why: "文字の濃さは muted / faint / decor から選ぶ" },
  {
    re: /\b(?:bg|text|border|ring|divide)-(?:black|white)\b/g,
    why: "globals.css の名前を使う（black / white を直に書かない）",
  },
  {
    re: /\b(?:bg|text|border|ring|divide)-(?:rose|emerald|amber|slate|zinc|gray|sky|indigo|violet)-\d+/g,
    why: "状態の色は danger / success / notice を使う",
  },
];

const hits = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const lines = src.split("\n");
  for (const { re, why } of BANNED) {
    lines.forEach((line, i) => {
      for (const m of line.matchAll(re)) hits.push(`${f}:${i + 1}  ${m[0]}  — ${why}`);
    });
  }
}
log(hits.length === 0, "生の色が1つも無い", hits.length ? `${hits.length}件` : "");
hits.forEach((h) => console.log("      " + h));

// --- 例外を明示する ---------------------------------------------------------
console.log("\n下限を課していないもの（意図的）");
const decor = parseRgba(light.get("decor"));
if (decor) {
  const page = hex(light.get("background"));
  const r = contrast(over(decor.rgb, page, decor.alpha), page);
  console.log(
    `  --decor  ${r.toFixed(2)}:1  情報を持たない飾りだけ（めくる前のカードの「?」など）`,
  );
}
console.log("  カードの縁・区切り線  装飾なので 1.4.11 の対象外");
console.log("  ボタン・タブの枠      中の文字で部品だと分かる");

console.log(bad === 0 ? "\n=== すべて下限を満たしている ===" : `\n=== ${bad}件 下限を満たさない ===`);
process.exit(bad === 0 ? 0 : 1);
