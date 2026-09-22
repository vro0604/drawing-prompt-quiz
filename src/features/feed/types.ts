/**
 * 作品一覧（Masonry）の型。
 *
 * 【既存の PublicWorkListItem と何が違うか】
 *   get_feed_works が返す4列ぶんだけ多い。
 *
 *     author_avatar_path  作者のアイコンの置き場所
 *     answered_by_me      **押したときの行き先を決める1点**
 *     liked_by_me         いいね済みの枠を出すかどうか
 *     saved_by_me         保存の入り／切り
 *
 *   どれも「見ている本人の状態」で、他人が誰を保存したかは入っていない。
 *
 * 【ここに無いもの】
 *   お題・正解・他人の回答・回答分布・伝達率・コメント。
 *   一覧はこれらを1つも受け取らない。**画面で隠しているのではなく、
 *   そもそも渡っていない。**
 */

import type { Completeness, Division } from "@/features/work/types";

/** 一覧の1件（get_feed_works が返す行） */
export type FeedWorkItem = {
  id: string;
  /** 画像の代替文と読み上げにだけ使う。**画面には出さない**（回答のヒントになる） */
  title: string;
  image_path: string;
  image_width: number;
  image_height: number;
  division: Division;
  completeness: Completeness;
  source_title: string | null;
  source_character: string | null;
  fanart_note: string | null;
  actual_time_seconds: number | null;
  time_limit_seconds: number | null;
  mode_key: string;
  was_rerolled: boolean;
  likes_count: number;
  saves_count: number;
  answers_count: number;
  created_at: string;
  author_id: string;
  author_handle: string | null;
  author_display_name: string;
  author_avatar_path: string | null;
  answered_by_me: boolean;
  liked_by_me: boolean;
  saved_by_me: boolean;
};

/**
 * 画面へ渡す1件。FeedWorkItem に、組み立て済みの画像のURLを2つ足したもの。
 *
 * 【なぜサーバー側で組み立てるか】
 *   URL を作る関数（workImageUrl / avatarUrl）は、Supabase の
 *   サーバー用クライアントを読み込むファイルに同居している。
 *   ブラウザ側の部品からそれを読み込むと、サーバー専用の仕組みごと
 *   持ち込むことになる。**文字列にしてから渡す。**
 */
export type FeedCardWork = FeedWorkItem & {
  image_url: string;
  /** 作者のアイコン。未設定なら null（画面は表示名の1文字を出す） */
  avatar_url: string | null;
};

/**
 * 画面が1枚のカードとして扱うもの。
 *
 * **本物の作品と、公開作品が0件のときに出す見本を、同じ形で持つ。**
 * 並べ方（列の割り振り・高さの計算）を2通り書かないため。
 * 違いは kind の1文字だけで、見本は押せない・触れても何も出ない。
 */
export type FeedCard =
  | { kind: "work"; work: FeedCardWork }
  | { kind: "placeholder"; placeholder: PlaceholderCard };

/** 投稿数が少ない間だけ画面に置く、押せない場所取り。 */
export type PlaceholderCard = {
  id: string;
  width: number;
  height: number;
};

/** 一覧を取るときの条件。URL の検索語と1対1で対応する */
export type FeedQuery = {
  division: string | null;
  sort: string;
  completeness: string | null;
  unansweredOnly: boolean;
};

/** 「…」メニューの中身。v1 の3つ（2026-09-18） */
export const CARD_MENU_ITEMS = ["share", "uninterest", "report"] as const;
export type CardMenuItem = (typeof CARD_MENU_ITEMS)[number];
