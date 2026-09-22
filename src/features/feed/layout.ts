/**
 * 一覧の並べ方（列の数・列の幅・段の組み方）。
 *
 * 【ここに数字を置く理由】
 *   列の数も隙間も、画面のファイルに直接書くと**試して戻すができない。**
 *   1か所に集めておけば、実測に合わせて直すのが1行で済む。
 *   色を globals.css に集めているのと同じ考えかた。
 *
 * 【数字の出どころ】
 *   docs/RESEARCH/2026-09-18_pinterest-masonry.md。
 *   2026-09-18 に Pinterest の検索結果ページ（ログインしていなくても
 *   本物の並びが出る唯一の画面）を Chromium で開き、
 *   画面の幅を 31 通りに変えて、列の数・列の幅・隙間・端の余白・角の丸みを
 *   その場で測った記録である。あわせて Pinterest が公開している
 *   UI 部品集（Gestalt）の元のコードから、既定値を読んだ。
 *
 *   **想像で決めた値をここへ足さないこと。**
 *   出どころが実測でないものは、下にその旨を書いてある。
 *
 * 【ブラウザが要らない】
 *   ここにある関数は、幅（数値）と作品の縦横比（数値）しか受け取らない。
 *   画面もブラウザも出てこないので、時計や実機を使わずに試験できる。
 */

/* ===========================================================================
 * 実測から写した値
 * =========================================================================== */

/**
 * 列の数を決めるときの、1列ぶんの目安（px）。
 *
 * Pinterest の列の数は、実測した 31 通りの幅すべてが次の1本の式に乗った。
 *
 *     列数 = max(2, floor((画面の幅 − 32) / 236))
 *
 * 236 はそこに出てくる数で、Pinterest が公開している UI 部品集
 * （Gestalt）の Masonry が持つ既定の列幅とも同じ値である。
 * 画像の配信URLも i.pinimg.com/236x/… で、同じ数が使われている。
 *
 * **列の幅そのものは 236px に固定されない。**列の数が決まったあと、
 * 余りを列で分け合う（実測: 幅1440で1列267.19px、幅1920で221px）。
 */
export const TARGET_COLUMN_PX = 236;

/**
 * 上の式に出てくる、引く量（px）。
 *
 * 実測の 31 点すべてがこの値で一致した。Pinterest の左右の余白の合計
 * （20 + 20 = 40）とは一致しないが、**合わせに行かない。**
 * 合わせると 31 点のうち何点かが外れる。式は測った結果のまま写す。
 */
export const COLUMN_FORMULA_INSET_PX = 32;

/**
 * 列と列、段と段のあいだ（px）。
 *
 * 実測（幅1440・5列）: 隣の列の左端の差 283.25 − 列の幅 267.19 = 16.06。
 * 縦は同じ列の上下のカードの隙間が 15.5〜16.5。**縦と横で同じ量。**
 *
 * 手のひらの端末向けの画面は作りが違い、見た目の隙間が 9px だった
 * （実測: 部品の隙間1px ＋ カードの外周の余白4px が両側で 4+1+4）。
 */
export const GAP_PX = 16;
export const GAP_PX_NARROW = 9;

/**
 * 画面の端からカードの端までの余白（px）。
 *
 * 実測: 広い画面では左右とも 20px（測った 31 通りの幅すべてで 20 固定）。
 * 手のひらの端末向けの画面では 8.5px。
 */
export const EDGE_PX = 20;
export const EDGE_PX_NARROW = 8;

/**
 * ここより狭い画面を「手のひらの端末」として扱う（px）。
 *
 * **この値だけは実測ではない。**Pinterest は画面の幅ではなく、
 * 接続してきた相手の名乗り（携帯かどうか）で別の画面を出している。
 * こちらは1つの画面で両方に応じるので、幅で分けるしかない。
 *
 * 640 にしたのは、このサービスの他の画面がすでにその幅で
 * 並びを変えているため（揃えないと、一覧だけ別の幅で切り替わる）。
 */
export const NARROW_MAX_PX = 640;

/**
 * 列の数の下限と上限。
 *
 * 下限2は実測（Pinterest も幅375・390で2列）。
 * 上限12は実測ではなく、こちらで置いた歯止め。Pinterest は幅2560で
 * 10列まで増え続けるので、上限そのものは Pinterest に無い。
 * 極端に広い画面で1枚あたりが小さくなりすぎるのを避けるために置いている。
 */
export const MIN_COLUMNS = 2;
export const MAX_COLUMNS = 12;

/** カードの角の丸み（px）。実測: Pinterest も 16px（広い画面・狭い画面とも） */
export const CARD_RADIUS_PX = 16;

/** 投稿が少ない時期にも、一覧の密度とカード形状が分かる最低枚数。 */
export const FEED_MIN_VISIBLE_CARDS = 8;

/** DB や API の件数には触れず、画面だけに足すプレースホルダー数を返す。 */
export function placeholderCount(realWorkCount: number): number {
  const safeCount = Number.isFinite(realWorkCount) ? Math.max(0, Math.floor(realWorkCount)) : 0;
  return Math.max(0, FEED_MIN_VISIBLE_CARDS - safeCount);
}

/**
 * 表示していい縦横比の限界（指示 4）。
 *
 *   MAX_RATIO … 縦長の限界。高さ ÷ 幅 がこれを超えたら、ここで止める
 *   MIN_RATIO … 横長の限界。これを下回ったら、ここで止める
 *
 * 【2.5 の出どころ】
 *   実測。Pinterest の Pin 329枚を測って、高さ÷幅が 2.5 を超えるものは
 *   1枚も無かった。上限に張り付いた個体は 236×590 ＝ ちょうど 2.5。
 *   さらにその元画像を直接取りに行くと 736×1840 ＝ ちょうど 2.5 で、
 *   **Pinterest は表示ではなく画像そのものを先に切っている。**
 *
 * 【0.25 の出どころ】
 *   実測。Pinterest に横長の下限は見当たらない（0.254 まで実在を確認）。
 *   ただし指示4が上限と下限の両方を求めているので、
 *   **Pinterest が実際に出している中でいちばん横長な値**を下限に採る。
 *
 * 【Pinterest と違うところ（意図して違えている）】
 *   あちらは投稿を受け取る時点で画像を切る。こちらは表示のときに切る。
 *   すでに投稿されている作品の画像に後から手を入れると、
 *   作者が出したものと違うものが保管庫に残る。表示で止めれば、
 *   元の絵は1バイトも変わらず、作品ページでは全体が見える。
 */
export const MAX_RATIO = 2.5;
export const MIN_RATIO = 0.25;

/* ===========================================================================
 * 勘定
 * =========================================================================== */

/** その画面幅が「手のひらの端末」か */
export function isNarrow(viewportPx: number): boolean {
  return viewportPx <= NARROW_MAX_PX;
}

/** その画面幅での隙間（px） */
export function gapFor(viewportPx: number): number {
  return isNarrow(viewportPx) ? GAP_PX_NARROW : GAP_PX;
}

/** その画面幅での左右の余白（px） */
export function edgeFor(viewportPx: number): number {
  return isNarrow(viewportPx) ? EDGE_PX_NARROW : EDGE_PX;
}

/**
 * 列の数。**Pinterest を実測して得た式をそのまま使う。**
 *
 *     列数 = max(2, floor((画面の幅 − 32) / 236))
 *
 * 実測の 31 点すべてがこの式に乗った（検算: 1440 → floor(1408/236)=5、
 * 1480 → floor(1448/236)=6、1920 → floor(1888/236)=8、
 * 375 → floor(343/236)=1 なので下限の2）。
 *
 * **ブレークポイントの一覧を書かない。**Pinterest の切り替わりは
 * 236px おきで、よくある 768 / 1024 / 1280 の区切りとは一致しない。
 * 区切りで書くと、広い画面ほど列が増え続けるという見た目そのものが消える。
 */
export function columnsFor(viewportPx: number): number {
  const raw = Math.floor((Math.max(0, viewportPx) - COLUMN_FORMULA_INSET_PX) / TARGET_COLUMN_PX);
  return Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, raw));
}

/**
 * 列1本の幅（px）。余りは列で分け合う。
 *
 * 検算（実測との突き合わせ）: 幅1440・5列 →
 * (1440 − 20×2 − 16×4) / 5 = 267.2。Pinterest の実測は 267.19。
 */
export function columnWidthFor(viewportPx: number, columns: number, gapPx: number, edgePx: number): number {
  const inner = Math.max(0, viewportPx) - edgePx * 2 - gapPx * Math.max(0, columns - 1);
  return inner / Math.max(1, columns);
}

/**
 * 表示に使う縦横比（高さ ÷ 幅）。
 *
 * **通常の絵は元の比率のまま返す。**限界を超えたものだけ、
 * 限界の値へ丸める。丸めた＝切ることになるので、
 * 画面はそのカードを上端から見せる（下を切る）。
 */
export function displayRatio(width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return 1;
  const ratio = height / width;
  if (ratio > MAX_RATIO) return MAX_RATIO;
  if (ratio < MIN_RATIO) return MIN_RATIO;
  return ratio;
}

/** その絵が、限界に当たって切られているか */
export function isClipped(width: number, height: number): boolean {
  if (!(width > 0) || !(height > 0)) return false;
  const ratio = height / width;
  return ratio > MAX_RATIO || ratio < MIN_RATIO;
}

/**
 * どの列に何番目のカードを入れるか。
 *
 * 【いちばん背の低い列へ順に積む】
 *   これが Masonry の中身。段をそろえるのではなく、
 *   **そのとき最も短い列の下へ次を置く。**
 *   同じ高さの列が並んだときはいちばん左を選ぶ。
 *   Pinterest の Masonry も同じ規則で置いている
 *   （出所: pinterest/gestalt の Masonry/README.md
 *   「place the item in the shortest column」）。
 *
 * 【あとから足しても、すでに置いたものが動かない】
 *   前から順に積むので、末尾に足しても前のカードの行き先は変わらない。
 *   読み足しのたびに一覧が組み直される形にはしない（指示 3・17）。
 *
 * 【高さを画像の読み込み前に決められる】
 *   縦横比は DB が持っている（works.image_width / image_height）。
 *   だから画像が1枚も届いていない時点で、全部の高さが分かる。
 *   **場所取りができるので、読み込み後に一覧が飛ばない。**
 */
export function distribute(
  ratios: number[],
  columns: number,
): { columns: number[][]; heights: number[] } {
  const cols: number[][] = Array.from({ length: Math.max(1, columns) }, () => []);
  const heights = new Array(cols.length).fill(0);

  ratios.forEach((ratio, index) => {
    let shortest = 0;
    for (let c = 1; c < cols.length; c += 1) {
      if (heights[c] < heights[shortest]) shortest = c;
    }
    cols[shortest].push(index);
    // 幅を1として数える。列の幅は全部同じなので、比だけで足りる
    heights[shortest] += ratio;
  });

  return { columns: cols, heights };
}
