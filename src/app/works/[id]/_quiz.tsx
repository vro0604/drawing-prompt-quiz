import {
  scoreLabel,
  type MyAnswer,
  type QuizQuestion,
  type WorkQuiz,
} from "@/features/quiz/types";
import { slotAccuracy, type SlotStat } from "@/features/work/types";
import { submitAnswerAction } from "./actions";
import { SubmitButton } from "@/app/_pending";

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

const box =
  "rounded-2xl border border-black/10 bg-white/60 p-6 dark:border-white/15 dark:bg-white/5";

/** 出題。1問につきラジオボタン4つ */
function QuestionBlock({ question }: { question: QuizQuestion }) {
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-bold">
        {question.position + 1}. {question.card_slot_label} はどれ？
      </legend>

      <div className="grid gap-2 sm:grid-cols-2">
        {question.choices.map((c) => (
          <label
            key={c.tag_id}
            className="flex cursor-pointer items-center gap-3 rounded-xl border border-black/10 px-4 py-3 text-sm hover:bg-black/[0.03] has-checked:border-black/40 dark:border-white/15 dark:hover:bg-white/5 dark:has-checked:border-white/50"
          >
            {/* name に問のIDを埋め込む。送信側はこの接頭辞で選択を拾う。
                value は tag_id で、正解かどうかの情報は含まれない。 */}
            <input type="radio" name={`q_${question.question_id}`} value={c.tag_id} required />
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
      <div className={box}>
        <p className="text-sm">この作品にはまだ問題が用意されていません。</p>
      </div>
    );
  }

  return (
    <form action={submitAnswerAction} className={`${box} space-y-6`}>
      <input type="hidden" name="workId" value={quiz.work_id} />

      <div className="space-y-1">
        <h2 className="text-sm font-bold">この絵のお題を当てる</h2>
        <p className="text-xs text-black/55 dark:text-white/55">
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
          className="w-full rounded-xl bg-black px-6 py-3 text-sm font-bold text-white hover:opacity-85 dark:bg-white dark:text-black"
        >
          回答する
        </SubmitButton>
        <p className="text-xs text-black/45 dark:text-white/45">
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
    <section className={`${box} space-y-5`}>
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
                ? "rounded-xl border border-emerald-500/40 bg-emerald-500/5 px-4 py-3"
                : "rounded-xl border border-rose-500/40 bg-rose-500/5 px-4 py-3"
            }
          >
            <div className="flex items-baseline gap-3">
              <span className="text-xs text-black/50 dark:text-white/50">
                {item.card_slot_label}
              </span>
              <span
                className={
                  item.is_correct
                    ? "text-xs font-bold text-emerald-700 dark:text-emerald-300"
                    : "text-xs font-bold text-rose-700 dark:text-rose-300"
                }
              >
                {item.is_correct ? "正解" : "不正解"}
              </span>
            </div>

            <div className="pt-1 text-sm">
              <span className="text-black/50 dark:text-white/50">あなたの答え：</span>
              <span className="font-bold">{item.selected_label}</span>
              {item.is_correct ? null : (
                <>
                  <span className="px-2 text-black/25 dark:text-white/25">/</span>
                  <span className="text-black/50 dark:text-white/50">正解：</span>
                  <span className="font-bold">{item.correct_label}</span>
                </>
              )}
            </div>
          </li>
        ))}
      </ol>

      <p className="text-xs text-black/45 dark:text-white/45">
        回答は1作品につき1回だけです。もう一度答えることはできません。
      </p>
    </section>
  );
}

/** 作者本人に出す案内。自作には回答できない（D28） */
export function AuthorNotice() {
  return (
    <div className={`${box} space-y-2`}>
      <h2 className="text-sm font-bold">この作品のクイズ</h2>
      <p className="text-sm text-black/60 dark:text-white/60">
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
      <div className={`${box} space-y-2`}>
        <h2 className="text-sm font-bold">項目別の伝達率</h2>
        <p className="text-sm text-black/55 dark:text-white/55">
          まだ回答がありません。誰かが答えると、項目ごとに何％の人が当てられたかが出ます。
        </p>
      </div>
    );
  }

  return (
    <section className={`${box} space-y-4`}>
      <div className="space-y-1">
        <h2 className="text-sm font-bold">項目別の伝達率</h2>
        <p className="text-xs text-black/50 dark:text-white/50">
          その項目を当てられた人の割合です。低い項目ほど、絵から読み取りにくかったことになります。
        </p>
      </div>

      <ul className="space-y-3">
        {stats.map((s) => {
          const percent = slotAccuracy(s);
          return (
            <li key={s.card_slot_key} className="space-y-1">
              <div className="flex items-baseline justify-between text-sm">
                <span>{s.card_slot_label}</span>
                <span className="font-bold">
                  {percent === null ? "—" : `${percent}%`}
                  <span className="pl-2 text-xs font-normal text-black/40 dark:text-white/40">
                    {s.corrects} / {s.attempts}
                  </span>
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/[0.07] dark:bg-white/10">
                <div
                  className="h-full rounded-full bg-black/60 dark:bg-white/60"
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
