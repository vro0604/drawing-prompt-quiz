import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchMyPrompt } from "@/features/draft/rpc";
import { formatDuration } from "@/features/draft/types";

/**
 * /prompt/[id] ／ 確定したお題を表示する。
 *
 * 【ここが「答え」を表示する唯一の画面】
 *   prompt_cards は誰も直接読めない。取り出せるのは get_my_prompt だけで、
 *   その関数は created_by = auth.uid() の行しか返さない。
 *
 *   **他人のお題IDを入れても「権限がありません」とは言わない。**
 *   存在しないIDと同じく null が返り、この画面は 404 を出す（D40）。
 *   「権限がありません」と返すと、そのIDが実在することを教えてしまうため。
 *
 * Next.js 16 では params が Promise なので await が必要。
 */

export const metadata = {
  title: "確定したお題",
};

export default async function PromptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const prompt = await fetchMyPrompt(id);
  if (!prompt) notFound();

  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 p-6 sm:p-10">
      <header className="space-y-2">
        <p className="text-xs font-bold tracking-wider text-emerald-600 dark:text-emerald-400">
          お題が確定しました
        </p>
        <h1 className="text-2xl font-bold">{prompt.mode_label}のお題</h1>
        <p className="text-sm text-black/55 dark:text-white/55">
          制作時間 {formatDuration(prompt.time_limit_seconds)}
          {prompt.was_rerolled ? `・引き直し ${prompt.reroll_count} 回` : ""}
        </p>
      </header>

      <ol className="space-y-3">
        {prompt.cards.map((c) => (
          // data-* は検査の手がかり。
          //
          // **ここは特に外してはいけない。**確定したお題（＝クイズの答え）を
          // 検査が読む唯一の場所で、読めた答えを使って
          // 「作品ページに漏れていないか」「一覧に漏れていないか」を
          // 全部のスモークが確かめている。
          //
          // 以前はこのカードの `class="w-28"` と `class="text-lg font-bold"` を
          // 手がかりにしていた。見た目を変えると答えが1件も読めなくなり、
          // **漏洩の検査が「空のリストを調べて合格」になる。**
          // 落ちるのではなく黙って通るので、いちばん危ない形だった。
          <li
            key={c.card_slot_key}
            data-prompt-card={c.card_slot_key}
            data-slot-label={c.card_slot_label}
            data-tag-label={c.tag_label}
            className="flex items-baseline gap-4 rounded-2xl border border-black/10 bg-white/60 px-6 py-5 dark:border-white/15 dark:bg-white/5"
          >
            <span className="w-28 shrink-0 text-xs text-black/50 dark:text-white/50">
              {c.card_slot_label}
            </span>
            <span className="text-lg font-bold">{c.tag_label}</span>
          </li>
        ))}
      </ol>

      <div className="space-y-4 rounded-2xl bg-black/[0.03] p-6 text-sm dark:bg-white/5">
        <p className="font-bold">この内容で描いてください。</p>
        <p className="text-black/60 dark:text-white/60">
          描き終えたら作品を投稿します。見た人はこのお題を4択で当てることになります。
          出題されるのは {prompt.cards.length} 枠のうち一部です。
        </p>

        {/* 1つのお題から作れる作品は1件まで（A11 / D17）。
            投稿済みなら投稿導線ではなく作品へのリンクを出す。 */}
        {prompt.work_id ? (
          <Link
            href={`/works/${prompt.work_id}`}
            className="inline-block rounded-xl border border-black/20 px-6 py-3 text-sm font-bold hover:bg-black/[0.04] dark:border-white/25 dark:hover:bg-white/10"
          >
            投稿した作品を見る
          </Link>
        ) : prompt.status === "active" ? (
          <Link
            href={`/works/new?promptId=${prompt.id}`}
            className="inline-block rounded-xl bg-black px-6 py-3 text-sm font-bold text-white hover:opacity-85 dark:bg-white dark:text-black"
          >
            このお題で描いた作品を投稿する
          </Link>
        ) : null}
      </div>

      {prompt.candidates_revealed_at ? (
        <section className="space-y-3">
          <h2 className="text-sm font-bold">引かなかったカード</h2>
          <ul className="flex flex-wrap gap-2">
            {prompt.unchosen.map((u) => (
              <li
                key={`${u.card_slot_key}-${u.candidate_index}`}
                className="rounded-lg bg-black/[0.04] px-3 py-1.5 text-xs dark:bg-white/10"
              >
                {u.card_slot_label}: {u.tag_label}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="text-xs text-black/40 dark:text-white/40">
          引かなかったカードは、作品を投稿したあと、または挑戦をやめたあとに見られます（D8）。
        </p>
      )}

      <footer className="border-t border-black/10 pt-6 text-sm dark:border-white/10">
        <Link href="/play" className="underline">
          お題を引く画面へ戻る
        </Link>
      </footer>
    </main>
  );
}
