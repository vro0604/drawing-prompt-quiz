"use client";

import Image from "next/image";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CARD_RADIUS_PX,
  columnWidthFor,
  columnsFor,
  displayRatio,
  distribute,
  edgeFor,
  gapFor,
  isClipped,
} from "@/features/feed/layout";
import {
  LIKE_PRESS_MS,
  PRESS_IDLE,
  type Point,
  type Press,
  pressAdvance,
  pressRelease,
  pressStart,
  stillPressing,
  washFraction,
} from "@/features/feed/press";
import type {
  CardMenuItem,
  FeedCard,
  FeedCardWork,
  FeedQuery,
  SampleCard,
} from "@/features/feed/types";
import { completenessLabel } from "@/features/work/types";
import {
  loadFeedPageAction,
  setFeedUninterestAction,
  toggleFeedLikeAction,
  toggleFeedSaveAction,
} from "./actions";

/**
 * 作品一覧の並べかたと、カード1枚の振る舞い。
 *
 * 【この画面が何をするものか】
 *   絵をそのまま並べる。カードの枠も、下に付く文字も無い。
 *   **絵そのものがカード。**
 *
 * 【段の組み方（Masonry）】
 *   列の数は画面の幅から毎回計算する（features/feed/layout.ts）。
 *   カードは「そのとき最も背の低い列」の下へ順に積む。
 *   縦横比は DB が持っているので、**画像が1枚も届く前に全部の高さが決まる。**
 *   だから読み込みが終わっても一覧は動かないし、
 *   下に読み足しても、すでに置いたカードは1枚も動かない。
 *
 * 【押したときの行き先は2つだけ】
 *   まだ答えていない作品 → そのままクイズ（/works/<id>?q=1）
 *   もう答えた作品       → 結果と鑑賞（/works/<id>）
 *   途中に「まず作品の説明を読む画面」は挟まない。
 *
 * 【いいねは長押し 0.5 秒】
 *   ボタンは置かない。カードのどこでも 0.5 秒押し続けると付く。
 *   押している間、中央からパステルピンクが外へ広がる。
 *   **スクロールは一切邪魔しない**（touch-action も preventDefault も
 *   使っていない）。代わりに「押している座標が、まだそのカードの中にあるか」を
 *   毎フレーム見る。スクロールでカードが逃げれば、そこで失効する。
 *
 * 【広がりを React の状態にしない】
 *   毎フレーム状態を書き換えると、一覧ぜんたいが描き直されて指が重くなる。
 *   広がりは、押されているカードの中の1つの要素へ**直に幅と高さを書く。**
 *   React が関わるのは、押し始めと押し終わりの2回だけ。
 *
 * 【スマホのカードには何も出さない】
 *   作者も、保存も、「…」も出さない。出るのは絵だけ。
 *   PC の情報子タブは `@media (hover: hover) and (pointer: fine)` の
 *   中だけで見えるようにしてある（globals.css）。触る端末では
 *   visibility が hidden なので、キーボードの移動先にもならない。
 */

/* ===========================================================================
 * 幅を測る
 * =========================================================================== */

/**
 * 組み立てのときに仮で使う幅（px）。
 *
 * サーバー側には画面の幅が無い。ここを毎回違う値にすると、
 * サーバーが作った HTML とブラウザの最初の描画が食い違う。
 * **決め打ちの1つの値**にして、測れたら差し替える。
 */
const ASSUMED_WIDTH = 992;

function useContainerWidth() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const read = () => setWidth(el.getBoundingClientRect().width);
    read();

    // 窓の大きさ変更・画面の回転・端末の向き。どれもここへ届く
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, width: width ?? ASSUMED_WIDTH, measured: width !== null };
}

/* ===========================================================================
 * 読み込み済みのカードと、スクロールの位置を覚えておく
 * =========================================================================== */

/**
 * 戻ってきたときに、元の場所へ戻すための控え。
 *
 * 【なぜ要るか】
 *   カードを押してクイズへ入り、答えずに戻ると、サーバーは1ページ目だけを
 *   作り直す。**読み足した何百枚も、スクロールの位置も無くなる。**
 *   ブラウザの「戻る」が先頭へ跳ぶのはこれが理由で、
 *   ブラウザのせいではない。
 *
 * 【どこへ置くか】
 *   sessionStorage。窓を閉じれば消える。別の窓には移らない。
 *   絞り込みの条件ごとに別の控えにするので、タブを変えて戻っても混ざらない。
 */
const STORE_PREFIX = "dpq-feed:";

/**
 * 「いま一覧からカードを押して出て行った」ことの印。
 *
 * 【なぜ要るか】
 *   控えがあるからといって、いつでも戻していいわけではない。
 *   ヘッダーの「作品」から開き直したときに控えを戻すと、
 *   **出て行ったあいだに増えた作品も、運営が下げた作品も、
 *   古いまま画面に残る。**実測: 管理の画面で作品を非表示にしたあと
 *   一覧を開き直したのに、その作品がまだ並んでいた。
 *
 *   だから「出て行くときに印を置き、戻ってきたら1回だけ使って消す」。
 *   印が無ければ、控えがあっても使わずサーバーの値で出す。
 */
const RETURN_KEY = "dpq-feed-return";

type Restored = { items: FeedCardWork[]; offset: number; scrollY: number; done: boolean };

function storeKey(query: FeedQuery): string {
  return (
    STORE_PREFIX +
    [
      query.division ?? "-",
      query.sort,
      query.completeness ?? "-",
      query.unansweredOnly ? "1" : "0",
    ].join("|")
  );
}

function readStore(query: FeedQuery): Restored | null {
  try {
    const raw = sessionStorage.getItem(storeKey(query));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Restored;
    if (!Array.isArray(parsed.items) || parsed.items.length === 0) return null;
    return parsed;
  } catch {
    // 使えなくても一覧は出る。先頭から始まるだけ
    return null;
  }
}

function writeStore(query: FeedQuery, value: Restored) {
  try {
    sessionStorage.setItem(storeKey(query), JSON.stringify(value));
  } catch {
    // 容量が足りないときは諦める。復帰しないだけで一覧は壊れない
  }
}

/* ===========================================================================
 * 短い知らせ（押せなかった理由など）
 * =========================================================================== */

function Toast({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div
      data-feed-toast
      role="status"
      className="fixed inset-x-0 bottom-6 z-50 mx-auto w-fit max-w-[90vw] rounded-full bg-accent px-5 py-3 text-xs text-on-accent shadow-lg"
    >
      {text}
    </div>
  );
}

/* ===========================================================================
 * カード1枚
 * =========================================================================== */

type CardState = { liked: boolean; saved: boolean };

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-glass px-2 py-0.5 text-[10px] font-bold whitespace-nowrap text-glass-ink">
      {children}
    </span>
  );
}

function AuthorAvatar({ work }: { work: FeedCardWork }) {
  if (work.avatar_url) {
    return (
      <Image
        src={work.avatar_url}
        alt=""
        width={20}
        height={20}
        className="size-5 shrink-0 rounded-full object-cover"
      />
    );
  }
  const initial = work.author_display_name.trim();
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-sunken-strong text-[10px]">
      {initial === "" ? "?" : Array.from(initial)[0]}
    </span>
  );
}

type WorkCardProps = {
  work: FeedCardWork;
  state: CardState;
  onPressStart: (workId: string, el: HTMLElement, point: Point) => void;
  /** カードから出て行く直前に呼ぶ（戻ってきたときの復帰の印を置く） */
  onLeave: () => void;
  onSave: (workId: string, saved: boolean) => void;
  onUninterest: (workId: string) => void;
  onShare: (workId: string) => void;
};

/**
 * memo を付けているのは、押している間の描き直しを1枚に閉じ込めるため。
 * 上からの props は全部安定しているので、押していないカードは素通しされる。
 */
const WorkCardView = memo(function WorkCardView({
  work,
  state,
  onPressStart,
  onLeave,
  onSave,
  onUninterest,
  onShare,
}: WorkCardProps) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [broken, setBroken] = useState(false);
  const ratio = displayRatio(work.image_width, work.image_height);
  const clipped = isClipped(work.image_width, work.image_height);

  // 未回答ならクイズへ、回答済みなら結果へ。**途中に何も挟まない**
  const href = work.answered_by_me ? `/works/${work.id}` : `/works/${work.id}?q=1`;

  return (
    <article
      data-work-card
      data-work-id={work.id}
      data-answered={work.answered_by_me ? "1" : "0"}
      data-liked={state.liked ? "1" : "0"}
      data-saved={state.saved ? "1" : "0"}
      data-clipped={clipped ? "1" : "0"}
      data-pressing="0"
      data-menu-open={menuOpen ? "1" : "0"}
      className="dpq-card relative block w-full"
      onDragStart={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        // 触る端末は下の onTouchStart で扱う。
        // スクロールが始まると pointercancel が飛ぶので、pointer 系だけでは
        // 「スクロール中も押し続けている」が表せない（指示 13）
        if (e.pointerType === "touch") return;
        if (e.button !== 0) return;
        onPressStart(work.id, e.currentTarget, { x: e.clientX, y: e.clientY });
      }}
      onTouchStart={(e) => {
        const t = e.touches[0];
        if (!t) return;
        onPressStart(work.id, e.currentTarget, { x: t.clientX, y: t.clientY });
      }}
    >
      <div
        className="dpq-card-frame relative w-full overflow-hidden bg-photo-bed"
        style={{ aspectRatio: `1 / ${ratio}`, borderRadius: `${CARD_RADIUS_PX}px` }}
      >
        {broken ? (
          <div className="flex h-full w-full items-center justify-center p-4 text-center text-[11px] text-faint">
            画像を読み込めませんでした
          </div>
        ) : (
          <Image
            src={work.image_url}
            /*
              【代替文にタイトルを入れない】
                タイトルはクイズの答えの手がかりになりうる（指示 5・21）。
                目に入らなくても、読み上げに入れば同じこと。
                絵は装飾として空にし、**意味は下のリンクの説明が持つ**
                （「〈作者〉さんの作品。クイズに答える」）。
            */
            alt=""
            fill
            draggable={false}
            onError={() => setBroken(true)}
            // 極端に縦長で切っているときだけ上を残す。ふつうの絵は
            // 縦横比が合っているので、ここは効かない（切れない）
            className={clipped ? "object-cover object-top" : "object-cover"}
            sizes="(max-width: 640px) 50vw, 300px"
          />
        )}

        {/* 絵の上に置く、押すための面。ここが「カードを押す」の実体。
            情報子タブの下にあるので、タブの中のボタンとは競合しない */}
        <a
          href={href}
          data-card-link
          draggable={false}
          onClick={onLeave}
          className="absolute inset-0 z-10"
          aria-label={
            work.answered_by_me
              ? `${work.author_display_name} さんの作品。答え合わせを見る`
              : `${work.author_display_name} さんの作品。クイズに答える`
          }
        />

        {/* 押している間の広がり。**濃く塗りつぶさない。**
            大きさは JavaScript が直に書き換える（React を通さない） */}
        <span
          data-like-wash
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 z-[15] block -translate-x-1/2 -translate-y-1/2 rounded-full bg-like-wash opacity-0"
          style={{ width: 0, height: 0 }}
        />

        {/* いいね済みの印。細い枠と、ごく小さな粒 */}
        {state.liked ? (
          <>
            <span
              aria-hidden
              data-like-ring
              className="pointer-events-none absolute inset-0 z-[16] border-2 border-like"
              style={{ borderRadius: `${CARD_RADIUS_PX}px` }}
            />
            <span aria-hidden className="dpq-like-motes pointer-events-none absolute inset-0 z-[17]">
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>
          </>
        ) : null}

        {/* --- 情報子タブ（PC でだけ出る） ------------------------------- */}
        <div data-card-tab className="dpq-card-tab absolute inset-0 z-20">
          {/* 上の段: 保存 と 「…」 */}
          <div className="absolute right-2 top-2 flex items-center gap-1.5">
            <button
              type="button"
              data-card-save
              aria-pressed={state.saved}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onSave(work.id, state.saved);
              }}
              className="rounded-full bg-glass px-3 py-1.5 text-[11px] font-bold text-glass-ink backdrop-blur hover:opacity-85"
            >
              {state.saved ? "保存済み" : "保存"}
            </button>

            <button
              type="button"
              data-card-menu
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="そのほかの操作"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
              className="rounded-full bg-glass px-2.5 py-1.5 text-[11px] font-bold text-glass-ink backdrop-blur hover:opacity-85"
            >
              …
            </button>
          </div>

          {menuOpen ? (
            <div
              role="menu"
              data-card-menu-list
              // z-10 は下の段（作者と札）より前に出すため。
              // 背の低いカードでは「…」の中身と下の段が重なり、
              // **あとに書いた下の段が上に来て、項目を押せなくなる**
              // （実測: 通報の項目が「別の要素に遮られている」で押せなかった）
              className="absolute right-2 top-11 z-10 w-36 overflow-hidden rounded-xl bg-glass text-glass-ink backdrop-blur"
            >
              {/*
                【項目を足すときは、この配列に1行足すだけ】
                  中身（key / label / run）だけを並べ、見た目と押した後の
                  片づけ（menu を閉じる・親の click へ伝えない）は
                  下の1か所が持つ。**項目ごとに同じ後始末を書き写さない。**
                  key は features/feed/types.ts の CARD_MENU_ITEMS と対で、
                  片方だけ増やすと型が合わなくなる。
              */}
              {(
                [
                  { key: "share", label: "共有", run: () => onShare(work.id) },
                  { key: "uninterest", label: "興味なし", run: () => onUninterest(work.id) },
                  {
                    key: "report",
                    label: "通報",
                    run: () => {
                      onLeave();
                      router.push(`/works/${work.id}/report`);
                    },
                  },
                ] satisfies { key: CardMenuItem; label: string; run: () => void }[]
              ).map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  data-card-menu-item={item.key}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenuOpen(false);
                    item.run();
                  }}
                  className="block w-full px-3 py-2 text-left text-[11px] hover:opacity-70"
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}

          {/* 下の段: 札と、作者 */}
          <div className="absolute inset-x-2 bottom-2 flex flex-col items-start gap-1">
            <div className="flex flex-wrap gap-1">
              {work.answered_by_me ? <Chip>回答済み</Chip> : null}
              {work.division === "ai" ? <Chip>AI</Chip> : null}
              <Chip>{completenessLabel(work.completeness)}</Chip>
            </div>

            {work.author_handle ? (
              <a
                href={`/u/${work.author_handle}`}
                data-card-author
                onClick={(e) => {
                  e.stopPropagation();
                  onLeave();
                }}
                className="flex max-w-full items-center gap-1.5 rounded-full bg-glass py-1 pl-1 pr-2.5 text-[11px] font-bold text-glass-ink backdrop-blur hover:opacity-85"
              >
                <AuthorAvatar work={work} />
                <span className="truncate">{work.author_display_name}</span>
              </a>
            ) : (
              <span
                data-card-author
                className="flex max-w-full items-center gap-1.5 rounded-full bg-glass py-1 pl-1 pr-2.5 text-[11px] font-bold text-glass-ink backdrop-blur"
              >
                <AuthorAvatar work={work} />
                <span className="truncate">{work.author_display_name}</span>
              </span>
            )}
          </div>
        </div>
      </div>
    </article>
  );
});

/**
 * 見本のカード。**押せない。触れても何も出ない。**
 *
 * リンクも、ボタンも、長押しの受け口も持たない。
 * カーソルも変わらないので、押せるようには見えない（指示 24）。
 */
function SampleCardView({ sample }: { sample: SampleCard }) {
  const ratio = displayRatio(sample.width, sample.height);
  return (
    <div
      data-sample-card
      aria-hidden
      className="dpq-card-frame relative w-full select-none overflow-hidden bg-photo-bed"
      style={{ aspectRatio: `1 / ${ratio}`, borderRadius: `${CARD_RADIUS_PX}px` }}
    >
      {/* 見本は SVG。next/image は SVG を既定で最適化しないので素の img で置く */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={sample.src} alt="" draggable={false} className="h-full w-full object-cover" />
    </div>
  );
}

/* ===========================================================================
 * 一覧ぜんたい
 * =========================================================================== */

export default function MasonryFeed({
  initialWorks,
  samples,
  query,
  pageSize,
  canReact,
}: {
  initialWorks: FeedCardWork[];
  /** 公開作品が0件のときだけ中身が入る。**実作品とは混ざらない**（指示 27） */
  samples: SampleCard[];
  query: FeedQuery;
  pageSize: number;
  /** 登録ユーザーとして見ているか。押す前の案内を出し分けるためだけ */
  canReact: boolean;
}) {
  const { ref: containerRef, width, measured } = useContainerWidth();

  const [works, setWorks] = useState<FeedCardWork[]>(initialWorks);
  const [cardState, setCardState] = useState<Record<string, CardState>>(() =>
    Object.fromEntries(
      initialWorks.map((w) => [w.id, { liked: w.liked_by_me, saved: w.saved_by_me }]),
    ),
  );
  const [offset, setOffset] = useState(initialWorks.length);
  const [done, setDone] = useState(initialWorks.length < pageSize);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const showSamples = samples.length > 0;

  /* --- 短い知らせ ------------------------------------------------------- */
  const say = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast((t) => (t === text ? null : t)), 3200);
  }, []);

  /* --- 戻ってきたときの復帰 --------------------------------------------- */
  const pendingScroll = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (showSamples) return;

    // 印が、この条件の一覧のものでなければ戻さない（上の説明のとおり）。
    // 使ったら必ず消す。**次に開いたときは新しい値で出す**
    let returning = false;
    try {
      returning = sessionStorage.getItem(RETURN_KEY) === storeKey(query);
      sessionStorage.removeItem(RETURN_KEY);
    } catch {
      /* 使えない環境では、いつも新しい値で出す */
    }
    if (!returning) return;

    const saved = readStore(query);
    if (!saved) return;
    // 描き終わる前にもう一度描き直すことになるが、**ここは必要な描き直し。**
    // 復帰する枚数はサーバー側では分からない（sessionStorage は
    // ブラウザの中にしか無い）ので、最初の描画に間に合わせる手が無い。
    // 描いてから直すと、先頭へ跳んでから戻る動きが見える。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWorks(saved.items);
    setCardState(
      Object.fromEntries(
        saved.items.map((w) => [w.id, { liked: w.liked_by_me, saved: w.saved_by_me }]),
      ),
    );
    setOffset(saved.offset);
    setDone(saved.done);
    pendingScroll.current = saved.scrollY;
    // query は URL から作られる値で、この画面が生きている間は変わらない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    if (pendingScroll.current === null) return;
    const y = pendingScroll.current;
    pendingScroll.current = null;
    window.scrollTo(0, y);
  }, [works]);

  /* --- いまの状態を控えておく ------------------------------------------- */
  //
  // 読み足しと、離れる直前の保存から読む。どちらも描画の外で走るので、
  // ここへ書き写すのも描画の外（effect の中）で行う
  const latest = useRef({ works, offset, done, cardState });
  useEffect(() => {
    latest.current = { works, offset, done, cardState };
  }, [works, offset, done, cardState]);

  useEffect(() => {
    if (showSamples) return;

    const save = () => {
      const { works: w, offset: o, done: d, cardState: cs } = latest.current;
      if (w.length === 0) return;
      // **画面でいま押してある状態を混ぜてから控える。**
      // サーバーから来たままの値を控えると、戻ったときに
      // さっき付けたいいねが消えて見える（DB には入っているのに）
      const items = w.map((x) => ({
        ...x,
        liked_by_me: cs[x.id]?.liked ?? x.liked_by_me,
        saved_by_me: cs[x.id]?.saved ?? x.saved_by_me,
      }));
      writeStore(query, { items, offset: o, scrollY: window.scrollY, done: d });
    };

    // 画面を離れる直前と、スクロールが止まったとき
    let timer = 0;
    const onScroll = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(save, 250);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", save);
    return () => {
      save();
      window.clearTimeout(timer);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", save);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSamples]);

  /* --- 読み足し --------------------------------------------------------- */
  const sentinel = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);

  const loadMore = useCallback(async () => {
    if (loadingRef.current || latest.current.done || showSamples) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const r = await loadFeedPageAction({
        division: query.division,
        sort: query.sort,
        completeness: query.completeness,
        unansweredOnly: query.unansweredOnly,
        limit: pageSize,
        offset: latest.current.offset,
      });
      if (!r.ok) {
        say(r.error);
        setDone(true);
        return;
      }

      // 同じ作品が二重に並ばないようにする。並べ替えが「いいね順」のとき、
      // 読み足しの合間に順位が入れ替わると同じ行が2ページに現れうる
      const known = new Set(latest.current.works.map((w) => w.id));
      const fresh = r.items.filter((w) => !known.has(w.id));

      setWorks((prev) => [...prev, ...fresh]);
      setCardState((prev) => {
        const next = { ...prev };
        for (const w of fresh) next[w.id] = { liked: w.liked_by_me, saved: w.saved_by_me };
        return next;
      });
      setOffset((prev) => prev + r.items.length);
      if (r.items.length < pageSize) setDone(true);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSize, showSamples, say]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || showSamples) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      // 画面の下端より少し前から読み始める。到達してから読むと、
      // 待ち時間がそのまま「下が空っぽの時間」になる
      { rootMargin: "800px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, showSamples]);

  /* --- 操作 ------------------------------------------------------------- */
  const setOne = useCallback((workId: string, patch: Partial<CardState>) => {
    setCardState((prev) => {
      const before: CardState = prev[workId] ?? { liked: false, saved: false };
      return { ...prev, [workId]: { ...before, ...patch } };
    });
  }, []);

  //
  // いまの入り／切りは**呼ぶ側から受け取る。**画面の状態を控えておく箱を
  // 別に持つと、描画の途中でその箱を読むことになり、React の作法から外れる。
  // 押した本人（カード、または長押しの受け口）は自分の状態を知っている。
  const doLike = useCallback(
    async (workId: string, before: boolean) => {
      if (!canReact) {
        say("いいねにはアカウント登録が必要です。クイズの回答はゲストのままできます。");
        return;
      }
      // 先に見た目を変える。長押しが満ちた瞬間に反応が無いと、
      // 押し続けた 0.5 秒が何だったのか分からなくなる
      setOne(workId, { liked: !before });
      const r = await toggleFeedLikeAction(workId);
      if (!r.ok) {
        setOne(workId, { liked: before });
        say(r.error);
        return;
      }
      setOne(workId, { liked: r.liked });
    },
    [canReact, say, setOne],
  );

  const doSave = useCallback(
    async (workId: string, before: boolean) => {
      if (!canReact) {
        say("保存にはアカウント登録が必要です。");
        return;
      }
      setOne(workId, { saved: !before });
      const r = await toggleFeedSaveAction(workId);
      if (!r.ok) {
        setOne(workId, { saved: before });
        say(r.error);
        return;
      }
      setOne(workId, { saved: r.saved });
    },
    [canReact, say, setOne],
  );

  const doUninterest = useCallback(
    async (workId: string) => {
      const r = await setFeedUninterestAction(workId, true);
      if (!r.ok) {
        say(r.error);
        return;
      }
      setWorks((prev) => prev.filter((w) => w.id !== workId));
      say("この作品は、あなたの一覧に出なくなりました。");
    },
    [say],
  );

  /**
   * カードから出て行く直前。戻ってきたときに復帰してよい、という印を置く。
   * 同じ往復で、いま画面に出ている中身も控える。
   */
  const onLeave = useCallback(() => {
    if (showSamples) return;
    const { works: w, offset: o, done: d, cardState: cs } = latest.current;
    if (w.length === 0) return;
    const items = w.map((x) => ({
      ...x,
      liked_by_me: cs[x.id]?.liked ?? x.liked_by_me,
      saved_by_me: cs[x.id]?.saved ?? x.saved_by_me,
    }));
    writeStore(query, { items, offset: o, scrollY: window.scrollY, done: d });
    try {
      sessionStorage.setItem(RETURN_KEY, storeKey(query));
    } catch {
      /* 使えない環境では復帰しないだけ */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSamples]);

  const doShare = useCallback(
    async (workId: string) => {
      const url = `${window.location.origin}/works/${workId}`;
      if (typeof navigator.share === "function") {
        try {
          await navigator.share({ url });
          return;
        } catch {
          // 共有先の選択をやめた場合もここへ来る。次の手には進まない
          return;
        }
      }
      try {
        await navigator.clipboard.writeText(url);
        say("リンクをコピーしました。");
      } catch {
        say(`このブラウザでは共有できませんでした。URL: ${url}`);
      }
    },
    [say],
  );

  /* --- 長押し ----------------------------------------------------------- */
  const live = useRef<{
    id: string | null;
    el: HTMLElement | null;
    point: Point;
    press: Press;
    raf: number;
  }>({ id: null, el: null, point: { x: 0, y: 0 }, press: PRESS_IDLE, raf: 0 });

  /** 直前の長押しで、いいねが成立したか。成立していたら次の click を飲み込む */
  const suppressClick = useRef(false);

  /** 押されているカードの中の「広がり」を、直に書き換える */
  const paintWash = useCallback((el: HTMLElement | null, progress: number | null) => {
    if (!el) return;
    const wash = el.querySelector<HTMLElement>("[data-like-wash]");
    el.setAttribute("data-pressing", progress === null ? "0" : "1");
    if (!wash) return;
    if (progress === null) {
      wash.style.width = "0px";
      wash.style.height = "0px";
      wash.style.opacity = "0";
      return;
    }
    // 145% にしているのは、**満ちた瞬間にちょうど四隅へ届く**ようにするため。
    // 100% だとカードの外周に内接する楕円で、角が残る。
    // 逆に大きすぎる値（実測: 260%）にすると、押しはじめて4割ほどで
    // カード全体が染まりきってしまい、**残り時間が分からなくなる。**
    const f = washFraction(progress) * 145;
    wash.style.width = `${f}%`;
    wash.style.height = `${f}%`;
    wash.style.opacity = "0.55";
  }, []);

  const endPress = useCallback(
    (now: number) => {
      const l = live.current;
      if (l.raf) cancelAnimationFrame(l.raf);
      paintWash(l.el, null);
      l.press = pressRelease(l.press, now);
      l.id = null;
      l.el = null;
      l.raf = 0;
    },
    [paintWash],
  );

  // requestAnimationFrame で自分自身を呼び直すので、名前ではなく箱を通す。
  // 名前で呼ぶと「宣言より前の自分」を参照することになる
  const tickRef = useRef<() => void>(() => {});

  const tick = useCallback(() => {
    const l = live.current;
    if (!l.id || !l.el) return;

    const now = performance.now();
    const rect = l.el.getBoundingClientRect();

    // まだ同じカードを押しているか。スクロールでカードが逃げたら、
    // 指が動いていなくてもここで false になる
    if (!stillPressing(l.point, rect, { width: window.innerWidth, height: window.innerHeight })) {
      endPress(now);
      return;
    }

    l.press = pressAdvance(l.press, now);
    paintWash(l.el, l.press.progress);

    if (l.press.phase === "done") {
      const id = l.id;
      const wasLiked = l.el.getAttribute("data-liked") === "1";
      // 長押しの直後に来る click（＝カードを開く操作）を1回だけ飲み込む。
      // **時間で必ず解除する。**解除しないと、長押しのあと別の場所を
      // 押したときの1回目が理由もなく効かなくなる
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 400);
      // 対応している端末では軽く震わせる。**無くても機能は成立する**
      try {
        navigator.vibrate?.(12);
      } catch {
        /* 対応していない端末 */
      }
      endPress(now);
      void doLike(id, wasLiked);
      return;
    }

    l.raf = requestAnimationFrame(() => tickRef.current());
  }, [doLike, endPress, paintWash]);

  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  const onPressStart = useCallback(
    (workId: string, el: HTMLElement, point: Point) => {
      const now = performance.now();
      const l = live.current;
      if (l.raf) cancelAnimationFrame(l.raf);
      paintWash(l.el, null);
      l.id = workId;
      l.el = el;
      l.point = point;
      l.press = pressStart(now);
      paintWash(el, 0);
      l.raf = requestAnimationFrame(() => tickRef.current());
    },
    [paintWash],
  );

  useEffect(() => {
    // 指やマウスの現在地を追う。**preventDefault は1度も呼ばない。**
    // 呼ぶとスクロールが止まる（指示 13）
    const movePointer = (e: PointerEvent) => {
      if (!live.current.id || e.pointerType === "touch") return;
      live.current.point = { x: e.clientX, y: e.clientY };
    };
    const moveTouch = (e: TouchEvent) => {
      if (!live.current.id) return;
      const t = e.touches[0];
      if (t) live.current.point = { x: t.clientX, y: t.clientY };
    };
    const up = () => {
      if (live.current.id) endPress(performance.now());
    };
    // マウスやペンでは、取り消しをそのまま終了として扱ってよい。
    // 触る端末の pointercancel は**スクロールが始まっただけ**で飛ぶので無視する
    const cancelPointer = (e: PointerEvent) => {
      if (e.pointerType !== "touch") up();
    };

    window.addEventListener("pointermove", movePointer, { passive: true });
    window.addEventListener("pointerup", up, { passive: true });
    window.addEventListener("pointercancel", cancelPointer, { passive: true });
    window.addEventListener("touchmove", moveTouch, { passive: true });
    window.addEventListener("touchend", up, { passive: true });
    window.addEventListener("touchcancel", up, { passive: true });

    return () => {
      window.removeEventListener("pointermove", movePointer);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancelPointer);
      window.removeEventListener("touchmove", moveTouch);
      window.removeEventListener("touchend", up);
      window.removeEventListener("touchcancel", up);
    };
  }, [endPress]);

  // いいねが成立した直後の click（＝カードを開く操作）を飲み込む
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  /* --- 並べる ----------------------------------------------------------- */
  // ここから下に useMemo を書かない。**React Compiler が自動で覚える。**
  // 手で useMemo を足すと、compiler が「手の memo を保てない」と言って
  // この部品ぜんたいの最適化をやめてしまう（実測: lint が
  // preserve-manual-memoization で落ちた）
  const cards: FeedCard[] = showSamples
    ? samples.map((s) => ({ kind: "sample" as const, sample: s }))
    : works.map((w) => ({ kind: "work" as const, work: w }));

  // 列の数は**画面の幅そのもの**から決める（Pinterest を実測した式。
  // features/feed/layout.ts）。余白を引いた幅からではない
  const gap = gapFor(width);
  const edge = edgeFor(width);
  const columns = columnsFor(width);
  const colWidth = columnWidthFor(width, columns, gap, edge);

  const ratios = cards.map((c) =>
    c.kind === "work"
      ? displayRatio(c.work.image_width, c.work.image_height)
      : displayRatio(c.sample.width, c.sample.height),
  );

  const laid = distribute(ratios, columns);

  return (
    <>
      <div
        ref={containerRef}
        data-feed-grid
        data-feed-columns={columns}
        data-feed-measured={measured ? "1" : "0"}
        data-feed-count={cards.length}
        data-feed-press-ms={LIKE_PRESS_MS}
        className="flex w-full items-start"
        style={{ gap: `${gap}px`, paddingLeft: `${edge}px`, paddingRight: `${edge}px` }}
      >
        {laid.columns.map((indexes, c) => (
          <div key={c} className="flex min-w-0 flex-1 flex-col" style={{ gap: `${gap}px` }}>
            {indexes.map((i) => {
              const card = cards[i];
              if (card.kind === "sample") {
                return <SampleCardView key={card.sample.id} sample={card.sample} />;
              }
              const w = card.work;
              return (
                <div
                  key={w.id}
                  // 画面の外に出ているあいだ、中身の組み立てをブラウザに省かせる。
                  // 省いても場所は取り続けるので、スクロールの棒は動かない
                  style={{
                    contentVisibility: "auto",
                    containIntrinsicSize: `${Math.round(colWidth)}px ${Math.round(colWidth * ratios[i])}px`,
                  }}
                >
                  <WorkCardView
                    work={w}
                    state={cardState[w.id] ?? { liked: w.liked_by_me, saved: w.saved_by_me }}
                    onPressStart={onPressStart}
                    onLeave={onLeave}
                    onSave={doSave}
                    onUninterest={doUninterest}
                    onShare={doShare}
                  />
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* 読み足しの目印。ここが画面に入ると続きを取りに行く */}
      {!showSamples ? (
        <div data-feed-sentinel ref={sentinel} className="h-px w-full" aria-hidden />
      ) : null}

      {loading ? (
        <p data-feed-loading className="py-6 text-center text-xs text-faint">
          読み込んでいます…
        </p>
      ) : null}

      {done && !showSamples && works.length > 0 ? (
        <p data-feed-end className="py-6 text-center text-xs text-faint">
          ここまでです。
        </p>
      ) : null}

      <Toast text={toast} />
    </>
  );
}
