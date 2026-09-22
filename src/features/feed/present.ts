import { avatarUrl } from "@/features/profile/avatar";
import { workImageUrl } from "@/features/work/rpc";
import type { FeedCardWork, FeedWorkItem } from "@/features/feed/types";

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
