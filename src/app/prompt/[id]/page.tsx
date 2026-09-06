import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchMyPrompt, fetchPromptTimer } from "@/features/draft/rpc";
import { getCurrentUser } from "@/features/auth/session";
import { btnPrimary, btnSecondary, noticeError, noticeSuccess } from "@/app/_surface";
import { CarryFromPromptBox, TimerBox } from "./_timer";

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
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { id } = await params;
  const { error, notice } = await searchParams;

  const prompt = await fetchMyPrompt(id);
  if (!prompt) notFound();

  // 期限の状態（D163）。他人のお題には null が返るが、
  // ここまで来ている時点で本人のお題だと分かっている
  const timer = await fetchPromptTimer(id);

  // 持ち出しは登録者のみ（D164）。本当の判定は save_prompt_elements が行う
  const user = await getCurrentUser();
  // 自分のお題からの持ち出しは、ゲストもできる（2026-09-05 の3区分）。
  // 違うのは「どこまで残るか」だけなので、その1点を画面に書く。
  const canPersist = user !== null && !user.is_anonymous;

  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 p-6 sm:p-10">
      {error ? <p className={noticeError}>{error}</p> : null}
      {notice ? <p className={noticeSuccess}>{notice}</p> : null}

      <header className="space-y-2">
        <p className="text-xs font-bold tracking-wider text-success">
          お題が確定しました
        </p>
        <h1 className="text-2xl font-bold">{prompt.mode_label}のお題</h1>
        <p className="text-sm text-faint">
          {prompt.cards.length} 語
          {prompt.was_rerolled ? `・引き直し ${prompt.reroll_count} 回` : ""}
        </p>
      </header>

      {timer ? <TimerBox promptId={prompt.id} timer={timer} /> : null}

      {/* **番号付きの並びにしない。**D158 は「複数のモーフに主対象・副対象の
          区別を設けない」「モーフ同士の関係もサービス側では固定しない」と
          決めている。<ol> にすると、上にあるものが主だと読める。 */}
      <ul className="space-y-3">
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
            className="flex items-baseline gap-4 rounded-2xl border border-line bg-surface px-6 py-5"
          >
            <span className="w-28 shrink-0 text-xs text-faint">
              {c.card_slot_label}
            </span>
            <span className="text-lg font-bold">{c.tag_label}</span>
          </li>
        ))}
      </ul>

      <div className="space-y-4 rounded-2xl bg-sunken p-6 text-sm">
        <p className="font-bold">この内容で描いてください。</p>
        <p className="text-muted">
          描き終えたら作品を投稿します。見た人はこのお題を4択で当てることになります。
          出題されるのは {prompt.cards.length} 語のうち一部です。
        </p>
        {/* D158「どう接続するかは描き手が解釈する」を、その場に書く。
            書かないと、並び順が指示に見える。 */}
        <p className="text-muted">
          並び順に主従の意味はありません。別々に描いても、1つに融合させても、
          関係を作っても構いません。どう繋ぐかは描き手が決めます。
        </p>

        {/* 1つのお題から作れる作品は1件まで（A11 / D17）。
            投稿済みなら投稿導線ではなく作品へのリンクを出す。
            挑戦が終了しているときは投稿の入口を出さない（D163）。 */}
        {prompt.work_id ? (
          <Link
            href={`/works/${prompt.work_id}`}
            className={`${btnSecondary} inline-block`}
          >
            投稿した作品を見る
          </Link>
        ) : prompt.status === "active" ? (
          <Link
            href={`/works/new?promptId=${prompt.id}`}
            className={`${btnPrimary} inline-block`}
          >
            このお題で描いた作品を投稿する
          </Link>
        ) : prompt.status === "failed" ? (
          <Link href="/play" className={`${btnSecondary} inline-block`}>
            新しいお題を引く
          </Link>
        ) : null}
      </div>

      <CarryFromPromptBox
        promptId={prompt.id}
        cards={prompt.cards}
        canPersist={canPersist}
      />

      {prompt.candidates_revealed_at ? (
        <section className="space-y-3">
          <h2 className="text-sm font-bold">引かなかったカード</h2>
          <ul className="flex flex-wrap gap-2">
            {prompt.unchosen.map((u) => (
              <li
                key={`${u.card_slot_key}-${u.candidate_index}`}
                className="rounded-lg bg-hover px-3 py-1.5 text-xs"
              >
                {u.card_slot_label}: {u.tag_label}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="text-xs text-faint">
          引かなかったカードは、作品を投稿したあと、または挑戦をやめたあとに見られます。
        </p>
      )}
    </main>
  );
}
