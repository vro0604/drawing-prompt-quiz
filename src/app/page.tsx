import Link from "next/link";
import { NavButton } from "@/app/_pending";

/**
 * / ／ トップページ。
 *
 * 【なぜこの画面が要るか】
 *   ここは create-next-app の雛形のままだった。英語で
 *   「To get started, edit the page.tsx file.」と出て、リンク先は
 *   Vercel と Next.js の資料だけ。**サービスへの入口が1つも無かった。**
 *
 *   /works や /play は互いにリンクし合っているので、いったん中へ入れば
 *   動き回れる。問題は「最初の一歩が無い」ことで、URL を直接打てる人
 *   以外は何も始められない。退会したあとの案内先もここなので、
 *   最後に見る画面が雛形になってしまう（/account/deleted）。
 *
 * 【何を置くか】
 *   遊びかたが1回読めば分かる説明と、次の一手へのリンクだけ。
 *   見た目を作り込むのではなく、**行き止まりを無くすことが目的**。
 *
 * 【ゲストを最初に置く】
 *   このサービスの入口はゲスト（spec 11-1）。登録を先に見せると、
 *   いちばん人数の多い「とりあえず見に来た人」が引き返す。
 *   だから最初のボタンは「お題を引く」で、登録の案内は下に置く。
 *
 * 【ユーザーを作らない】
 *   この画面では匿名サインインをしない。開いただけで auth.users が
 *   増えると、見に来ただけの人が MAU に乗る（spec 11-1）。
 *   ゲストが発行されるのは、お題を引くなど実際に書き込む瞬間だけ。
 */

export const metadata = {
  // レイアウトの template は「%s ｜ お題を引いて描くクイズ」。
  // トップで使うと名前が二重になるので、ここだけ絶対指定にする。
  title: { absolute: "お題を引いて描くクイズ" },
};

const card =
  "rounded-2xl border border-black/10 bg-white/60 p-6 dark:border-white/15 dark:bg-white/5";

const STEPS = [
  {
    n: "1",
    title: "お題を引く",
    body: "モチーフ・色・生きもの・ジャンルのカードを引きます。お手軽（3枚）と標準（5枚）があり、引き直しは1回だけできます。",
  },
  {
    n: "2",
    title: "その お題で描く",
    body: "引いたお題どおりに絵を描いて投稿します。制作時間の目安も選べます。投稿にはアカウント登録が必要です。",
  },
  {
    n: "3",
    title: "見た人が当てる",
    body: "ほかの人は絵だけを見て、元のお題を4択で当てます。どれだけ伝わったかが伝達率として残ります。",
  },
];

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-10 p-6 sm:p-10">
      <header className="space-y-3">
        <h1 className="text-3xl font-bold sm:text-4xl">お題を引いて描くクイズ</h1>
        <p className="text-base leading-7 text-black/65 dark:text-white/65">
          ランダムに引いたお題で絵を描き、見た人が
          <strong>絵だけを手がかりに</strong>そのお題を当てるサービスです。
          お題を引くのも、クイズに答えるのも、
          <strong>アカウント登録なしで</strong>できます。
        </p>
      </header>

      {/* --- 次の一手。ゲストのままできることを先に置く --------------------- */}
      <div className="flex flex-col gap-3 sm:flex-row">
        {/* この2つは行き先が動的ページで、開くまでに間がある。
            押した反応が出ないと「効いていない」と読まれて二度押しになるので、
            その場で読み込み中を出す（loading.tsx と二段構え）。 */}
        <NavButton
          href="/play"
          pendingLabel="読み込み中…"
          className="flex-1 rounded-xl bg-black px-6 py-4 text-center text-sm font-bold text-white hover:opacity-85 dark:bg-white dark:text-black"
        >
          お題を引く
        </NavButton>
        <NavButton
          href="/works"
          pendingLabel="読み込み中…"
          className="flex-1 rounded-xl border border-black/15 px-6 py-4 text-center text-sm font-bold hover:bg-black/[0.04] dark:border-white/20 dark:hover:bg-white/10"
        >
          みんなの作品を見る
        </NavButton>
      </div>

      {/* --- 遊びかた --------------------------------------------------------- */}
      <section className="space-y-4">
        <h2 className="text-sm font-bold">遊びかた</h2>
        <ol className="grid gap-4 sm:grid-cols-3">
          {STEPS.map((s) => (
            <li key={s.n} className={`${card} space-y-2`}>
              <span className="inline-flex size-7 items-center justify-center rounded-full bg-black/[0.06] text-xs font-bold dark:bg-white/10">
                {s.n}
              </span>
              <h3 className="text-sm font-bold">{s.title}</h3>
              <p className="text-xs leading-6 text-black/55 dark:text-white/55">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* --- 登録すると何ができるか ------------------------------------------- */}
      <section className={`${card} space-y-3`}>
        <h2 className="text-sm font-bold">アカウント登録でできること</h2>
        <ul className="space-y-2 text-sm text-black/65 dark:text-white/65">
          <li>・描いた作品を投稿する</li>
          <li>・いいね と お気に入り を付ける</li>
          <li>・自分のページ（公開プロフィール）を持つ</li>
        </ul>
        <p className="text-xs text-black/45 dark:text-white/45">
          ゲストのまま遊んでいる途中で登録しても、引いたお題はそのまま引き継がれます。
        </p>
        <p className="pt-1 text-sm">
          <Link href="/account" className="underline">
            アカウントの画面へ
          </Link>
        </p>
      </section>

      {/* --- そのほかの入口 --------------------------------------------------- */}
      <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <Link href="/rankings" className="underline">
          ランキング
        </Link>
        <Link href="/works" className="underline">
          作品一覧
        </Link>
        <Link href="/terms" className="underline">
          利用規約
        </Link>
        <Link href="/privacy" className="underline">
          プライバシーポリシー
        </Link>
      </nav>
    </main>
  );
}
