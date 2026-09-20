import Link from "next/link";
import { fetchFounderOfferStatus } from "@/features/billing/rpc";
import { SUPPORT_MAX_YEN, SUPPORT_MIN_YEN } from "@/features/billing/support";
import { surface } from "@/app/_surface";

/**
 * /tokushoho ／ 特定商取引法に基づく表示。
 *
 * 【なぜ規約と別の画面なのか】
 *   規約は「同意してもらうもの」で、版ごとに同意の記録が残る。
 *   こちらは「売る側が名乗るもの」で、同意を取る対象ではない。
 *   混ぜると、名乗りを1文字直すたびに全員へ同意を取り直すことになる。
 *
 * 【価格と枠を、この画面で書かない】
 *   3,000円も30枠も、DB の商品定義（billing_offers）から読む。
 *   ここに数字を書き写すと、値段を変えた日に**表示だけが古くなる。**
 *   売る側の名乗りとして、それがいちばん困る。
 *
 * 【氏名・住所・電話番号を載せていない理由】
 *   特定商取引法は、これらを広告に表示することを求めているが、
 *   **「請求があれば遅滞なく開示する」と表示し、実際にそうできる場合は
 *   省略してよい**とされている（消費者庁「通信販売広告Q&A」）。
 *   個人が住所を常時公開することの負担を避けて、この形にしている。
 *   請求への対応は下の窓口で行う。
 */

export const metadata = {
  title: "特定商取引法に基づく表示",
};

export const dynamic = "force-dynamic";

const CONTACT = "vro.artcode@gmail.com";

export default async function TokushohoPage() {
  const status = await fetchFounderOfferStatus();

  const price =
    status === null
      ? null
      : `${status.amount.toLocaleString("ja-JP")}円（税込）`;
  const cap = status?.sales_cap ?? null;

  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 p-6 sm:p-10">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">特定商取引法に基づく表示</h1>
        <p className="text-sm text-faint">
          Founder のご購入、または自由額支援のお支払いの前にお読みください。
        </p>
      </header>

      {status === null ? (
        <div className={surface}>
          <p className="text-sm">
            Founding Creator の販売情報は現在表示できません。
            自由額支援の条件はこの下に掲載しています。
          </p>
        </div>
      ) : null}

      {status !== null && !status.is_open ? (
        <div className={surface}>
          <p className="text-sm">
            <strong>現在、この商品は販売していません。</strong>
            下の表示は、販売を始めるときの条件です。
          </p>
        </div>
      ) : null}

      <dl className={`${surface} divide-y divide-line`}>
        <Row label="販売事業者">
          VRO（個人運営）
          <Note>
            運営責任者の氏名・所在地・電話番号は、
            <strong>ご請求があれば遅滞なく開示します。</strong>
            下記の窓口までご連絡ください。
          </Note>
        </Row>

        <Row label="お問い合わせ窓口">
          <a href={`mailto:${CONTACT}`} className="underline">
            {CONTACT}
          </a>
          <Note>
            電話でのお問い合わせは受け付けておりません。
            お返事までに数日いただくことがあります。
          </Note>
        </Row>

        <Row label="販売する商品">
          {status ? status.name : "Founding Creator"}
          <Note>
            本サービス上でお使いいただける権利（Founder 権・Founder 番号・
            Founder 表示・新機能の試験版への先行参加ほか）です。
            形のある品物の発送はありません。
          </Note>
        </Row>

        <Row label="販売価格">
          {price ?? "販売しておりません"}
          <Note>表示している価格が、お支払いいただく総額です。</Note>
        </Row>

        <Row label="自由額の単発支援">
          「つたわるかなを応援する」：{SUPPORT_MIN_YEN.toLocaleString("ja-JP")}円〜
          {SUPPORT_MAX_YEN.toLocaleString("ja-JP")}円（税込・1円単位）
          <Note>
            お支払いになる金額は支援する方が入力し、Stripe の決済画面でも確認できます。
            支援に対する機能上の優遇・特典・Founder 資格はありません。
          </Note>
        </Row>

        <Row label="商品代金以外に必要な費用">
          ありません
          <Note>
            本サービスのご利用にかかる通信料は、お客様のご負担となります。
          </Note>
        </Row>

        <Row label="お支払いの方法">
          クレジットカード等（決済代行事業者 Stripe の画面でのお支払い）
          <Note>
            <strong>
              カード番号・有効期限・セキュリティコードを運営者が受け取ることはありません。
            </strong>
          </Note>
        </Row>

        <Row label="お支払いの時期">
          お申し込み時（決済手続きの完了時）
          <Note>一回払いのみです。継続課金・自動更新はありません。</Note>
        </Row>

        <Row label="商品の引き渡し時期">
          Founder 権は、お支払いの成立を確認しだい、ただちに付与します。
          <Note>
            通常は数秒から数分で、Founder 権と Founder 番号がアカウントに付きます。
            決済事業者からの連絡が遅れた場合は、そのぶん遅れます。
            <br />
            Creator Pro の90日間の利用権は、
            <strong>Creator Pro が正式に開始した時点</strong>から始まります
            （購入日からは数えません）。
            自由額支援には商品の引き渡しや特典の付与はありません。
          </Note>
        </Row>

        <Row label="販売数量の制限">
          Founding Creator は{status === null ? "現在ご案内しておりません" :
            cap === null ? "制限なし" : `有効なご購入者 ${cap} 名まで`}。
          自由額支援には件数の制限はありません。
          <Note>
            上限に達した時点、または販売開始から90日を過ぎた時点の、
            早いほうで販売を終了します。
            返金により枠が空いた場合は、あらためて購入できるようになります。
          </Note>
        </Row>

        <Row label="返品・キャンセル（返金）について">
          Founder の購入・自由額支援とも、決済成立から7日以内であれば、
          お申し出により全額を返金します。
          <Note>
            お申し出は上記の窓口へご連絡ください。返金が成立した時点で、
            Founder 権・新機能の試験版への参加資格・Creator Pro の90日間の
            利用権は終了し、Founder 一覧ではその番号が「欠番」として残ります
            （他の方に付け直すことはありません）。
            <br />
            <strong>
              二重に請求された場合や、運営者の側の不手際による場合は、
              7日を過ぎていても対応します。
            </strong>
            <br />
            Founder 権は返金時に終了します。自由額支援には取り消す特典はありません。
            上記以外の理由による返金はお受けできません。
          </Note>
        </Row>

        <Row label="動作環境">
          最新版の Google Chrome / Safari / Firefox / Microsoft Edge
          <Note>
            JavaScript と Cookie を有効にしてご利用ください。
          </Note>
        </Row>
      </dl>

      <p className="text-sm">
        <Link href="/founder" className="underline">
          Founding Creator について
        </Link>
        {" ／ "}
        <Link href="/terms" className="underline">
          利用規約
        </Link>
        {" ／ "}
        <Link href="/privacy" className="underline">
          プライバシーポリシー
        </Link>
        {" ／ "}
        <Link href="/support" className="underline">
          つたわるかなを支援する
        </Link>
      </p>
    </main>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-4 first:pt-0 last:pb-0 sm:grid-cols-[12rem_1fr] sm:gap-4">
      <dt className="text-sm font-bold">{label}</dt>
      <dd className="space-y-1 text-sm">{children}</dd>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-faint">{children}</p>;
}
