import Link from "next/link";
import { redirect } from "next/navigation";
import { LegalBody } from "@/app/_legal-body";
import { SubmitButton } from "@/app/_pending";
import { btnPrimary, noticeError, noticeMuted, surface } from "@/app/_surface";
import { fetchCurrentDocuments } from "@/features/account/rpc";
import { fetchConsentStatus } from "@/features/consent/rpc";
import { agreeAction } from "./actions";

/**
 * /consent ／ 規約とポリシーへの同意（P5）。
 *
 * 【いつ出るか】
 *   ・登録した直後（そのセッションはたった今始まっている）
 *   ・未同意のまま次にログインしたとき
 *   ・規約を改定したあと、次にログインしたとき
 *
 *   **作業の途中で割り込むことはない。**止めるかどうかを決めているのは
 *   DB の consent_status() で、そこが「セッションの開始が関門より後か」を見る。
 *
 * 【本文をこの画面の中に置く理由】
 *   同意を求める画面から本文へ出ていくと、戻ってこられる保証が無い。
 *   読む場所と同意する場所を1枚にまとめて、外へ出さない。
 *   （/terms と /privacy は残す。同意の外から読みたい人のため）
 *
 * 【同意しない道を塞がない】
 *   サインアウトと退会への行き先を必ず出す。
 *   同意しない人が閉じ込められる画面にしない。
 */

export const metadata = { title: "利用規約への同意" };

export const dynamic = "force-dynamic";

export default async function ConsentPage({
  searchParams,
}: {
  // Next.js 16 では searchParams が Promise
  searchParams: Promise<{ back?: string; error?: string }>;
}) {
  const { back, error } = await searchParams;
  const status = await fetchConsentStatus();

  // ゲスト・未サインイン・同意済みの人には用が無い画面。
  // **開いても止めない。**行き先を失わせないためトップへ戻す
  if (!status || status.is_anonymous || !status.needs_consent) redirect("/");

  const { terms, privacy } = await fetchCurrentDocuments();

  // 戻り先はサイト内のパスだけ受け取る
  const safeBack = back && back.startsWith("/") && !back.startsWith("//") ? back : "/";

  return (
    <main
      data-consent-gate=""
      className="mx-auto w-full max-w-3xl space-y-8 p-6 sm:p-10"
    >
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">利用規約への同意</h1>
        <p className="text-sm text-muted">
          {status.terms_agreed || status.privacy_agreed
            ? "規約またはプライバシーポリシーが新しくなりました。続けるには、新しい版への同意が必要です。"
            : "このサービスを使うには、利用規約とプライバシーポリシーへの同意が必要です。"}
        </p>
      </div>

      {error ? <p className={noticeError}>{error}</p> : null}

      {/* --- 同意する --------------------------------------------------------- */}
      {/*
        本文より前にボタンを置く。本文は長いので、後ろに置くと
        「読み終わらないと押せない」画面になる。読みたい人は下にある。
      */}
      <section className={`${surface} space-y-4`}>
        <form action={agreeAction} className="space-y-3">
          <input type="hidden" name="termsVersion" value={status.terms_version ?? ""} />
          <input type="hidden" name="privacyVersion" value={status.privacy_version ?? ""} />
          <input type="hidden" name="back" value={safeBack} />

          <p className="text-sm">
            利用規約（版 {status.terms_version ?? "—"}）とプライバシーポリシー（版{" "}
            {status.privacy_version ?? "—"}）に同意します。
          </p>

          <SubmitButton pendingLabel="記録しています…" className={btnPrimary}>
            同意して続ける
          </SubmitButton>

          <p className="text-xs text-faint">
            同意した記録として、あなたの識別子・どの文書か・どの版か・同意した日時の
            4つを5年間だけ保存します。退会するとこの記録からあなたとの結び付きが外れます。
          </p>
        </form>
      </section>

      {/* --- 同意しない道 ----------------------------------------------------- */}
      <p className={noticeMuted}>
        同意しない場合は、このまま
        <Link href="/account" className="px-1 underline">
          アカウントの画面
        </Link>
        からサインアウトするか、
        <Link href="/account/delete" className="px-1 underline">
          退会
        </Link>
        できます。作品を見ることや、ゲストとしてお題を引くことは止まりません。
      </p>

      {/* --- 本文 ------------------------------------------------------------- */}
      <section className="space-y-8">
        {terms ? (
          <details data-doc="terms" open>
            <summary className="cursor-pointer py-2 text-sm font-bold">
              利用規約を読む
            </summary>
            <LegalBody
              body={terms.body_md}
              version={terms.version}
              publishedAt={terms.published_at}
            />
          </details>
        ) : null}

        {privacy ? (
          <details data-doc="privacy">
            <summary className="cursor-pointer py-2 text-sm font-bold">
              プライバシーポリシーを読む
            </summary>
            <LegalBody
              body={privacy.body_md}
              version={privacy.version}
              publishedAt={privacy.published_at}
            />
          </details>
        ) : null}
      </section>
    </main>
  );
}
