import Link from "next/link";
import { getCurrentUser } from "@/features/auth/session";
import { fetchCurrentDraft, fetchDraftModes } from "@/features/draft/rpc";
import { fetchSavedElements } from "@/features/carry/rpc";
import { EMPTY_SAVED, type SavedElements } from "@/features/carry/types";
import type { DraftState } from "@/features/draft/types";
import { DraftBoard, ErrorBox, RedoConfirm, StartForm } from "./_components";
import { surface } from "@/app/_surface";
import { requireConsent } from "@/features/consent/rpc";

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
  searchParams: Promise<{ error?: string; redo?: string; discarded?: string }>;
}) {
  // 未同意の登録者をここで止める（P5）。**判定は DB の consent_status()。**
  // 止めるのは、そのセッションが関門より後に始まっていて、かつ未同意のときだけ。
  await requireConsent();

  const { error, redo, discarded } = await searchParams;

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

  // 持ち出しはゲストも使える（2026-09-05 の3区分）。
  // ゲストが持てるのは「いまの流れの中だけ」の分で、
  // **どこまで残せるかは DB が返す can_persist が持つ。**画面では決めない。
  let savedElements: SavedElements = EMPTY_SAVED;
  if (user) {
    try {
      savedElements = await fetchSavedElements();
    } catch {
      // 手持ちが読めなくてもドラフトは始められる。**画面を止めない**
      savedElements = EMPTY_SAVED;
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 p-6 sm:p-10">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">お題を引く</h1>
        <p className="text-sm text-faint">
          何を描くか（描く対象）と、それをどう解釈するか（状態）の組み合わせが
          毎回抽選されます。伏せられたカードを1枠につき1枚めくると、その内容がお題になります。
          描き終えたら作品を投稿し、見た人がお題を当てます。
        </p>
      </header>

      {error ? <ErrorBox message={error} /> : null}
      {loadError ? <ErrorBox message={loadError} /> : null}

      {/* 引き直しの確認は、盤面の上に重ねずに画面を1枚使う（2026-09-08）。
          取り消せない操作なので、押し間違いでは辿り着けない場所に置く。
          URL に印があるだけなので、戻るボタンでもここへ戻るだけで、
          戻った先で送り直しても DB が2枚目を捨てない。 */}
      {draft && redo ? (
        <RedoConfirm state={draft} cardSlotKey={redo} />
      ) : draft ? (
        <DraftBoard state={draft} discardedKey={discarded ?? null} />
      ) : (
        <StartForm modes={modes} saved={savedElements} signedIn={user !== null} />
      )}

      {/* もう描いてある絵を出したい人の行き先。**お題を引く操作の下に置く。**
          この画面はお題を引くための画面なので、入口を上に置くと
          引く操作より先に目に入る。 */}
      <section className={`${surface} space-y-2`}>
        <h2 className="text-sm font-bold">もう描いてある絵で試すこともできます</h2>
        <p className="text-sm text-muted">
          お題を引かずに、手元の絵を出せます。その絵で伝えたかったことを自分で選ぶと、
          見た人が絵だけを見てそれを当てます。
        </p>
        <p className="text-sm">
          <Link href="/works/import" className="underline">
            描いた絵で試す
          </Link>
        </p>
      </section>

      <footer className="border-t border-ink/10 pt-6 text-xs text-faint">
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
        {/* 「作品一覧」「アカウント」はヘッダーにあるので、ここには置かない。
            残すのはヘッダーに無いものだけ。 */}
        <p className="pt-2">
          <Link href="/health/auth" className="underline">
            サインイン状態を確認する
          </Link>
        </p>
      </footer>
    </main>
  );
}
