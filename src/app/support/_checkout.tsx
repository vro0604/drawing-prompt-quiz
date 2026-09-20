"use client";

import { useState } from "react";
import { btnPrimary, field, noticeError } from "@/app/_surface";
import { parseSupportAmount, SUPPORT_DEFAULT_YEN, SUPPORT_MAX_YEN, SUPPORT_MIN_YEN } from "@/features/billing/support";
import type { SupportSource } from "@/features/billing/support";

export function SupportCheckout({ source, available }: { source: SupportSource; available: boolean }) {
  const [amount, setAmount] = useState(String(SUPPORT_DEFAULT_YEN));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function checkout() {
    setError(null);
    const parsed = parseSupportAmount(amount);
    if (parsed === null) {
      setError("500円から100,000円まで、1円単位の金額を入力してください。");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/billing/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: parsed, source }),
      });
      const result = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!response.ok || !result.url) {
        setError(result.error ?? "決済ページを開けませんでした。");
        setBusy(false);
        return;
      }
      window.location.href = result.url;
    } catch {
      setError("通信できませんでした。少し時間をおいてからお試しください。");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <label className="block space-y-2" htmlFor="support-amount">
        <span className="text-sm font-bold">応援する金額</span>
        <span className="flex items-center gap-2">
          <input
            id="support-amount"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            pattern="[0-9]*"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            disabled={!available || busy}
            className={`${field} max-w-40`}
            aria-describedby="support-amount-help"
          />
          <span className="text-sm">円</span>
        </span>
      </label>
      <p id="support-amount-help" className="text-xs text-faint">
        {SUPPORT_MIN_YEN.toLocaleString("ja-JP")}〜{SUPPORT_MAX_YEN.toLocaleString("ja-JP")}円・一回払い。ログインは不要です。
      </p>
      {error ? <p role="alert" className={noticeError}>{error}</p> : null}
      <button
        type="button"
        onClick={checkout}
        disabled={!available || busy}
        className={`${btnPrimary} w-full disabled:opacity-60`}
      >
        {busy ? "決済ページへ移動しています…" : "自由な金額で応援する"}
      </button>
      {!available ? <p className="text-sm text-faint">ただいま支援のお支払いを準備中です。</p> : null}
    </div>
  );
}
