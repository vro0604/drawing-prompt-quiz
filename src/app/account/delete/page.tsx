import Link from "next/link";
import { fetchAccountState } from "@/features/account/rpc";
import { deleteAccountAction } from "./actions";
import { SubmitButton } from "@/app/_pending";

/**
 * /account/delete ／ 退会の確認画面。
 *
 * 【誤操作を防ぐ作法】Step 15 の作品削除と同じ。
 *   1. 何が消えて何が残るかを、押す前に全部並べる
 *   2. 合言葉（ID。無ければ表示名）を手で入力させる
 *   3. 「取り消せません」を目立つ場所に書く
 *
 *   合言葉の判定は **DB 側にもある**（start_account_deletion）。
 *   画面だけで見ていると、POST を直接作れば飛ばせてしまう。
 *
 * 【他人のアカウントは消せない】
 *   RPC が引数で利用者を受け取らず、auth.uid() の行しか触らない。
 *   このページに他人のIDを渡す口が無いのではなく、
 *   **渡す口そのものが存在しない。**
 */

export const metadata = {
  title: "退会する",
};

const box =
  "rounded-2xl border border-black/10 bg-white/60 p-6 dark:border-white/15 dark:bg-white/5";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-2xl space-y-8 p-6 sm:p-10">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">退会する</h1>
        <p className="text-sm text-black/55 dark:text-white/55">
          アカウントと、あなたが投稿した作品を削除します。
        </p>
      </header>
      {children}
    </main>
  );
}

export default async function DeleteAccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const state = await fetchAccountState();

  if (!state) {
    return (
      <Shell>
        <div className={box}>
          <p className="text-sm">サインインしてから開いてください。</p>
          <p className="pt-3 text-sm">
            <Link href="/account" className="underline">
              アカウントの画面へ
            </Link>
          </p>
        </div>
      </Shell>
    );
  }

  if (state.is_anonymous) {
    return (
      <Shell>
        <div className={`${box} space-y-3`}>
          <h2 className="text-sm font-bold">ゲストには退会の手続きがありません</h2>
          <p className="text-sm">
            ゲストはメールアドレスを持たないため、消すべき個人情報がありません。
            使われなくなったゲストの記録は自動で消えます。
          </p>
          <p className="text-sm">
            <Link href="/account" className="underline">
              アカウントの画面へ
            </Link>
          </p>
        </div>
      </Shell>
    );
  }

  if (state.account_status !== "active") {
    return (
      <Shell>
        <div className={`${box} space-y-3`}>
          <h2 className="text-sm font-bold">すでに退会の処理に入っています</h2>
          <p className="text-sm">
            このアカウントからは、もう投稿も編集もできません。
            残りの処理は自動で進みます。
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      {error ? (
        <p className="rounded-xl bg-rose-500/10 px-4 py-3 text-sm whitespace-pre-wrap text-rose-700 dark:text-rose-300">
          {error}
        </p>
      ) : null}

      <div className="rounded-2xl border-2 border-rose-500/50 bg-rose-500/[0.06] p-6">
        <p className="text-sm font-bold text-rose-700 dark:text-rose-300">
          退会は取り消せません。
        </p>
        <p className="pt-2 text-sm text-rose-700/80 dark:text-rose-300/80">
          元に戻す手段はありません。同じメールアドレスで登録し直しても、
          消えた作品と記録は戻りません。
        </p>
      </div>

      <section className={`${box} space-y-4`}>
        <h2 className="text-sm font-bold">消えるもの</h2>
        <ul className="space-y-1.5 text-sm">
          <li>・メールアドレスとパスワード（ログインできなくなります）</li>
          <li>・表示名・ID・自己紹介・外部リンク</li>
          <li>
            ・<strong>投稿した作品 {state.works_count} 件</strong>
            。すぐに非公開になり、画像・作品名・二次創作の記載が消えます
          </li>
          <li>・あなたが押したいいねとお気に入り</li>
          <li>・あなたの回答成績</li>
          <li>・引きかけのお題と下書き</li>
        </ul>

        <h2 className="pt-2 text-sm font-bold">残るもの（あなたとは結び付きません）</h2>
        <ul className="space-y-1.5 text-sm">
          <li>
            ・作品の記録そのもの。
            <span className="text-black/55 dark:text-white/55">
              消すと、その作品に答えた他の方の記録と正答率まで壊れてしまうためです。
              作者が誰だったかは分からなくなります
            </span>
          </li>
          <li>
            ・あなたが他の方の作品に答えた記録。
            <span className="text-black/55 dark:text-white/55">
              作者にとっては「何人に伝わったか」という自分の記録だからです。
              誰の回答かは分からなくなります
            </span>
          </li>
          <li>
            ・通報の記録。
            <span className="text-black/55 dark:text-white/55">
              運営が対応するために残します。誰が通報したかは消えます
            </span>
          </li>
          <li>
            ・規約に同意した記録。
            <span className="text-black/55 dark:text-white/55">
              5年で自動的に消えます。あなたとの結び付きは退会時に外れます
            </span>
          </li>
        </ul>

        <h2 className="pt-2 text-sm font-bold">そのほか知っておいていただきたいこと</h2>
        <ul className="space-y-1.5 text-sm text-black/55 dark:text-white/55">
          <li>
            ・使っていた ID は、しばらく他の方が取得できません。
            保存するのは ID そのものではなく、読み取れない形に変換した値です
          </li>
          <li>
            ・画像は消しますが、配信の仕組みの都合で
            <strong>最大1時間ほど同じURLから見えることがあります</strong>
          </li>
          <li>・あなたの作品に付いていたいいねの数は、他の方の画面から消えます</li>
        </ul>
      </section>

      <form action={deleteAccountAction} className={`${box} space-y-4`}>
        <label className="block space-y-2">
          <span className="block text-sm font-bold">
            確認のため <code className="rounded bg-black/10 px-1.5 py-0.5">{state.confirm_word}</code>{" "}
            と入力してください
          </span>
          <input
            type="text"
            name="confirm"
            required
            autoComplete="off"
            placeholder={state.confirm_word}
            className="w-full rounded-xl border border-black/15 bg-transparent px-4 py-3 text-sm dark:border-white/20"
          />
        </label>

        <div className="flex flex-wrap gap-3">
          <SubmitButton
            pendingLabel="退会の手続き中…"
            className="rounded-xl bg-rose-600 px-6 py-3 text-sm font-bold text-white hover:opacity-85"
          >
            退会する（取り消せません）
          </SubmitButton>
          <Link
            href="/account"
            className="rounded-xl border border-black/20 px-6 py-3 text-sm font-bold hover:bg-black/[0.04] dark:border-white/25 dark:hover:bg-white/10"
          >
            やめる
          </Link>
        </div>
      </form>
    </Shell>
  );
}
