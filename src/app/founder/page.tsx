import Link from "next/link";
import { getCurrentUser } from "@/features/auth/session";
import { fetchFounderOfferStatus } from "@/features/billing/rpc";
import {
  founderLabel,
  isLiveFounder,
  purchaseStatusText,
} from "@/features/billing/types";
import { BuyButton, ConfirmingNotice } from "./_buy";
import { agreeToBillingDocumentsAction, setFounderVisibilityAction } from "./actions";
import { SubmitButton } from "@/app/_pending";
import {
  btnSecondary,
  noticeError,
  noticeMuted,
  noticeSuccess,
  surface,
} from "@/app/_surface";

/**
 * /founder ／ Founding Creator の紹介と購入。
 *
 * 【この画面が判定しないこと】
 *   残り枠も、売り出し中かも、自分が買ったかも、**すべて DB が返した
 *   1つの答え（get_founder_offer_status）から読む。**
 *   画面の側で「30 から引き算する」といった勘定をしない。
 *   ここで数えると、画面と受け口で答えが割れる。
 *
 * 【戻ってきただけでは「購入済み」と書かない】
 *   Stripe から戻る URL には ?paid=1 が付くが、それは手で打てる。
 *   購入済みと書くのは、DB の状態が paid になっているときだけ。
 *   払い終えて戻ってきたのに、まだ知らせが届いていないあいだは
 *   「決済を確認しています」と出す。**待つことは正常な状態。**
 *
 * 【一般公開を止めない】
 *   決済の設定（Stripe の鍵）が入っていなければ、この画面は
 *   「準備中」と出すだけで、サイトの他の部分には何も起きない。
 *
 * Next.js 16 では searchParams が Promise なので await が必要。
 */

export const metadata = {
  title: "Founding Creator",
};

/** 特典。**「改善要望の優先実装」は入れない**（約束できないものを書かない） */
const BENEFITS = [
  "Founder 権（期限なし）",
  "Founder 番号（#001 から、決済順）",
  "プロフィールに Founder 表示（公開・非公開は本人が選べます）",
  "Founder 一覧への掲載（匿名希望も選べます）",
  "Creator Pro の正式開始後、90日間の利用権",
  "新しい機能のβ版へ先に参加",
  "Founder 向けのアンケート・お話をうかがう場への参加",
];

export default async function FounderPage({
  searchParams,
}: {
  searchParams: Promise<{ paid?: string; canceled?: string; error?: string; notice?: string }>;
}) {
  const { paid, canceled, error, notice } = await searchParams;

  const [user, status] = await Promise.all([getCurrentUser(), fetchFounderOfferStatus()]);

  // 商品そのものが無い＝ migration が入っていない
  if (!status) {
    return (
      <main className="mx-auto w-full max-w-2xl space-y-8 p-6 sm:p-10">
        <h1 className="text-2xl font-bold">Founding Creator</h1>
        <div className={surface}>
          <p className="text-sm">ただいま準備中です。</p>
        </div>
      </main>
    );
  }

  const isGuest = user !== null && user.is_anonymous === true;
  const isMember = user !== null && !user.is_anonymous;
  const mine = status.mine;

  const priceText = `${status.amount.toLocaleString("ja-JP")}円（税込・一回払い）`;

  return (
    <main className="mx-auto w-full max-w-2xl space-y-8 p-6 sm:p-10">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">{status.name}</h1>
        <p className="text-sm text-faint">
          このサービスを最初に支えてくださる方のための、一回きりの枠です。
          買わなくても、お題を引く・投稿する・答える・結果を見る・共有するといった
          基本の機能はすべて今までどおりお使いいただけます。
        </p>
      </header>

      {error ? <p className={noticeError}>{error}</p> : null}
      {notice ? <p className={noticeSuccess}>{notice}</p> : null}
      {canceled === "1" && !isLiveFounder(mine?.status) ? (
        <p className={noticeMuted}>
          お支払いを取りやめました。枠は押さえたままになっていますので、
          あらためて手続きを進められます。
        </p>
      ) : null}

      {/* ── 商品の中身 ─────────────────────────────────── */}
      <section className={`${surface} space-y-4`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-xl font-bold">{priceText}</p>
          <p className="text-sm">
            {status.sales_cap === null ? (
              "枠の上限はありません"
            ) : status.sold_out ? (
              <span className="font-bold">販売枠が埋まりました</span>
            ) : (
              <>
                残り <span className="font-bold">{status.remaining}</span> 枠
                <span className="text-faint">（全 {status.sales_cap} 枠）</span>
              </>
            )}
          </p>
        </div>

        <ul className="space-y-2 text-sm">
          {BENEFITS.map((b) => (
            <li key={b} className="flex gap-2">
              <span aria-hidden>・</span>
              <span>{b}</span>
            </li>
          ))}
        </ul>

        <p className={noticeMuted}>
          Founder 番号は、こちらでお支払いの成立を確認した順にお出しします。
          返金された番号は欠番として残し、他の方に付け直すことはありません。
        </p>
      </section>

      {/* ── いまの状態に応じた入口 ───────────────────────── */}
      <section className={`${surface} space-y-4`}>
        <FounderState
          isMember={isMember}
          isGuest={isGuest}
          signedIn={user !== null}
          isOpen={status.is_open}
          soldOut={status.sold_out}
          agreed={status.agreed}
          termsVersion={status.terms_version}
          privacyVersion={status.privacy_version}
          mine={mine}
          returnedFromCheckout={paid === "1"}
        />
      </section>

      {/* ── 返金と問い合わせ ──────────────────────────── */}
      <section className={`${surface} space-y-3 text-sm`}>
        <h2 className="font-bold">返金について</h2>
        <p>
          ご購入から7日以内であれば、お申し出により全額を返金します。
          返金が成立した時点で、Founder 権・β参加・Creator Pro の90日利用権は
          いずれも終了し、Founder 一覧では欠番として表示されます。
        </p>
        <p>
          二重の請求など、こちらの不手際による場合は7日を過ぎていても対応します。
        </p>
        <p>
          お問い合わせ:{" "}
          <a href="mailto:vro.artcode@gmail.com" className="underline">
            vro.artcode@gmail.com
          </a>
        </p>
        <p className="text-faint">
          <Link href="/terms" className="underline">
            利用規約
          </Link>
          {" ／ "}
          <Link href="/privacy" className="underline">
            プライバシーポリシー
          </Link>
          {" ／ "}
          <Link href="/tokushoho" className="underline">
            特定商取引法に基づく表示
          </Link>
        </p>
      </section>

      <p className="text-sm">
        <Link href="/founder/members" className="underline">
          Founder 一覧を見る
        </Link>
      </p>
    </main>
  );
}

/* ---------------------------------------------------------------------------
 * 状態ごとの表示。**1つの場所で全部の場合分けを持つ**
 * ------------------------------------------------------------------------- */

function FounderState({
  isMember,
  isGuest,
  signedIn,
  isOpen,
  soldOut,
  agreed,
  termsVersion,
  privacyVersion,
  mine,
  returnedFromCheckout,
}: {
  isMember: boolean;
  isGuest: boolean;
  signedIn: boolean;
  isOpen: boolean;
  soldOut: boolean;
  agreed: boolean;
  termsVersion: string | null;
  privacyVersion: string | null;
  mine: NonNullable<Awaited<ReturnType<typeof fetchFounderOfferStatus>>>["mine"];
  returnedFromCheckout: boolean;
}) {
  // 1. すでに Founder
  if (mine && isLiveFounder(mine.status) && mine.founder_number !== null) {
    return (
      <div className="space-y-4">
        <p className="text-lg font-bold">
          Founding Creator {founderLabel(mine.founder_number)}
        </p>
        <p className="text-sm">{purchaseStatusText(mine.status)}</p>

        <VisibilityForm isPublic={mine.founder_public} />

        <p className="text-sm">
          <Link href="/founder/members" className="underline">
            Founder 一覧で見え方を確かめる
          </Link>
        </p>
      </div>
    );
  }

  // 2. 払い終えて戻ってきたが、まだ知らせが届いていない
  if (mine && mine.status === "reserved" && returnedFromCheckout) {
    return <ConfirmingNotice />;
  }

  // 3. 手続きの途中（戻ってきていない／取りやめた）
  if (mine && mine.status === "reserved") {
    return (
      <div className="space-y-3">
        <p className="text-sm">
          お支払いの手続きが途中です。枠は押さえてあります。
          {mine.checkout_expires_at
            ? "手続きの画面には期限があります。切れた場合は、もう一度この画面から始めてください。"
            : null}
        </p>
        <BuyButton label="お支払いの手続きを続ける" />
      </div>
    );
  }

  // 4. 返金・取り消しのあと（買い直せる）
  if (mine && (mine.status === "refunded" || mine.status === "reversed")) {
    return (
      <div className="space-y-3">
        <p className="text-sm">{purchaseStatusText(mine.status)}</p>
        {isOpen && !soldOut ? (
          <BuyButton label="あらためて購入する" />
        ) : (
          <p className="text-sm">{soldOut ? "販売枠が埋まりました。" : "ただいま販売しておりません。"}</p>
        )}
      </div>
    );
  }

  // 5. まだ買っていない
  if (!signedIn) {
    return (
      <div className="space-y-3">
        <p className="text-sm">ご購入にはログインが必要です。</p>
        <Link href="/account" className={`${btnSecondary} inline-block`}>
          ログイン・登録の画面へ
        </Link>
      </div>
    );
  }

  if (isGuest) {
    return (
      <div className="space-y-3">
        <p className="text-sm">
          ゲストのままではご購入いただけません。Founder 権はずっと残るものなので、
          メールアドレスを登録して、いつでも同じアカウントに戻れる状態にしてからお進みください。
        </p>
        <Link href="/account" className={`${btnSecondary} inline-block`}>
          アカウントを登録する
        </Link>
      </div>
    );
  }

  if (!isOpen) {
    return <p className="text-sm">ただいま販売しておりません。</p>;
  }

  if (soldOut) {
    return (
      <p className="text-sm">
        販売枠が埋まりました。返金などで枠が空いた場合は、この画面から購入できるようになります。
      </p>
    );
  }

  if (!isMember) {
    return <p className="text-sm">ただいまご購入いただけません。</p>;
  }

  // **同意していなければ、購入のボタンを出さない**（規約 13-6）。
  // ここで出さないのは案内のためで、守りは DB 側（billing_reserve_slot）にある。
  if (!agreed && termsVersion && privacyVersion) {
    return <ConsentForm termsVersion={termsVersion} privacyVersion={privacyVersion} />;
  }

  return <BuyButton label="Founding Creator を購入する" />;
}

/**
 * 購入の前に、いま有効な規約とポリシーへ同意してもらう。
 *
 * **投稿の画面と同じ形にしてある。**別の見た目にすると、
 * 「これは何に同意しているのか」を読み直すことになる。
 */
function ConsentForm({
  termsVersion,
  privacyVersion,
}: {
  termsVersion: string;
  privacyVersion: string;
}) {
  return (
    <form action={agreeToBillingDocumentsAction} className="space-y-3">
      <p className="text-sm">
        ご購入の前に、いま有効な利用規約とプライバシーポリシーへの同意が必要です。
      </p>
      <input type="hidden" name="termsVersion" value={termsVersion} />
      <input type="hidden" name="privacyVersion" value={privacyVersion} />
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="accept"
          value="1"
          required
          className="mt-1"
          data-testid="founder-consent"
        />
        <span>
          <Link href="/terms" className="underline">
            利用規約
          </Link>
          （版 {termsVersion}）と{" "}
          <Link href="/privacy" className="underline">
            プライバシーポリシー
          </Link>
          （版 {privacyVersion}）に同意します。
          有料の商品については、利用規約の第13条をお読みください。
        </span>
      </label>
      <SubmitButton className={`${btnSecondary} w-full`} pendingLabel="記録しています…">
        同意して次へ
      </SubmitButton>
    </form>
  );
}

/**
 * 名前を出すかどうか。**購入直後は非公開が既定。**
 *
 * 押すと反対側へ切り替わる1つのボタンにしてある。
 * 入り／切りの2つを並べると、いまどちらなのかが読み取りにくい。
 */
function VisibilityForm({ isPublic }: { isPublic: boolean }) {
  return (
    <form action={setFounderVisibilityAction} className="space-y-2">
      <p className="text-sm">
        いまの表示:{" "}
        <span className="font-bold">
          {isPublic ? "表示名を出す" : "匿名希望（名前を出さない）"}
        </span>
      </p>
      <input type="hidden" name="public" value={isPublic ? "0" : "1"} />
      <SubmitButton
        className={`${btnSecondary} w-full`}
        pendingLabel="切り替えています…"
        data={{ "data-founder-visibility": isPublic ? "to-private" : "to-public" }}
      >
        {isPublic ? "匿名希望に変える" : "表示名を出す"}
      </SubmitButton>
      <p className="text-xs text-faint">
        匿名希望にしても、Founder 一覧から番号が消えることはありません。
        番号はそのまま残り、名前の代わりに「匿名希望」と表示されます。
      </p>
    </form>
  );
}
