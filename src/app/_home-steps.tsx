"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ActiveChallenge } from "@/features/challenge/types";

/**
 * トップの主役「引く → 描く → 答える」。**3つとも押せる行き先。**
 *
 * 【形の出どころ（2026-09-18 の参照調査。docs/home-first-use.md）】
 *   ・Kahoot! の上部の行き先（発見・習得・まっすぐ…）… 絵記号の入った四角の下に短い語を置き、
 *     スマホでも横一列のまま並べる。**説明の図ではなく、そのまま押す場所**になっている形
 *   ・Drawception の「Draw / Describe / Laugh」… 手順の名前を動詞1語にし、
 *     その手順で触る物（キャンバス）を絵で見せる
 *   ここでは、四角の中の絵記号を「その手順で手に取る物」（お題札・紙とペン・4つの選択肢）にし、
 *   手順のあいだに矢印を置いて、3つが1本の流れだと分かるようにする。
 *
 * 【「描く」だけ行き先が人によって変わる】
 *   描くには確定したお題が要る。確定したお題（制作挑戦）を持っている人は、
 *   そのお題のページが描く場所なので、そこへ直接つなぐ。
 *   持っていない人は、まずお題を引く必要があるので /play へつなぐ（「引く」と同じ行き先）。
 *
 *   持っているかどうかは、全ページの時計の帯と同じ /api/challenge から読む。
 *   **ページ側でサインイン状態を読まない。**読むとトップが静的に配れなくなる
 *   （api/challenge/route.ts の冒頭）。最初の表示は「持っていない人」の形で出し、
 *   読めたら行き先と一言だけを差し替える。読めなかったときは最初の形のまま。
 *
 *   ドラフトの途中（カードをめくっている最中）の人は、/play を開けば盤面が出る
 *   （play/page.tsx）ので、「引く」も「描く」も /play のままでよい。
 *
 * 【ユーザーを作らない】
 *   /api/challenge は、サインインしていない人には null を返すだけで、匿名の利用者を発行しない
 *   （features/challenge/rpc.ts）。開いただけの人が増えない。
 */

type Step = {
  key: "draw-prompt" | "draw" | "answer";
  href: string;
  label: string;
  caption: string;
  icon: React.ReactNode;
};

/** 引く: お題札（伏せたカードの上に、表の1枚） */
function CardIcon() {
  return (
    <svg viewBox="0 0 32 32" className="size-8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="7" width="15" height="20" rx="2.5" transform="rotate(-10 11.5 17)" />
      <rect x="13" y="5" width="15" height="20" rx="2.5" fill="var(--background)" />
      <path d="M17 11h7M17 15h5" strokeLinecap="round" />
    </svg>
  );
}

/** 描く: 紙とペン、紙の上の線 */
function DrawIcon() {
  return (
    <svg viewBox="0 0 32 32" className="size-8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="6" width="18" height="21" rx="2.5" />
      <path d="M8 20c2-4 4-4 5-1s3 2 5-2" />
      <path d="M26.5 5.5l2 2L19 17l-3 1 1-3z" fill="var(--background)" />
    </svg>
  );
}

/** 答える: 4つの選択肢。1つに印 */
function ChoiceIcon() {
  return (
    <svg viewBox="0 0 32 32" className="size-8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="4" width="11" height="11" rx="2.5" />
      <rect x="17" y="4" width="11" height="11" rx="2.5" />
      <rect x="4" y="17" width="11" height="11" rx="2.5" />
      <rect x="17" y="17" width="11" height="11" rx="2.5" />
      <path d="M20 22.5l2 2 3.5-4" />
    </svg>
  );
}

function Arrow() {
  return (
    <svg viewBox="0 0 12 12" className="size-3 text-faint" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 2l4 4-4 4" />
    </svg>
  );
}

/** 挑戦がまだ続いていて、描く場所として開けるか */
function isDrawable(c: ActiveChallenge | null): c is ActiveChallenge {
  return c !== null && !c.is_finished && !c.is_discarded;
}

export function HomeSteps() {
  const [challenge, setChallenge] = useState<ActiveChallenge | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/challenge", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { "x-requested-with": "home-steps" },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { challenge: ActiveChallenge | null; error?: string } | null) => {
        if (alive && body && !body.error) setChallenge(body.challenge);
      })
      .catch(() => {
        /* 読めなければ最初の形のまま。トップを壊さない */
      });
    return () => {
      alive = false;
    };
  }, []);

  const drawable = isDrawable(challenge);

  const steps: Step[] = [
    { key: "draw-prompt", href: "/play", label: "引く", caption: "お題カード", icon: <CardIcon /> },
    drawable
      ? { key: "draw", href: challenge.href, label: "描く", caption: "描きかけへ", icon: <DrawIcon /> }
      : { key: "draw", href: "/play", label: "描く", caption: "絵を描く", icon: <DrawIcon /> },
    { key: "answer", href: "/works", label: "答える", caption: "絵から当てる", icon: <ChoiceIcon /> },
  ];

  return (
    <nav aria-label="遊びかたの3つの手順">
      <ol className="grid grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-1 sm:gap-3">
        {steps.map((s, i) => (
          <li key={s.key} className="contents">
            {i > 0 ? (
              <span className="flex justify-center" aria-hidden="true">
                <Arrow />
              </span>
            ) : null}
            <Link
              href={s.href}
              data-home-step={s.key}
              data-home-step-state={s.key === "draw" ? (drawable ? "challenge" : "none") : undefined}
              className="flex h-full min-h-11 flex-col items-center gap-2 rounded-2xl border border-line-firm px-1 py-4 text-center transition hover:bg-hover active:scale-[0.98] sm:px-3 sm:py-5"
            >
              <span className="flex size-14 items-center justify-center rounded-2xl bg-sunken-strong sm:size-16">
                {s.icon}
              </span>
              <span className="text-base font-bold leading-none sm:text-lg">
                <span className="sr-only">{i + 1}. </span>
                {s.label}
              </span>
              <span className="text-[11px] leading-4 text-muted sm:text-xs">{s.caption}</span>
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}
