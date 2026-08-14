import {
  scoreLabel,
  type MyAnswer,
  type QuizQuestion,
  type WorkQuiz,
} from "@/features/quiz/types";
import {
  slotAccuracy,
  type MyWorkResult,
  type SlotStat,
} from "@/features/work/types";
import { submitAnswerAction } from "./actions";
import { SubmitButton } from "@/app/_pending";
import { btnPrimary, noticeMuted, surface } from "@/app/_surface";

/**
 * 作品ページのクイズ部分。
 *
 * 【正解がこの世に出てくる順番】
 *   1. 出題（QuizForm）… tag_id と label だけ。**正解の印は無い**
 *   2. 送信 … 選んだ tag_id を送るだけ
 *   3. 採点 … DB の submit_answer の中だけで行われる
 *   4. 結果（AnswerResult）… ここで初めて正解が返ってくる
 *
 *   つまり、答える前のページのソースをいくら読んでも正解は出てこない。
 *   これは「画面に出さない」ではなく「そもそも送られてこない」形で
 *   実現している。
 *
 * すべて Server Component。ボタンは form の送信で、
 * JavaScript が無効でも動く。
 */

/** 出題。1問につきラジオボタン4つ */
function QuestionBlock({ question }: { question: QuizQuestion }) {
  return (
    // fieldset と legend は**意味づけ**であって見た目ではない。
    // ラジオの集まりに名前を付ける正しい要素なので、検査が
    // このまとまりを手がかりにするのは構わない（枠線は消せる・並べ方も自由）。
    //
    // 一方 data-slot-label を足したのは、以前の検査が legend の
    // 「◯◯ はどれ？」という**文言**からラベルを削り出していたため。
    // 問いかけの言い回しを変えると検査が落ちる状態だった。
    <fieldset
      data-question=""
      data-slot-label={question.card_slot_label}
      className="space-y-3"
    >
      <legend className="text-sm font-bold">
        {question.position + 1}. {question.card_slot_label} はどれ？
      </legend>

      <div className="grid gap-2 sm:grid-cols-2">
        {question.choices.map((c) => (
          <label
            key={c.tag_id}
            className="flex cursor-pointer items-center gap-3 rounded-xl border border-line px-4 py-3 text-sm hover:bg-sunken has-checked:border-line-active"
          >
            {/* name に問のIDを埋め込む。送信側はこの接頭辞で選択を拾う。
                value は tag_id で、正解かどうかの情報は含まれない。

                data-choice-label は検査用。以前は「input の**次の** span」を
                選択肢の文字として読んでいたので、札のような見た目に変えると
                検査が落ちた。**4択の文字は元から全部 HTML に出ている**ので
                （どれが正解かは分からないまま）、ここに写しても漏れは増えない。 */}
            <input
              type="radio"
              name={`q_${question.question_id}`}
              value={c.tag_id}
              data-choice-label={c.label}
              required
            />
            <span>{c.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** まだ答えていない人に出す回答フォーム */
export function QuizForm({ quiz }: { quiz: WorkQuiz }) {
  if (quiz.questions.length === 0) {
    return (
      <div className={surface}>
        <p className="text-sm">この作品にはまだ問題が用意されていません。</p>
      </div>
    );
  }

  return (
    <form action={submitAnswerAction} className={`${surface} space-y-6`}>
      <input type="hidden" name="workId" value={quiz.work_id} />

      <div className="space-y-1">
        <h2 className="text-sm font-bold">この絵のお題を当てる</h2>
        <p className="text-xs text-faint">
          全{quiz.questions.length}問。<strong>答えられるのは1回だけ</strong>
          で、やり直しはできません。送信すると正解が表示されます。
        </p>
      </div>

      <div className="space-y-6">
        {quiz.questions.map((q) => (
          <QuestionBlock key={q.question_id} question={q} />
        ))}
      </div>

      <div className="space-y-2">
        <SubmitButton
          pendingLabel="採点しています…"
          className={`${btnPrimary} w-full`}
        >
          回答する
        </SubmitButton>
        <p className="text-xs text-faint">
          サインインしていない場合、送信した時点でゲストとして記録されます。
          アカウント登録は不要です。
        </p>
      </div>
    </form>
  );
}

/** 答え終わった本人に出す結果 */
export function AnswerResult({ answer }: { answer: MyAnswer }) {
  const allCorrect = answer.correct_count === answer.items.length;

  return (
    <section className={`${surface} space-y-5`}>
      <div className="space-y-1">
        <h2 className="text-sm font-bold">あなたの回答</h2>
        <p className="text-lg font-bold">
          {scoreLabel(answer)}
          {allCorrect ? "（全問正解）" : ""}
        </p>
      </div>

      <ol className="space-y-3">
        {answer.items.map((item) => (
          <li
            key={item.question_id}
            className={
              item.is_correct
                ? "rounded-xl border border-success-tint/40 bg-success-tint/5 px-4 py-3"
                : "rounded-xl border border-danger-tint/40 bg-danger-tint/5 px-4 py-3"
            }
          >
            <div className="flex items-baseline gap-3">
              <span className="text-xs text-faint">
                {item.card_slot_label}
              </span>
              <span
                className={
                  item.is_correct
                    ? "text-xs font-bold text-success"
                    : "text-xs font-bold text-danger"
                }
              >
                {item.is_correct ? "正解" : "不正解"}
              </span>
            </div>

            <div className="pt-1 text-sm">
              <span className="text-faint">あなたの答え：</span>
              <span className="font-bold">{item.selected_label}</span>
              {item.is_correct ? null : (
                <>
                  <span className="px-2 text-decor">/</span>
                  <span className="text-faint">正解：</span>
                  <span className="font-bold">{item.correct_label}</span>
                </>
              )}
            </div>
          </li>
        ))}
      </ol>

      <p className="text-xs text-faint">
        回答は1作品につき1回だけです。もう一度答えることはできません。
      </p>
    </section>
  );
}

/** 作者本人に出す案内。自作には回答できない（D28） */
export function AuthorNotice() {
  return (
    <div className={`${surface} space-y-2`}>
      <h2 className="text-sm font-bold">この作品のクイズ</h2>
      <p className="text-sm text-muted">
        自分の作品には回答できません。答えを知っているため、
        回答すると伝達率が実際より高く出てしまいます。
      </p>
    </div>
  );
}

/**
 * 枠ごとの伝達率。
 *
 * 「どの項目が伝わりにくかったか」を作者にも閲覧者にも見せる。
 * 割合しか出さないので、ここから正解のタグは分からない。
 *
 * まだ誰も答えていない枠は「—」にする。0% と出すと
 * 「誰も当てられなかった」と読めてしまい、意味が違うため。
 */
export function SlotStats({ stats }: { stats: SlotStat[] }) {
  if (stats.length === 0) {
    return (
      <div className={`${surface} space-y-2`}>
        <h2 className="text-sm font-bold">項目別の伝達率</h2>
        <p className="text-sm text-faint">
          まだ回答がありません。誰かが答えると、項目ごとに何％の人が当てられたかが出ます。
        </p>
      </div>
    );
  }

  return (
    <section className={`${surface} space-y-4`}>
      <div className="space-y-1">
        <h2 className="text-sm font-bold">項目別の伝達率</h2>
        <p className="text-xs text-faint">
          その項目を当てられた人の割合です。低い項目ほど、絵から読み取りにくかったことになります。
        </p>
      </div>

      <ul className="space-y-3">
        {stats.map((s) => {
          const percent = slotAccuracy(s);
          return (
            // 内訳は data-* にも出す。以前の検査は「1 / 2」という
            // **文字の並びと span の位置**から読んでいたので、
            // 数字の見せ方を変えると落ちた。
            <li
              key={s.card_slot_key}
              data-slot-stat={s.card_slot_key}
              data-corrects={s.corrects}
              data-attempts={s.attempts}
              className="space-y-1"
            >
              <div className="flex items-baseline justify-between text-sm">
                <span>{s.card_slot_label}</span>
                <span className="font-bold">
                  {percent === null ? "—" : `${percent}%`}
                  <span className="pl-2 text-xs font-normal text-faint">
                    {s.corrects} / {s.attempts}
                  </span>
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunken-strong">
                <div
                  className="h-full rounded-full bg-ink/60"
                  style={{ width: `${percent ?? 0}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * 自分の作品の結果。**封を切るまで数字を出さない**（D112 / D134）。
 *
 * 【なぜ既定で見せないのか】
 *   D8 は「未選択カードは自動開示しない。見せると気持ちが先に来て、
 *   描く意欲を削ぐ」と決めている。**数字も同じ。**
 *
 *   そして序列は「装飾」ではなく「比較可能性」から生まれる。
 *   自分だけが自分の数字を見るなら比較対象が存在せず、序列は生まれない。
 *
 * 【プル型の弱点と、その裏返し】
 *   開かれなければ核が届かない。だから「開きたくさせる」必要がある。
 *   ここで良いことが起きる。
 *
 *     常に見えている → 驚きが分散して消える
 *     封を切る       → 驚きがその一瞬に集中する
 *
 * 【予告に人数を出しても正答率にならない理由】
 *   2行目は「間違えた人」ではなく **「全部の枠を外した人」** の数。
 *   「3人中2人が間違えた」なら 1/3 と計算できてしまうが、
 *   全部外すのは珍しいので、そこから正答率は復元できない。
 *
 * 開くかどうかは `?result=open` で持つ。Client Component にしないのは、
 * JavaScript が無効でも開けるようにするため。
 */
export function MyResult({
  result,
  open,
  workId,
}: {
  result: MyWorkResult;
  open: boolean;
  workId: string;
}) {
  // まだ誰も答えていない。**0% とは書かない。**
  // 「誰にも伝わらなかった」と「まだ誰も見ていない」は別のこと
  if (result.answers_count === 0) {
    return (
      <section className={`${surface} space-y-2`}>
        <h2 className="text-sm font-bold">まだ誰も答えていません</h2>
        <p className="text-sm text-faint">
          誰かが答えると、ここで結果を見られるようになります。
        </p>
      </section>
    );
  }

  if (!open) {
    return (
      <section className={`${surface} space-y-4 text-center`}>
        <div className="space-y-2">
          <p className="text-base font-bold">
            {result.answers_count}人が、あなたの絵を読み解きました
          </p>
          {result.blind_count > 0 ? (
            <p className="text-sm text-muted">
              うち{result.blind_count}人は、まったく違うものを見ていました
            </p>
          ) : null}
        </div>

        <p>
          <a
            href={`/works/${workId}?result=open`}
            className={`${btnPrimary} inline-block`}
          >
            開く
          </a>
        </p>
      </section>
    );
  }

  const percent =
    result.total_items === 0
      ? null
      : Math.round((result.correct_items / result.total_items) * 100);

  return (
    <section className={`${surface} space-y-5`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-bold">結果</h2>
        <a
          href={`/works/${workId}`}
          className="text-xs text-faint underline"
        >
          閉じる
        </a>
      </div>

      <div className="flex items-baseline gap-3">
        <span className="text-3xl font-bold tabular-nums">
          {percent === null ? "—" : `${percent}%`}
        </span>
        <span className="text-xs text-faint">
          {result.correct_items} / {result.total_items} の項目が伝わりました
        </span>
      </div>

      {/*
        伝達率は上手さの物差しではない（D105）。
        **絵の巧拙とは独立した軸**なので、そう書いておく。
        「上手くなくていい」は、慰めではなく、この数字が示す事実。
      */}
      <p className={noticeMuted}>
        伝わりやすさは、絵の上手さとは別の軸です。
        線が荒くても伝わることも、丁寧に描いても伝わらないこともあります。
      </p>

      {result.misreads.length > 0 ? (
        <div className="space-y-2 border-t border-ink/10 pt-4">
          <h3 className="text-xs text-faint">
            代わりに選ばれたもの
          </h3>
          <ul className="space-y-1 text-sm">
            {result.misreads.map((m) => (
              <li
                key={`${m.slot_label}:${m.tag_label}`}
                className="flex items-baseline justify-between gap-4"
              >
                <span>
                  <span className="text-faint">{m.slot_label}</span>
                  <span className="pl-2">{m.tag_label}</span>
                </span>
                <span className="shrink-0 text-xs text-faint tabular-nums">
                  {m.count}人
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-faint">
            誰が選んだかは記録していません。
          </p>
        </div>
      ) : null}
    </section>
  );
}
