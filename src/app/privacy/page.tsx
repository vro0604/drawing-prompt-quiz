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
