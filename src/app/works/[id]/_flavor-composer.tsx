"use client";

import { useMemo, useState } from "react";
import { SubmitButton } from "@/app/_pending";
import {
  btnQuiet,
  btnSecondary,
  btnToggle,
  btnToggleOff,
  btnToggleOn,
  field,
  noticeMuted,
  surface,
} from "@/app/_surface";
import type { FlavorVocabSet, WorkFlavor } from "@/features/flavor/types";
import {
  addToken,
  fromSaved,
  moveDown,
  moveUp,
  removeAt,
  renderSentences,
  sentenceCount,
  toPayload,
  toggleBreak,
  type Token,
} from "@/features/flavor/compose";

/**
 * 作者が自作へ文章を付ける画面（D162 の 1 ／ P5）。
 *
 * ============================================================================
 * 【この画面で何ができるか】
 * ============================================================================
 *
 *   1. 分類を選び、その中から語を探して足す
 *   2. 足した語を上下に動かして、語順を決める
 *   3. 語のあいだで文を切る（最大3文）
 *   4. 保存する
 *
 *   自由入力は1文字も無い。**打てる欄は「語を探す」の1つだけ**で、
 *   そこへ打った文字は語を絞り込むためにしか使われない。送信もされない。
 *
 * ============================================================================
 * 【分類は探すためだけのもの】
 * ============================================================================
 *
 *   分類ごとに「何語まで」という枠は無い。同じ分類から5語、
 *   他の分類が0語でもよい。分類は 333語（お題の語彙）と同じ問題
 *   ——一列に並べると探せない——を解くためだけに置いてある。
 *
 * ============================================================================
 * 【並べ替えを指の操作だけに頼らない】
 * ============================================================================
 *
 *   「上へ」「下へ」は本物のボタン。Tab で移動して Enter か Space で押せる。
 *   引っ張って動かす操作は用意していない。**引っ張る操作しか無いと、
 *   キーボードだけで使う人が語順を決められなくなる。**
 *
 * ============================================================================
 * 【数はどこから来るか】
 * ============================================================================
 *
 *   語数の上限も文数の上限も、この画面には書いていない。
 *   DB の flavor_limits が唯一の出どころで、get_flavor_vocab が
 *   max_tokens / max_sentences として返したものをそのまま使う。
 *
 * ============================================================================
 * 【送るもの】
 * ============================================================================
 *
 *   隠し欄2つ。語のIDをカンマでつないだもの（vocabIds）と、
 *   文を切る位置をカンマでつないだもの（breaks）。
 *   受け口が数の並びに直して RPC へ渡し、**保存のときにも同じ関門を通す。**
 *   画面で押せなくすることは守りではない。
 */

/** 分類ごとに何語選んでいるか。**枠ではなく、見えているだけの数** */
function usedByCategory(tokens: Token[], vocab: FlavorVocabSet): Map<string, number> {
  const where = new Map<number, string>();
  for (const c of vocab.categories) for (const w of c.words) where.set(w.id, c.key);

  const out = new Map<string, number>();
  for (const t of tokens) {
    const key = where.get(t.id);
    if (key) out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

export function FlavorComposer({
  workId,
  vocab,
  current,
  action,
}: {
  workId: string;
  vocab: FlavorVocabSet;
  current: WorkFlavor | null;
  action: (form: FormData) => void | Promise<void>;
}) {
  const [tokens, setTokens] = useState<Token[]>(() =>
    current?.token_ids?.length
      ? fromSaved(current.token_ids, current.tokens, current.breaks ?? [])
      : [],
  );
  const [openCategory, setOpenCategory] = useState<string>(
    vocab.categories.find((c) => c.words.length > 0)?.key ?? "",
  );
  const [query, setQuery] = useState("");

  const payload = useMemo(() => toPayload(tokens), [tokens]);
  const lines = useMemo(() => renderSentences(tokens), [tokens]);
  const used = useMemo(() => usedByCategory(tokens, vocab), [tokens, vocab]);

  const category = vocab.categories.find((c) => c.key === openCategory) ?? null;
  const full = tokens.length >= vocab.max_tokens;
  const sentences = sentenceCount(tokens);

  // 読み仮名は無いので、絞り込みは表記だけ。空欄なら全部出す
  const words = useMemo(() => {
    const list = category?.words ?? [];
    const q = query.trim();
    const hit = q === "" ? list : list.filter((w) => w.label.includes(q));
    // 「この絵に効きそう」と登録された語を先に出す
    return [...hit].sort((a, b) => Number(b.suggested) - Number(a.suggested));
  }, [category, query]);

  return (
    <section data-flavor-composer="" className={`${surface} space-y-6`}>
      <div className="space-y-1">
        <h2 className="text-sm font-bold">作者の言葉を付ける</h2>
        <p className="text-xs text-faint">
          決まった語から選んで、短い文章を作ります。
          見た人は回答前に任意で開けて、回答後には必ず読みます。
        </p>
      </div>

      {/* --- いまの文章 ------------------------------------------------------- */}
      <div data-flavor-preview="" className="rounded-xl bg-sunken px-4 py-3">
        <p className="text-xs text-faint">
          いまの文章（{tokens.length} / {vocab.max_tokens} 語・{sentences} /{" "}
          {vocab.max_sentences} 文）
        </p>
        {lines.length === 0 ? (
          <p className="text-sm text-faint">まだ語を選んでいません。</p>
        ) : (
          lines.map((line, i) => (
            <p key={i} className="text-lg leading-relaxed">
              {line}
            </p>
          ))
        )}
      </div>

      {/* --- 選んだ語の並び --------------------------------------------------- */}
      {tokens.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-xs font-bold">語順と、文の切れ目</h3>
          <ol data-flavor-tokens="" className="space-y-2">
            {tokens.map((t, i) => (
              <li
                key={`${t.id}-${i}`}
                data-token-index={i}
                data-token-label={t.label}
                data-break={t.breakAfter ? "1" : "0"}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2"
              >
                <span className="min-w-8 text-xs text-faint">{i + 1}</span>
                <span className="text-sm font-bold">{t.label}</span>

                <span className="ml-auto flex flex-wrap items-center gap-1">
                  <button
                    type="button"
                    data-action="up"
                    disabled={i === 0}
                    onClick={() => setTokens((prev) => moveUp(prev, i))}
                    className={`${btnQuiet} disabled:opacity-40`}
                    aria-label={`${t.label} を前へ`}
                  >
                    上へ
                  </button>
                  <button
                    type="button"
                    data-action="down"
                    disabled={i === tokens.length - 1}
                    onClick={() => setTokens((prev) => moveDown(prev, i))}
                    className={`${btnQuiet} disabled:opacity-40`}
                    aria-label={`${t.label} を後ろへ`}
                  >
                    下へ
                  </button>
                  <button
                    type="button"
                    data-action="break"
                    disabled={i === tokens.length - 1}
                    aria-pressed={t.breakAfter}
                    onClick={() =>
                      setTokens((prev) => toggleBreak(prev, i, vocab.max_sentences))
                    }
                    className={`${btnToggle} ${
                      t.breakAfter ? btnToggleOn : btnToggleOff
                    } disabled:opacity-40`}
                    aria-label={`${t.label} のあとで文を切る`}
                  >
                    ここで文を切る
                  </button>
                  <button
                    type="button"
                    data-action="remove"
                    onClick={() => setTokens((prev) => removeAt(prev, i))}
                    className={btnQuiet}
                    aria-label={`${t.label} を外す`}
                  >
                    外す
                  </button>
                </span>
              </li>
            ))}
          </ol>
          <p className="text-xs text-faint">
            いちばん最後の語のあとは、必ず文の終わりです。切れ目の印は付けられません。
          </p>
        </div>
      ) : null}

      {/* --- 語を探す --------------------------------------------------------- */}
      <div className="space-y-3">
        <h3 className="text-xs font-bold">語を探す</h3>

        <div data-flavor-categories="" className="flex flex-wrap gap-2">
          {vocab.categories.map((c) => (
            <button
              key={c.key}
              type="button"
              data-category={c.key}
              aria-pressed={c.key === openCategory}
              disabled={c.words.length === 0}
              onClick={() => {
                setOpenCategory(c.key);
                setQuery("");
              }}
              className={`${btnToggle} ${
                c.key === openCategory ? btnToggleOn : btnToggleOff
              } disabled:opacity-40`}
            >
              {c.label}
              <span className="pl-2 text-xs text-faint">
                {c.words.length}語{used.get(c.key) ? `／選択 ${used.get(c.key)}` : ""}
              </span>
            </button>
          ))}
        </div>

        {category ? (
          <>
            {category.hint ? (
              <p className="text-xs text-faint">{category.hint}</p>
            ) : null}

            <label className="block space-y-1">
              <span className="block text-xs text-faint">
                この分類の中で絞り込む（打った文字は送信しません）
              </span>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                data-flavor-search=""
                className={field}
              />
            </label>

            <div data-flavor-words="" className="flex flex-wrap gap-2">
              {words.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  data-word={w.label}
                  data-word-id={w.id}
                  disabled={full}
                  onClick={() =>
                    setTokens((prev) => addToken(prev, w, vocab.max_tokens))
                  }
                  className={`${btnToggle} ${
                    w.suggested ? btnToggleOn : btnToggleOff
                  } disabled:opacity-40`}
                >
                  {w.label}
                </button>
              ))}
              {words.length === 0 ? (
                <p className="text-xs text-faint">
                  この分類に、いま使える語はありません。
                </p>
              ) : null}
            </div>
          </>
        ) : null}

        {full ? (
          <p className={noticeMuted}>
            語数の上限（{vocab.max_tokens}語）に達しました。
            足すには、先にどれかを外してください。
          </p>
        ) : null}
      </div>

      {/* --- 保存 ------------------------------------------------------------- */}
      <form action={action} className="space-y-2">
        <input type="hidden" name="workId" value={workId} />
        <input type="hidden" name="vocabIds" value={payload.vocabIds.join(",")} />
        <input type="hidden" name="breaks" value={payload.breaks.join(",")} />

        <SubmitButton
          pendingLabel="保存しています…"
          className={btnSecondary}
          disabled={tokens.length === 0}
        >
          この文章にする
        </SubmitButton>

        <p className="text-xs text-faint">
          答えそのものや、答えを言い換えただけの語は一覧に出ていません。
          回答前に読む人へ、答えが直接渡らないようにするためです。
        </p>
      </form>
    </section>
  );
}
