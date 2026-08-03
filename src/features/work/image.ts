/**
 * 画像の種類と大きさを、ファイルの中身から読み取る。
 *
 * 【なぜブラウザから受け取らないか】
 *   Server Action は誰でも叩ける入口なので、幅・高さ・種類を hidden 項目で
 *   送らせると、いくらでも嘘をつける。works.image_width / image_height は
 *   作品ページの表示に使う値なので、実物から数える。
 *
 * 【なぜライブラリを使わないか】
 *   必要なのは「先頭の数十バイトを読む」だけで、sharp のような
 *   画像処理ライブラリはネイティブ依存を持ち込む。
 *   受け付ける3形式はどれもヘッダの決まった位置に大きさを持っている。
 *
 * 【拡張子について】
 *   MIME から決める。ファイル名の拡張子は当てにしない
 *   （中身が PNG の "a.jpg" を置かれると image_path と実体がずれる）。
 */

export type ImageInfo = {
  /** Storage へ渡す Content-Type */
  mime: "image/png" | "image/jpeg" | "image/webp";
  /** image_path の末尾に付ける拡張子（ドットなし） */
  ext: "png" | "jpg" | "webp";
  width: number;
  height: number;
};

/** ビッグエンディアンで 4 バイト読む */
function be32(b: Uint8Array, at: number): number {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
}

/** ビッグエンディアンで 2 バイト読む */
function be16(b: Uint8Array, at: number): number {
  return (b[at] << 8) | b[at + 1];
}

/** リトルエンディアンで 2 バイト読む（WebP はこちら） */
function le16(b: Uint8Array, at: number): number {
  return b[at] | (b[at + 1] << 8);
}

/** 指定位置が ASCII の文字列と一致するか */
function ascii(b: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > b.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (b[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * PNG。署名8バイトのあと、必ず IHDR チャンクが来ると規格で決まっている。
 *   0..7   89 50 4E 47 0D 0A 1A 0A
 *   8..11  IHDR の長さ（13）
 *   12..15 "IHDR"
 *   16..19 幅
 *   20..23 高さ
 */
function readPng(b: Uint8Array): ImageInfo | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24) return null;
  if (!signature.every((v, i) => b[i] === v)) return null;
  if (!ascii(b, 12, "IHDR")) return null;

  return { mime: "image/png", ext: "png", width: be32(b, 16), height: be32(b, 20) };
}

/**
 * JPEG。可変長のセグメントが並ぶので、先頭から順に読み飛ばして
 * SOF（フレーム開始）マーカーを探す。そこに高さと幅が入っている。
 *
 *   FF D8                        画像の始まり
 *   FF xx  <長さ2バイト> <中身>  セグメント（長さは自分自身の2バイトを含む）
 *   FF C0〜CF                    SOF。ただし C4/C8/CC は別物なので除く
 *     +5 高さ / +7 幅
 */
function readJpeg(b: Uint8Array): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;

  let at = 2;
  while (at + 9 < b.length) {
    // マーカーの前に FF が連続することがある（パディング）
    if (b[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = b[at + 1];
    if (marker === 0xff) {
      at += 1;
      continue;
    }

    // データを持たないマーカー
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }

    const length = be16(b, at + 2);
    if (length < 2) return null;

    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isSof) {
      return {
        mime: "image/jpeg",
        ext: "jpg",
        // at+2 が長さ、at+4 が精度、at+5 から高さ・幅
        height: be16(b, at + 5),
        width: be16(b, at + 7),
      };
    }

    at += 2 + length;
  }
  return null;
}

/**
 * WebP。RIFF コンテナの中に3種類の形式が入りうる。
 *
 *   0..3   "RIFF"
 *   8..11  "WEBP"
 *   12..15 チャンク名 … "VP8 "（非可逆）/ "VP8L"（可逆）/ "VP8X"（拡張）
 *
 * 大きさの位置と数え方が3種で違う。どれも「実際の値 - 1」を持つ形式が
 * あるので +1 を忘れないこと。
 */
function readWebp(b: Uint8Array): ImageInfo | null {
  if (b.length < 30) return null;
  if (!ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return null;

  const info = { mime: "image/webp", ext: "webp" } as const;

  // --- 非可逆。VP8 のキーフレームヘッダに 14 ビットずつ入っている ---
  if (ascii(b, 12, "VP8 ")) {
    return { ...info, width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  }

  // --- 可逆。21..24 バイト目に 14 ビットずつ詰めてある（値は -1 されている） ---
  if (ascii(b, 12, "VP8L")) {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return {
      ...info,
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }

  // --- 拡張（アニメーション・透過など）。24..29 に3バイトずつ（-1 されている） ---
  if (ascii(b, 12, "VP8X")) {
    return {
      ...info,
      width: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1,
      height: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1,
    };
  }

  return null;
}

/**
 * 画像の種類と大きさを返す。読み取れなければ null。
 *
 * null が返る場合は「対応していない形式」か「画像ではないもの」。
 * どちらも投稿を断る理由としては同じなので区別しない。
 */
export function readImageInfo(bytes: Uint8Array): ImageInfo | null {
  const parsed = readPng(bytes) ?? readJpeg(bytes) ?? readWebp(bytes);
  if (!parsed) return null;

  // 0 や異常値を弾く。works の CHECK 制約（1〜20000）と同じ範囲。
  const inRange = (n: number) => Number.isInteger(n) && n >= 1 && n <= 20000;
  if (!inRange(parsed.width) || !inRange(parsed.height)) return null;

  return parsed;
}
