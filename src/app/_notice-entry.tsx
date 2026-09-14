"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/** ヘッダーを静的に配るため、未確認の有無だけを描画後に読み込む。 */
export function NoticeEntry() {
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
      className={`ml-auto inline-flex min-h-11 items-center text-sm hover:underline ${
        hasUnseen ? "font-bold text-ink" : "text-muted"
      }`}
    >
      知らせ
    </Link>
  );
}
