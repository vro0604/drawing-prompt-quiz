import Link from "next/link";
import { fetchCurrentDocuments } from "@/features/account/rpc";
import { LegalBody } from "@/app/_legal-body";

/**
 * /terms ／ 利用規約。
 *
 * 本文は DB（terms_versions）にある。ファイルに持たないのは、
 * **同意の記録が版に紐づく**ため。ファイルだと「そのとき何に同意したか」を
 * あとから示せない。DB なら過去の版がそのまま残る。
 *
 * 未サインインでも読める（get_current_documents は anon にも許可）。
 * 同意する前に本文が読めないのはおかしいため。
 */

export const metadata = {
  title: "利用規約",
};

export default async function TermsPage() {
  const { terms } = await fetchCurrentDocuments();

  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 p-6 sm:p-10">
      {terms ? (
        <LegalBody
          body={terms.body_md}
          version={terms.version}
          publishedAt={terms.published_at}
        />
      ) : (
        <p className="text-sm text-ink/55">
          いま有効な利用規約が登録されていません。
        </p>
      )}

      <footer className="border-t border-ink/10 pt-6 text-xs">
        <Link href="/privacy" className="underline">
          プライバシーポリシー
        </Link>
      </footer>
    </main>
  );
}
