import Image from "next/image";
import Link from "next/link";
import { fetchRankings } from "@/features/ranking/rpc";
import {
  RANKING_FEEDS,
  RANKING_PAGE_SIZE,
  RANKING_TYPES,
  TIME_BUCKETS,
  resolveRankingFeed,
  resolveRankingType,
  resolveTimeBucket,
  timeBucketLabel,
  type RankingItem,
} from "@/features/ranking/types";
import { divisionLabel } from "@/features/work/types";
import { workImageUrl } from "@/features/work/rpc";
import { surface } from "@/app/_surface";

/**
 * /rankings ／ ランキング（2種 × 2系統）。
 *
 * 【伝達率ランキングは外した（D112）】
 *   種類は「人気」と「時間別」の2つ。どちらもいいねの多い順で、
 *   **上手さの序列ではない。**伝達率を順位にすると、
 *   D105 の「下手なままでいい」という証明が上手さの物差しに変わる。
 *
 * 【並べ替えを画面でやらない】
 *   上位20件を取ってから並べ替えても「全体の上位」にはならない。
 *   絞り込みも順位付けも、件数を数える前に SQL 側で済ませる
 *   （/works の一覧が AI を SQL 側で除いているのと同じ理由）。
 *
 * 【いいねの数を2つ出している】
 *   順位に使うのは**作者本人のいいねを除いた数**（D57）。
 *   カードに出している「いいね」は表示用の総数で、こちらには本人のぶんも
 *   含まれる。両者が食い違うのは自作にいいねが付いているときだけなので、
 *   食い違うときだけ内訳を添える。
 *
 * 【未サインインでも見られる】
 *   get_rankings は anon にも実行権限がある（spec 10 の権限表）。
 *   ページを開いただけで匿名アカウントを作らせない。
 *
 * Next.js 16 では searchParams が Promise なので await が必要。
 */

export const metadata = {
  title: "ランキング",
};

type Current = { type: string; feed: string; time: string; page: number };

/** 現在の選択を保ったまま、一部だけ差し替えたリンク先を作る */
function hrefWith(current: Current, patch: Partial<Current>) {
  const next = { ...current, ...patch };
  const params = new URLSearchParams();
  if (next.type !== RANKING_TYPES[0].value) params.set("type", next.type);
  if (next.feed !== RANKING_FEEDS[0].value) params.set("feed", next.feed);
  if (next.type === "duration" && next.time !== TIME_BUCKETS[0].value) {
    params.set("time", next.time);
  }
  if (next.page > 1) params.set("page", String(next.page));
  const query = params.toString();
  return query ? `/rankings?${query}` : "/rankings";
}

/** 順位に使った票数と、表示用の総数が食い違うときだけ内訳を出す */
function LikeCounts({ item }: { item: RankingItem }) {
  if (item.likes_count === item.ranking_likes_count) {
    return <>いいね {item.likes_count}</>;
  }
  return (
    <>
      いいね {item.likes_count}
      <span className="text-ink/35">
        （順位に数えたのは {item.ranking_likes_count}）
      </span>
    </>
  );
}

/**
 * 伝達率は、ここには出さない（D112）。
 *
 * 順位の隣に % を置くと、それが上手さの物差しとして読まれる。
 * 伝達率は D105 の「下手なままでいい」を支える数字なので、
 * **順位づけの材料にすると意味が反転する。**
 * 自分の作品の結果画面で、取りに行けば見える。
 */
function RankingRow({ item }: { item: RankingItem }) {
  return (
    // data-* は検査の手がかり。**クラス名を手がかりにさせない。**
    // 以前は `<li class="flex items-start` で1行を探していたので、
    // 並びを変えるだけで検査が落ちた。
    <li
      data-ranking-row=""
      data-rank={item.rank}
      className="flex items-start gap-4 border-b border-ink/10 py-4 last:border-b-0"
    >
      <div className="w-10 shrink-0 pt-1 text-center">
        <span className="text-xl font-bold tabular-nums">{item.rank}</span>
      </div>

      <Link
        href={`/works/${item.id}`}
        className="group flex min-w-0 flex-1 items-start gap-4"
      >
        <div className="h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-sunken">
          <Image
            src={workImageUrl(item.image_path)}
            alt={item.title}
            width={item.image_width}
            height={item.image_height}
            className="h-20 w-20 object-cover transition group-hover:scale-[1.03]"
            sizes="80px"
          />
        </div>

        <div className="min-w-0 flex-1 space-y-1">
          <p className="truncate text-sm font-bold group-hover:underline">{item.title}</p>
          <p className="truncate text-xs text-ink/50">
            {item.author_display_name}
            {item.author_handle ? `（@${item.author_handle}）` : ""}
          </p>
          <p className="text-xs text-ink/40">
            {divisionLabel(item.division)}・{timeBucketLabel(item.time_limit_bucket)}・回答{" "}
            {item.answers_count}・<LikeCounts item={item} />
          </p>
        </div>
      </Link>
    </li>
  );
}

export default async function RankingsPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; feed?: string; time?: string; page?: string }>;
}) {
  const {
    type: rawType,
    feed: rawFeed,
    time: rawTime,
    page: rawPage,
  } = await searchParams;

  const type = resolveRankingType(rawType);
  const feed = resolveRankingFeed(rawFeed);
  const bucket = resolveTimeBucket(rawTime);

  const parsedPage = Number.parseInt(rawPage ?? "1", 10);
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;

  const current: Current = {
    type: type.value,
    feed: feed.value,
    time: bucket.value,
    page,
  };

  const items = await fetchRankings({
    type: type.value,
    feed: feed.value,
    // 区分で絞るのは時間別のときだけ。ほかの種類では DB 側も見ない
    timeBucket: type.value === "duration" ? bucket.value : null,
    limit: RANKING_PAGE_SIZE,
    offset: (page - 1) * RANKING_PAGE_SIZE,
  });

  const hasNext = items.length === RANKING_PAGE_SIZE;

  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 p-6 sm:p-10">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">ランキング</h1>
        <p className="text-sm text-ink/55">
          反応を集めた作品です。
        </p>
      </header>

      {/* --- 種類 ------------------------------------------------------------- */}
      <nav className="flex flex-wrap gap-2">
        {RANKING_TYPES.map((t) => (
          <Link
            key={t.value}
            href={hrefWith(current, { type: t.value, page: 1 })}
            className={
              t.value === type.value
                ? "rounded-full bg-accent px-4 py-2 text-xs font-bold text-on-accent"
                : "rounded-full border border-line-mid px-4 py-2 text-xs font-bold hover:bg-hover"
            }
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {/* --- 部門 ------------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <span className="text-ink/45">部門</span>
        {RANKING_FEEDS.map((f) => (
          <Link
            key={f.value}
            href={hrefWith(current, { feed: f.value, page: 1 })}
            className={
              f.value === feed.value
                ? "font-bold underline"
                : "text-ink/50 underline hover:text-ink/80"
            }
          >
            {f.label}
          </Link>
        ))}
      </div>

      {/* --- 時間区分（時間別のときだけ）-------------------------------------- */}
      {type.value === "duration" ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          <span className="text-ink/45">制限時間</span>
          {TIME_BUCKETS.map((b) => (
            <Link
              key={b.value}
              href={hrefWith(current, { time: b.value, page: 1 })}
              className={
                b.value === bucket.value
                  ? "font-bold underline"
                  : "text-ink/50 underline hover:text-ink/80"
              }
            >
              {b.label}
            </Link>
          ))}
        </div>
      ) : null}

      <p className="rounded-xl bg-sunken px-4 py-3 text-xs text-ink/55">
        {type.note}
      </p>

      {/* --- 一覧 ------------------------------------------------------------- */}
      {items.length === 0 ? (
        <div className={surface}>
          <p className="text-sm">
            {page > 1 ? "このページには作品がありません。" : "まだ作品がありません。"}
          </p>
          <p className="pt-3 text-sm">
            <Link href="/works" className="underline">
              作品一覧へ
            </Link>
          </p>
        </div>
      ) : (
        <ul>
          {items.map((item) => (
            <RankingRow key={item.id} item={item} />
          ))}
        </ul>
      )}

      {/* --- ページ送り ------------------------------------------------------- */}
      {page > 1 || hasNext ? (
        <div className="flex items-center justify-between border-t border-ink/10 pt-6 text-sm">
          {page > 1 ? (
            <Link href={hrefWith(current, { page: page - 1 })} className="underline">
              ← 前のページ
            </Link>
          ) : (
            <span />
          )}
          <span className="text-xs text-ink/40">{page} ページ目</span>
          {hasNext ? (
            <Link href={hrefWith(current, { page: page + 1 })} className="underline">
              次のページ →
            </Link>
          ) : (
            <span />
          )}
        </div>
      ) : null}

      <footer className="flex flex-wrap gap-4 border-t border-ink/10 pt-6 text-sm">
        <Link href="/works" className="underline">
          作品一覧へ
        </Link>
        <Link href="/play" className="underline">
          お題を引く画面へ
        </Link>
      </footer>
    </main>
  );
}
