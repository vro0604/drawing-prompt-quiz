import Link from "next/link";

import { fetchHasUnseenResults } from "@/features/notice/rpc";

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
 *   このために、この枠は**状態を持つものになった。**全ページで
 *   「未確認があるか」を1回聞く。聞くのは真偽値1つで、
 *   失敗しても知らせが出ないだけ（fetchHasUnseenResults が握りつぶす）。
 *   サインインしているかどうかは、これまでどおり出していない。
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

export async function SiteHeader() {
  // 未確認の回答があるか。**件数は聞いていない。**
  // 未サインインなら、fetchHasUnseenResults が DB に聞かずに false を返す
  // （DB は未サインインには実行させない。聞くと断られる）。ここで場合分けはしない。
  const hasUnseen = await fetchHasUnseenResults();

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
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-6 gap-y-1 px-6 py-2 sm:px-10">
        <Link href="/" className="inline-flex min-h-11 items-center text-base font-bold">
          つたわるかな
        </Link>

        <nav aria-label="サイト内の移動" className="flex flex-wrap items-center gap-x-5">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="inline-flex min-h-11 items-center text-sm hover:underline"
            >
              {n.label}
            </Link>
          ))}
        </nav>

        {/*
          知らせ（D192）。行き先は常に同じで、**出ているかどうかは変わらない。**
          変わるのは太さだけ。丸も数字も付けない。
          読み上げには「未確認の回答があります」と伝わるようにしてある。
        */}
        <Link
          href="/notices"
          data-testid="notice-entry"
          data-unseen={hasUnseen ? "yes" : "no"}
          aria-label={
            hasUnseen ? "知らせ。未確認の回答があります" : "知らせ。未確認の回答はありません"
          }
          className={`ml-auto inline-flex min-h-11 items-center text-sm hover:underline ${
            hasUnseen ? "font-bold text-ink" : "text-muted"
          }`}
        >
          知らせ
        </Link>

        {/* アカウントは右端へ。ゲストのままでも押せるが、主動線ではない */}
        <Link
          href="/account"
          className="inline-flex min-h-11 items-center text-sm text-muted hover:underline"
        >
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
      </div>
    </footer>
  );
}
