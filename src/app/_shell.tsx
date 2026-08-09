import Link from "next/link";

/**
 * 全ページの上と下に付く枠（ヘッダーとフッター）。
 *
 * 【なぜ要るか】
 *   これまで layout.tsx は本文を流すだけで、移動の手段が無かった。
 *   各ページが末尾に行き先を手書きしていて、
 *
 *     ・ページごとに行ける先が違う（作品一覧から /rankings へは行けるが、
 *       ランキングから /saves へは行けない、など）
 *     ・**新しい導線を足す場所が無い。** D118（答えると同じ札の作品が開く）は
 *       「次の1件」へ送る機能なのに、送り出す場所がどこにも無い
 *
 * 【置いていないもの】
 *   数字を置かない。通知の丸も、いいねの数も、回答数も出さない。
 *   D112 は「数字は取りに行った人にだけ出す」と決めていて、
 *   **ヘッダーはいちばん目に入る回数が多い場所**だから、ここに数字を置くと
 *   フィードのカードから数字を落とした意味が消える。
 *
 *   サインインしているかどうかも出していない。出すには全ページで
 *   認証を読むことになり、**この枠を「状態を持つもの」に変えてしまう。**
 *   いまの状態は /account が受け持っている。
 *
 * 【並び順】
 *   ゲストのままできること（お題を引く・作品を見る）を先に置く。
 *   このサービスの入口はゲストで（spec 11-1）、登録を先に見せると
 *   いちばん人数の多い「とりあえず来た人」が引き返す。
 *
 * 【変えるとき】
 *   中身と並びはこのファイルだけを直せば全ページに効く。
 *   枠ごとやめるなら layout.tsx から2行消す。
 */

/** ヘッダーの行き先。ゲストで使えるものから並べる */
const NAV = [
  { href: "/play", label: "お題を引く" },
  { href: "/works", label: "作品" },
  { href: "/rankings", label: "ランキング" },
];

export function SiteHeader() {
  return (
    <header className="border-b border-line">
      {/*
        本文の幅は画面によって違う（max-w-2xl 〜 max-w-5xl）。
        枠だけ広い幅に揃えると本文とずれて見えるので、
        いちばん広い本文に合わせる。
      */}
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-4 sm:px-10">
        <Link href="/" className="text-base font-bold">
          つたわるかな
        </Link>

        <nav aria-label="サイト内の移動" className="flex flex-wrap items-center gap-x-5 gap-y-1">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="text-sm hover:underline">
              {n.label}
            </Link>
          ))}
        </nav>

        {/* アカウントは右端へ。ゲストのままでも押せるが、主動線ではない */}
        <Link href="/account" className="ml-auto text-sm text-muted hover:underline">
          アカウント
        </Link>
      </div>
    </header>
  );
}

/**
 * フッター。
 *
 * 規約とプライバシーポリシーは、**どのページからも1回で行ける必要がある。**
 * これまでは /account と / にしか置いていなかった。
 */
export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-line">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-5 gap-y-2 px-6 py-6 text-xs sm:px-10">
        <span className="text-faint">つたわるかな</span>
        <Link href="/terms" className="text-muted hover:underline">
          利用規約
        </Link>
        <Link href="/privacy" className="text-muted hover:underline">
          プライバシーポリシー
        </Link>
      </div>
    </footer>
  );
}
