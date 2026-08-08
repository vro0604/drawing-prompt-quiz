import Link from "next/link";
import { surface } from "@/app/_surface";

/**
 * /account/deleted ／ 退会したあとの画面。
 *
 * 【どこまで進んだかを隠さない】
 *   Storage や auth.users の削除は取引の外なので、失敗することがある。
 *   そのとき「完了しました」とだけ出すのは嘘になる。
 *
 *   ただし、**退会そのものは成立している**（DB 側は1つの取引で終わっている）。
 *   だから「失敗しました」でもない。残りが自動で片づくことを伝える。
 */

export const metadata = {
  title: "退会しました",
};

export default async function DeletedPage({
  searchParams,
}: {
  searchParams: Promise<{
    storageDeleted?: string;
    storageFailed?: string;
    authDeleted?: string;
    noKey?: string;
  }>;
}) {
  const q = await searchParams;
  const storageFailed = Number.parseInt(q.storageFailed ?? "0", 10) || 0;
  const authDeleted = q.authDeleted === "1";
  const leftover = storageFailed > 0 || !authDeleted;

  return (
    <main className="mx-auto w-full max-w-2xl space-y-8 p-6 sm:p-10">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">退会しました</h1>
        <p className="text-sm text-ink/55">
          ご利用ありがとうございました。
        </p>
      </header>

      <section className={`${surface} space-y-3`}>
        <h2 className="text-sm font-bold">終わっていること</h2>
        <ul className="space-y-1.5 text-sm">
          <li>・投稿した作品はすべて非公開になり、削除済みになりました</li>
          <li>・表示名・ID・自己紹介・外部リンクを消しました</li>
          <li>・いいね・お気に入り・成績を消しました</li>
          <li>・このアカウントからは、もう投稿も編集もできません</li>
        </ul>
      </section>

      {leftover ? (
        <section className={`${surface} space-y-3 border-notice-tint/40`}>
          <h2 className="text-sm font-bold">自動で片づく残り</h2>
          <ul className="space-y-1.5 text-sm">
            {storageFailed > 0 ? (
              <li>・画像 {storageFailed} 件をまだ消せていません。あとで自動的に消します</li>
            ) : null}
            {!authDeleted ? (
              <li>
                ・ログイン情報の削除がまだ終わっていません。あとで自動的に消します。
                その間もこのアカウントでは何もできません
              </li>
            ) : null}
          </ul>
          <p className="text-xs text-ink/45">
            この画面を閉じて構いません。残りの処理に、あなたの操作は要りません。
          </p>
        </section>
      ) : null}

      <section className={`${surface} space-y-2`}>
        <h2 className="text-sm font-bold">画像がまだ見えることがあります</h2>
        <p className="text-sm text-ink/60">
          配信の仕組みの都合で、消したあとも最大1時間ほど同じURLから
          画像が見えることがあります。時間が経てば消えます。
        </p>
      </section>

      <footer className="border-t border-ink/10 pt-6 text-sm">
        <Link href="/" className="underline">
          トップへ
        </Link>
      </footer>
    </main>
  );
}
