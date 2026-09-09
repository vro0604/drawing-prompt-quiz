"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 「制作時間やお題の期限を通知しますか？」の案内。
 *
 * 【いきなり許可を求めない】
 *   サイトを開いた直後にブラウザの許可の窓を出すと、
 *   何の通知か分からないまま断られる。断られると**取り消すのが難しい**
 *   （利用者がブラウザの設定を開いて戻す必要がある）。
 *   そこで順番を、
 *     こちらの説明 → 利用者がボタンを押す → ブラウザの許可の窓
 *   にする。押されるまでブラウザには一切触らない。
 *
 * 【出す場所】
 *   制作を始めた場面（お題のページ・ドラフトのページ）だけ。
 *   通知の理由がその場で分かるところに置く。
 *
 * 【断られても制作はできる】
 *   通知は補助で、無くても制作・投稿・延長はすべて動く。
 *   断られたらこの案内は消える。しつこく出し直さない。
 *
 * 【出さない場合】
 *   ・ブラウザがプッシュに対応していない（iOS の一部など）
 *   ・すでに許可済み、またはすでに断られている
 *   ・サイトの公開鍵（VAPID）が設定されていない
 */

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

/** base64url の文字列を、ブラウザが求めるバイト列へ直す */
function toBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** ArrayBuffer を base64url の文字列にする（サーバーへ渡す形） */
function toBase64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) return "";
  const bytes = new Uint8Array(buffer);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type State = "hidden" | "ask" | "working" | "done" | "denied" | "error";

export function PushOptIn() {
  const [state, setState] = useState<State>("hidden");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (VAPID_PUBLIC_KEY === "") return;
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (!("PushManager" in window)) return;
    if (typeof Notification === "undefined") return;

    // すでに答えが出ている人には出さない
    if (Notification.permission !== "default") return;

    // effect の本体から直接 setState を呼ばない（描画が連鎖する）。
    // ChallengeBar と同じく、いったんタイマーへ逃がす
    const id = window.setTimeout(() => setState("ask"), 0);
    return () => window.clearTimeout(id);
  }, []);

  const enable = useCallback(async () => {
    setState("working");
    setError(null);

    try {
      // **ここで初めてブラウザの許可の窓が開く。**押した直後にしか呼ばない
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState("denied");
        return;
      }

      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: toBytes(VAPID_PUBLIC_KEY),
      });

      const json = subscription.toJSON() as {
        endpoint?: string;
        keys?: { p256dh?: string; auth?: string };
      };

      const res = await fetch("/api/push", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          endpoint: json.endpoint ?? subscription.endpoint,
          p256dh: json.keys?.p256dh ?? toBase64Url(subscription.getKey("p256dh")),
          auth: json.keys?.auth ?? toBase64Url(subscription.getKey("auth")),
        }),
      });

      const body = (await res.json()) as { saved?: boolean; error?: string };

      if (!res.ok || body.error) {
        // **登録できたことにしない。**理由を出す
        setError(body.error ?? "通知の宛先を保存できませんでした。");
        setState("error");
        return;
      }

      setState("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }, []);

  if (state === "hidden") return null;

  return (
    <section
      data-push-optin={state}
      className="rounded-2xl border border-line bg-sunken px-4 py-3 text-sm"
    >
      {state === "done" ? (
        <p data-field="done">
          通知を受け取れるようになりました。制作予定時間の超過と、
          制作途中のお題の破棄の予告をお知らせします。
        </p>
      ) : state === "denied" ? (
        <p data-field="denied" className="text-faint">
          通知は受け取らない設定になりました。制作・投稿・延長はこれまでどおり使えます。
        </p>
      ) : (
        <div className="space-y-2">
          <p className="font-bold">制作時間やお題の期限を通知しますか？</p>
          <p className="text-xs text-faint">
            お知らせするのは3つだけです。制作予定時間を超過したとき、
            制作途中のお題が1日間操作されていないとき、
            2日間の放置で自動的に破棄したとき。
            通知にお題の語や答えは入りません。あとから止められます。
          </p>
          <button
            type="button"
            onClick={() => void enable()}
            disabled={state === "working"}
            data-action="enable-push"
            className="inline-flex min-h-11 items-center rounded-full border border-line-active px-4 text-xs font-bold hover:bg-hover disabled:opacity-60"
          >
            {state === "working" ? "設定しています…" : "通知を受け取る"}
          </button>

          {error ? (
            <p className="text-xs text-danger" data-field="error">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
