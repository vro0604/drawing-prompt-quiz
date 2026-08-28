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
 * ビルド中にこのページを作らせない（リクエストのたびに作る）。
 *
 * 本文は DB から読む。`next build` はページを前もって作ろうとして
 * その読み取りを一度実行するが、そこで Supabase の環境変数が無いと
 * assertSupabaseEnv() が投げてビルドごと止まる。PR ごとのプレビューには
 * 環境変数が入っていないので、これで毎回落ちていた（B-005 / PENDING 9）。
 *
 * 中身は Cookie（サインイン状態）に依らないが、**版が変わったときに
 * 古い本文を配らない**ことのほうが大事なので、キャッシュはせず
 * 毎回読む。規約ページの表示回数はもともと多くない。
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
