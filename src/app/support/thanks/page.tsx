import Link from "next/link";
import { fetchSupportPaymentStatus } from "@/features/billing/support-rpc";
import { btnPrimary, btnSecondary, surface } from "@/app/_surface";
import { PaymentRefresh } from "./_refresh";

export const metadata = { title: "応援のお支払い" };
export const dynamic = "force-dynamic";

export default async function SupportThanksPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>;
}) {
  const { session_id: sessionId } = await searchParams;
  let status: string | null = null;
  if (typeof sessionId === "string" && /^cs_[A-Za-z0-9_]{1,240}$/.test(sessionId)) {
    status = await fetchSupportPaymentStatus(sessionId).catch(() => null);
  }

  const paid = status === "paid";
  const pending = status === "pending";

  return (
    <main className="mx-auto w-full max-w-2xl space-y-8 p-6 sm:p-10">
      <div className={`${surface} space-y-5`}>
        <h1 className="text-2xl font-bold">
          {paid ? "応援ありがとうございます。" : "お支払いの確認"}
        </h1>
        {paid ? (
          <p className="text-sm leading-relaxed">
            いただいた支援は、つたわるかなの開発・運営に使います。
          </p>
        ) : pending ? (
          <PaymentRefresh />
        ) : (
          <p className="text-sm text-muted">
            この画面ではお支払いの成立を確認できませんでした。決済が完了したかどうかは、
            Stripe からのメールやカードの明細をご確認ください。
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <Link href="/" className={`${btnPrimary} inline-flex min-h-11 items-center`}>
            サービスへ戻る
          </Link>
          <Link href="/works" className={`${btnSecondary} inline-flex min-h-11 items-center`}>
            作品を見る
          </Link>
        </div>
      </div>
    </main>
  );
}
