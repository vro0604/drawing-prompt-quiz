import Link from "next/link";
import { getCurrentUser } from "@/features/auth/session";
import { fetchArtFirstVocabulary } from "@/features/artfirst/rpc";
import { EMPTY_VOCABULARY, type ArtFirstVocabulary } from "@/features/artfirst/types";
import { ImportForm } from "./_form";
import { noticeError, surface } from "@/app/_surface";
import { requireConsent } from "@/features/consent/rpc";

/**
 * /works/import ／ 描いた絵を持ち込んで、どう見えるか試す画面。
 *
 * 【お題を引く画面との違い】
 *   /play → /prompt/[id] → /works/new は「先にお題があって、それを描く」流れ。
 *   ここは逆で、**先に絵があり、作者が「この絵で何が伝わるか」を選ぶ。**
 *   選んだ語がそのまま、見る人へのクイズの正解になる。
 *
 * 【この画面が持っていないもの】
 *   ・お題（引いていないので promptId が無い。URL にも要らない）
 *   ・制作時間と時計（測っていない挑戦なので、時間の欄を出さない）
 *
 * 【ここでの確認は親切であって守りではない】
 *   登録済みか・語が有効か・何件選んだか・画像の置き場所は、すべて
 *   create_art_first_work と create_work（D27 の6検査）が最終的に判定する。
 */

export const metadata = {
  title: "描いた絵で試す",
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 p-6 sm:p-10">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">描いた絵で試す</h1>
        <p className="text-sm text-faint">
          手元にある絵を出して、それが人にどう見えるかを試せます。
          この絵で試したいことを選ぶと、見た人はその項目を絵だけから当てます。
        </p>
      </header>
      {children}
    </main>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={`${surface} space-y-3`}>
      <h2 className="text-sm font-bold">{title}</h2>
      <div className="space-y-2 text-sm text-muted">{children}</div>
    </div>
  );
}

export default async function ImportWorkPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // 未同意の登録者をここで止める（P5）。**判定は DB の consent_status()。**
  // 止めるのは、そのセッションが関門より後に始まっていて、かつ未同意のときだけ。
  await requireConsent();

  const { error } = await searchParams;
  const errorBox = error ? <p className={noticeError}>{error}</p> : null;

  const user = await getCurrentUser();

  if (!user) {
    return (
      <Shell>
        {errorBox}
        <Notice title="サインインが必要です">
          <p>作品の投稿にはアカウントが必要です。</p>
          <p>
            <Link href="/account" className="underline">
              アカウントの画面へ
            </Link>
          </p>
        </Notice>
      </Shell>
    );
  }

  if (user.is_anonymous) {
    return (
      <Shell>
        {errorBox}
        <Notice title="投稿にはアカウント登録が必要です">
          <p>ゲストのままお題を引くことはできますが、作品の投稿はできません（spec C3）。</p>
          <p>
            <Link href="/account" className="underline">
              アカウントを登録する
            </Link>
          </p>
        </Notice>
      </Shell>
    );
  }

  // 規約への同意は登録のときに済ませる（P5）。入口の requireConsent が止める。

  // 語の一覧が読めなくても、画面ごと落とさない。
  // 選べる語が0件なら、フォーム側が「いま選べません」と出して投稿を止める。
  let vocabulary: ArtFirstVocabulary = EMPTY_VOCABULARY;
  let loadError: string | null = null;

  try {
    vocabulary = await fetchArtFirstVocabulary();
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  }

  return (
    <Shell>
      {errorBox}
      {loadError ? <p className={noticeError}>{loadError}</p> : null}

      <section className={`${surface} space-y-3`}>
        <h2 className="text-sm font-bold">この画面でできること</h2>
        <ul className="space-y-2 text-sm text-muted">
          <li>
            すでに描いてある絵を出せます。お題を引く必要はありません。
          </li>
          <li>
            選んだ項目は、<strong>作品を見る人への問題になります。</strong>
            見た人は絵だけを手がかりに、その項目を当てます。
          </li>
          <li>
            当たったか外れたかは、あとから自分の作品ページで見られます。
          </li>
        </ul>
      </section>

      {/* 規約への同意はここでは求めない（P5）。入口の requireConsent が止める。 */}
      <ImportForm vocabulary={vocabulary} />

      <footer className="border-t border-ink/10 pt-6 text-xs text-faint">
        <p>
          お題を引いて描きたいときは{" "}
          <Link href="/play" className="underline">
            お題を引く画面
          </Link>{" "}
          へ。
        </p>
      </footer>
    </Shell>
  );
}
