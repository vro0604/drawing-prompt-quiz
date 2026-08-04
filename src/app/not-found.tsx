import Link from "next/link";

/**
 * 404 ／ ページが無いときの画面。
 *
 * 【なぜ要るか】
 *   これが無いと Next.js の既定の画面が出る。英語1行だけで、
 *   **どこにも行けない。**戻る手段が無いので、そこで操作が止まる。
 *
 * 【404 になるのは「無い」ときだけではない】
 *   このサービスは、他人の下書き・削除済みの作品・退会した人のページを
 *   すべて 404 にしている（D40）。「権限がありません」と答えると、
 *   その ID が実在することを教えてしまうため。
 *
 *   つまり利用者から見た 404 には
 *     ・URL の打ち間違い
 *     ・作者が非公開に戻した／消した
 *     ・その人が退会した
 *   が混ざる。**どれなのかは答えない**まま、次の一手だけを示す。
 */

export const metadata = {
  title: "ページが見つかりません",
};

export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-6 p-6 sm:p-10">
      <div className="space-y-3">
        <p className="text-sm font-bold text-black/40 dark:text-white/40">404</p>
        <h1 className="text-2xl font-bold">ページが見つかりません</h1>
        <p className="text-sm leading-7 text-black/60 dark:text-white/60">
          URL が違っているかもしれません。
          作品の場合は、作者が非公開に戻したか、削除した可能性もあります。
        </p>
      </div>

      <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <Link href="/" className="underline">
          トップへ
        </Link>
        <Link href="/works" className="underline">
          作品一覧
        </Link>
        <Link href="/play" className="underline">
          お題を引く
        </Link>
      </nav>
    </main>
  );
}
