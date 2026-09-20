import Link from "next/link";
import { fetchFounderOfferStatus } from "@/features/billing/rpc";
import { normalizeSupportSource } from "@/features/billing/support";
import { billingConfigError } from "@/lib/env";
import { btnSecondary, noticeMuted, surface } from "@/app/_surface";
import { SupportCheckout } from "./_checkout";

export const metadata = { title: "つたわるかなを支援する" };
export const dynamic = "force-dynamic";

export default async function SupportPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string; canceled?: string }>;
}) {
  const query = await searchParams;
  const source = normalizeSupportSource(query.source ?? "support_page");
  const founder = await fetchFounderOfferStatus();
  const amount = founder?.amount.toLocaleString("ja-JP") ?? "3,000";

  return (
    <main className="mx-auto w-full max-w-5xl space-y-8 p-6 sm:p-10">
      <header className="max-w-2xl space-y-3">
        <h1 className="text-2xl font-bold">つたわるかなを支援する</h1>
        <p className="text-sm leading-relaxed text-muted">
          絵を描く人と、絵からお題を読み解く人が出会う場所を、これからも続けていきます。
          支援には、Founding Creator と自由額の応援の二つがあります。
        </p>
      </header>

      {query.canceled === "1" ? (
        <p className={noticeMuted}>お支払いは完了していません。金額を変えて、いつでもやり直せます。</p>
      ) : null}

      <div className="grid items-start gap-6 md:grid-cols-2">
        <section className={`${surface} space-y-5`} aria-labelledby="founder-title">
          <div className="space-y-2">
            <h2 id="founder-title" className="text-lg font-bold">Founding Creator</h2>
            <p className="text-2xl font-bold">{amount}円</p>
            <p className="text-sm text-muted">最初期参加者向け・30人限定の買い切りです。</p>
          </div>
          <p className="text-sm">
            {founder?.sold_out
              ? "完売しました。"
              : founder?.is_open
                ? `残り ${founder.remaining ?? 0} 枠です。`
                : "現在は販売準備中です。"}
          </p>
          <p className="text-sm text-muted">
            Founder 番号と特典があります。購入には登録済みアカウントが必要です。
          </p>
          <Link href="/founder" className={`${btnSecondary} inline-flex min-h-11 items-center`}>
            詳細を見る
          </Link>
        </section>

        <section className={`${surface} space-y-5`} aria-labelledby="support-title">
          <div className="space-y-2">
            <h2 id="support-title" className="text-lg font-bold">つたわるかなを応援する</h2>
            <p className="text-sm leading-relaxed text-muted">
              つたわるかなを気に入っていただけたら、開発・運営を自由な金額で支援できます。
            </p>
          </div>
          <p className="text-sm text-muted">
            サービスの運営、開発、UI・デザインの改善、サーバー等の維持に使います。
          </p>
          <p className="text-sm font-bold">支援による機能上の優遇や特典はありません。</p>
          <SupportCheckout source={source} available={billingConfigError() === null} />
          <p className="text-xs text-faint">
            お支払いは Stripe の画面で行います。金額は一度だけ請求され、自動更新はありません。
            返金条件は <Link href="/tokushoho" className="underline">特定商取引法に基づく表示</Link>をご覧ください。
          </p>
        </section>
      </div>
    </main>
  );
}
