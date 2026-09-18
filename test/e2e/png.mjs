/**
 * png.mjs ／ 検証用の「べた塗りの絵」をその場で作る
 *
 * 【なぜ要るか】
 *   画面の検証では、作品の画像が**実際に表示される**必要がある。
 *   これまでの検証用データは DB に行を作るだけで、画像は1枚も無かった
 *   （保管庫のもどきが 404 を返す）。
 *
 *   一覧を段違いの列で組む作りにしたので、**絵が出ないと
 *   「縦横比どおりに並んでいるか」を目で確かめられない。**
 *   色の違う四角を置けば、どの絵がどこに入ったかも分かる。
 *
 * 【外部の部品を足していない】
 *   Node に最初から入っている zlib だけで PNG を組む。
 *   PNG は「署名 ＋ いくつかの塊」でできていて、塊はどれも
 *   長さ・名前・中身・検査値（CRC32）の順に並ぶ。
 *
 * **この画像は検証の中だけで使う。**本番へは1バイトも出ない。
 */

import { deflateSync } from "node:zlib";

/** CRC32。PNG の塊ごとの検査値に使う */
const TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 塊1つ（長さ・名前・中身・検査値） */
function chunk(name, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(name, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * 指定の大きさ・色のべた塗り PNG を作る。
 *
 * 大きさは**実際の画素数**にする。DB に入れる image_width / image_height と
 * 同じ値にしておけば、画面が場所取りに使う縦横比と、
 * 届いた画像の縦横比が一致する（ずれていれば検証で見つかる）。
 */
export function solidPng(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 1色あたり8ビット
  ihdr[9] = 2; // 種類2 = 透明度なしのカラー
  ihdr[10] = 0; // 圧縮方式
  ihdr[11] = 0; // ふるい分けの方式
  ihdr[12] = 0; // 飛び越し走査なし

  // 1行ぶん = 先頭に「ふるい分けの種類」1バイト ＋ 画素（3バイト×幅）
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * 文字列から色を1つ決める。同じ文字列なら必ず同じ色。
 *
 * 明るすぎず暗すぎない範囲に収める。**真っ白は別に作る**
 * （地に溶ける絵の境界を確かめる検証で、狙って白を置くため）。
 */
export function colorFor(key) {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return [80 + (h % 130), 80 + ((h >>> 8) % 130), 80 + ((h >>> 16) % 130)];
}
