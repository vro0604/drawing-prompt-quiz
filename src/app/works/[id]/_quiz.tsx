import {
  MODE_LABEL,
  modeBreakdown,
  scoreLabel,
  type MyAnswer,
  type QuizQuestion,
  type WorkQuiz,
} from "@/features/quiz/types";
import {
  ratioPercent,
  slotExactAccuracy,
  slotPairAccuracy,
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

/**
 * 出題。1問につき選択肢が4つ（語彙が足りない問だけ3つ）。
 *
 * 【ラジオボタンではなくチェックボックスにした理由】
 *   D165 が回答方式を2つ並立させた。
 *     1つ選ぶ → ビタ当て（この語だと断定した）
 *     2つ選ぶ → 2択当て（この2語のどちらかまでは絞れた）
 *   ラジオボタンは1つしか選べないので、2択当てを表現できない。
 *   チェックボックスなら、**同じ操作の中で回答者が方式を選べる。**
 *   別のボタンで方式を切り替える形にしないのは、
 *   JavaScript 無しでも動かすためと、操作を1段減らすため。
 *
 *   3つ以上選ばれた場合は Server Action が断る。
 *   **画面で押せなくするのではなく、送られてから断る。**
 *   フォームは誰でも作れるので、止める場所は最後に1つあればよい。
 *
 * 【選んだ数で暗黙に決まるだけにしない】
 *   チェックの数だけで方式が変わると、送るまで自分がどちらで
 *   答えたことになるのか分からない。そこで問ごとに
 *   「いまの答え方」を文字で出す（未選択／ビタ当て／2択当て／3つ以上）。
 *   出し分けは CSS の :has() で行い、JavaScript には依存しない。
 *
 * 【方式は問ごとに選ぶ。挑戦の最初に決めるものではない】
 *   D165 の 3「各問題について、回答者は次のどちらかで答える」と、
 *   同 6 の回答者B「ビタ当て2問・2択当て4問」がその形を示している。
 */
function QuestionBlock({ question }: { question: QuizQuestion }) {
  return (
    // fieldset と legend は**意味づけ**であって見た目ではない。
    // 選択肢の集まりに名前を付ける正しい要素なので、検査が
    // このまとまりを手がかりにするのは構わない（枠線は消せる・並べ方も自由）。
    //
    // data-slot-key も出す。**枠の呼び名は重複する**（「モーフ」は
    // morph_1 / morph_2 / morph_3 の3つに付く）ので、呼び名だけで
    // 問と答えを突き合わせると、別の枠の答えと組んでしまう。
    // 一意なのは枠のキーと問のIDのほう。
    <fieldset
      data-question={question.question_id}
      data-slot-key={question.card_slot_key}
      data-slot-label={question.card_slot_label}
      data-choice-count={question.choices.length}
      className="space-y-3"
    >
      <legend className="text-sm font-bold">
        {question.position + 1}. {question.card_slot_label} はどれ？
      </legend>

      <div className="answer-mode-choices grid gap-2 sm:grid-cols-2">
        {question.choices.map((c) => (
          <label
            key={c.tag_id}
            className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-line px-4 py-3 text-sm hover:bg-sunken has-checked:border-line-active"
          >
            {/* name に問のIDを埋め込む。送信側はこの接頭辞で選択を拾い、
                同じ name が2つ来たら2択当てとして扱う。
                value は tag_id で、正解かどうかの情報は含まれない。 */}
            <input
              type="checkbox"
              name={`q_${question.question_id}`}
              value={c.tag_id}
              data-choice-label={c.label}
            />
            <span>{c.label}</span>
          </label>
        ))}

        {/*
          いま何個選んでいるかで、この問の答え方が決まる。
          **選んだ数から暗黙に決まるだけにしない。**送る前に、
          いまどちらで送ることになるのかを、この問の場所に文字で出す。

          4つのうち1つだけが見える。切り替えは CSS が行うので
          JavaScript が無効でも動く（globals.css の .answer-mode-choices）。
          選択肢より**後ろ**に置いてあるのは、CSS が「チェック済みの選択肢が
          何個先行しているか」を数えて出し分けるため。先行の数しか数えられない。
        */}
        <p
          className="answer-mode-state text-xs sm:col-span-2"
          aria-live="polite"
          data-question-mode={question.question_id}
        >
          <span data-state="none" className="text-notice">
            回答を選んでください（1つ選ぶとビタ当て、2つ選ぶと2択当て）
          </span>
          <span data-state="exact">
            いまの答え方: <span className="font-bold">ビタ当て</span>
            （1つ選択中）。この語だと断定して送ります
          </span>
          <span data-state="pair">
            いまの答え方: <span className="font-bold">2択当て</span>
            （2つ選択中）。どちらかが正解なら的中しますが、
            「2つまでしか絞れなかった」として残ります
          </span>
          <span data-state="over" className="text-danger">
            3つ以上は選べません。1つか2つに減らしてください
          </span>
        </p>
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

      <div className="space-y-2">
        <h2 className="text-sm font-bold">この絵のお題を当てる</h2>
        {/* 問数は作品ごとに変わる（お題の語数と同じ）。数字は必ず quiz から取る */}
        <p className="text-xs text-faint" data-question-count={quiz.questions.length}>
          全{quiz.questions.length}問。この絵のお題になった語が、すべて出ます。
          <strong>答えられるのは1回だけ</strong>
          で、やり直しはできません。送信すると正解が表示されます。
        </p>
        <div className="rounded-xl bg-sunken px-4 py-3 text-xs leading-relaxed">
          <p className="font-bold">答え方は2通りあります。問ごとに選べます。</p>
          <p>
            1つだけ選ぶと「ビタ当て」。その語が合っていれば的中です。
          </p>
          <p>
            2つ選ぶと「2択当て」。どちらかが合っていれば的中です。
            ただし記録には「2つまでしか絞れなかった」として残ります。
          </p>
          <p className="pt-1">
            結果の違いは、的中したかどうかではなく
            <span className="font-bold">残りかた</span>
            です。ビタ当ての的中と2択当ての的中は別々に数えられ、
            作者へもそのまま別々の数で届きます。ひとつの正答率にまとめません。
          </p>
          <p className="pt-1 text-faint">
            どちらを選んでも減点はありません。
            いまどちらで送ることになるかは、問ごとに表示されます。
          </p>
        </div>
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
  const total = answer.question_count || answer.items.length;
  const allCorrect = answer.correct_count === total;
  const breakdown = modeBreakdown(answer);

  return (
    <section className={`${surface} space-y-5`}>
      <div className="space-y-1">
        <h2 className="text-sm font-bold">あなたの回答</h2>
        <p className="text-lg font-bold" data-question-count={total}>
          {scoreLabel(answer)}
          {allCorrect ? "（全問的中）" : ""}
        </p>
        {breakdown ? (
          <p className="text-xs text-faint" data-mode-breakdown={breakdown}>
            {breakdown}
          </p>
        ) : null}
        {allCorrect && answer.pair_attempts > 0 ? (
          <p className="text-xs text-faint">
            全問的中ですが、{answer.pair_attempts}問は2つまでの絞り込みでした。
            全問をビタ当てで通した回答とは別の記録として残ります。
          </p>
        ) : null}
      </div>

      <ol className="space-y-3">
        {answer.items.map((item) => (
          <li
            key={item.question_id}
            data-answer-item={item.question_id}
            data-answer-mode={item.answer_mode}
            className={
              item.is_correct
                ? "rounded-xl border border-success-tint/40 bg-success-tint/5 px-4 py-3"
                : "rounded-xl border border-danger-tint/40 bg-danger-tint/5 px-4 py-3"
            }
          >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-xs text-faint">
                {item.card_slot_label}
              </span>
              <span className="text-xs text-faint">
                {MODE_LABEL[item.answer_mode]}
              </span>
              <span
                className={
                  item.is_correct
                    ? "text-xs font-bold text-success"
                    : "text-xs font-bold text-danger"
                }
              >
                {item.is_correct ? "的中" : "はずれ"}
              </span>
            </div>

            <div className="pt-1 text-sm">
              <span className="text-faint">あなたの答え：</span>
              <span className="font-bold">{item.selected_label}</span>
              {item.selected_label_2 ? (
                <>
                  <span className="px-1 text-faint">か</span>
                  <span className="font-bold">{item.selected_label_2}</span>
                </>
              ) : null}
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
 *
 * 【1つの割合にまとめない】
 *   以前はビタ当てと2択当てを足した corrects ÷ attempts を1つ出していた。
 *   D165 の 11-2 が「重みを付けて1つの伝達率にまとめない」と決めているので、
 *   **断定で当てられた割合と、2つまで絞られた割合を並べて出す。**
 *   足した数字は、どちらの意味でもなくなる。
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
          断定して当てた人（ビタ当て）と、2つまで絞って当てた人（2択当て）は、
          別々に数えています。
        </p>
      </div>

      <ul className="space-y-3">
        {stats.map((s) => {
          const exact = slotExactAccuracy(s);
          const pair = slotPairAccuracy(s);
          return (
            // 内訳は data-* にも出す。以前の検査は「1 / 2」という
            // **文字の並びと span の位置**から読んでいたので、
            // 数字の見せ方を変えると落ちた。
            <li
              key={s.card_slot_key}
              data-slot-stat={s.card_slot_key}
              data-corrects={s.corrects}
              data-attempts={s.attempts}
              data-exact-corrects={s.exact_corrects}
              data-exact-attempts={s.exact_attempts}
              data-pair-corrects={s.pair_corrects}
              data-pair-attempts={s.pair_attempts}
              className="space-y-1"
            >
              <div className="text-sm">{s.card_slot_label}</div>

              <div className="flex items-baseline justify-between text-xs">
                <span className="text-faint">断定（ビタ当て）</span>
                <span className="font-bold">
                  {exact === null ? "—" : `${exact}%`}
                  <span className="pl-2 font-normal text-faint">
                    {s.exact_corrects} / {s.exact_attempts}
                  </span>
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunken-strong">
                <div
                  className="h-full rounded-full bg-ink/60"
                  style={{ width: `${exact ?? 0}%` }}
                />
              </div>

              <div className="flex items-baseline justify-between pt-1 text-xs">
                <span className="text-faint">2つまで絞り込み（2択当て）</span>
                <span className="font-bold">
                  {pair === null ? "—" : `${pair}%`}
                  <span className="pl-2 font-normal text-faint">
                    {s.pair_corrects} / {s.pair_attempts}
                  </span>
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunken-strong">
                <div
                  className="h-full rounded-full bg-ink/40"
                  style={{ width: `${pair ?? 0}%` }}
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

  const exactPercent = ratioPercent(result.exact_correct, result.exact_items);
  const pairPercent = ratioPercent(result.pair_correct, result.pair_items);

  return (
    <section className={`${surface} space-y-5`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-bold">当てられた割合（内訳）</h2>
        <a
          href={`/works/${workId}`}
          className="text-xs text-faint underline"
        >
          閉じる
        </a>
      </div>

      {/*
        【2026-09-08。ここを主役から降ろした】
          もとはこの2つを 3xl の大きな数字で出していた。
          その数は「当てられた割合」でしかなく、**どう見えたかを何も言わない。**
          作品を出した人が最初に見る数として、この2つは弱い。

          消してはいない。当たった割合を知りたいときには要るし、
          どこで使われているかを確かめる前に消すのは早い。
          小さくして、語の分布と重なりの図（AuthorAnalysis）の下に置く。

        **1つにまとめた割合は出さない**（D165 の 11-2）。
          断定して当てた人と2つまで絞った人を足すと、どちらの意味でもなくなる。
      */}
      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
        <div
          data-mode-stat="exact"
          data-attempts={result.exact_items}
          data-corrects={result.exact_correct}
        >
          <div className="flex items-baseline gap-2">
            <span className="text-base font-bold tabular-nums">
              {exactPercent === null ? "—" : `${exactPercent}%`}
            </span>
            <span className="text-xs text-faint tabular-nums">
              {result.exact_correct} / {result.exact_items}
            </span>
          </div>
          <p className="text-xs text-faint">断定して当てられた（ビタ当て）</p>
        </div>

        <div
          data-mode-stat="pair"
          data-attempts={result.pair_items}
          data-corrects={result.pair_correct}
        >
          <div className="flex items-baseline gap-2">
            <span className="text-base font-bold tabular-nums">
              {pairPercent === null ? "—" : `${pairPercent}%`}
            </span>
            <span className="text-xs text-faint tabular-nums">
              {result.pair_correct} / {result.pair_items}
            </span>
          </div>
          <p className="text-xs text-faint">2つまで絞って当てられた（2択当て）</p>
        </div>
      </div>

      {/* 分母は「出題された項目の総数」。**作品ごとに3〜6問と変わる**（D165）。
          割合にはしない。方式をまたいで数えた素の数として出す */}
      <p className="text-xs text-faint" data-total-items={result.total_items}>
        出題された項目は全部で {result.total_items} 個
        （うち断定で答えられたのが {result.exact_items} 個、
        2つまでの絞り込みが {result.pair_items} 個）。
      </p>

      {result.slots.length > 0 ? (
        <div className="space-y-2 border-t border-ink/10 pt-4">
          <h3 className="text-xs text-faint">項目ごとの当て方</h3>
          <ul className="space-y-1 text-sm">
            {result.slots.map((sl) => (
              <li
                key={sl.card_slot_key}
                data-result-slot={sl.card_slot_key}
                data-exact={sl.exact_corrects}
                data-pair={sl.pair_corrects}
                className="flex flex-wrap items-baseline justify-between gap-x-4"
              >
                <span className="text-faint">{sl.card_slot_label}</span>
                <span className="text-xs tabular-nums">
                  断定 {sl.exact_corrects}/{sl.exact_attempts}
                  <span className="px-2 text-decor">/</span>
                  絞り込み {sl.pair_corrects}/{sl.pair_attempts}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {result.legacy_answers > 0 ? (
        <p className="text-xs text-faint">
          このうち {result.legacy_answers} 件は、答え方が1通りしかなかった頃の回答です。
          断定と絞り込みの内訳はありません。
        </p>
      ) : null}

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
