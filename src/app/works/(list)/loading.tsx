/**
 * 画面が切り替わるまでのあいだ出す表示。
 *
 * 【なぜ要るか】
 *   この画面は動的で、開くたびにサーバーで組み立てる。
 *   これが無いと、リンクを押してから**画面が何も変わらないまま**
 *   数百ミリ秒〜数秒が過ぎる。利用者は押せていないと判断して押し直す。
 *
 * 【なぜ app/ 直下に置かないか】
 *   loading は Suspense の境界を作る。境界より上の外枠が先に送られるため、
 *   そのあとで notFound() を呼んでも **HTTP の状態が 200 のまま**になる。
 *   実測で /works/{存在しないID} が 404 → 200 に変わった。
 *
 *   下書き・削除済み・退会した人のページは 404 で返す決まりなので（D40）、
 *   **notFound() を使う区画の上には置かない。**
 *   置いてよいのは、この画面のように一覧を出すだけの区画だけ。
 *
 *   /works の一覧に置くために (list) というグループを切ってある。
 *   グループは URL に出ないので、/works はそのまま。
 *   /works/[id] はグループの外なので、404 を返せる。
 *
 * 【NavButton との違い】
 *   これは**JavaScript が動く前でも出る**（サーバーから流れてくる）。
 *   NavButton は押したボタンの上に反応を返す。役割が違うので両方置く。
 */

export default function Loading() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 items-center justify-center p-6 sm:p-10">
      <p
        role="status"
        aria-live="polite"
        className="flex items-center gap-3 text-sm text-faint"
      >
        <span
          aria-hidden
          className="inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
        読み込み中…
      </p>
    </main>
  );
}
