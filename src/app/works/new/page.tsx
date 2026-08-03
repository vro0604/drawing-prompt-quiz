import Link from "next/link";
import { getCurrentUser } from "@/features/auth/session";
import { fetchMyPrompt } from "@/features/draft/rpc";
import { formatDuration } from "@/features/draft/types";
import { WorkForm } from "./_form";

/**
 * /works/new ／ 作品を投稿する画面。
 *
 * 【入口はお題】
 *   ?promptId=... が必ず要る。作品は「どのお題から生まれたか」と
 *   1対1で結びつくため（works.prompt_id の UNIQUE。A11 / D17）。
 *   お題のないところから作品だけを作ることはできない。
 *
 * 【他人のお題IDを入れたら】
 *   get_my_prompt が null を返すので「見つかりません」になる。
 *   「権限がありません」とは言わない。存在するかどうかを教えないため（D40）。
 *
 * 【ここでの確認は親切であって守りではない】
 *   登録済みか・お題の持ち主か・そのお題がまだ使えるかは、
 *   すべて create_work（D27 の6検査）が最終的に判定する。
 *   この画面が見せているのは、投稿ボタンを押す前に分かることだけ。
 *
 * Next.js 16 では searchParams が Promise なので await が必要。
 */

export const metadata = {
  title: "作品を投稿する",
};

const box =
  "rounded-2xl border border-black/10 bg-white/60 p-6 dark:border-white/15 dark:bg-white/5";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 p-6 sm:p-10">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">作品を投稿する</h1>
        <p className="text-sm text-black/55 dark:text-white/55">
          描いた絵と、引いたお題を結びつけます。見た人は絵だけを見てお題を当てます。
        </p>
      </header>
      {children}
    </main>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={`${box} space-y-3`}>
      <h2 className="text-sm font-bold">{title}</h2>
      <div className="space-y-2 text-sm text-black/60 dark:text-white/60">{children}</div>
    </div>
  );
}

export default async function NewWorkPage({
  searchParams,
}: {
  searchParams: Promise<{ promptId?: string; error?: string }>;
}) {
  const { promptId, error } = await searchParams;

  const errorBox = error ? (
    <p className="rounded-xl bg-rose-500/10 px-4 py-3 text-sm whitespace-pre-wrap text-rose-700 dark:text-rose-300">
      {error}
    </p>
  ) : null;

  // --- お題が指定されていない -------------------------------------------------
  if (!promptId) {
    return (
      <Shell>
        {errorBox}
        <Notice title="どのお題の作品かが分かりません">
          <p>投稿はお題の画面から始めてください。</p>
          <p>
            <Link href="/play" className="underline">
              お題を引く画面へ
            </Link>
          </p>
        </Notice>
      </Shell>
    );
  }

  // --- 誰として来ているか ----------------------------------------------------
  //
  // 未サインインのまま get_my_prompt を呼ぶと permission denied になる
  // （anon には実行権限が無い）。呼ぶ前に分ける。
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
          <p>
            ゲストのままお題を引くことはできますが、作品の投稿はできません（spec C3）。
          </p>
          <p>
            いまのゲストのまま登録すれば <strong>同じアカウントのまま</strong> 続けられ、
            引いたお題もそのまま使えます。
          </p>
          <p>
            <Link href="/account" className="underline">
              アカウントを登録する
            </Link>
          </p>
        </Notice>
      </Shell>
    );
  }

  // --- お題を読む ------------------------------------------------------------
  const prompt = await fetchMyPrompt(promptId);

  if (!prompt) {
    return (
      <Shell>
        {errorBox}
        <Notice title="そのお題は見つかりません">
          <p>URL が間違っているか、自分が引いたお題ではありません。</p>
          <p>
            <Link href="/play" className="underline">
              お題を引く画面へ
            </Link>
          </p>
        </Notice>
      </Shell>
    );
  }

  if (prompt.work_id) {
    return (
      <Shell>
        <Notice title="このお題ではもう投稿しています">
          <p>1つのお題から作れる作品は1件までです（A11 / D17）。</p>
          <p>
            <Link href={`/works/${prompt.work_id}`} className="underline">
              投稿した作品を見る
            </Link>
          </p>
        </Notice>
      </Shell>
    );
  }

  if (prompt.status !== "active") {
    return (
      <Shell>
        <Notice title="このお題はもう使えません">
          <p>状態: {prompt.status}</p>
          <p>
            <Link href="/play" className="underline">
              新しいお題を引く
            </Link>
          </p>
        </Notice>
      </Shell>
    );
  }

  // --- 投稿フォーム ----------------------------------------------------------
  return (
    <Shell>
      {errorBox}

      {/* 何を描いたはずかを手元で確認できるように、答えを並べておく。
          この情報が外へ出ないのは get_my_prompt が本人にしか返さないから。 */}
      <section className={`${box} space-y-4`}>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 className="text-sm font-bold">{prompt.mode_label}のお題</h2>
          <span className="text-xs text-black/55 dark:text-white/55">
            制作時間 {formatDuration(prompt.time_limit_seconds)}
          </span>
        </div>
        <ul className="flex flex-wrap gap-2">
          {prompt.cards.map((c) => (
            <li
              key={c.card_slot_key}
              className="rounded-lg bg-black/[0.04] px-3 py-1.5 text-xs dark:bg-white/10"
            >
              <span className="text-black/45 dark:text-white/45">{c.card_slot_label}</span>{" "}
              <span className="font-bold">{c.tag_label}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-black/40 dark:text-white/40">
          この一覧は自分にしか見えません。投稿した作品のページには出ません。
        </p>
      </section>

      <WorkForm promptId={promptId} />

      <footer className="border-t border-black/10 pt-6 text-xs text-black/40 dark:border-white/10 dark:text-white/40">
        <Link href={`/prompt/${promptId}`} className="underline">
          お題の画面へ戻る
        </Link>
      </footer>
    </Shell>
  );
}
