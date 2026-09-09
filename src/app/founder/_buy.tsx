"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { btnPrimary, noticeError } from "@/app/_surface";

/** 回っている印。_pending.tsx の同じものと同じ見た目（あちらは外へ出ていない） */
function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent align-[-2px]"
    />
  );
}

/**
 * 購入ボタンと、「決済を確認しています」の待ち表示。
 *
 * 【なぜここだけブラウザ側の部品か】
 *   ・購入は**別のサイト（Stripe）へ移る**ので、フォームの送信では扱えない。
 *     受け口が返した URL へ、こちらで移動する必要がある。
 *   ・払い終えて戻ってきた直後は、まだ知らせが届いていないことがある。
 *     そのあいだ、こちらから定期的に画面を読み直す。
 *
 * 【送るものが1つも無い】
 *   購入の要求に本文を付けない。金額も商品も人も、受け口の側で決める。
 *   **ブラウザから送れる値が無ければ、書き換えられる値も無い。**
 */

export function BuyButton({ label }: { label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const body = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };

      if (!res.ok || !body.url) {
        setError(body.error ?? "決済ページを開けませんでした。もう一度お試しください。");
        setBusy(false);
        return;
      }

      // Stripe の決済ページへ移る。**ここから先は Stripe の画面**
      window.location.href = body.url;
    } catch {
      setError("通信できませんでした。電波の状況を確かめて、もう一度お試しください。");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {error ? <p className={noticeError}>{error}</p> : null}
      <button
        type="button"
        onClick={go}
        disabled={busy}
        className={`${btnPrimary} w-full disabled:opacity-60`}
      >
        {busy ? (
          <span className="inline-flex items-center gap-2">
            <Spinner />
            決済ページへ移動しています…
          </span>
        ) : (
          label
        )}
      </button>
    </div>
  );
}

/**
 * 払い終えて戻ってきたが、まだ知らせが届いていないときの表示。
 *
 * 【なぜ待つのが正常なのか】
 *   Founder 権を付けるのは Stripe からの知らせだけで、
 *   ブラウザが戻ってきたことは根拠にならない。
 *   知らせは数秒で届くが、遅れることもある。
 *   **「まだ反映されていない」は失敗ではない。**
 *
 * 【いつまでも回さない】
 *   4秒ごとに読み直し、2分で止める。止まったあとは、
 *   利用者が自分で読み直せる案内を出す。
 */
export function ConfirmingNotice() {
  const router = useRouter();
  const [gaveUp, setGaveUp] = useState(false);
  const tries = useRef(0);

  useEffect(() => {
    const timer = setInterval(() => {
      tries.current += 1;
      if (tries.current > 30) {
        setGaveUp(true);
        clearInterval(timer);
        return;
      }
      router.refresh();
    }, 4000);

    return () => clearInterval(timer);
  }, [router]);

  if (gaveUp) {
    return (
      <p className="text-sm">
        お支払いの確認に時間がかかっています。
        お金は正しく処理されていますので、しばらくしてからこの画面を開き直してください。
        1時間たっても変わらない場合は、下の問い合わせ先までご連絡ください。
      </p>
    );
  }

  return (
    <p className="inline-flex items-center gap-2 text-sm">
      <Spinner />
      決済を確認しています。この画面を開いたままお待ちください。
    </p>
  );
}
