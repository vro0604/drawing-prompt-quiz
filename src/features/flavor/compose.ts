/**
 * フレーバーテキストの組み立ての勘定（P5）。
 *
 * 【ここが持っているもの】
 *   選んだ語の並びを、足す・外す・上へ動かす・下へ動かす・文を切る。
 *   それだけ。画面も通信も知らない。
 *
 * 【なぜ画面から切り離すか】
 *   並べ替えは「上のものと入れ替える」だけの単純な操作だが、
 *   **入れ替えると文の区切りがどこに付いていたかが変わる。**
 *   区切りは「この語のあとで文が終わる」という語ごとの印なので、
 *   語を動かしたときに印も一緒に動く。ここを画面の中に書くと、
 *   時計もブラウザも要る試験でしか確かめられなくなる。
 *
 * 【上限は2つある。混ぜない】
 *   ・語数 … 技術上の上限。DOM と DB を守るための数。**DB が決める**
 *   ・文数 … 文章としての決まり。**DB が決める**
 *   どちらもこのファイルに数を書かない。呼ぶ側が DB から受け取った値を渡す。
 */

/** 並びの中の語1つ */
export type Token = {
  /** flavor_vocab.id */
  id: number;
  label: string;
  /** この語のあとで文が終わるか。最後の語には付けない */
  breakAfter: boolean;
};

/** 語を末尾に足す。上限に達していれば何も起きない */
export function addToken(tokens: Token[], token: { id: number; label: string }, maxTokens: number): Token[] {
  if (tokens.length >= maxTokens) return tokens;
  return [...tokens, { id: token.id, label: token.label, breakAfter: false }];
}

/**
 * 位置を指して外す。
 *
 * **最後の語を外したら、新しい最後の語の印を落とす。**
 * 落とさないと「最後の語のあとで文が終わる」という、数えると
 * 1文多くなる並びが残る。
 */
export function removeAt(tokens: Token[], index: number): Token[] {
  if (index < 0 || index >= tokens.length) return tokens;
  const next = tokens.filter((_, i) => i !== index);
  return trimLastBreak(next);
}

/** 上と入れ替える。印は語に付いて動く */
export function moveUp(tokens: Token[], index: number): Token[] {
  if (index <= 0 || index >= tokens.length) return tokens;
  const next = [...tokens];
  [next[index - 1], next[index]] = [next[index], next[index - 1]];
  return trimLastBreak(next);
}

/** 下と入れ替える */
export function moveDown(tokens: Token[], index: number): Token[] {
  if (index < 0 || index >= tokens.length - 1) return tokens;
  const next = [...tokens];
  [next[index], next[index + 1]] = [next[index + 1], next[index]];
  return trimLastBreak(next);
}

/**
 * この語のあとで文を切る／切るのをやめる。
 *
 * 切れる数には上限がある（文数 − 1）。超えるときは何も起きない。
 * 最後の語には付けられない（そこは必ず文の終わりで、印は要らない）。
 */
export function toggleBreak(tokens: Token[], index: number, maxSentences: number): Token[] {
  if (index < 0 || index >= tokens.length - 1) return tokens;

  const on = tokens[index].breakAfter;
  if (!on && countBreaks(tokens) >= maxSentences - 1) return tokens;

  return tokens.map((t, i) => (i === index ? { ...t, breakAfter: !on } : t));
}

/** 印の数 */
export function countBreaks(tokens: Token[]): number {
  return tokens.filter((t, i) => t.breakAfter && i < tokens.length - 1).length;
}

/** いま何文か。語が0なら0文 */
export function sentenceCount(tokens: Token[]): number {
  if (tokens.length === 0) return 0;
  return countBreaks(tokens) + 1;
}

/** 最後の語に付いた印を落とす */
function trimLastBreak(tokens: Token[]): Token[] {
  if (tokens.length === 0) return tokens;
  const last = tokens.length - 1;
  if (!tokens[last].breakAfter) return tokens;
  return tokens.map((t, i) => (i === last ? { ...t, breakAfter: false } : t));
}

/** 文ごとに分ける。表示にも、文の数を数えるのにも使う */
export function toSentences(tokens: Token[]): Token[][] {
  const out: Token[][] = [];
  let current: Token[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    current.push(tokens[i]);
    if (tokens[i].breakAfter && i < tokens.length - 1) {
      out.push(current);
      current = [];
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

/**
 * 読める文にする。
 *
 * **語と語のあいだは空ける。**助詞を選んでいない並び（「影 消える」）でも
 * 読めるようにするため。詰めて書くと「影消える」になって切れ目が分からない。
 * 文の終わりに「。」を付ける。**作者が記号を打つのではなく、区切りの結果。**
 */
export function renderSentences(tokens: Token[]): string[] {
  return toSentences(tokens).map((s) => `${s.map((t) => t.label).join(" ")}。`);
}

/** DB へ送る形。語のIDの並びと、印が付いた位置 */
export function toPayload(tokens: Token[]): { vocabIds: number[]; breaks: number[] } {
  return {
    vocabIds: tokens.map((t) => t.id),
    breaks: tokens.flatMap((t, i) => (t.breakAfter && i < tokens.length - 1 ? [i] : [])),
  };
}

/** DB から返った形を組み立て直す。作り直しの初期値に使う */
export function fromSaved(
  ids: number[],
  labels: string[],
  breaks: number[],
): Token[] {
  return trimLastBreak(
    ids.map((id, i) => ({
      id,
      label: labels[i] ?? String(id),
      breakAfter: breaks.includes(i),
    })),
  );
}
