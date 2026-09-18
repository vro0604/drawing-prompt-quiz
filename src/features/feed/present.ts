import { avatarUrl } from "@/features/profile/avatar";
import { workImageUrl } from "@/features/work/rpc";
import type { FeedCardWork, FeedWorkItem, SampleCard } from "@/features/feed/types";

/**
 * DB から来た行を、画面がそのまま使える形にする。サーバー側で呼ぶ。
 *
 * **やることは画像のURLを2つ組み立てるだけ。**行を減らしたり、
 * 値を書き換えたりはしない。ここで絞り込みをしないのは、
 * 数える前に絞るという一覧全体の作法（get_feed_works 側で絞る）と
 * 二重になるのを避けるため。
 */
export function toFeedCardWorks(rows: FeedWorkItem[]): FeedCardWork[] {
  return rows.map((w) => ({
    ...w,
    image_url: workImageUrl(w.image_path),
    avatar_url: w.author_avatar_path ? avatarUrl(w.author_avatar_path) : null,
  }));
}

/**
 * 公開作品が0件のときに並べる見本10枚。
 *
 * 【この配列は scripts/make-sample-art.mjs の出力と対になっている】
 *   縦横比は SVG の viewBox と同じ値を書く。食い違うと、
 *   場所取りの高さと実際の絵の高さがずれて、読み込み後に段が飛ぶ。
 *   絵を作り直したら、あの script が出す一覧をここへ写すこと。
 *
 * 【配分（指示 23）】縦長6・正方形3・横長1。**等分にしない。**
 */
export const SAMPLE_CARDS: SampleCard[] = [
  { id: "sample-01", src: "/sample-art/01.svg", width: 900, height: 1350 },
  { id: "sample-02", src: "/sample-art/02.svg", width: 900, height: 1200 },
  { id: "sample-03", src: "/sample-art/03.svg", width: 800, height: 1400 },
  { id: "sample-04", src: "/sample-art/04.svg", width: 900, height: 1500 },
  { id: "sample-05", src: "/sample-art/05.svg", width: 900, height: 1160 },
  { id: "sample-06", src: "/sample-art/06.svg", width: 900, height: 1280 },
  { id: "sample-07", src: "/sample-art/07.svg", width: 1000, height: 1000 },
  { id: "sample-08", src: "/sample-art/08.svg", width: 1000, height: 1000 },
  { id: "sample-09", src: "/sample-art/09.svg", width: 1000, height: 1000 },
  { id: "sample-10", src: "/sample-art/10.svg", width: 1400, height: 900 },
];
