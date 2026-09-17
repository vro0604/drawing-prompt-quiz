"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * ヘッダーを静的に配るため、未確認の有無だけを描画後に読み込む。
 *
 * 【見た目と場所は呼ぶ側が決める（2026-09-18）】
 *   狭い画面ではヘッダーのメニューの中に、広い画面では横並びの中に置く。
 *   同じ部品が2通りの場所に出るので、**位置と大きさの指定は className で
 *   受け取る。**ここが持つのは「未確認があるかどうかで太さと濃さが変わる」
 *   ことだけで、読み込み方（D192）は1文字も変えていない。
 *   onNavigate は、押したときに呼ぶ側が閉じるためのもの。
 */
export function NoticeEntry({
  className = "",
  onNavigate,
}: {
  className?: string;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const [hasUnseen, setHasUnseen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const latestRequest = useRef(0);

  useEffect(() => {
    let active = true;

    const load = async () => {
      const requestId = ++latestRequest.current;
      const isCurrent = () => active && latestRequest.current === requestId;
      try {
        const res = await fetch("/api/notices/unseen", {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (!res.ok) {
          if (isCurrent()) setHasUnseen(false);
          return;
        }
        const data = (await res.json()) as { hasUnseen?: boolean };
        if (isCurrent()) setHasUnseen(data.hasUnseen === true);
      } catch {
        if (isCurrent()) setHasUnseen(false);
      } finally {
        if (isCurrent()) setLoaded(true);
      }
    };

    const refresh = () => void load();
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const authChannel = typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel("dpq-auth");
    if (authChannel) authChannel.onmessage = refresh;

    refresh();
    window.addEventListener("pageshow", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      active = false;
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
      authChannel?.close();
    };
  }, [pathname]);

  return (
    <Link
      href="/notices"
      data-testid="notice-entry"
      data-unseen={hasUnseen ? "yes" : "no"}
      data-loaded={loaded ? "true" : "false"}
      aria-label={
        hasUnseen ? "知らせ。未確認の回答があります" : "知らせ。未確認の回答はありません"
      }
      onClick={onNavigate}
      className={`${className} ${hasUnseen ? "font-bold text-ink" : "text-muted"}`}
    >
      知らせ
    </Link>
  );
}
