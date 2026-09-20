import Link from "next/link";

import { SiteNav } from "@/app/_site-nav";

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
 * 【2026-09-10 に1つだけ足した：回答の知らせ（D192）】
 *   「知らせ」の行き先を1つ置いた。**数字はここでも置いていない。**
 *   出すのは「未確認の回答があるかどうか」だけで、何件あるかは
 *   運んでもいない（has_unseen_results は真偽値しか返さない）。
 *   見た目の違いも、文字の太さが変わるだけにしてある。
 *   出所: ユーザー指示（2026-09-10）「ヘッダーに通知入口を追加する。
 *   ただしD112を維持する。絶対に表示しない：回答件数 / 通知件数 /
 *   数字badge / 未読を示す丸badge / いいね型カウンター」。
 *
 *   NoticeEntry がブラウザから真偽値だけを聞く。ヘッダー本体は Cookie を
 *   読まないので、公開ページを静的に配信できる。失敗しても入口は残る。
 *   サインインしているかどうかは、これまでどおり出していない。
 *
 * 【並び順】
 *   ゲストのままできること（お題を引く・作品を見る）を先に置く。
 *   このサービスの入口はゲストで（spec 11-1）、登録を先に見せると
 *   いちばん人数の多い「とりあえず来た人」が引き返す。
 *
 * 【2026-09-18：狭い画面では行き先をメニューへ畳んだ】
 *   5つの行き先を横に並べると、**536px より狭い画面で折り返していた**
 *   （実測: 320px と 375px で3段・高さ 157px、390px と 430px で2段・109px）。
 *   スマホの最初の画面の上 96px ぶんが移動手段で埋まり、D207 で作り直した
 *   トップの見出しと3つの手順が下へ押し出されていた。
 *   狭いときは「つたわるかな」とメニューのボタンだけを1行で出し、
 *   行き先はボタンを押したときにヘッダーの直下へ開く。
 *   **広い画面の横並びは変えていない。**
 *   中身は _site-nav.tsx が持つ。ここは置く場所と、いちばん左の名前だけ。
 *
 * 【変えるとき】
 *   行き先と並びは _site-nav.tsx を直せば全ページに効く。
 *   知らせの読み込み方は _notice-entry.tsx に置いている。
 *   枠ごとやめるなら layout.tsx から2行消す。
 */

export function SiteHeader() {
  return (
    <header data-site-nav="" className="border-b border-line">
      {/*
        本文の幅は画面によって違う（max-w-2xl 〜 max-w-5xl）。
        枠だけ広い幅に揃えると本文とずれて見えるので、
        いちばん広い本文に合わせる。
      */}
      {/*
        【2026-09-05】行き先はどれも min-h-11（44px）。
        スマホで指が届く下限に届いていなかった（実測 20px）。
        文字の大きさは変えず、押せる高さだけを確保している。
      */}
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-6 px-6 py-2 sm:px-10">
        <Link href="/" className="inline-flex min-h-11 items-center text-base font-bold">
          つたわるかな
        </Link>

        {/* メニューのボタンと5つの行き先。狭い画面では畳む（_site-nav.tsx） */}
        <SiteNav />
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
    <footer data-site-nav="" className="mt-16 border-t border-line">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-5 px-6 py-4 text-xs sm:px-10">
        <span className="inline-flex min-h-11 items-center text-faint">つたわるかな</span>
        <Link href="/terms" className="inline-flex min-h-11 items-center text-muted hover:underline">
          利用規約
        </Link>
        <Link
          href="/privacy"
          className="inline-flex min-h-11 items-center text-muted hover:underline"
        >
          プライバシーポリシー
        </Link>
        {/* 有料の商品を売る以上、名乗りはどのページからも1回で行けること */}
        <Link
          href="/tokushoho"
          className="inline-flex min-h-11 items-center text-muted hover:underline"
        >
          特定商取引法に基づく表示
        </Link>
        <Link href="/support?source=footer" className="inline-flex min-h-11 items-center text-muted hover:underline">
          つたわるかなを応援する
        </Link>
      </div>
    </footer>
  );
}
