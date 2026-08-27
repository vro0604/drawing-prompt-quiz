import { fetchCurrentDocuments } from "@/features/account/rpc";
import { LegalBody } from "@/app/_legal-body";

/**
 * /privacy ／ プライバシーポリシー。
 *
 * 利用規約とは**別の表**（privacy_versions）で管理する。
 * 改定の周期が違うので、片方を直したときにもう片方の同意まで
 * 取り直すことになるのを避けるため。
 */

export const metadata = {
  title: "プライバシーポリシー",
};

/**
 * **ビルドの最中に DB を読ませない。**
 *
 * 【何が起きていたか】
 *   この画面はもともとリクエストごとに描かれていた（ビルドの出力でも ƒ）。
 *   それでも `next build` は、静的にできるかどうかを確かめるために
 *   ページを一度実行する。そこで Supabase の環境変数が無いと
 *   `assertSupabaseEnv()` が投げ、**ビルド全体が止まっていた。**
 *
 *     Error occurred prerendering page "/privacy"
 *     Error: Supabase の環境変数が設定されていません
 *
 *   本番には値が入っているので本番のビルドは通っていたが、
 *   **PR ごとのプレビューには入っていない。**そのため PR を出すたびに
 *   デプロイが赤くなり、画面で確かめられない状態だった（D155 と同じ形で、
 *   「本番で通る」と「どこでも通る」は別）。
 *
 * 【なぜこれで直るか】
 *   `force-dynamic` を書くと、Next.js はこの経路を静的化の対象から外し、
 *   ビルド中に一度も実行しなくなる。**描かれるのは request のときだけ。**
 *   もともとそうなっていたので、利用者から見た動きは1つも変わらない。
 *
 * 【捨てているもの】
 *   規約は年に何度も変わるものではないので、本当は焼き付けて配るほうが速い。
 *   それをやるなら「改定したら焼き直す」仕組みが別に要る。
 *   同意の記録は版に紐づくので、**古い版が配られているあいだに同意が入る**のが
 *   いちばん困る。速さより、いま有効な版が必ず出ることを取る。
 */
export const dynamic = "force-dynamic";

export default async function PrivacyPage() {
  const { privacy } = await fetchCurrentDocuments();

  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 p-6 sm:p-10">
      {privacy ? (
        <LegalBody
          body={privacy.body_md}
          version={privacy.version}
          publishedAt={privacy.published_at}
        />
      ) : (
        <p className="text-sm text-faint">
          いま有効なプライバシーポリシーが登録されていません。
        </p>
      )}
    </main>
  );
}
