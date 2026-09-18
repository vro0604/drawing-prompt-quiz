import Link from "next/link";
import { getCurrentUser } from "@/features/auth/session";
import { countPublicWorks, fetchFeedWorks } from "@/features/feed/rpc";
import { SAMPLE_CARDS, toFeedCardWorks } from "@/features/feed/present";
import {
  COMPLETENESS_FILTERS,
  FEED_PAGE_SIZE,
  FEED_SORTS,
  FEED_TABS,
} from "@/features/work/types";
import { noticeMuted, noticeSuccess, surface, tabOff, tabOn } from "@/app/_surface";
import { requireConsent } from "@/features/consent/rpc";
import MasonryFeed from "./_masonry";

/**
 * /works ／ 公開作品の一覧。
 *
 * 【2026-09-18 に作りを変えた】
 *   もとは「決まった大きさのカードの中に、絵を縮めて入れる」形だった。
 *   カードの下にタイトル・作者・部門・完成度が並んでいた。
 *
 *   いまは**絵そのものがカード**で、列の高さは絵ごとに違う。
 *   通常の状態でカードに出るものは絵だけで、文字は1つも出ない。
 *   PC で絵に触れたときだけ、小さな情報のタブが絵の上に浮く。
 *
 *   タイトルを一覧に出さないのは、**それがクイズの答えの手がかりになる**ため
 *   （指示 5・21）。作者名・部門・完成度は、答えには関わらないが、
 *   絵を見る邪魔になるので同じくタブの中へ移した。
 *
 * 【ページ送りをやめた】
 *   「次のページ」の代わりに、下まで来たら続きを読む。読んだぶんと
 *   スクロールの位置は、クイズへ入って戻ってきたときに復帰する
 *   （_masonry.tsx の sessionStorage）。
 *
 * 【AI 作品を通常の一覧に混ぜない（spec 7-3 / Step 8 の終了条件）】
 *   既定のタブでは AI 部門が出ない。分けているのは
 *   **SQL 側**（get_feed_works の p_division が null のとき AI を除く）で、
 *   ここで取ってから捨てているのではない。
 *
 *   AI を締め出しているのではなく、見る場所を分けている。
 *   タブで「AI生成」を選べば見られる。
 *
 * 【未サインインでも見られる】
 *   get_feed_works は anon にも実行権限がある。一覧そのものは、
 *   サインインしていなくても、匿名の利用者が発行されていなくても出る。
 *
 *   サインイン状態を読むのは2点だけで、**読むだけ。**
 *     ・「未回答のみ」を押せるか
 *     ・いいね／保存を押す前に案内を出し分けるか
 *   ここで匿名の利用者を作らない（spec 11-1）。
 *
 * 【未回答のみ（D169 の11）】
 *   自分が回答を送った作品を一覧から外す絞り込み。**推薦ではない。**
 *   外す条件は回答を送ったかどうかだけで、開いただけの作品は消えない。
 *   除外は SQL 側で行う（取ってから捨てると1ページの件数がばらつく）。
 *
 * 【作品が1件も無いとき（指示 22〜27）】
 *   真っ白な画面にしない。見本のカードを10枚並べる。
 *   **見本は押せない。**公開作品が1件でもあれば、見本は1枚も出ない。
 *   「1件も無い」の判定は count_public_works で、絞り込みも興味なしも
 *   掛けていない。絞り込みの結果として0件になっただけのときは、
 *   見本ではなく「この条件では見つかりません」と書く。
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
  const query = params.toString();
  return query ? `/works?${query}` : "/works";
}

export default async function WorksPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    sort?: string;
    done?: string;
    unanswered?: string;
    notice?: string;
  }>;
}) {
  // 未同意の登録者をここで止める（P5）。**判定は DB の consent_status()。**
  await requireConsent();

  const {
    tab: rawTab,
    sort: rawSort,
    done: rawDone,
    unanswered: rawUnanswered,
    notice,
  } = await searchParams;

  const tab = resolveTab(rawTab);
  const sort = resolveSort(rawSort);

  // 知らない値は「すべて」に落とす。一覧が壊れるより空のほうが害が小さい
  const done = COMPLETENESS_FILTERS.some((f) => f.value !== null && f.value === rawDone)
    ? (rawDone as string)
    : "";

  // **回答履歴を照合できる相手が居るかどうか。**
  // ここで匿名ユーザーを発行してはいけない（spec 11-1）。読むだけにする。
  const viewer = await getCurrentUser();
  const canFilterUnanswered = viewer !== null;
  const canReact = viewer !== null && viewer.is_anonymous !== true;

  const wantsUnanswered = rawUnanswered === "1";
  const unanswered = wantsUnanswered && canFilterUnanswered;

  const current = { tab: tab.key, sort: sort.value, done, unanswered: wantsUnanswered };

  const [rows, totalPublic] = await Promise.all([
    fetchFeedWorks({
      division: tab.value,
      sort: sort.value,
      completeness: done === "" ? null : done,
      unansweredOnly: unanswered,
      limit: FEED_PAGE_SIZE,
      offset: 0,
    }),
    countPublicWorks(),
  ]);

  const works = toFeedCardWorks(rows);

  // 見本を出すのは「公開作品が本当に0件」のときだけ（指示 27）。
  // 数えられなかったとき（-1）は出さない。**作品があるのに
  // 「まだありません」と書くほうが害が大きい。**
  const showSamples = works.length === 0 && totalPublic === 0;

  return (
    // 一覧は画面の幅いっぱいに広げる。**幅に上限を置かない。**
    // Pinterest も広い画面ほど列が増え続ける（実測: 幅2560で10列）。
    // 上限を置くと、広い画面で右側が空いたまま列が増えなくなる
    <main className="w-full space-y-6 py-6 sm:py-8">
      <div className="mx-auto w-full max-w-5xl space-y-6 px-5">
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
          <p className="text-xs text-faint">
            絵を押すとクイズが始まります。長押しすると「いいね」が付きます。
          </p>
        </header>

        {notice ? <p className={noticeSuccess}>{notice}</p> : null}

        {/* --- 部門タブ ------------------------------------------------------- */}
        <nav className="flex flex-wrap gap-2">
          {FEED_TABS.map((t) => (
            <Link
              key={t.key}
              href={hrefWith(current, { tab: t.key })}
              className={t.key === tab.key ? tabOn : tabOff}
            >
              {t.label}
            </Link>
          ))}
        </nav>

        {/* --- 並び順 --------------------------------------------------------- */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          <span className="text-faint">並び</span>
          {FEED_SORTS.map((s) => (
            <Link
              key={s.value}
              href={hrefWith(current, { sort: s.value })}
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

        {/* --- 完成度 -------------------------------------------------------- */}
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
                href={hrefWith(current, { done: value })}
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

        {/* --- 未回答のみ ---------------------------------------------------- */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          <span className="text-faint">回答</span>
          {canFilterUnanswered ? (
            <Link
              href={hrefWith(current, { unanswered: !wantsUnanswered })}
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
          <p className={noticeMuted}>AI生成の作品です。通常の一覧には出ません。</p>
        ) : null}

        {/* --- 作品が1件も無いときの説明（指示 25。一覧の上に1度だけ） -------- */}
        {showSamples ? (
          <div data-feed-sample-notice className={`${surface} space-y-2`}>
            <p className="text-sm font-bold">まだ作品がありません。</p>
            <p className="text-sm text-faint">
              下に並んでいるのは、作品が投稿されたときの表示イメージです。押しても何も起きません。
            </p>
            <p className="pt-1 text-sm">
              <Link href="/play" className="underline">
                お題を引く画面へ
              </Link>
            </p>
          </div>
        ) : null}

        {/* --- 絞り込んだ結果として0件だったとき ----------------------------- */}
        {works.length === 0 && !showSamples ? (
          <div className={surface}>
            <p className="text-sm">
              {unanswered
                ? "この条件で、まだ答えていない作品はありません。"
                : "この条件に当てはまる作品はありません。"}
            </p>
            <p className="pt-3 text-sm">
              <Link href="/works" className="underline">
                絞り込みを外して全部見る
              </Link>
            </p>
          </div>
        ) : null}
      </div>

      {/* --- 一覧本体 --------------------------------------------------------- */}
      {works.length > 0 || showSamples ? (
        <MasonryFeed
          /*
            【条件が変わったら、部品ごと作り直す】
              タブや並び順を押すと、同じ道筋のまま検索語だけが変わる。
              React はこの部品を残したまま渡す値だけを差し替えるので、
              **中に貯めた「読み込み済みの何百枚」が前の条件のまま残る。**
              条件を鍵にして作り直させる（key）。復帰の控えも条件ごとに
              別なので、タブを行き来しても混ざらない。
          */
          key={`${tab.key}|${sort.value}|${done}|${unanswered ? "1" : "0"}`}
          initialWorks={works}
          samples={showSamples ? SAMPLE_CARDS : []}
          query={{
            division: tab.value,
            sort: sort.value,
            completeness: done === "" ? null : done,
            unansweredOnly: unanswered,
          }}
          pageSize={FEED_PAGE_SIZE}
          canReact={canReact}
        />
      ) : null}
    </main>
  );
}
