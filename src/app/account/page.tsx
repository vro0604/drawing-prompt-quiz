import Link from "next/link";
import { getCurrentUser } from "@/features/auth/session";
import { registerAction, signInAction, signOutAction } from "./actions";

/**
 * /account ／ アカウントの最小画面。
 *
 * 【なぜ最小か】
 *   spec 13 の Step 6（登録・昇格・handle 設定）の本体はまだ先。
 *   ここにあるのは「作品の投稿は登録ユーザーだけ」（spec C3 / D27-1）を
 *   ブラウザで満たすために要る分だけ。
 *   handle・表示名・プロフィール・パスワード再設定は Step 6 で作る。
 *
 * 【ゲストに見せる文言】
 *   ここで signUp を選ぶと uid が変わり、引いたお題を持ち主ごと失う。
 *   だからゲストには「登録する」しか出さない（内部では昇格を呼ぶ）。
 *
 * Next.js 16 では searchParams が Promise なので await が必要。
 */

export const metadata = {
  title: "アカウント",
};

const box =
  "rounded-2xl border border-black/10 bg-white/60 p-6 dark:border-white/15 dark:bg-white/5";

const input =
  "w-full rounded-xl border border-black/15 bg-transparent px-4 py-3 text-sm dark:border-white/20";

const primary =
  "w-full rounded-xl bg-black px-5 py-3 text-sm font-bold text-white hover:opacity-85 dark:bg-white dark:text-black";

const secondary =
  "w-full rounded-xl border border-black/20 px-5 py-3 text-sm font-bold hover:bg-black/[0.04] dark:border-white/25 dark:hover:bg-white/10";

/** メールとパスワードの2欄。サインインにも登録にも同じ形を使う */
function Credentials({ idPrefix }: { idPrefix: string }) {
  return (
    <>
      <label className="block space-y-1">
        <span className="block text-xs text-black/55 dark:text-white/55">メールアドレス</span>
        <input
          id={`${idPrefix}-email`}
          type="email"
          name="email"
          required
          autoComplete="email"
          className={input}
        />
      </label>
      <label className="block space-y-1">
        <span className="block text-xs text-black/55 dark:text-white/55">
          パスワード（6文字以上）
        </span>
        <input
          id={`${idPrefix}-password`}
          type="password"
          name="password"
          required
          minLength={6}
          className={input}
        />
      </label>
    </>
  );
}

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { error, notice } = await searchParams;
  const user = await getCurrentUser();

  const isGuest = user?.is_anonymous === true;
  const isRegistered = user !== null && !user.is_anonymous;

  return (
    <main className="mx-auto w-full max-w-lg space-y-8 p-6 sm:p-10">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">アカウント</h1>
        <p className="text-sm text-black/55 dark:text-white/55">
          お題を引く・クイズに答えるはゲストのままできます。
          作品の投稿にはアカウントが必要です。
        </p>
      </header>

      {error ? (
        <p className="rounded-xl bg-rose-500/10 px-4 py-3 text-sm whitespace-pre-wrap text-rose-700 dark:text-rose-300">
          {error}
        </p>
      ) : null}

      {notice ? (
        <p className="rounded-xl bg-emerald-500/10 px-4 py-3 text-sm whitespace-pre-wrap text-emerald-700 dark:text-emerald-300">
          {notice}
        </p>
      ) : null}

      {/* --- いまの状態 -------------------------------------------------------- */}
      <section className={`${box} space-y-2`}>
        <h2 className="text-sm font-bold">いまの状態</h2>
        {isRegistered ? (
          <div className="space-y-1 text-sm">
            <p>
              登録ユーザーとしてサインインしています（{user.email ?? "メール未設定"}）。
            </p>
            <p className="text-xs text-black/45 dark:text-white/45">ID: {user.id}</p>
          </div>
        ) : isGuest ? (
          <div className="space-y-1 text-sm">
            <p>ゲストとして遊んでいます。作品の投稿はできません。</p>
            <p className="text-xs text-black/45 dark:text-white/45">ID: {user.id}</p>
          </div>
        ) : (
          <p className="text-sm">まだサインインしていません。</p>
        )}
      </section>

      {/* --- ゲスト：昇格 ------------------------------------------------------ */}
      {isGuest ? (
        <section className={`${box} space-y-4`}>
          <div className="space-y-1">
            <h2 className="text-sm font-bold">アカウントを登録する</h2>
            <p className="text-xs text-black/55 dark:text-white/55">
              いまのゲストにメールとパスワードを結びつけます。
              <strong>IDは変わりません。</strong>
              引いたお題も、これまでの記録もそのまま残ります。
            </p>
          </div>
          <form action={registerAction} className="space-y-4">
            <Credentials idPrefix="promote" />
            <button type="submit" className={primary}>
              このゲストのまま登録する
            </button>
          </form>
        </section>
      ) : null}

      {/* --- 未サインイン：登録／サインイン ------------------------------------ */}
      {user === null ? (
        <>
          <section className={`${box} space-y-4`}>
            <h2 className="text-sm font-bold">新しく登録する</h2>
            <form action={registerAction} className="space-y-4">
              <Credentials idPrefix="signup" />
              <button type="submit" className={primary}>
                登録する
              </button>
            </form>
          </section>

          <section className={`${box} space-y-4`}>
            <h2 className="text-sm font-bold">登録済みの方はこちら</h2>
            <form action={signInAction} className="space-y-4">
              <Credentials idPrefix="signin" />
              <button type="submit" className={secondary}>
                サインインする
              </button>
            </form>
          </section>
        </>
      ) : null}

      {/* --- サインアウト ------------------------------------------------------ */}
      {user !== null ? (
        <section className={`${box} space-y-3`}>
          <form action={signOutAction}>
            <button type="submit" className={secondary}>
              サインアウトする
            </button>
          </form>
          {isGuest ? (
            <p className="text-xs text-rose-700 dark:text-rose-300">
              ゲストのままサインアウトすると、そのIDには二度と戻れません。
              引いたお題も見られなくなります。
            </p>
          ) : null}
        </section>
      ) : null}

      <footer className="border-t border-black/10 pt-6 text-sm dark:border-white/10">
        <Link href="/play" className="underline">
          お題を引く画面へ
        </Link>
      </footer>
    </main>
  );
}
