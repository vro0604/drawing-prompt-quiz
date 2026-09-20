"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/** Stripe の帰還より Webhook が遅れたときだけ、短い間読み直す。 */
export function PaymentRefresh() {
  const router = useRouter();
  const [waited, setWaited] = useState(false);

  useEffect(() => {
    let count = 0;
    const timer = setInterval(() => {
      count += 1;
      if (count > 30) {
        setWaited(true);
        clearInterval(timer);
      } else {
        router.refresh();
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [router]);

  return waited ? (
    <p className="text-sm text-muted">確認に時間がかかっています。しばらくしてからこの画面を読み込み直してください。</p>
  ) : (
    <p className="text-sm text-muted">Stripe からのお支払い結果を確認しています…</p>
  );
}
