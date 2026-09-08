"use client";

import { useMemo, useState } from "react";
import { kindLabel, type VocabCategory, type VocabTag } from "@/features/vocab/types";
import { btnToggle, btnToggleOff, btnToggleOn, field } from "@/app/_surface";

/**
 * 語彙から語を選ぶ部品。
 *
 * 【どこで使うか】
 *   ・持ち込みの投稿（/works/import）… その絵で試したい項目を3〜6件
 *   ・プロフィール（/account）… 描くのが得意／見るのが得意を0〜5件ずつ
 *
 *   もとは持ち込みのフォームの中に直接書いてあった。プロフィールでも
 *   同じ選び方をすることになったので、**同じ部品を2か所から使う**形にした。
 *   書き写して2つ持つと、片方だけ直したときに操作が食い違う。
 *
 * 【333語を一度に並べない】
 *   まず分類を選び、その中で探す。読み（かな）でも引ける。
 *   数（上限・いま何件）はすべて呼び出し側から渡された値を出す。
 *   **この部品の中に数を書かない。**
 *
 * 【押せなくすることは守りではない】
 *   上限に達した語は押せなくするが、同じ判定は必ず受け口（RPC）が持つ。
 *   ここで止めるのは、送っても断られると分かっている操作を押させないため。
 *
 * 【選んだ結果の渡し方】
 *   隠し欄1つに、語のIDをカンマでつないで入れる。フォームの送信に
 *   そのまま乗るので、親が状態を持ち回らなくてよい。
 *   件数だけは親も要る（送信ボタンの可否）ので、変わるたびに知らせる。
 */

export type PickedTag = { tag: VocabTag; category: VocabCategory };

/** 検査で名前を引くための印。持ち込みの画面は接頭辞なしの名前を使い続ける */
function testIds(prefix: string) {
  const at = (base: string) => (prefix === "" ? base : `${prefix}-${base}`);
  return {
    root: at("picker"),
    count: at("picked-count"),
    picked: at("picked"),
    categories: at("categories"),
    words: at("words"),
  };
}

export function VocabPicker({
  categories,
  max,
  min,
  name,
  testPrefix = "",
  useCategoryCapacity,
  initial = [],
  onPickedChange,
  heading,
  hint,
  emptyHint,
  shortfallHint,
}: {
  categories: VocabCategory[];
  /** 全体で選べる数 */
  max: number;
  /** これだけ選ばないと送れない数。0 なら下限なし */
  min: number;
  /** 隠し欄の名前。値は語のIDをカンマでつないだもの */
  name: string;
  testPrefix?: string;
  /** 分類ごとの上限（capacity）も見るか。お題を作るときだけ true */
  useCategoryCapacity: boolean;
  /** 最初から選ばれている語（設定の編集で使う） */
  initial?: PickedTag[];
  onPickedChange?: (picked: PickedTag[]) => void;
  heading: string;
  hint: string;
  /** 1件も選んでいないときに出す案内 */
  emptyHint: string;
  /** 下限に届いていないときに出す案内。min が 0 なら使わない */
  shortfallHint?: (remaining: number) => string;
}) {
  const ids = testIds(testPrefix);

  const [openCategory, setOpenCategory] = useState<string>(
    categories[0]?.category_key ?? "",
  );
  const [keyword, setKeyword] = useState("");
  const [selected, setSelected] = useState<PickedTag[]>(initial);

  const full = selected.length >= max;
  const enough = selected.length >= min;

  const category = useMemo(
    () => categories.find((c) => c.category_key === openCategory) ?? null,
    [categories, openCategory],
  );

  function pickedIn(categoryKey: string) {
    return selected.filter((s) => s.category.category_key === categoryKey).length;
  }

  /** その分類がもう一杯か。分類ごとの上限を見ないときは、常に空きあり */
  function categoryFull(cat: VocabCategory) {
    if (!useCategoryCapacity) return false;
    return pickedIn(cat.category_key) >= cat.capacity;
  }

  const visibleTags = useMemo(() => {
    if (!category) return [];
    const word = keyword.trim();
    if (word === "") return category.tags;
    return category.tags.filter(
      (t) => t.label.includes(word) || (t.reading ?? "").includes(word),
    );
  }, [category, keyword]);

  function toggle(tag: VocabTag, cat: VocabCategory) {
    setSelected((now) => {
      let next: PickedTag[];
      if (now.some((s) => s.tag.id === tag.id)) {
        next = now.filter((s) => s.tag.id !== tag.id);
      } else if (now.length >= max) {
        next = now;
      } else if (
        useCategoryCapacity &&
        now.filter((s) => s.category.category_key === cat.category_key).length >=
          cat.capacity
      ) {
        next = now;
      } else {
        next = [...now, { tag, category: cat }];
      }
      if (next !== now) onPickedChange?.(next);
      return next;
    });
  }

  return (
    <div className="space-y-4" data-testid={ids.root}>
      <span className="block space-y-1">
        <span className="block text-sm font-bold">{heading}</span>
        <span className="block text-xs text-faint">{hint}</span>
      </span>

      <input
        type="hidden"
        name={name}
        value={selected.map((s) => s.tag.id).join(",")}
      />

      <div className="rounded-xl bg-sunken p-4 space-y-3">
        <p className="text-sm font-bold" data-testid={ids.count}>
          選択中 {selected.length} / {max}
        </p>

        {selected.length === 0 ? (
          <p className="text-xs text-faint">{emptyHint}</p>
        ) : (
          <ul className="flex flex-wrap gap-2" data-testid={ids.picked}>
            {selected.map((s) => (
              <li key={s.tag.id}>
                <button
                  type="button"
                  onClick={() => toggle(s.tag, s.category)}
                  className="rounded-lg border border-line-firm bg-surface px-3 py-1.5 text-xs hover:bg-hover"
                  aria-label={`${s.category.label}の${s.tag.label}をやめる`}
                >
                  <span className="text-faint">{s.category.label}</span>{" "}
                  <span className="font-bold">{s.tag.label}</span>
                  <span className="pl-2 text-faint">×</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {!enough && shortfallHint ? (
          <p className="text-xs text-faint">{shortfallHint(min - selected.length)}</p>
        ) : null}
      </div>

      {categories.length === 0 ? (
        <p className="text-xs text-danger">
          いま選べる語を読み込めませんでした。時間をおいて開き直してください。
        </p>
      ) : (
        <>
          {/* 分類。全部の語を一度に並べない。まず分類、その中で探す */}
          <div className="flex flex-wrap gap-2" data-testid={ids.categories}>
            {categories.map((c) => {
              const picked = pickedIn(c.category_key);
              const on = c.category_key === openCategory;
              return (
                <button
                  key={c.category_key}
                  type="button"
                  onClick={() => {
                    setOpenCategory(c.category_key);
                    setKeyword("");
                  }}
                  className={`${btnToggle} ${on ? btnToggleOn : btnToggleOff} text-xs`}
                >
                  <span className="text-faint">{kindLabel(c.kind)}</span> {c.label}
                  {picked > 0
                    ? useCategoryCapacity
                      ? ` ${picked}/${c.capacity}`
                      : ` ${picked}`
                    : ""}
                </button>
              );
            })}
          </div>

          {category ? (
            <div className="space-y-3">
              <input
                type="search"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder={`${category.label}の中を探す（かなでも探せます）`}
                className={field}
                aria-label={`${category.label}の中を探す`}
              />

              {useCategoryCapacity ? (
                <p className="text-xs text-faint">
                  {category.label}は {category.capacity} 件まで選べます（いま{" "}
                  {pickedIn(category.category_key)} 件）。
                </p>
              ) : (
                <p className="text-xs text-faint">
                  分類をまたいで選べます。合計 {max} 件までです（いま{" "}
                  {selected.length} 件）。
                </p>
              )}

              <ul className="flex flex-wrap gap-2" data-testid={ids.words}>
                {visibleTags.map((t) => {
                  const picked = selected.some((s) => s.tag.id === t.id);
                  const disabled = !picked && (full || categoryFull(category));

                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => toggle(t, category)}
                        className={`${btnToggle} ${picked ? btnToggleOn : btnToggleOff} text-xs disabled:cursor-not-allowed disabled:opacity-40`}
                      >
                        {t.label}
                      </button>
                    </li>
                  );
                })}
              </ul>

              {visibleTags.length === 0 ? (
                <p className="text-xs text-faint">見つかりませんでした。</p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
