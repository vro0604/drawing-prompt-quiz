/**
 * 結果を読むための計算。**画面もDBも出てこない。**
 *
 * DB 側（get_work_answer_analysis / get_my_answer_analysis）は数えた素の数だけを返す。
 * 割り算・並べ替え・掛け合わせはここでやる。
 *
 * 【なぜ割り算を DB に置かないか】
 *   分母が 0 のときにどうするか、順位をどう決めるかは、
 *   何度も変わる。**変わるものを、権限の壁の向こうに置かない。**
 *   ここに置けば、ブラウザも DB も立てずにそのまま試せる。
 */

/* ===========================================================================
 * DB から返ってくる形
 * =========================================================================== */

/** 問1つに出た語1つぶんの数。**割合ではなく回数** */
export type WordCount = {
  tag_id: number;
  label: string;
  /** その問の正解か。呼べるのは作者と回答済みの本人だけ */
  is_correct: boolean;
  /** ビタ当て（1語だけ選ぶ）でこの語が選ばれた回数 */
  exact_count: number;
  /** 複勝（2語選ぶ）の2語のどちらかとしてこの語が選ばれた回数 */
  pair_count: number;
  /** この語が選択肢として目の前に出た回数 */
  shown_times: number;
};

/** セクション（＝問）1つぶん */
export type SectionWords = {
  question_id: number;
  position: number;
  card_slot_key: string;
  card_slot_label: string;
  /** その問の選択肢の数。3 か 4 */
  choice_count: number;
  correct_tag_id: number;
  correct_label: string;
  words: WordCount[];
};

/** 正解を含んでいたかの並び（"11010" のような 0 と 1 の文字列）と、その人数 */
export type PatternCount = { pattern: string; count: number };

/** 作者が見る集計（get_work_answer_analysis） */
export type WorkAnswerAnalysis = {
  /** 分析に使った回答の数。**外した回答は入っていない** */
  answers_count: number;
  /** 作者が分析から外している回答の数 */
  excluded_count: number;
  /** 取り込み済みの回答の数 */
  imported_count: number;
  /** まだ取り込んでいない回答の数 */
  unimported_count: number;
  /** 高度な分析の対象になる回答の数（取り込み済み かつ 外していない） */
  advanced_count: number;
  /** 掘り下げに要る最少人数。画面はこの値を読む */
  min_subgroup: number;
  question_count: number;
  perfect_exact_count: number;
  patterns: PatternCount[];
  sections: SectionWords[];
};

/** 自分と何問一致した人が何人いたか */
export type MatchBucket = { matches: number; count: number };

/** 答え終わった本人が見る集計（get_my_answer_analysis） */
export type MyAnswerAnalysis = {
  answers_count: number;
  /** 自分を除いた回答者の数 */
  others_count: number;
  question_count: number;
  my_pattern: string | null;
  is_perfect_exact: boolean | null;
  perfect_exact_count: number;
  match_histogram: MatchBucket[];
  sections: SectionWords[];
};

/* ===========================================================================
 * 語の点
 * =========================================================================== */

/** 複勝で選ばれた語の重み。ビタ当ては 1.0、複勝は1語あたり 0.5 */
export const PAIR_WEIGHT = 0.5;

/**
 * 重み付きの点。ビタ18・複勝26 なら 18 + 26×0.5 = 31。
 *
 * **これは順位そのものではない。**出た回数で割る前の素の点。
 */
export function weightedPoints(word: {
  exact_count: number;
  pair_count: number;
}): number {
  return word.exact_count + word.pair_count * PAIR_WEIGHT;
}

/**
 * 出された回数あたりの点。順位はこれで決める。
 *
 * 一度も出ていない語は null。**0 を返さない。**
 * 0 だと「出たのに1人も選ばなかった」と区別が付かなくなる。
 */
export function scoreRate(word: {
  exact_count: number;
  pair_count: number;
  shown_times: number;
}): number | null {
  if (!word.shown_times) return null;
  return weightedPoints(word) / word.shown_times;
}

/** 「31.0点」「62%」の表示用。小数第1位まで */
export function formatRate(rate: number | null): string {
  if (rate === null) return "—";
  return `${Math.round(rate * 1000) / 10}%`;
}

/**
 * 語を順位の順に並べる。
 *
 * 1. 出された回数あたりの点が高い順（出ていない語はいちばん後ろ）
 * 2. 同点ならビタ当てで選ばれた数が多い順（断定された語を上にする）
 * 3. それも同じなら語の名前順（並びが実行のたびに変わらないように）
 */
export function rankWords<T extends WordCount>(words: T[]): T[] {
  return [...words].sort((a, b) => {
    const ra = scoreRate(a);
    const rb = scoreRate(b);
    if (ra === null && rb !== null) return 1;
    if (rb === null && ra !== null) return -1;
    if (ra !== null && rb !== null && ra !== rb) return rb - ra;
    if (a.exact_count !== b.exact_count) return b.exact_count - a.exact_count;
    return a.label.localeCompare(b.label, "ja");
  });
}

/* ===========================================================================
 * 正解を含んでいたかの並び
 * =========================================================================== */

/**
 * n問ぶんの並びを全部作る。5問なら 2^5 = 32 通り。
 *
 * "00000"（全部外した）も1つの正式な並びとして入る。
 * 上から順に、正解を含んだ問が多い順・そのあと文字の順で並べる。
 */
export function allPatterns(length: number): string[] {
  if (length <= 0) return [];
  const out: string[] = [];
  for (let i = 0; i < 2 ** length; i += 1) {
    out.push(i.toString(2).padStart(length, "0"));
  }
  return out.sort((a, b) => {
    const ca = countOnes(b) - countOnes(a);
    return ca !== 0 ? ca : a.localeCompare(b);
  });
}

/** 並びの中で、正解を含んだ問がいくつあるか */
export function countOnes(pattern: string): number {
  let n = 0;
  for (const c of pattern) if (c === "1") n += 1;
  return n;
}

/** 並びを真偽の配列にする。問の順番はお題の出題順 */
export function patternBits(pattern: string): boolean[] {
  return [...pattern].map((c) => c === "1");
}

/**
 * 観測された並びの表に、出なかった並びを 0 人として足す。
 *
 * **出なかった並びを表から消さない。**「誰もそう答えなかった」ことは
 * 「そういう答え方が無い」とは違う。
 *
 * 問数が多いと組み合わせが増えすぎるので（10問なら1024通り）、
 * 上限を超えたら観測されたものだけを返す。
 */
export const PATTERN_GRID_MAX_QUESTIONS = 6;

export function patternTable(
  patterns: PatternCount[],
  questionCount: number,
): PatternCount[] {
  const seen = new Map(patterns.map((p) => [p.pattern, p.count]));
  if (questionCount <= 0 || questionCount > PATTERN_GRID_MAX_QUESTIONS) {
    return [...patterns].sort(
      (a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern),
    );
  }
  return allPatterns(questionCount).map((pattern) => ({
    pattern,
    count: seen.get(pattern) ?? 0,
  }));
}

/** 人数を割合（0〜100）にする。母数が 0 なら null */
export function sharePercent(count: number, total: number): number | null {
  if (!total) return null;
  return Math.round((count / total) * 1000) / 10;
}

/* ===========================================================================
 * 回答の似かた
 * =========================================================================== */

/** 「k問以上一致した人」の人数と割合 */
export type CumulativeMatch = {
  atLeast: number;
  count: number;
  percent: number | null;
};

/**
 * 一致数ごとの人数から、「k問以上一致した人」を上から積み上げる。
 *
 * 母数は自分を除いた回答者の数。**1問も一致しなかった人も母数に入れる。**
 * 入れないと、似ている人の割合がいくらでも高く出る。
 */
export function cumulativeMatches(
  histogram: MatchBucket[],
  questionCount: number,
  othersCount: number,
): CumulativeMatch[] {
  const byMatches = new Map(histogram.map((h) => [h.matches, h.count]));
  const out: CumulativeMatch[] = [];
  let running = 0;
  for (let k = questionCount; k >= 1; k -= 1) {
    running += byMatches.get(k) ?? 0;
    out.push({
      atLeast: k,
      count: running,
      percent: sharePercent(running, othersCount),
    });
  }
  return out;
}

/* ===========================================================================
 * 組み合わせ上の希少度
 * =========================================================================== */

/**
 * 1つのセクションで作れる答え方の数。
 *
 * 4択なら、ビタ当てが4通り（どれか1語）、複勝が6通り（4語から2語）で 10 通り。
 * 3択なら 3 + 3 = 6 通り。
 *
 * **10 という数を画面にも式にも直接書かない。**選択肢の数から出す。
 * 選択肢が3つになる問があるし、将来 4 でなくなるかもしれない。
 */
export function sectionPatternCount(choiceCount: number): number {
  if (choiceCount < 1) return 0;
  const pairs = (choiceCount * (choiceCount - 1)) / 2;
  return choiceCount + pairs;
}

/**
 * 作品まるごとで作れる答え方の数。4択が5問なら 10^5 = 100,000。
 *
 * これは「組み合わせが何通りあるか」であって、**当たる確率ではない。**
 * 語の選ばれやすさは均等ではないので、確率とは呼ばない。
 */
export function totalAnswerPatterns(choiceCounts: number[]): number {
  if (choiceCounts.length === 0) return 0;
  return choiceCounts.reduce((acc, k) => acc * sectionPatternCount(k), 1);
}

/** 「1 / 100,000」の形にする。作れる組み合わせが無いときは null */
export function rarityLabel(choiceCounts: number[]): string | null {
  const total = totalAnswerPatterns(choiceCounts);
  if (!total) return null;
  return `1 / ${total.toLocaleString("en-US")}`;
}

/* ===========================================================================
 * 掘り下げ（P3）
 * =========================================================================== */

/** 絞り込みの1段。「この問で、この語を選んだ人」 */
export type AnswerFilter = { question_id: number; tag_id: number };

/** get_work_drilldown の戻り値 */
export type Drilldown = {
  /** 取り込んだ回答が1件も無く、掘り下げを始められないか */
  not_imported: boolean;
  /** 集団が少人数で、これ以上返せないか */
  below_threshold: boolean;
  /** 掘り下げに要る最少人数。**画面に数を直接書かず、ここから読む** */
  min_subgroup: number;
  /** 集団の人数。少人数のときは null（人数も返さない） */
  subgroup_count: number | null;
  question_count: number;
  pattern: string | null;
  /** 正解を含まなかった問だけ。少人数のときは空 */
  sections: SectionWords[];
};

/** 作者向けの回答一覧の1行。**誰が答えたかは入っていない** */
export type AnswerListRow = {
  /** その作品の中だけの通し番号（古い順に1から） */
  no: number;
  answered_at: string;
  /** いくつの項目で正解を含んだか。当て方の並びそのものは返らない */
  correct_sections: number;
  question_count: number;
  is_perfect_exact: boolean;
  is_excluded: boolean;
};

/** get_work_answer_list の戻り値 */
export type WorkAnswerList = {
  total: number;
  excluded_count: number;
  question_count: number;
  answers: AnswerListRow[];
};

/**
 * URL の `f=<問のID>:<語のID>` を読み取る。
 *
 * 読めない形は捨てる。同じ問に2つ来たら**先に来たほうだけ**を残す。
 * DB 側は同じ問が重なると断るので、ここで整えてから渡す。
 */
export function parseFilters(raw: string | string[] | undefined): AnswerFilter[] {
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const out: AnswerFilter[] = [];

  for (const item of list) {
    const [a, b] = item.split(":");
    const question_id = Number.parseInt(a ?? "", 10);
    const tag_id = Number.parseInt(b ?? "", 10);
    if (!Number.isFinite(question_id) || !Number.isFinite(tag_id)) continue;
    if (out.some((f) => f.question_id === question_id)) continue;
    out.push({ question_id, tag_id });
  }
  return out;
}

/** URL へ戻す */
export function serializeFilters(filters: AnswerFilter[]): string[] {
  return filters.map((f) => `${f.question_id}:${f.tag_id}`);
}

/**
 * 語を1つ選んだあとの絞り込みを作る。
 *
 * 【同じ項目に2つ重ねない】
 *   同じ問に別の語を足すと、両方を選んだ人だけが残り、必ず0人になる。
 *   0人になる操作を押させない。
 *
 *   その問に既に条件があるときは、**その条件を置き換え、それより後ろの
 *   条件を落とす。**後ろを残すと、置き換えた条件と噛み合わない
 *   組み合わせが残りうるため。前の段へ戻って選び直したのと同じ結果になる。
 */
export function withFilter(
  filters: AnswerFilter[],
  questionId: number,
  tagId: number,
): AnswerFilter[] {
  const at = filters.findIndex((f) => f.question_id === questionId);
  if (at === -1) return [...filters, { question_id: questionId, tag_id: tagId }];
  return [...filters.slice(0, at), { question_id: questionId, tag_id: tagId }];
}

/** 「ここまで戻る」。0 を渡すと全部解除 */
export function filtersUpTo(filters: AnswerFilter[], count: number): AnswerFilter[] {
  return filters.slice(0, Math.max(0, Math.min(count, filters.length)));
}

/**
 * 当て方の並びのうち、正解を含まなかった問だけを返す。
 *
 * 掘り下げの対象はここだけ。当たった問の内訳は
 * 「伝わらなかった部分を何だと思ったか」に答えないので並べない。
 */
export function mismatchPositions(pattern: string): number[] {
  const out: number[] = [];
  [...pattern].forEach((c, i) => {
    if (c === "0") out.push(i);
  });
  return out;
}
