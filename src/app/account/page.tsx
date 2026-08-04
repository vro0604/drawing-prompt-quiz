import Link from "next/link";
import { getCurrentUser, getMyProfile } from "@/features/auth/session";
import { SubmitButton } from "@/app/_pending";
import { LINK_FIELDS } from "@/features/profile/rpc";
import { VISIBILITY_FIELDS } from "@/features/profile/types";
import type { Profile } from "@/types/database";
import {
  registerAction,
  signInAction,
  signOutAction,
  updateProfileAction,
  updateVisibilityAction,
} from "./actions";

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

  // 登録ユーザーのときだけ、いまの設定値をフォームの初期値として読む。
  // 自分の行は RLS で必ず見えるので、ここは直接読んでよい（001 の SELECT ポリシー）。
  let profile: Profile | null = null;
  if (isRegistered) profile = await getMyProfile();

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

      {/* --- 登録ユーザー：プロフィール ---------------------------------------- */}
      {isRegistered ? (
        <section className={`${box} space-y-4`}>
          <div className="space-y-1">
            <h2 className="text-sm font-bold">プロフィール</h2>
            <p className="text-xs text-black/55 dark:text-white/55">
              ここで決めた表示名が、作品一覧や作品ページに出ます。
              空欄のままにした項目は変更されません。
            </p>
          </div>

          <form action={updateProfileAction} className="space-y-4">
            <label className="block space-y-1">
              <span className="block text-xs text-black/55 dark:text-white/55">
                ID（3〜20字・小文字の英数字とハイフン）
              </span>
              <input
                type="text"
                name="handle"
                defaultValue={profile?.handle ?? ""}
                maxLength={20}
                pattern="[a-z0-9][a-z0-9\-]{1,18}[a-z0-9]"
                placeholder="my-handle"
                className={input}
              />
              <span className="block text-xs text-black/40 dark:text-white/40">
                {profile?.handle
                  ? "早い者勝ちです。変えると、いまの ID は他の人が取れるようになります。"
                  : "早い者勝ちです。ほかの人が使っている ID は取れません。"}
              </span>
            </label>

            <label className="block space-y-1">
              <span className="block text-xs text-black/55 dark:text-white/55">
                表示名（30字まで）
              </span>
              <input
                type="text"
                name="displayName"
                defaultValue={profile?.display_name ?? ""}
                maxLength={30}
                className={input}
              />
            </label>

            <label className="block space-y-1">
              <span className="block text-xs text-black/55 dark:text-white/55">
                自己紹介（500字まで）
              </span>
              <textarea
                name="bio"
                defaultValue={profile?.bio ?? ""}
                maxLength={500}
                rows={3}
                className={input}
              />
            </label>

            <div className="space-y-3">
              <span className="block text-xs text-black/55 dark:text-white/55">
                外部リンク（http:// または https:// で始まる URL）
              </span>
              {LINK_FIELDS.map((f) => (
                <label key={f.key} className="block space-y-1">
                  <span className="block text-xs text-black/40 dark:text-white/40">
                    {f.label}
                  </span>
                  <input
                    type="url"
                    name={`link_${f.key}`}
                    defaultValue={profile?.links?.[f.key] ?? ""}
                    placeholder={f.placeholder}
                    className={input}
                  />
                </label>
              ))}
            </div>

            <SubmitButton pendingLabel="保存しています…" className={primary}>
              プロフィールを保存する
            </SubmitButton>
          </form>

          {profile?.handle ? (
            <p className="border-t border-black/10 pt-4 text-sm dark:border-white/10">
              <Link href={`/u/${profile.handle}`} className="underline">
                公開プロフィールを見る（/u/{profile.handle}）
              </Link>
            </p>
          ) : (
            <p className="border-t border-black/10 pt-4 text-xs text-black/45 dark:border-white/10 dark:text-white/45">
              ID を決めると、公開プロフィールのページ（/u/あなたのID）ができます。
            </p>
          )}
        </section>
      ) : null}

      {/* --- 登録ユーザー：公開設定 -------------------------------------------- */}
      {isRegistered ? (
        <section className={`${box} space-y-4`}>
          <div className="space-y-1">
            <h2 className="text-sm font-bold">公開設定</h2>
            <p className="text-xs text-black/55 dark:text-white/55">
              すべて既定では公開しません。
              <strong>投稿した作品と、描き手としての記録は常に公開されます。</strong>
            </p>
          </div>

          <form action={updateVisibilityAction} className="space-y-4">
            {VISIBILITY_FIELDS.map((f) => (
              <label key={f.key} className="flex gap-3">
                <input
                  type="checkbox"
                  name={f.key}
                  defaultChecked={profile?.[f.key] ?? false}
                  className="mt-1 size-4 shrink-0"
                />
                <span className="space-y-1">
                  <span className="block text-sm">{f.label}</span>
                  <span className="block text-xs text-black/45 dark:text-white/45">
                    {f.note}
                  </span>
                </span>
              </label>
            ))}

            <SubmitButton pendingLabel="保存しています…" className={primary}>
              公開設定を保存する
            </SubmitButton>
          </form>

          <p className="border-t border-black/10 pt-4 text-sm dark:border-white/10">
            <Link href="/saves" className="underline">
              自分のお気に入りを見る
            </Link>
            <span className="ml-2 text-xs text-black/45 dark:text-white/45">
              公開設定に関わらず、自分では常に見られます
            </span>
          </p>
        </section>
      ) : null}

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
            <SubmitButton pendingLabel="登録中…" className={primary}>
              このゲストのまま登録する
            </SubmitButton>
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
              <SubmitButton pendingLabel="登録中…" className={primary}>
                登録する
              </SubmitButton>
            </form>
          </section>

          <section className={`${box} space-y-4`}>
            <h2 className="text-sm font-bold">登録済みの方はこちら</h2>
            <form action={signInAction} className="space-y-4">
              <Credentials idPrefix="signin" />
              <SubmitButton pendingLabel="サインイン中…" className={secondary}>
                サインインする
              </SubmitButton>
            </form>
          </section>
        </>
      ) : null}

      {/* --- サインアウト ------------------------------------------------------ */}
      {user !== null ? (
        <section className={`${box} space-y-3`}>
          <form action={signOutAction}>
            <SubmitButton pendingLabel="サインアウト中…" className={secondary}>
              サインアウトする
            </SubmitButton>
          </form>
          {isGuest ? (
            <p className="text-xs text-rose-700 dark:text-rose-300">
              ゲストのままサインアウトすると、そのIDには二度と戻れません。
              引いたお題も見られなくなります。
            </p>
          ) : null}
        </section>
      ) : null}

      {/* --- 退会 -------------------------------------------------------------- */}
      {/*
        ゲストには出さない。メールもプロフィールも持たないので消すものが無く、
        使われなくなれば自動で消えるため。
        いちばん下に置き、確認画面を挟む。ここでは実行しない。
      */}
      {user !== null && !isGuest ? (
        <section className={`${box} space-y-2`}>
          <h2 className="text-sm font-bold">退会</h2>
          <p className="text-xs text-black/55 dark:text-white/55">
            アカウントと投稿した作品を削除します。取り消せません。
            次の画面で、何が消えて何が残るかを確認できます。
          </p>
          <p className="pt-1 text-sm">
            <Link href="/account/delete" className="underline">
              退会の手続きへ進む
            </Link>
          </p>
        </section>
      ) : null}

      <footer className="space-y-2 border-t border-black/10 pt-6 text-sm dark:border-white/10">
        <p>
          <Link href="/play" className="underline">
            お題を引く画面へ
          </Link>
        </p>
        <p className="text-xs text-black/45 dark:text-white/45">
          <Link href="/terms" className="underline">
            利用規約
          </Link>
          {" ・ "}
          <Link href="/privacy" className="underline">
            プライバシーポリシー
          </Link>
        </p>
      </footer>
    </main>
  );
}
