import Image from "next/image";
import Link from "next/link";
import { getCurrentUser } from "@/features/auth/session";
import { fetchPublicWorks, workImageUrl } from "@/features/work/rpc";
import {
  COMPLETENESS_FILTERS,
  FEED_PAGE_SIZE,
  FEED_SORTS,
  FEED_TABS,
  completenessLabel,
  divisionLabel,
  type PublicWorkListItem,
} from "@/features/work/types";
import { noticeMuted, noticeSuccess, surface, tabOff, tabOn } from "@/app/_surface";
import { requireConsent } from "@/features/consent/rpc";

/**
 * /works ／ 公開作品の一覧。
 *
 * 【AI 作品を通常の一覧に混ぜない（spec 7-3 / Step 8 の終了条件）】
 *   既定のタブでは AI 部門が出ない。分けているのは
 *   **SQL 側**（get_public_works の p_division が null のとき AI を除く）で、
 *   ここで取ってから捨てているのではない。
 *
 *   捨てる形にすると、24件取って数件捨てた結果ページごとの件数がばらつき、
 *   ページ送りの位置もずれる。絞り込みは件数を数える前に済ませる必要がある。
 *
 *   AI を締め出しているのではなく、見る場所を分けている。
 *   タブで「AI生成」を選べば見られる。
 *
 * 【未サインインでも見られる】
 *   get_public_works は anon にも実行権限がある。一覧そのものは、
 *   サインインしていなくても、匿名の利用者が発行されていなくても出る。
 *
 *   サインイン状態を読むのは「未回答のみ」を押せるかどうかの1点だけで、
 *   **読むだけ。**ここで匿名の利用者を作らない（下記）。
 *
 * 【ページ送りの作り】
 *   総件数を数える関数が無いので「次のページがあるか」は
 *   取れた件数で判断する。1ページぶん丸ごと取れたときだけ次を出す。
 *   最終ページがちょうど24件だと空のページへ進めてしまうが、
 *   総件数を数えるより負荷が軽く、実害も小さいのでこの形にする。
 *
 * 【未回答のみ（D169 の11）】
 *   自分が回答を送った作品を一覧から外す絞り込み。**推薦ではない。**
 *   見る人が自分で押す道具で、システムが選ぶ「次の作品」とは別物である。
 *
 *   外す条件は**回答を送ったかどうかだけ。**開いただけの作品は消えない。
 *   閲覧の履歴は記録していないし、ここでも見ていない。
 *
 *   除外は SQL 側（get_public_works の p_unanswered_only）で行う。
 *   取ってから画面で捨てると、1ページの件数がばらつき、
 *   次のページに回答済みの作品が混ざる。
 *
 *   **誰なのか分からないときは押せない。**このサービスは、回答や投稿の
 *   直前になって初めて匿名の利用者を発行する（ページを開いただけでは
 *   発行しない）。まだ一度も何もしていない訪問者には、照合する回答履歴が
 *   そもそも無い。その状態では絞り込みを押せなくして、理由をその場に書く。
 *
 * Next.js 16 では searchParams が Promise なので await が必要。
 */

export const metadata = {
  title: "作品一覧",
};

/** 選ばれたタブを決める。知らない値なら通常フィードに落とす */
function resolveTab(raw: string | undefined) {
  return FEED_TABS.find((t) => t.key === raw) ?? FEED_TABS[0];
}

/** 選ばれた並び順を決める。知らない値なら新着に落とす */
function resolveSort(raw: string | undefined) {
  return FEED_SORTS.find((s) => s.value === raw) ?? FEED_SORTS[0];
}

/** 現在の選択を保ったまま、一部だけ差し替えたリンク先を作る */
type FeedState = {
  tab: string;
  sort: string;
  page: number;
  done: string;
  unanswered: boolean;
};

function hrefWith(current: FeedState, patch: Partial<FeedState>) {
  const next = { ...current, ...patch };
  const params = new URLSearchParams();
  if (next.tab !== FEED_TABS[0].key) params.set("tab", next.tab);
  if (next.sort !== FEED_SORTS[0].value) params.set("sort", next.sort);
  if (next.done !== "") params.set("done", next.done);
  // 既定（OFF）のときは付けない。**OFF に戻すとURLからも消える**
  if (next.unanswered) params.set("unanswered", "1");
  if (next.page > 1) params.set("page", String(next.page));
  const query = params.toString();
  return query ? `/works?${query}` : "/works";
}

function WorkCard({ work }: { work: PublicWorkListItem }) {
  return (
    <li>
      <Link
        href={`/works/${work.id}`}
        className="group block space-y-3 rounded-2xl border border-line p-3 transition hover:border-line-hover"
      >
        <div className="overflow-hidden rounded-xl bg-sunken">
          <Image
            src={workImageUrl(work.image_path)}
            alt={work.title}
            width={work.image_width}
            height={work.image_height}
            className="h-48 w-full object-cover transition group-hover:scale-[1.02]"
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
          />
        </div>

        <div className="space-y-1 px-1 pb-1">
          <p className="truncate text-sm font-bold">{work.title}</p>
          <p className="truncate text-xs text-faint">
            {work.author_display_name}
            {work.author_handle ? `（@${work.author_handle}）` : ""}
          </p>
          {/*
            カードに数字を載せない（D112）。

            一覧は目に入る回数が最も多く、横並びなので**比較が自動的に起きる**。
            数字を置くと、見るたびに順位づけが立ち上がる。

            回答数もいいね数も消えたわけではなく、作品ページで取りに行けば見える。
            **隠すのではなく、取りに行かせる。**
          */}
          <p className="text-xs text-faint">
            {divisionLabel(work.division)}・{completenessLabel(work.completeness)}
          </p>
        </div>
      </Link>
    </li>
  );
}

export default async function WorksPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    sort?: string;
    done?: string;
    unanswered?: string;
    page?: string;
    notice?: string;
  }>;
}) {
  // 未同意の登録者をここで止める（P5）。**判定は DB の consent_status()。**
  // 止めるのは、そのセッションが関門より後に始まっていて、かつ未同意のときだけ。
  await requireConsent();

  const {
    tab: rawTab,
    sort: rawSort,
    done: rawDone,
    unanswered: rawUnanswered,
    page: rawPage,
    notice,
  } = await searchParams;

  const tab = resolveTab(rawTab);
  const sort = resolveSort(rawSort);

  // 知らない値は「すべて」に落とす。一覧が壊れるより空のほうが害が小さい、
  // という get_public_works 側の考えかたに合わせる
  const done = COMPLETENESS_FILTERS.some((f) => f.value !== null && f.value === rawDone)
    ? (rawDone as string)
    : "";

  const parsedPage = Number.parseInt(rawPage ?? "1", 10);
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;

  // **回答履歴を照合できる相手が居るかどうか。**
  // ここで匿名ユーザーを発行してはいけない（spec 11-1）。開いただけの
  // 訪問者で利用者の行が増え、無料枠を圧迫する。読むだけにする。
  const viewer = await getCurrentUser();
  const canFilterUnanswered = viewer !== null;

  const wantsUnanswered = rawUnanswered === "1";
  const unanswered = wantsUnanswered && canFilterUnanswered;

  const current = { tab: tab.key, sort: sort.value, page, done, unanswered: wantsUnanswered };

  const works = await fetchPublicWorks({
    division: tab.value,
    sort: sort.value,
    completeness: done === "" ? null : done,
    unansweredOnly: unanswered,
    limit: FEED_PAGE_SIZE,
    offset: (page - 1) * FEED_PAGE_SIZE,
  });

  const hasNext = works.length === FEED_PAGE_SIZE;

  return (
    <main className="mx-auto w-full max-w-5xl space-y-8 p-6 sm:p-10">
      <header className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="text-2xl font-bold">作品一覧</h1>
          <Link href="/rankings" className="text-sm underline">
            ランキングを見る
          </Link>
        </div>
        <p className="text-sm text-faint">
          絵だけを見て、描き手が引いたお題を当ててみてください。回答はゲストのままでもできます。
        </p>
      </header>

      {notice ? (
        <p className={noticeSuccess}>
          {notice}
        </p>
      ) : null}

      {/* --- 部門タブ --------------------------------------------------------- */}
      <nav className="flex flex-wrap gap-2">
        {FEED_TABS.map((t) => (
          <Link
            key={t.key}
            href={hrefWith(current, { tab: t.key, page: 1 })}
            className={
              t.key === tab.key
                ? tabOn
                : tabOff
            }
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {/* --- 並び順 ----------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <span className="text-faint">並び</span>
        {FEED_SORTS.map((s) => (
          <Link
            key={s.value}
            href={hrefWith(current, { sort: s.value, page: 1 })}
            className={
              s.value === sort.value
                ? "font-bold underline"
                : "text-faint underline hover:text-muted"
            }
          >
            {s.label}
          </Link>
        ))}
      </div>

      {/* --- 完成度 ---------------------------------------------------------- */}
      {/*
        既定は「すべて」。**落書きを別の場所へ押し込めるための絞り込みではない。**
        落書きにも居場所を作るための軸なので、既定で全部見える形にする（D135）。
      */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <span className="text-faint">完成度</span>
        {COMPLETENESS_FILTERS.map((f) => {
          const value = f.value ?? "";
          return (
            <Link
              key={f.label}
              href={hrefWith(current, { done: value, page: 1 })}
              className={
                value === done
                  ? "font-bold underline"
                  : "text-faint underline hover:text-muted"
              }
            >
              {f.label}
            </Link>
          );
        })}
      </div>

      {/* --- 未回答のみ ------------------------------------------------------ */}
      {/*
        部門・完成度・並び順・ページと**同時に使える。**
        URL の検索語（?unanswered=1）に入るので、再読込しても残り、
        部門を変えても外れない。OFF にすると URL からも消える。
      */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <span className="text-faint">回答</span>
        {canFilterUnanswered ? (
          <Link
            href={hrefWith(current, { unanswered: !wantsUnanswered, page: 1 })}
            aria-pressed={wantsUnanswered}
            data-unanswered-filter={wantsUnanswered ? "on" : "off"}
            className={
              // スマホでも押せる大きさにする（44px 以上）
              `inline-flex min-h-11 items-center rounded-lg border px-4 ${
                wantsUnanswered
                  ? "border-line-active font-bold"
                  : "border-line text-faint hover:text-muted"
              }`
            }
          >
            未回答のみ{wantsUnanswered ? "（ON）" : ""}
          </Link>
        ) : (
          <span
            data-unanswered-filter="disabled"
            className="inline-flex min-h-11 items-center rounded-lg border border-line px-4 text-faint opacity-60"
          >
            未回答のみ（まだ使えません）
          </span>
        )}
        {!canFilterUnanswered ? (
          <span className="text-faint">
            どの作品に答えたかは、一度でも回答するか、アカウントでサインインすると
            分かるようになります。それまでは絞り込めません。
          </span>
        ) : null}
      </div>

      {wantsUnanswered && !canFilterUnanswered ? (
        <p className={noticeMuted}>
          「未回答のみ」は、いまの状態では使えません（回答の履歴を照合する相手が
          決まっていないため）。一覧はすべての作品を出しています。
        </p>
      ) : null}

      {tab.key === "ai" ? (
        <p className={noticeMuted}>
          AI生成の作品です。通常の一覧には出ません。
        </p>
      ) : null}

      {/* --- 一覧 ------------------------------------------------------------- */}
      {works.length === 0 ? (
        <div className={surface}>
          <p className="text-sm">
            {page > 1
              ? "このページには作品がありません。"
              : unanswered
                ? "この条件で、まだ答えていない作品はありません。"
                : "まだ作品がありません。お題を引いて最初の1件を投稿してみてください。"}
          </p>
          <p className="pt-3 text-sm">
            <Link href="/play" className="underline">
              お題を引く画面へ
            </Link>
          </p>
        </div>
      ) : (
        <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {works.map((w) => (
            <WorkCard key={w.id} work={w} />
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
          <span className="text-xs text-faint">{page} ページ目</span>
          {hasNext ? (
            <Link href={hrefWith(current, { page: page + 1 })} className="underline">
              次のページ →
            </Link>
          ) : (
            <span />
          )}
        </div>
      ) : null}
    </main>
  );
}
