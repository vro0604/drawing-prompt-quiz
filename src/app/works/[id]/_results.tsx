import Image from "next/image";

import {
  cumulativeMatches,
  countOnes,
  formatRate,
  patternTable,
  rankWords,
  rarityLabel,
  scoreRate,
  sharePercent,
  type MyAnswerAnalysis,
  type SectionWords,
  type WorkAnswerAnalysis,
} from "@/features/quiz/results";
import { btnPrimary, btnQuiet, btnSecondary, surface } from "@/app/_surface";
import { SubmitButton } from "@/app/_pending";

/* ===========================================================================
 * 語ランキング
 * ===========================================================================
 *
 * 【順位を、選ばれた回数だけで決めない】
 *   語は「目の前に出た」ときにしか選ばれない。10回出て5回選ばれた語と、
 *   2回しか出ていない語を、選ばれた数だけで並べると後者が沈む。
 *   だから出た回数で割った値を順位にする。
 *
 *   いまは1つの作品につき4択が固定なので、どの語も同じ回数だけ出る。
 *   それでも割ってから並べるのは、**人ごとに選択肢を変えたときに
 *   並べ方を作り直さなくて済むようにする**ため。
 *
 * 【ビタ当てと複勝の重み】
 *   ビタ当てで選ばれたら 1.0、複勝の2語のどちらかなら 0.5。
 *   複勝は「2つまでしか絞れなかった」ので、断定の半分として数える。
 */
function WordRanking({
  section,
  myTagIds = [],
  pick = null,
}: {
  section: SectionWords;
  /** 自分が選んだ語。回答者向けのときだけ渡す */
  myTagIds?: number[];
  /**
   * 語を押せるようにする（掘り下げのときだけ渡す）。
   * 押すと「その問でその語を選んだ人」だけに絞られる。
   */
  pick?: { workId: string; params: (tagId: number) => Param[] } | null;
}) {
  const ranked = rankWords(section.words);
  const top = scoreRate(ranked[0] ?? { exact_count: 0, pair_count: 0, shown_times: 0 });

  return (
    <li
      data-word-ranking={section.card_slot_key}
      data-question={String(section.question_id)}
      className="space-y-2"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-sm font-bold">{section.card_slot_label}</span>
        <span className="text-xs text-faint">
          正解は「{section.correct_label}」
        </span>
      </div>

      <ul className="space-y-1.5">
        {ranked.map((w) => {
          const rate = scoreRate(w);
          // 棒の長さは1位を満たすように取る。**割合そのものではない。**
          // 割合で描くと、全員が同じ語を選んでも棒が短いままになる
          const width = rate !== null && top ? Math.max(2, (rate / top) * 100) : 2;
          const mine = myTagIds.includes(w.tag_id);

          return (
            <li
              key={w.tag_id}
              data-word={String(w.tag_id)}
              data-word-label={w.label}
              data-exact={String(w.exact_count)}
              data-pair={String(w.pair_count)}
              data-shown={String(w.shown_times)}
              data-correct={w.is_correct ? "1" : "0"}
              data-mine={mine ? "1" : "0"}
              className="space-y-1"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
                <span>
                  {pick ? (
                    // 押すと、この語を選んだ人だけに絞る。
                    // 正解の語は押せない（絞っても「伝わらなかった理由」にならない）
                    <AnalysisButton
                      workId={pick.workId}
                      params={pick.params(w.tag_id)}
                      disabled={w.is_correct}
                      data={{ "data-pick-word": String(w.tag_id) }}
                      className={[
                        "inline-flex min-h-11 items-center rounded-lg px-2 text-xs",
                        w.is_correct
                          ? "font-bold text-faint"
                          : "font-bold underline hover:bg-hover",
                      ].join(" ")}
                    >
                      {w.label}
                    </AnalysisButton>
                  ) : (
                    <span className={w.is_correct ? "font-bold" : ""}>{w.label}</span>
                  )}
                  {w.is_correct ? (
                    <span className="pl-2 text-success">正解</span>
                  ) : null}
                  {mine ? (
                    <span className="pl-2 text-notice">あなたの答え</span>
                  ) : null}
                </span>
                <span className="tabular-nums text-faint">
                  {formatRate(rate)}
                  <span className="pl-2">
                    ビタ {w.exact_count}・複勝 {w.pair_count}
                  </span>
                  <span className="pl-2">／ {w.shown_times}回提示</span>
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunken-strong">
                <div
                  className={w.is_correct ? "h-full rounded-full bg-accent" : "h-full rounded-full bg-ink/40"}
                  style={{ width: `${width}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

/* ===========================================================================
 * 正解を含んだ人の重なり（5つの集合）
 * ===========================================================================
 *
 * 【ベン図をそのまま描いていない】
 *   概念は5つの集合の重なりで、区画は 2^5 = 32 個。
 *   5つの円で描く図は、区画が細く潰れて人数を書き込めない。
 *   **読めない図は、重なりを見せていない。**
 *
 *   代わりに、区画そのものを1マスずつ並べる。
 *   マスの中の点が、どのセクションを含む区画かを表す。
 *   点が5つ光っているマスが「全部に正解を含んだ人」、
 *   1つも光っていないマスが「1つも含まなかった人」。
 *   **0人の区画も出す。**誰もいないことは、そういう答え方が無いのとは違う。
 *
 * 【あとで押せるようにするために】
 *   1マスを PatternCell に切り出してある。P3 で区画を押して
 *   その人たちを深掘りするときは、この部品を押せるものに変えるだけで済む。
 */
function PatternCell({
  workId,
  pattern,
  count,
  total,
  sections,
  selected,
  dimmed,
  locked,
}: {
  workId: string;
  pattern: string;
  count: number;
  total: number;
  sections: SectionWords[];
  /** いま選んでいる区画か */
  selected: boolean;
  /** 別の区画を選んでいるので薄くするか */
  dimmed: boolean;
  /** 取り込んだ回答が無いので、まだ掘り下げられない */
  locked: boolean;
}) {
  const percent = sharePercent(count, total);
  const bits = [...pattern];

  const face = (
    <>
      <span className="flex items-center gap-1" aria-hidden>
        {bits.map((b, i) => (
          <span
            key={`${pattern}-${i}`}
            title={sections[i]?.card_slot_label ?? ""}
            className={[
              "size-2.5 rounded-full",
              b === "1" ? "bg-accent" : "bg-sunken-strong",
            ].join(" ")}
          />
        ))}
      </span>
      <span className="pt-1 text-xs tabular-nums">
        <span className="font-bold">{count}人</span>
        <span className="pl-2 text-faint">
          {percent === null ? "—" : `${percent}%`}
        </span>
      </span>
      <span className="sr-only">
        {bits
          .map((b, i) =>
            b === "1"
              ? `${sections[i]?.card_slot_label ?? i + 1} は正解を含む`
              : `${sections[i]?.card_slot_label ?? i + 1} は外した`,
          )
          .join("、")}
        。{count}人。{count > 0 ? "押すと、この人たちだけを見られます。" : ""}
      </span>
    </>
  );

  const shape = [
    "flex w-full min-h-14 flex-col items-start rounded-xl border px-3 py-2 text-left",
    selected
      ? "border-line-active bg-hover"
      : count > 0
        ? "border-line-firm hover:bg-hover"
        : "border-line-faint text-faint",
    dimmed ? "opacity-40" : "",
  ].join(" ");

  // 誰もいない区画と、取り込みがまだの作品は押しても掘れない。
  // 押せる見た目にしない
  if (count === 0 || locked) {
    return (
      <div
        data-pattern={pattern}
        data-pattern-count={String(count)}
        data-pattern-locked={locked ? "1" : "0"}
        className={shape}
      >
        {face}
      </div>
    );
  }

  return (
    <AnalysisButton
      workId={workId}
      params={analysisParams(pattern, [])}
      data={{
        "data-pattern": pattern,
        "data-pattern-count": String(count),
        "data-pattern-selected": selected ? "1" : "0",
      }}
      className={shape}
    >
      {face}
    </AnalysisButton>
  );
}

function PatternField({
  workId,
  patterns,
  questionCount,
  total,
  sections,
  selected,
  locked,
}: {
  workId: string;
  patterns: { pattern: string; count: number }[];
  questionCount: number;
  total: number;
  sections: SectionWords[];
  selected: string | null;
  locked: boolean;
}) {
  const table = patternTable(patterns, questionCount);
  const groups = new Map<number, typeof table>();
  for (const row of table) {
    const k = countOnes(row.pattern);
    groups.set(k, [...(groups.get(k) ?? []), row]);
  }
  const levels = [...groups.keys()].sort((a, b) => b - a);

  return (
    <div className="space-y-4" data-pattern-field={String(questionCount)}>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-faint">
        {sections.map((s, i) => (
          <span key={s.question_id}>
            {i + 1}. {s.card_slot_label}
          </span>
        ))}
      </div>

      {levels.map((level) => {
        const rows = groups.get(level) ?? [];
        const people = rows.reduce((n, r) => n + r.count, 0);
        return (
          <div key={level} className="space-y-2" data-pattern-level={String(level)}>
            <p className="text-xs">
              <span className="font-bold">{level} 項目</span>
              <span className="pl-2 text-faint">
                で正解を含んだ人 … {people}人
                {sharePercent(people, total) === null
                  ? ""
                  : `（${sharePercent(people, total)}%）`}
              </span>
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {rows.map((r) => (
                <PatternCell
                  key={r.pattern}
                  workId={workId}
                  pattern={r.pattern}
                  count={r.count}
                  total={total}
                  sections={sections}
                  selected={selected === r.pattern}
                  dimmed={selected !== null && selected !== r.pattern}
                  locked={locked}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ===========================================================================
 * 回答者向け
 * =========================================================================== */

export function AnswererAnalysis({
  analysis,
  myTagsByQuestion,
}: {
  analysis: MyAnswerAnalysis;
  /** 問のID → 自分が選んだ語。ランキングの中で自分の答えに印を付ける */
  myTagsByQuestion: Record<number, number[]>;
}) {
  const cumulative = cumulativeMatches(
    analysis.match_histogram,
    analysis.question_count,
    analysis.others_count,
  );
  // いちばん上に出す1行。**4問以上一致**のように、真ん中あたりを選ぶ
  const headline =
    cumulative.find((c) => c.atLeast === Math.max(1, analysis.question_count - 1)) ??
    cumulative[0];

  const rarity = rarityLabel(analysis.sections.map((s) => s.choice_count));

  return (
    <section className={`${surface} space-y-6`} data-answerer-analysis>
      {analysis.is_perfect_exact ? (
        <div
          data-perfect-exact="1"
          className="space-y-1 rounded-xl bg-success-tint/10 px-4 py-3"
        >
          <p className="text-base font-bold text-success">完全ビタ</p>
          <p className="text-xs">
            全{analysis.question_count}問を、2語に絞らずビタ当てで通しました。
            この作品で完全ビタは {analysis.perfect_exact_count}人です。
          </p>
          {rarity ? (
            <p className="text-xs text-faint" data-rarity={rarity}>
              組み合わせ上の希少度 … {rarity}
              （答え方の組み合わせの数から出したもので、当たる確率ではありません）
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-1">
        <h2 className="text-sm font-bold">他の人は、どう見たか</h2>
        {analysis.others_count === 0 ? (
          <p className="text-xs text-faint">
            まだあなたしか答えていません。他の人が答えると、ここに並びます。
          </p>
        ) : (
          <p className="text-sm" data-similarity-headline>
            あなたと{headline?.atLeast ?? 1}項目以上で同じ答えだった人 …{" "}
            <span className="font-bold tabular-nums">
              {headline?.percent === null || headline === undefined
                ? "—"
                : `${headline.percent}%`}
            </span>
            <span className="pl-2 text-xs text-faint">
              （{headline?.count ?? 0} / {analysis.others_count}人）
            </span>
          </p>
        )}
      </div>

      {analysis.others_count > 0 ? (
        <ul className="space-y-1 text-xs" data-similarity-list>
          {cumulative.map((c) => (
            <li
              key={c.atLeast}
              data-at-least={String(c.atLeast)}
              data-count={String(c.count)}
              className="flex items-baseline justify-between gap-4"
            >
              <span className="text-faint">{c.atLeast}項目以上が同じ</span>
              <span className="tabular-nums">
                {c.percent === null ? "—" : `${c.percent}%`}
                <span className="pl-2 text-faint">
                  {c.count} / {analysis.others_count}人
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="space-y-4 border-t border-ink/10 pt-5">
        <h3 className="text-xs text-faint">項目ごとに、みんなが選んだ語</h3>
        <ul className="space-y-5">
          {analysis.sections.map((s) => (
            <WordRanking
              key={s.question_id}
              section={s}
              myTagIds={myTagsByQuestion[s.question_id] ?? []}
            />
          ))}
        </ul>
        <p className="text-xs text-faint">
          同じ答えとは、その項目で選んだ語の集まりが完全に同じことです。
          1語だけ選んだ答えと、その語を含む2語の答えは、別の答えとして数えます。
        </p>
      </div>
    </section>
  );
}
