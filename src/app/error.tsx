"use client";

import Link from "next/link";

/**
 * 予期しない失敗のときの画面。
 *
 * 【なぜ要るか】
 *   これが無いと Next.js の既定の画面が出る。英語で
 *   「Application error: a server-side exception has occurred」とだけ表示され、
 *   **戻る手段が無い。**
 *
 * 【中身は出さない】
 *   error.message には、DB の制約名やクエリの断片が入りうる。
 *   本番の Next.js は元の文言を伏せて digest だけを渡すが、
 *   **こちらからも出さない**（両方で守る）。
 *
 *   代わりに digest を小さく添える。利用者には意味が無い文字列だが、
 *   問い合わせを受けたときに記録と突き合わせる手がかりになる。
 *
 * 【Client Component であること】
 *   error.tsx は必ず "use client"。reset() はブラウザ側で
 *   描き直すための関数なので、サーバーでは持てない。
 */

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-6 p-6 sm:p-10">
      <div className="space-y-3">
        <h1 className="text-2xl font-bold">うまく表示できませんでした</h1>
        <p className="text-sm leading-7 text-black/60 dark:text-white/60">
          一時的な不具合の可能性があります。
          もう一度お試しいただくか、しばらく待ってからお越しください。
        </p>
        {error.digest ? (
          <p className="text-xs text-black/35 dark:text-white/35">
            参照番号: {error.digest}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={reset}
          className="rounded-xl bg-black px-5 py-3 text-sm font-bold text-white hover:opacity-85 dark:bg-white dark:text-black"
        >
          もう一度読み込む
        </button>
        <Link href="/" className="text-sm underline">
          トップへ
        </Link>
      </div>
    </main>
  );
}
