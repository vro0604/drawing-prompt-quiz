import Link from "next/link";
import type { Metadata } from "next";
import { requireAdminPage } from "@/features/admin/auth";

/**
 * /admin 以下の共通の枠。
 *
 * 【検索除外は、限定公開が終わっても残す】
 *   いまはサイト全体に noindex が付いている（next.config.ts の headers と
 *   src/app/layout.tsx の robots）。**一般公開のときにその2か所を消しても、
 *   ここと next.config.ts の /admin/:path* だけは残す。**
 *   管理画面が検索結果に出てよい理由が1つも無い。
 *
 *   ただし noindex は認証ではない。クローラーに読ませないだけで、
 *   人が URL を打てば届く。守っているのは下の requireAdminPage()。
 *
 * 【ここで断っても、それだけに頼らない】
 *   各ページと各 Server Action でも同じ判定を行う。
 *   Next.js の同梱文書が「画面を出さないことは安全の境界ではない」と
 *   書いているため（server-actions.md）。
 *
 * 【サイト共通のヘッダー・フッターを使わない】
 *   _shell.tsx は一般利用者向けの案内（お題を引く・作品一覧・ランキング）を
 *   並べる。管理画面にそれが出ていると、運営の作業中に一般の画面へ迷い込む。
 */

/**
 * **必ずリクエストごとに描く。**
 *
 * これが無いと、ビルド時に一度描かれた結果がそのまま配られることがある。
 * 実測（2026-09-08 の `npm run build`）では `/admin/reports` が
 * 「静的」と判定されていた。理由は、ビルド中は ADMIN_USER_ID が空なので
 * 判定が Cookie を読む前に「管理者ではない」で終わり、404 の結果が
 * そのまま焼き付いたこと。**環境変数の有無で静的・動的が変わる形にしない。**
 *
 * layout に書くと、この下の画面すべてに効く。各画面にも同じ行を置いてある
 * （どちらか一方が消えても、もう一方が残るように）。
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "管理", template: "%s ｜ 管理" },
  robots: {
    index: false,
    follow: false,
    noarchive: true,
    googleBot: { index: false, follow: false, noarchive: true },
  },
};

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAdminPage();

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-line px-6 py-4">
        <div className="mx-auto flex max-w-5xl items-baseline gap-4">
          <Link href="/admin/reports" className="text-sm font-bold">
            つたわるかな ／ 管理
          </Link>
          <span className="text-xs text-faint">通報の処理と、作品の非表示だけ</span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl p-6 sm:p-10">{children}</main>
    </div>
  );
}
