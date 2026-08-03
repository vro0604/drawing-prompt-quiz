import Link from "next/link";
import { getCurrentUser } from "@/features/auth/session";
import { fetchCurrentDraft, fetchDraftModes } from "@/features/draft/rpc";
import type { DraftState } from "@/features/draft/types";
import { DraftBoard, ErrorBox, StartForm } from "./_components";

/**
 * /play ／ お題を引く画面。
 *
 * 【状態をここに持たない】
 *   進行中のドラフトは DB の draft_sessions が正本。
 *   このページは毎回それを読み直して描く。ブラウザを閉じて開き直しても続きから戻れる。
 *
 * 【匿名ユーザーはここでは作らない】
 *   ページを開いただけで作ると、見ただけの人の分まで課金対象の
 *   ユーザーが増える（spec 11-1）。発行は「ドラフトを始める」を押した瞬間。
 *   なので未サインインのときは get_current_draft を呼ばない
 *   （そもそも anon には実行権限が無く permission denied になる）。
 *
 * Next.js 16 では searchParams が Promise なので await が必要。
 */

export const metadata = {
  title: "お題を引く",
};

export default async function PlayPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  const user = await getCurrentUser();

  const modes = await fetchDraftModes();

  let draft: DraftState | null = null;
  let loadError: string | null = null;

  if (user) {
    try {
      draft = await fetchCurrentDraft();
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 p-6 sm:p-10">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">お題を引く</h1>
        <p className="text-sm text-black/55 dark:text-white/55">
          伏せられたカードを1枠につき1枚めくると、その内容がお題になります。
          描き終えたら作品を投稿し、見た人がお題を当てます。
        </p>
      </header>

      {error ? <ErrorBox message={error} /> : null}
      {loadError ? <ErrorBox message={loadError} /> : null}

      {draft ? <DraftBoard state={draft} /> : <StartForm modes={modes} />}

      <footer className="border-t border-black/10 pt-6 text-xs text-black/40 dark:border-white/10 dark:text-white/40">
        {user ? (
          <p>
            サインイン済み（
            {user.is_anonymous ? "ゲスト" : "登録ユーザー"}）。
            進行中のドラフトは1つまでです。
          </p>
        ) : (
          <p>
            まだサインインしていません。「ドラフトを始める」を押した時点で
            ゲストとして発行されます。
          </p>
        )}
        <p className="pt-2">
          {/* 作品の投稿にはアカウントが要る（spec C3）。導線をここに置く。 */}
          <Link href="/account" className="underline">
            アカウント
          </Link>
          <span className="px-2 text-black/20 dark:text-white/20">/</span>
          <Link href="/health/auth" className="underline">
            サインイン状態を確認する
          </Link>
        </p>
      </footer>
    </main>
  );
}
