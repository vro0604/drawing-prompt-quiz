import Link from "next/link";
import { notFound } from "next/navigation";
import { subDirectiveLabel } from "@/features/modifier/types";
import { shapeAssistLabel } from "@/features/shape-assist/types";
import { fetchMyPrompt, fetchPromptTimer } from "@/features/draft/rpc";
import { getCurrentUser } from "@/features/auth/session";
import {
  btnPrimary,
  btnQuiet,
  btnSecondary,
  noticeError,
  noticeMuted,
  noticeSuccess,
} from "@/app/_surface";
import { SubmitButton } from "@/app/_pending";
import { abandonPromptAction, revealPromptCandidatesAction } from "./actions";
import { CarryFromPromptBox, TimerBox } from "./_timer";
import { requireConsent } from "@/features/consent/rpc";

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
  // 未同意の登録者をここで止める（P5）。**判定は DB の consent_status()。**
  // 止めるのは、そのセッションが関門より後に始まっていて、かつ未同意のときだけ。
  await requireConsent();

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
        {/* 放棄したお題を開いたときに「確定しました」と出ると、
            まだ描ける状態に見える。状態ごとに一言だけ変える。 */}
        {prompt.status === "abandoned" ? (
          <p className="text-xs font-bold tracking-wider text-faint">
            このお題はやめました
          </p>
        ) : (
          <p className="text-xs font-bold tracking-wider text-success">
            お題が確定しました
          </p>
        )}
        <h1 className="text-2xl font-bold">{prompt.mode_label}のお題</h1>
        <p className="text-sm text-faint">
          {prompt.cards.length} 語
          {prompt.was_rerolled ? `・引き直し ${prompt.reroll_count} 回` : ""}
        </p>
      </header>

      {/* 形状アシスト（D191）。**お題ではない。**
          この画面に居るのは必ずそのお題の作者なので、ここに出しても
          回答者には届かない（get_my_prompt が created_by で絞っている）。

          下のお題カードと同じ見た目にしない。守らせるものではないので、
          文言でもそう書く。出所: ユーザー指示（2026-09-09）
          「正式お題と視覚的に同格に見せない」「『必須条件』と誤解させない」。 */}
      {shapeAssistLabel(prompt.shape_assist_key) ? (
        <p className={noticeMuted} data-testid="prompt-shape-assist">
          形状アシスト:{" "}
          <span className="font-bold text-muted">
            {shapeAssistLabel(prompt.shape_assist_key)}
          </span>
          {" — "}
          始める前に選んだ、発想の手がかりです。お題ではありません。
          守らなくても投稿できますし、クイズにも出ません。
        </p>
      ) : null}

      {/* 時計は「引いてから描く」挑戦のためのもの。
          持ち込み（art_first）は投稿と同時に作られるお題なので、
          出すと「かかった時間 0秒」になる。**測っていない値を出さない。** */}
      {timer && prompt.origin !== "art_first" ? (
        <TimerBox promptId={prompt.id} timer={timer} />
      ) : null}

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
            className="rounded-2xl border border-line bg-surface px-6 py-5"
          >
            <div className="flex items-baseline gap-4">
              <span className="w-28 shrink-0 text-xs text-faint">
                {c.card_slot_label}
              </span>
              <span className="text-lg font-bold">{c.tag_label}</span>
            </div>

            {/* サブ指令（D193）。**正式なお題ではない。**
                上の語と同じ大きさで出さない。字も小さく、色も薄くしてある。
                断り書きはここに繰り返さず、下の説明にまとめてある
                （1画面に同じ注意書きを何度も置かない）。
                出所: ユーザー指示（2026-09-10）「正式お題より一段弱い見た目にする」
                「既存の形状アシスト説明と重複しすぎないよう、
                画面全体を見て最小表示にする」。 */}
            {subDirectiveLabel(c.sub_directive_key) ? (
              <p
                data-testid="prompt-sub-directive"
                data-sub-directive-for={c.card_slot_key}
                className="mt-2 pl-32 text-xs text-faint"
              >
                └ {subDirectiveLabel(c.sub_directive_key)}
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="space-y-4 rounded-2xl bg-sunken p-6 text-sm">
        <p className="font-bold">この内容で描いてください。</p>
        {/* サブ指令が1つでも出ているときだけ、断り書きを1度だけ置く（D193）。
            語ごとに繰り返すと、正式なお題と同じ重さに見えてしまう。 */}
        {prompt.cards.some((c) => subDirectiveLabel(c.sub_directive_key)) ? (
          <p className="text-muted" data-testid="sub-directive-note">
            語の下に小さく添えてあるのは、描くときの手がかりです。お題ではありません。
            守らなくてもかまいませんし、クイズにも出ません。
          </p>
        ) : null}
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
        ) : prompt.status === "failed" || prompt.status === "abandoned" ? (
          // やめたお題では投稿の入口を出さない。**画面で隠すだけではない。**
          // create_work が status <> 'active' を断るので、
          // /works/new へ直接来ても同じところで止まる。
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

      {/* ------------------------------------------------------------------
          引かなかったカード（spec 4-4）

          【この画面に居る人は、必ずそのお題の作成者】
            get_my_prompt が created_by = auth.uid() の行しか返さないので、
            他人が開くと上で 404 になっている（D40）。だからここでは
            改めて本人か確かめていない。**ただし錠は画面ではなく DB 側にある。**
            reveal_prompt_candidates も abandon_prompt も、それぞれ自分で
            作成者を確かめる。ボタンを隠すのは見やすさのためだけ。

          【制作中の「残りを見る」とは別の操作】
            あちらは /play でカードをめくっている最中に、枠1つぶんの残りを
            開くもの。こちらはお題が決まったあとに、お題ごと開くもの。
            同じ画面には出ないが、読む人が混ぜないように一行そえる。
      ------------------------------------------------------------------ */}
      {prompt.candidates_revealed_at ? (
        <section className="space-y-3" data-unchosen="open">
          <h2 className="text-sm font-bold">引かなかったカード</h2>
          <ul className="flex flex-wrap gap-2">
            {prompt.unchosen.map((u) => (
              <li
                key={`${u.card_slot_key}-${u.candidate_index}`}
                data-unchosen-card={u.card_slot_key}
                className="rounded-lg bg-hover px-3 py-1.5 text-xs"
              >
                {u.card_slot_label}: {u.tag_label}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <section className="space-y-3" data-unchosen="closed">
          <h2 className="text-sm font-bold">引かなかったカード</h2>
          <p className="text-xs text-faint">
            引かなかったカードは、作品を投稿したあと、または挑戦をやめたあとに見られます。
            待たずに、いま見ることもできます。
          </p>
          {/* 投稿が済んでいるお題には出さない。投稿の完了そのものが開示の契機
              （reveal_reason = work_submitted）なので、押す操作が要らない。 */}
          {prompt.work_id === null ? (
            <>
              <form action={revealPromptCandidatesAction}>
                <input type="hidden" name="promptId" value={prompt.id} />
                <SubmitButton
                  pendingLabel="開いています…"
                  className={btnSecondary}
                  data={{ "data-reveal-candidates": "manual" }}
                >
                  他の候補を見る
                </SubmitButton>
              </form>
              <p className="text-xs text-faint">
                一度開くと元に戻せません。開いても、このお題で描いて投稿することは
                そのまま続けられます。
              </p>
            </>
          ) : null}
        </section>
      )}

      {/* このお題は描かない（spec 4-4 のチャレンジ放棄）。
          進行中のお題にだけ出す。投稿済み・期限切れ・やめたあとには出さない。 */}
      {prompt.status === "active" && prompt.work_id === null ? (
        <section className="space-y-3 border-t border-line pt-6">
          <p className="text-xs text-faint">
            描かないことにした場合は、ここでやめられます。やめると、このお題では
            作品を投稿できなくなります。かわりに引かなかったカードが開きます。
          </p>
          <form action={abandonPromptAction}>
            <input type="hidden" name="promptId" value={prompt.id} />
            <SubmitButton
              pendingLabel="やめています…"
              className={btnQuiet}
              data={{ "data-abandon-prompt": "1" }}
            >
              このお題は描かない
            </SubmitButton>
          </form>
        </section>
      ) : null}
    </main>
  );
}
