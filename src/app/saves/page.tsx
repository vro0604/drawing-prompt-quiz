import Link from "next/link";
import { SavedList } from "@/app/_saved-list";
import { getCurrentUser, getMyProfile } from "@/features/auth/session";
import { fetchSavedWorks } from "@/features/profile/rpc";

/**
 * /saves ／ 自分のお気に入り一覧。
 *
 * 【なぜポートフォリオのタブとは別に用意するのか】
 *   ポートフォリオは /u/{handle} にあるので、**ID をまだ決めていない人には
 *   開く URL が無い**。自分の持ち物はいつでも見られるべきなので、
 *   handle に依存しない入口をここに置く（spec 12-1「本人は常に閲覧可能」）。
 *
 * 【公開設定と無関係】
 *   show_saved_works が切れていてもここには出る。自分が保存したものが、
 *   自分の公開設定しだいで自分から見えなくなるのは道理に合わない。
 *   他人に見せるかどうかだけが設定で決まる。
 *
 * 【非公開になった作品も出す】
 *   作者が非公開にしたり削除したりした作品も、状態つきで残す。
 *   黙って消えると、消したのか隠れたのか分からない。
 */

export const metadata = {
  title: "お気に入り",
};

const box =
  "rounded-2xl border border-black/10 bg-white/60 p-6 dark:border-white/15 dark:bg-white/5";

export default async function SavesPage() {
  const user = await getCurrentUser();
  const isRegistered = user !== null && !user.is_anonymous;

  if (!isRegistered) {
    return (
      <main className="mx-auto w-full max-w-3xl space-y-8 p-6 sm:p-10">
        <h1 className="text-2xl font-bold">お気に入り</h1>
        <div className={box}>
          <p className="text-sm">
            お気に入りの保存にはアカウント登録が必要です。
            {user === null
              ? "サインインすると、保存した作品がここに並びます。"
              : "ゲストのままでは保存できません。登録すると、そのまま同じIDで使えます。"}
          </p>
          <p className="pt-3 text-sm">
            <Link href="/account" className="underline">
              アカウントの画面へ
            </Link>
          </p>
        </div>
      </main>
    );
  }

  const [profile, saves] = await Promise.all([
    getMyProfile(),
    fetchSavedWorks({ userId: user.id, limit: 24, offset: 0 }),
  ]);

  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 p-6 sm:p-10">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">お気に入り</h1>
        <p className="text-sm text-black/55 dark:text-white/55">
          あとで見返すために保存した作品です。
          {profile?.show_saved_works
            ? "いまは他の人にも公開しています。"
            : "いまは自分だけが見られます。"}
          <Link href="/account" className="ml-1 underline">
            公開設定を変える
          </Link>
        </p>
      </header>

      <SavedList
        items={saves}
        showStatus
        emptyMessage="まだ何も保存していません。作品ページの「保存」から追加できます。"
      />

      {profile?.handle ? (
        <p className="text-sm">
          <Link href={`/u/${profile.handle}`} className="underline">
            自分の公開プロフィールを見る
          </Link>
        </p>
      ) : (
        <p className="text-sm text-black/55 dark:text-white/55">
          公開プロフィールを持つには ID の設定が必要です。
          <Link href="/account" className="ml-1 underline">
            ID を決める
          </Link>
        </p>
      )}

      <footer className="flex flex-wrap gap-4 border-t border-black/10 pt-6 text-sm dark:border-white/10">
        <Link href="/works" className="underline">
          作品一覧へ
        </Link>
        <Link href="/rankings" className="underline">
          ランキングへ
        </Link>
      </footer>
    </main>
  );
}
