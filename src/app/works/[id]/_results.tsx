import Image from "next/image";

import {
  cumulativeMatches,
  countOnes,
  formatRate,
  filtersUpTo,
  patternTable,
  rankWords,
  rarityLabel,
  scoreRate,
  serializeFilters,
  sharePercent,
  withFilter,
  type AnswerFilter,
  type Drilldown,
  type MyAnswerAnalysis,
  type SectionWords,
  type WorkAnswerAnalysis,
  type WorkAnswerList,
} from "@/features/quiz/results";
import { btnPrimary, btnQuiet, btnSecondary, surface } from "@/app/_surface";
import { SubmitButton } from "@/app/_pending";

import { setAnswerExcludedAction } from "./actions";
import { AnalysisScope } from "./_capacity";
import type { WorkImportState } from "@/features/quiz/capacity";

/* ===========================================================================
 * 押すと画面が変わる部品（JavaScript を使わない）
 * ===========================================================================
 *
 * 【なぜ form なのか】
 *   掘り下げは「押す → 条件が増える → 数え直す」の繰り返しで、
 *   数えるのは DB。押した結果はURLに残したい（戻る・進む・共有・読み込み直しが
 *   そのまま効く）。
 *
 *   リンクでもURLは作れるが、仕様は**押せる部品であること**を求めている。
 *   `<a>` は押せる部品ではない。GET の form なら、中身は本物の button で、
 *   押すと URL が組み立てられて画面が変わる。JavaScript は要らない。
 *
 * 【条件をURLに置いても安全な理由】
 *   URL を手で書き換えても、返す・返さないを決めるのは DB 側。
 *   作品の持ち主でなければ null、集団が少人数なら内訳も人数も返らない。
 */

/** URL に載せる名前と値の組 */
type Param = [name: string, value: string];

function AnalysisButton({
  workId,
  params,
  className,
  data,
  children,
  disabled = false,
}: {
  workId: string;
  params: Param[];
  className?: string;
  data?: Record<`data-${string}`, string>;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    // contents にしているのは、この form が並びの箱として数えられないようにするため
    <form method="get" action={`/works/${workId}`} className="contents">
      {params.map(([name, value], i) => (
        <input key={`${name}-${i}`} type="hidden" name={name} value={value} />
      ))}
      <button type="submit" disabled={disabled} {...data} className={className}>
        {children}
      </button>
    </form>
  );
}

/** 掘り下げの状態をURLへ戻す。result=open は必ず付ける（開いた状態を保つ） */
function analysisParams(
  pattern: string | null,
  filters: AnswerFilter[],
  extra: Param[] = [],
): Param[] {
  const out: Param[] = [["result", "open"]];
  if (pattern) out.push(["pattern", pattern]);
  for (const f of serializeFilters(filters)) out.push(["f", f]);
  return [...out, ...extra];
}

/**
 * 回答が集まったあとの結果。作者向けと回答者向けの2つ。
 *
 * 【何が主役か】
 *   これまでの主役は「67% 2/3」のような正解の割合だった。
 *   その数は「当たったかどうか」しか言わないので、
 *   **どう見えたか**は何も分からない。
 *
 *   いまの主役は、作者側が「どの語が選ばれたか」と
 *   「どの項目が伝わった人がどれだけ重なっているか」、
 *   回答者側が「自分がどう見て、他の人はどう見たか」。
 *
 * 【正解がここに出てよい理由】
 *   この2つの部品を出す相手は、作者本人か、答え終わった人だけ。
 *   どちらも既に正解を知っている。まだ答えていない人には
 *   DB 側（get_work_answer_analysis / get_my_answer_analysis）が
 *   null を返すので、そもそも中身が届かない。
 */

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
 * 掘り下げ
 * ===========================================================================
 *
 * 【何をする面か】
 *   「この組み合わせで伝わった人たちは、伝わらなかった部分を何だと思ったのか」
 *   を見る。だから並べるのは、選んだ区画で**正解を含まなかった項目だけ。**
 *   当たった項目の内訳は、その問いに答えない。
 *
 * 【少人数のときに何も出さない】
 *   人数も語も出さない。「4人です」と出すだけでも、条件を少しずつ変えれば
 *   誰か1人を言い当てられる。**画面で隠すのではなく、DB が返さない。**
 */
function Trail({
  workId,
  pattern,
  filters,
  sections,
}: {
  workId: string;
  pattern: string;
  filters: AnswerFilter[];
  sections: SectionWords[];
}) {
  const labelOf = (f: AnswerFilter) => {
    const sec = sections.find((x) => x.question_id === f.question_id);
    const word = sec?.words.find((w) => w.tag_id === f.tag_id);
    return `${sec?.card_slot_label ?? "項目"}：${word?.label ?? f.tag_id}`;
  };

  return (
    <div className="flex flex-wrap items-center gap-2" data-trail>
      <AnalysisButton
        workId={workId}
        params={analysisParams(pattern, [])}
        data={{ "data-trail-step": "0" }}
        className={`${btnSecondary} min-h-11 px-3 py-1 text-xs`}
      >
        {pattern}
      </AnalysisButton>

      {filters.map((f, i) => (
        <span key={`${f.question_id}-${f.tag_id}`} className="flex items-center gap-2">
          <span aria-hidden className="text-faint">
            ›
          </span>
          <AnalysisButton
            workId={workId}
            params={analysisParams(pattern, filtersUpTo(filters, i + 1))}
            data={{ "data-trail-step": String(i + 1) }}
            className={`${btnSecondary} min-h-11 px-3 py-1 text-xs`}
          >
            {labelOf(f)}
          </AnalysisButton>
        </span>
      ))}

      <AnalysisButton
        workId={workId}
        params={[["result", "open"]]}
        data={{ "data-trail-clear": "1" }}
        className={`${btnQuiet} min-h-11 px-3 py-1 text-xs`}
      >
        全部解除
      </AnalysisButton>
    </div>
  );
}

function DrilldownPanel({
  workId,
  pattern,
  filters,
  drilldown,
  allSections,
}: {
  workId: string;
  pattern: string;
  filters: AnswerFilter[];
  drilldown: Drilldown;
  /** 語の名前を引くための、絞り込む前の一覧 */
  allSections: SectionWords[];
}) {
  return (
    <section
      className="space-y-4 rounded-xl border border-line-firm p-4"
      data-drilldown
      data-below-threshold={drilldown.below_threshold ? "1" : "0"}
    >
      <Trail
        workId={workId}
        pattern={pattern}
        filters={filters}
        sections={allSections}
      />

      {drilldown.not_imported ? (
        <div className="space-y-1" data-drilldown-blocked>
          <p className="text-sm font-bold">
            取り込んだ回答がないので、掘り下げられません
          </p>
          <p className="text-xs text-faint">
            下の「分析に使う回答の枠」から取り込んでください。
          </p>
        </div>
      ) : drilldown.below_threshold ? (
        <div className="space-y-1" data-drilldown-blocked>
          <p className="text-sm font-bold">
            少人数のため、これ以上の絞り込みはできません
          </p>
          <p className="text-xs text-faint">
            この条件に当てはまる人が {drilldown.min_subgroup}
            人に届いていません。人数も、選ばれた語も出しません。
            誰が何と答えたかを言い当てられないようにするためです。
            1つ前の条件へ戻ってください。
          </p>
        </div>
      ) : (
        <>
          <p className="text-sm" data-subgroup-count={String(drilldown.subgroup_count)}>
            この条件に当てはまる人 …{" "}
            <span className="font-bold tabular-nums">
              {drilldown.subgroup_count}人
            </span>
          </p>

          {drilldown.sections.length === 0 ? (
            <p className="text-xs text-faint">
              この区画は全項目で正解を含んでいます。掘り下げる項目がありません。
            </p>
          ) : (
            <>
              <p className="text-xs text-faint">
                この人たちが、正解を含まなかった項目で何を選んだか。
                語を押すと、その語を選んだ人だけに絞り込めます。
              </p>
              <ul className="space-y-5">
                {drilldown.sections.map((sec) => (
                  <WordRanking
                    key={sec.question_id}
                    section={sec}
                    pick={{
                      workId,
                      params: (tagId) =>
                        analysisParams(
                          pattern,
                          withFilter(filters, sec.question_id, tagId),
                        ),
                    }}
                  />
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}

/* ===========================================================================
 * 分析から外す
 * =========================================================================== */

function ExclusionPanel({
  workId,
  list,
  open,
}: {
  workId: string;
  list: WorkAnswerList;
  open: boolean;
}) {
  if (!open) {
    return (
      <div className="border-t border-ink/10 pt-5">
        <AnalysisButton
          workId={workId}
          params={[
            ["result", "open"],
            ["manage", "open"],
          ]}
          data={{ "data-open-manage": "1" }}
          className={btnSecondary}
        >
          分析に使う回答を選ぶ（{list.excluded_count}件を外しています）
        </AnalysisButton>
      </div>
    );
  }

  return (
    <section className="space-y-4 border-t border-ink/10 pt-5" data-exclusion-panel>
      <div className="space-y-1">
        <h3 className="text-sm font-bold">分析に使う回答</h3>
        <p className="text-xs text-faint">
          外した回答は、上の集計と掘り下げから抜けます。
          <span className="font-bold">回答そのものは消えません。</span>
          答えた本人の画面も、公開の集計も変わりません。いつでも戻せます。
        </p>
        <p className="text-xs text-faint">
          誰が答えたかは出していません。番号は、この作品の中だけの通し番号です。
        </p>
      </div>

      <form action={setAnswerExcludedAction} className="space-y-3">
        <input type="hidden" name="workId" value={workId} />

        <ul className="space-y-1">
          {list.answers.map((row) => (
            <li
              key={row.no}
              data-answer-row={String(row.no)}
              data-excluded={row.is_excluded ? "1" : "0"}
              className={[
                "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-3 py-2 text-xs",
                row.is_excluded ? "border-line-faint text-faint" : "border-line",
              ].join(" ")}
            >
              <label className="flex min-h-11 items-center gap-2">
                <input type="checkbox" name="no" value={row.no} />
                <span className="font-bold tabular-nums">#{row.no}</span>
              </label>
              <span className="tabular-nums">
                {new Date(row.answered_at).toLocaleString("ja-JP", {
                  timeZone: "Asia/Tokyo",
                  dateStyle: "short",
                  timeStyle: "short",
                })}
              </span>
              <span className="tabular-nums">
                {row.correct_sections} / {row.question_count} 項目で正解を含む
              </span>
              {row.is_perfect_exact ? (
                <span className="text-success">完全ビタ</span>
              ) : null}
              {row.is_excluded ? (
                <span className="font-bold">外しています</span>
              ) : null}
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap gap-2">
          <SubmitButton
            name="mode"
            value="exclude"
            pendingLabel="外しています…"
            className={btnPrimary}
            data={{ "data-bulk-exclude": "1" }}
          >
            チェックした回答を分析から外す
          </SubmitButton>
          <SubmitButton
            name="mode"
            value="restore"
            pendingLabel="戻しています…"
            className={btnSecondary}
            data={{ "data-bulk-restore": "1" }}
          >
            チェックした回答を戻す
          </SubmitButton>
        </div>
      </form>

      <AnalysisButton
        workId={workId}
        params={[["result", "open"]]}
        className={btnQuiet}
      >
        閉じる
      </AnalysisButton>
    </section>
  );
}

/* ===========================================================================
 * 作者向け
 * =========================================================================== */

export function AuthorAnalysis({
  analysis,
  workId,
  imageSrc,
  imageWidth,
  imageHeight,
  title,
  pattern,
  filters,
  drilldown,
  answerList,
  manageOpen,
  importState,
}: {
  analysis: WorkAnswerAnalysis;
  workId: string;
  imageSrc: string;
  imageWidth: number;
  imageHeight: number;
  title: string;
  /** いま選んでいる区画。URL の pattern */
  pattern: string | null;
  filters: AnswerFilter[];
  /** 区画を選んでいるときだけ入る */
  drilldown: Drilldown | null;
  answerList: WorkAnswerList | null;
  manageOpen: boolean;
  /** 取り込み枠の状態。作者以外なら null */
  importState: WorkImportState | null;
}) {
  if (analysis.answers_count === 0 && analysis.excluded_count === 0) return null;

  // 取り込んだ回答が1件も無いあいだは、区画を押しても掘り下げられない
  const locked = analysis.advanced_count === 0;

  return (
    <section className={`${surface} space-y-6`} data-author-analysis>
      {/*
        掘り下げのあいだも絵が見えているようにする。
        どの語が選ばれたかを読むとき、絵が無いと何の話か分からなくなる。
      */}
      <div className="sticky top-14 z-10 -mx-6 border-b border-line bg-surface px-6 py-2">
        <Image
          src={imageSrc}
          alt={title}
          width={imageWidth}
          height={imageHeight}
          sizes="(max-width: 768px) 100vw, 768px"
          className="mx-auto h-auto max-h-[22vh] w-auto object-contain"
        />
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-bold">どう見えたか</h2>
        <p className="text-xs text-faint" data-analysed-count={String(analysis.answers_count)}>
          ここから下の語の分布と重なりの図は、
          <span className="font-bold">全{analysis.answers_count}件の回答</span>
          で出しています。何人が当てたかではなく、どの語が選ばれたかを並べています。
        </p>
        {importState ? <AnalysisScope state={importState} /> : null}
      </div>

      <div className="space-y-4">
        <h3 className="text-xs text-faint">項目ごとに、選ばれた語</h3>
        <ul className="space-y-5">
          {analysis.sections.map((s) => (
            <WordRanking key={s.question_id} section={s} />
          ))}
        </ul>
        <p className="text-xs text-faint">
          割合は「その語が出た回数のうち、どれだけ選ばれたか」です。
          ビタ当てで選ばれたら1、複勝の2語のどちらかなら0.5として数えます。
        </p>
      </div>

      <div className="space-y-3 border-t border-ink/10 pt-5">
        <div className="space-y-1">
          <h3 className="text-xs text-faint">どの項目が、誰に伝わったか</h3>
          <p className="text-xs text-faint">
            1マスが1通りの当て方です。点が光っている項目で正解を含んでいた人が、
            そのマスに入ります。全部外した人（点が1つも光っていないマス）も出します。
          </p>
          {locked ? (
            <div
              className="space-y-1 rounded-xl border border-line-firm px-4 py-3"
              data-drilldown-locked
            >
              <p className="text-sm font-bold">
                掘り下げは、取り込んだ回答があるときだけ使えます
              </p>
              <p className="text-xs text-faint">
                高度分析の対象：{analysis.advanced_count}件 ／ 未インポート：
                {analysis.unimported_count}件。
                下の「分析に使う回答の枠」から取り込むと、マスを押して
                「その人たちが何を選んだか」まで見られるようになります。
              </p>
            </div>
          ) : (
            <p className="text-xs text-faint">
              <span className="font-bold">マスを押すと、その人たちだけを掘り下げられます</span>
              （{analysis.min_subgroup}人以上のときだけ）。掘り下げが数えるのは、
              取り込んだ {analysis.advanced_count}件です。
            </p>
          )}
        </div>
        <PatternField
          workId={workId}
          patterns={analysis.patterns}
          questionCount={analysis.question_count}
          total={analysis.answers_count}
          sections={analysis.sections}
          selected={pattern}
          locked={locked}
        />
      </div>

      {pattern && drilldown ? (
        <DrilldownPanel
          workId={workId}
          pattern={pattern}
          filters={filters}
          drilldown={drilldown}
          allSections={analysis.sections}
        />
      ) : null}

      <div
        className="border-t border-ink/10 pt-5 text-sm"
        data-perfect-exact-count={String(analysis.perfect_exact_count)}
      >
        <span className="text-faint">全問をビタ当てで通した人（完全ビタ）… </span>
        <span className="font-bold tabular-nums">
          {analysis.perfect_exact_count} / {analysis.answers_count}人
        </span>
      </div>

      {answerList ? (
        <ExclusionPanel workId={workId} list={answerList} open={manageOpen} />
      ) : null}
    </section>
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
