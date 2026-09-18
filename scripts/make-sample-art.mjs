#!/usr/bin/env node
/**
 * make-sample-art.mjs ／ 作品が0件のときに並べる見本の絵を作る
 *
 * 実行: node scripts/make-sample-art.mjs
 *
 * 【なぜ他所の絵を使わないか】
 *   見本は本番の画面に出る。よそのサービスの画像や、他人の作品を
 *   持ってくると、それは無断利用になる。**このサービスが自分で作った絵**
 *   しか置かない。
 *
 * 【なぜ写真や生成画像ではなく図形か】
 *   見本の役目は「作品が増えるとこう並ぶ」を見せることだけで、
 *   絵の中身を見せることではない。縦横比と密度が伝われば足りる。
 *   図形なら1枚あたり数キロバイトで済み、権利の出どころもはっきりする。
 *
 * 【縦横比の配分（指示 23）】
 *   縦長6枚・正方形3枚・横長1枚。実際の投稿は縦長に偏るので、
 *   見本もそう偏らせる。**等分にしない。**等分にすると、
 *   並んだときの段違いが出ず、Masonry に見えない。
 *
 * 【作り直すとき】
 *   このファイルを直して実行し直す。手で SVG を編集しない
 *   （編集した内容が次の実行で消える）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "public", "sample-art");

/**
 * 10枚ぶんの設計。
 *
 *   w / h   縦横比（そのまま SVG の viewBox になる）
 *   bg      背景の2色
 *   shapes  重ねる図形
 */
const PIECES = [
  // ── 縦長 6枚 ──────────────────────────────────────────────
  {
    w: 900, h: 1350, bg: ["#f4e7dd", "#e7cfc2"],
    shapes: [
      { t: "circle", cx: 450, cy: 520, r: 300, fill: "#d9a48f", o: 0.75 },
      { t: "circle", cx: 620, cy: 860, r: 210, fill: "#8fa8b8", o: 0.55 },
      { t: "path", d: "M120 1350 Q 450 780 780 1350 Z", fill: "#5d6b73", o: 0.5 },
      { t: "line", d: "M300 300 Q 450 180 600 300", stroke: "#3f4a52", w: 10 },
    ],
  },
  {
    w: 900, h: 1200, bg: ["#e9eef2", "#cbd7e0"],
    shapes: [
      { t: "rect", x: 150, y: 220, w: 600, h: 760, rx: 300, fill: "#9db4c4", o: 0.8 },
      { t: "circle", cx: 450, cy: 420, r: 150, fill: "#f0e3d2", o: 0.95 },
      { t: "path", d: "M300 980 Q 450 700 600 980 Z", fill: "#6b8296", o: 0.7 },
      { t: "line", d: "M220 1080 L 680 1080", stroke: "#45586a", w: 8 },
    ],
  },
  {
    w: 800, h: 1400, bg: ["#f6efe4", "#dcd0bd"],
    shapes: [
      { t: "path", d: "M400 160 C 640 400 640 900 400 1240 C 160 900 160 400 400 160 Z", fill: "#a8b98f", o: 0.8 },
      { t: "circle", cx: 400, cy: 620, r: 130, fill: "#e5d3ae", o: 0.9 },
      { t: "line", d: "M400 200 L 400 1240", stroke: "#4f5a3f", w: 6 },
      { t: "line", d: "M280 760 Q 400 700 520 760", stroke: "#4f5a3f", w: 6 },
    ],
  },
  {
    w: 900, h: 1500, bg: ["#efe6f2", "#d3c2dd"],
    shapes: [
      { t: "circle", cx: 450, cy: 470, r: 260, fill: "#b9a0cb", o: 0.75 },
      { t: "rect", x: 260, y: 700, w: 380, h: 620, rx: 60, fill: "#8f7aa6", o: 0.6 },
      { t: "circle", cx: 640, cy: 1120, r: 160, fill: "#f2dfd0", o: 0.8 },
      { t: "line", d: "M300 520 Q 450 620 600 520", stroke: "#4a3e57", w: 9 },
    ],
  },
  {
    w: 900, h: 1160, bg: ["#fdf3ea", "#f0d9c6"],
    shapes: [
      { t: "path", d: "M140 1000 Q 300 460 460 1000 Z", fill: "#cf9b7c", o: 0.8 },
      { t: "path", d: "M420 1000 Q 620 560 800 1000 Z", fill: "#a9745c", o: 0.7 },
      { t: "circle", cx: 690, cy: 300, r: 130, fill: "#f4dcae", o: 0.95 },
      { t: "line", d: "M100 1010 L 800 1010", stroke: "#5c4034", w: 10 },
    ],
  },
  {
    w: 900, h: 1280, bg: ["#e6f0ec", "#c2d9d0"],
    shapes: [
      { t: "circle", cx: 380, cy: 560, r: 240, fill: "#8fb9a6", o: 0.8 },
      { t: "circle", cx: 600, cy: 820, r: 190, fill: "#ccdfd3", o: 0.9 },
      { t: "rect", x: 200, y: 980, w: 520, h: 180, rx: 90, fill: "#5d7d6f", o: 0.6 },
      { t: "line", d: "M300 400 Q 450 300 600 400", stroke: "#33493f", w: 8 },
    ],
  },

  // ── 正方形 3枚 ────────────────────────────────────────────
  {
    w: 1000, h: 1000, bg: ["#f7f0e1", "#e3d3b5"],
    shapes: [
      { t: "circle", cx: 500, cy: 470, r: 300, fill: "#d8b36a", o: 0.75 },
      { t: "path", d: "M180 860 Q 500 500 820 860 Z", fill: "#7d6a4a", o: 0.65 },
      { t: "circle", cx: 640, cy: 360, r: 90, fill: "#fbf5e6", o: 0.95 },
    ],
  },
  {
    w: 1000, h: 1000, bg: ["#eef1f6", "#cdd6e4"],
    shapes: [
      { t: "rect", x: 200, y: 200, w: 600, h: 600, rx: 120, fill: "#91a6c6", o: 0.75 },
      { t: "circle", cx: 500, cy: 500, r: 190, fill: "#f3e9dc", o: 0.9 },
      { t: "line", d: "M260 740 Q 500 620 740 740", stroke: "#3f4f68", w: 10 },
    ],
  },
  {
    w: 1000, h: 1000, bg: ["#fbeeee", "#eccfd2"],
    shapes: [
      { t: "circle", cx: 420, cy: 460, r: 250, fill: "#e0a3ab", o: 0.8 },
      { t: "circle", cx: 660, cy: 640, r: 200, fill: "#c98a95", o: 0.65 },
      { t: "line", d: "M240 820 L 760 820", stroke: "#6b4048", w: 9 },
    ],
  },

  // ── 横長 1枚 ──────────────────────────────────────────────
  {
    w: 1400, h: 900, bg: ["#eaf0f4", "#c8d8e2"],
    shapes: [
      { t: "path", d: "M0 720 Q 350 380 700 720 Q 1050 380 1400 720 L 1400 900 L 0 900 Z", fill: "#7c9cb0", o: 0.75 },
      { t: "circle", cx: 1080, cy: 280, r: 140, fill: "#f6e7cf", o: 0.95 },
      { t: "line", d: "M120 300 Q 320 220 520 300", stroke: "#3d5464", w: 8 },
    ],
  },
];

/** 図形1つを SVG の文字列にする */
function shapeToSvg(s) {
  const o = s.o ?? 1;
  if (s.t === "circle") {
    return `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" fill="${s.fill}" opacity="${o}"/>`;
  }
  if (s.t === "rect") {
    return `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${s.rx}" fill="${s.fill}" opacity="${o}"/>`;
  }
  if (s.t === "path") {
    return `<path d="${s.d}" fill="${s.fill}" opacity="${o}"/>`;
  }
  // line は「線として引いたあと」を表す。塗らずに線幅だけを持つ
  return `<path d="${s.d}" fill="none" stroke="${s.stroke}" stroke-width="${s.w}" stroke-linecap="round" opacity="${o}"/>`;
}

function toSvg(p, i) {
  const id = `g${i}`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${p.w} ${p.h}" width="${p.w}" height="${p.h}">`,
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0.6" y2="1">`,
    `<stop offset="0" stop-color="${p.bg[0]}"/><stop offset="1" stop-color="${p.bg[1]}"/>`,
    `</linearGradient></defs>`,
    `<rect width="${p.w}" height="${p.h}" fill="url(#${id})"/>`,
    ...p.shapes.map(shapeToSvg),
    `</svg>`,
  ].join("");
}

mkdirSync(OUT, { recursive: true });

const manifest = [];
PIECES.forEach((p, i) => {
  const name = `${String(i + 1).padStart(2, "0")}.svg`;
  writeFileSync(join(OUT, name), toSvg(p, i + 1), "utf8");
  manifest.push({ src: `/sample-art/${name}`, width: p.w, height: p.h });
});

console.log(`${manifest.length}枚を ${OUT} へ書きました`);
console.log(JSON.stringify(manifest));
