"use client";

import { useCallback, useEffect, useState } from "react";
import {
  isInterrupting,
  unacknowledged,
  type AppNotification,
} from "@/features/notify/types";

/**
 * 全ページの上に出る「未確認の知らせ」。
 *
 * 【なぜプッシュだけに頼らないか】
 *   ブラウザのプッシュは、許可していない人・許可を取り消した人・
 *   端末を変えた人には届かない。届かなくても
 *   **「制作途中のお題を自動的に破棄しました」は必ず伝える必要がある。**
 *   出来事は DB（notification_events）に残してあるので、
 *   次にサイトへ来たときにここが読んで出す。
 *
 * 【本体が消えていても出る】
 *   自動破棄の記録は、作りかけの行に外部キーを張っていない。
 *   掃除が実体を消したあとでも、この帯は出る。
 *   「作りかけが無いから何も表示しない」にはしない。
 *
 * 【一度確認したら繰り返さない】
 *   「確認しました」を押すと、その知らせに確認の時刻が入る。
 *   以後は履歴に残るだけで、前へは出てこない。
 *
 * 【延長の成功はここに割り込ませない】
 *   押したその場で帯が結果を出しているので、二重に出さない。
 *   履歴には残る（isInterrupting が false）。
 *
 * 【挑戦の帯との位置関係】
 *   挑戦の帯は position: fixed で画面のいちばん上に貼り付く。
 *   ここは本文の流れの中に置く（fixed にしない）。
 *   両方を貼り付けると、狭い画面で本文がほとんど見えなくなる。
 */

export function Notices() {
  const [list, setList] = useState<AppNotification[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      // 知らせが読めないことで画面を壊さない。次の機会に読み直す
    }
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const onShow = () => void load();

    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("pageshow", onShow);

    return () => {
      window.clearTimeout(first);
      document.removeEventListener("visibilitychange", onShow);
      window.removeEventListener("pageshow", onShow);
    };
  }, [load]);

  const acknowledge = useCallback(async (id: number) => {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch("/api/notifications", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const body = (await res.json()) as {
        notifications?: AppNotification[];
        error?: string;
      };

      if (!res.ok || body.error) {
        // **確認できたことにしない。**次に来たときにまた出す
        setError(body.error ?? "確認を記録できませんでした。");
        return;
      }
      setList(body.notifications ?? []);
    } catch {
      setError("通信できませんでした。確認は記録されていません。");
    } finally {
      setBusy(null);
    }
  }, []);

  const shown = unacknowledged(list).filter(isInterrupting);
  if (shown.length === 0) return null;

  return (
    <div data-notices="" className="mx-auto w-full max-w-5xl px-4 pt-3 sm:px-10">
      <ul className="space-y-2">
        {shown.map((n) => (
          <li
            key={n.id}
            data-notice={n.kind}
            data-notice-id={n.id}
            className={`rounded-2xl border px-4 py-3 text-sm ${
              n.kind === "inactivity_discard"
                ? "border-danger-tint bg-danger-tint/10"
                : "border-notice-tint bg-notice-tint/10"
            }`}
          >
            <p className="font-bold" data-field="title">
              {n.title}
            </p>
            <p className="mt-1 text-xs" data-field="body">
              {n.body}
            </p>

            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
              <button
                type="button"
                onClick={() => void acknowledge(n.id)}
                disabled={busy === n.id}
                data-action="acknowledge"
                className="inline-flex min-h-11 items-center rounded-full border border-line-active px-4 font-bold hover:bg-hover disabled:opacity-60"
              >
                {busy === n.id ? "記録しています…" : "確認しました"}
              </button>

              {n.payload?.url && n.kind !== "inactivity_discard" ? (
                <a href={n.payload.url} data-action="open" className="underline">
                  制作へ戻る
                </a>
              ) : null}
            </div>

            {error && busy === null ? (
              <p className="mt-2 text-xs text-danger" data-field="error">
                {error}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
