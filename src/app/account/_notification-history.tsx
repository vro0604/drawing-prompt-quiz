"use client";

import { useCallback, useEffect, useState } from "react";
import type { AppNotification } from "@/features/notify/types";

/**
 * サイト内の知らせの履歴と、この端末への通知の止め方。
 *
 * 【なぜ履歴が要るか】
 *   本文の上に出る帯（_notices.tsx）は、**未確認のものだけ**を出す。
 *   「確認しました」を押すと消える。あとから「そういえば何と書いてあったか」を
 *   読み返す場所が無いと、消した瞬間に内容が失われる。
 *   ここは確認済みも含めて、最近の20件をそのまま並べる。
 *
 * 【この端末への通知を止める】
 *   ブラウザの許可を取り消すには、利用者がブラウザの設定を開く必要がある。
 *   こちら側でできるのは「宛先を消して、以後そこへ送らない」ところまで。
 *   **できることとできないことを、そのまま書く。**
 */

const KIND_LABEL: Record<string, string> = {
  deadline_overrun: "制作予定時間の超過",
  inactivity_warning: "放置の予告",
  inactivity_discard: "自動破棄",
  deadline_extended: "制作時間の延長",
};

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function NotificationHistory() {
  const [list, setList] = useState<AppNotification[] | null>(null);
  const [pushState, setPushState] = useState<"unknown" | "on" | "off" | "working">("unknown");
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!res.ok) return;
      const body = (await res.json()) as { notifications?: AppNotification[] };
      setList(body.notifications ?? []);
    } catch {
      setList([]);
    }
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(id);
  }, [load]);

  // この端末が通知の宛先になっているかを見る
  useEffect(() => {
    let alive = true;
    const check = async () => {
      if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
        if (alive) setPushState("off");
        return;
      }
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = await reg?.pushManager.getSubscription();
        if (alive) setPushState(sub ? "on" : "off");
      } catch {
        if (alive) setPushState("off");
      }
    };
    const id = window.setTimeout(() => void check(), 0);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
  }, []);

  const stopPush = useCallback(async () => {
    setPushState("working");
    setMessage(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (!sub) {
        setPushState("off");
        return;
      }

      const endpoint = sub.endpoint;
      await sub.unsubscribe();

      const res = await fetch("/api/push", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint }),
      });
      const body = (await res.json()) as { deleted?: number; error?: string };

      if (!res.ok || body.error) {
        // **止められたことにしない。**ブラウザ側は外れているので、その差を書く
        setMessage(
          `このブラウザでは受け取らなくなりましたが、送り先の記録を消せませんでした（${body.error ?? res.status}）。`,
        );
      } else {
        setMessage("この端末への通知を止めました。");
      }
      setPushState("off");
    } catch (e) {
      setMessage(`止められませんでした: ${e instanceof Error ? e.message : String(e)}`);
      setPushState("on");
    }
  }, []);

  return (
    <div className="space-y-4" data-notification-history="">
      <div className="space-y-2">
        <h3 className="text-xs font-bold text-faint">ブラウザの通知</h3>
        {pushState === "on" ? (
          <div className="space-y-2">
            <p className="text-sm">この端末は通知を受け取る設定になっています。</p>
            <button
              type="button"
              onClick={() => void stopPush()}
              data-action="stop-push"
              className="inline-flex min-h-11 items-center rounded-full border border-line-active px-4 text-xs font-bold hover:bg-hover"
            >
              この端末への通知を止める
            </button>
          </div>
        ) : pushState === "working" ? (
          <p className="text-sm text-faint">止めています…</p>
        ) : (
          <p className="text-sm text-faint">
            この端末は通知を受け取りません。受け取るには、お題を引いたあとの制作の画面に
            出る案内から設定します。
          </p>
        )}
        {message ? (
          <p className="text-xs text-faint" data-field="push-message">
            {message}
          </p>
        ) : null}
        <p className="text-xs text-faint">
          ここで止められるのは「この端末へ送らないこと」までです。
          ブラウザ自体の許可を取り消すには、ブラウザの設定から行ってください。
        </p>
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-bold text-faint">最近の知らせ</h3>
        {list === null ? (
          <p className="text-sm text-faint">読み込んでいます…</p>
        ) : list.length === 0 ? (
          <p className="text-sm text-faint">まだ知らせはありません。</p>
        ) : (
          <ul className="space-y-2">
            {list.map((n) => (
              <li
                key={n.id}
                data-history-item={n.kind}
                className="rounded-xl border border-line px-3 py-2 text-sm"
              >
                <p className="text-xs text-faint">
                  {when(n.created_at)}・{KIND_LABEL[n.kind] ?? n.kind}
                  {n.acknowledged_at ? "・確認済み" : ""}
                </p>
                <p className="font-bold">{n.title}</p>
                <p className="text-xs">{n.body}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
