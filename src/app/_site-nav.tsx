"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { NoticeEntry } from "@/app/_notice-entry";

/**
 * ヘッダーの行き先そのもの。**狭い画面ではメニューの中へ畳む。**
 *
 * 【なぜ畳むか】
 *   行き先が5つ（お題を引く・作品・ランキング・知らせ・アカウント）あり、
 *   横に並べると**幅 536px より狭い画面で折り返す。**
 *   実測（2026-09-18・この端末のブラウザ試験と同じ Chromium）:
 *     320px と 375px で3段・ヘッダーの高さ 157px、
 *     390px と 430px で2段・109px、536px 以上で1段・61px。
 *   スマホでいちばん上の 96px ぶんが移動手段だけで埋まっていた。
 *   D207 でトップの最初の画面を作り直したので、**そこを取り返す。**
 *
 * 【畳み方】
 *   行き先は1組しか書かない。同じ `<nav>` を、
 *     ・狭いとき … 閉じていれば出さない。開いたらヘッダーの直下に、
 *                  画面の端まで広がる縦並びの板として出す
 *     ・広いとき … これまでどおりヘッダーの中の横並び
 *   として使う。**2組書いて片方を隠す作りにしない。**
 *   同じ文言のリンクが画面の外に重複すると、読み上げにも試験にも二重に見える。
 *
 *   端まで広げるのに負の余白（-mx-6）を使っている。包む箱に左右 24px の
 *   余白があるためで、`grow` と組み合わせると板だけがその外側へ届く。
 *
 * 【切り替える幅】
 *   `sm`（640px）。**このリポジトリが既に使っている区切りで、新しく増やさない。**
 *   折り返しが起きるのは 536px より狭いときなので、640px で畳めば
 *   折り返す幅は全部カバーできる（上の実測）。
 *
 * 【知らせ（D192）は作りを変えていない】
 *   未確認があるかどうかは NoticeEntry がブラウザから真偽値だけを聞く。
 *   読み込み方も、数字を出さないことも、そのまま。
 *   メニューの中でも、未確認があれば太字になる。
 *   **その代わり、狭い画面ではメニューを開くまで太字が見えない。**
 *   ボタンの側に印を付ければ見えるが、それは D112（数字も丸も出さない）を
 *   緩める話になるので、今回は付けていない。
 *
 * 【開け閉て】
 *   同じボタンで開いて閉じる。行き先を押す・Escape を押す・
 *   メニューの外を押す・別のページへ移る、のどれでも閉じる。
 *   読み上げには aria-expanded（開いているか）と aria-controls
 *   （どれが開くか）で伝える。
 *
 * 【参照した実在の画面】（2026-09-18 に 390px 幅で開いて実測）
 *   ・Stripe https://stripe.com/jp … 閉じているときヘッダーに置くのは
 *     ロゴとボタン1個だけ。ボタンは aria-expanded を持ち、開くと×に変わる。
 *     行き先は縦に積み、間に細い線を引く。
 *   ・Notion https://www.notion.com/ja … 44×44 のボタンを右端（余白 16px）に置く。
 *   ・Tailwind CSS https://tailwindcss.com/ … 開いた板の1行は 52px、左揃え。
 *   どれも**全画面を覆う**作りだが、ここでは覆わない（行き先が5つしかなく、
 *   いま居るページを見失わせる必要が無い）。
 */

/** ヘッダーの行き先。ゲストで使えるものから並べる（並びは変えない） */
const NAV = [
  { href: "/play", label: "お題を引く" },
  { href: "/works", label: "作品" },
  { href: "/rankings", label: "ランキング" },
];

/**
 * 行き先1つぶんの形。
 * 狭いとき: 高さ 48px の行。広いとき: これまでどおりの小さな文字のリンク。
 */
const ITEM =
  "flex min-h-12 items-center text-base hover:underline sm:min-h-11 sm:text-sm";

export function SiteNav() {
  const panelId = useId();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const navRef = useRef<HTMLElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => setOpen(false), []);

  /*
   * ページが変わったら閉じる。**開いたまま次の画面へ持ち越さない。**
   * 戻る・進むで移ったときも通る。
   *
   * 効果（useEffect）ではなく描画の途中で直している。React の
   * 「前の値と比べて状態を合わせる」書き方で、こちらは画面が1回で落ち着く。
   * 効果でやると、開いたままの姿を一度描いてから閉じることになる
   * （eslint の react-hooks/set-state-in-effect もそれを止める）。
   */
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setOpen(false);
  }

  // Escape で閉じ、押していたボタンへ戻る。外側を押しても閉じる。
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node)) return;
      const inside =
        navRef.current?.contains(e.target) || buttonRef.current?.contains(e.target);
      if (!inside) setOpen(false);
    };

    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <>
      {/* 開け閉てのボタン。**広い画面では出さない**（そこでは畳んでいない） */}
      <button
        ref={buttonRef}
        type="button"
        data-testid="menu-button"
        data-site-menu={open ? "open" : "closed"}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? "メニューを閉じる" : "メニューを開く"}
        onClick={() => setOpen((v) => !v)}
        className="ml-auto inline-flex size-11 items-center justify-center rounded-xl border border-line-firm hover:bg-hover sm:hidden"
      >
        <MenuIcon open={open} />
      </button>

      <nav
        ref={navRef}
        id={panelId}
        aria-label="サイト内の移動"
        data-site-menu-panel={open ? "open" : "closed"}
        className={`${open ? "flex" : "hidden"} -mx-6 grow basis-full flex-col divide-y divide-line-faint border-t border-line bg-background px-6 sm:mx-0 sm:flex sm:basis-auto sm:flex-row sm:items-center sm:gap-x-5 sm:divide-y-0 sm:border-t-0 sm:bg-transparent sm:px-0`}
      >
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} onClick={close} className={ITEM}>
            {n.label}
          </Link>
        ))}

        {/*
          知らせ（D192）。行き先は常に同じで、**出ているかどうかは変わらない。**
          変わるのは太さだけ。丸も数字も付けない。
          広い画面では、これまでどおり右端へ寄せる。
        */}
        <NoticeEntry onNavigate={close} className={`${ITEM} sm:ml-auto`} />

        {/* アカウントは右端へ。ゲストのままでも押せるが、主動線ではない */}
        <Link
          href="/account"
          onClick={close}
          className={`${ITEM} text-muted sm:ml-1`}
        >
          アカウント
        </Link>
      </nav>
    </>
  );
}

/**
 * メニューの絵。閉じているとき三本線、開いているとき×。
 * **飾りの記号を新しく増やさない。**線だけで描く（globals.css の色をそのまま継ぐ）。
 */
function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      {open ? (
        <>
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </>
      ) : (
        <>
          <line x1="4" y1="7" x2="20" y2="7" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="17" x2="20" y2="17" />
        </>
      )}
    </svg>
  );
}
