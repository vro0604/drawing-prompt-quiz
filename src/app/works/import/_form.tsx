"use client";

import { useMemo, useState } from "react";
import { SubmitButton } from "@/app/_pending";
import {
  COMPLETENESS_CHOICES,
  DEFAULT_COMPLETENESS,
  DIVISIONS,
  MAX_IMAGE_BYTES,
  type Division,
} from "@/features/work/types";
import {
  kindLabel,
  type ArtFirstVocabulary,
  type VocabCategory,
  type VocabTag,
} from "@/features/artfirst/types";
import type { AgreementProps } from "@/app/works/new/_form";
import { createArtFirstWorkAction } from "./actions";
import {
  btnPrimary,
  btnSecondary,
  btnToggle,
  btnToggleOff,
  btnToggleOn,
  field,
  surface,
} from "@/app/_surface";

/**
 * 持ち込みの投稿フォーム。
 *
 * 【なぜ Client Component か】
 *   語を選ぶ操作が、送信前に画面を変える。
 *     ・いま何件選んでいるか
 *     ・その分類はもう上限か
 *     ・3件に届いたか（届くまで投稿できない）
 *   どれもサーバー往復では表せない。部門による欄の増減も /works/new と同じ。
 *
 * 【数を画面に書かない】
 *   3件・6件・分類ごとの上限は、すべて DB から来た vocabulary の値を使う。
 *   ここに数を書くと、DB 側の規則を変えたときに画面だけ古くなる。
 *
 * 【選べても格納できない状態を作らない】
 *   分類ごとの上限（capacity）に達した語は押せなくする。
 *   総数が上限に達したら、選んでいない語を全部押せなくする。
 *   **画面で止めるのは親切であって守りではない。**同じ判定は
 *   create_art_first_work が持っていて、直接叩いても断られる。
 */

type Selected = { tag: VocabTag; category: VocabCategory };

function Label({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <span className="block space-y-1">
      <span className="block text-sm font-bold">{children}</span>
      {hint ? <span className="block text-xs text-faint">{hint}</span> : null}
    </span>
  );
}

export function ImportForm({
  vocabulary,
  agreement,
}: {
  vocabulary: ArtFirstVocabulary;
  agreement: AgreementProps;
}) {
  const [division, setDivision] = useState<Division>("original");
  const [fileName, setFileName] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [sizeError, setSizeError] = useState<string | null>(null);

  const [openCategory, setOpenCategory] = useState<string>(
    vocabulary.categories[0]?.category_key ?? "",
  );
  const [keyword, setKeyword] = useState("");
  const [selected, setSelected] = useState<Selected[]>([]);

  const max = vocabulary.max_words;
  const min = vocabulary.min_words;
  const full = selected.length >= max;
  const enough = selected.length >= min;

  const category = useMemo(
    () => vocabulary.categories.find((c) => c.category_key === openCategory) ?? null,
    [vocabulary, openCategory],
  );

  /** その分類ですでに何件選んでいるか */
  function pickedIn(categoryKey: string) {
    return selected.filter((s) => s.category.category_key === categoryKey).length;
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
      if (now.some((s) => s.tag.id === tag.id)) {
        return now.filter((s) => s.tag.id !== tag.id);
      }
      if (now.length >= max) return now;
      if (now.filter((s) => s.category.category_key === cat.category_key).length >= cat.capacity) {
        return now;
      }
      return [...now, { tag, category: cat }];
    });
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;

    setPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return file ? URL.createObjectURL(file) : null;
    });

    setFileName(file?.name ?? null);
    setSizeError(
      file && file.size > MAX_IMAGE_BYTES
        ? `このファイルは ${(file.size / 1024 / 1024).toFixed(1)}MB あります。5MB までにしてください。`
        : null,
    );
  }

  return (
    <form action={createArtFirstWorkAction} className={`${surface} space-y-8`}>
      {/* 選んだ語は、この1つの欄でサーバーへ渡る。並びがそのままお題の並びになる */}
      <input
        type="hidden"
        name="tagIds"
        value={selected.map((s) => s.tag.id).join(",")}
      />

      {/* --- 画像 ------------------------------------------------------------ */}
      <div className="space-y-3">
        <Label hint="JPEG / PNG / WebP・5MBまで。1投稿1画像です（仮定A5）">画像</Label>
        <input
          type="file"
          name="image"
          accept="image/jpeg,image/png,image/webp"
          required
          onChange={onPickFile}
          className="w-full text-sm file:mr-4 file:cursor-pointer file:rounded-lg file:border-0 file:bg-accent file:px-4 file:py-2 file:text-sm file:font-bold file:text-on-accent"
        />

        {sizeError ? <p className="text-xs text-danger">{sizeError}</p> : null}

        {previewUrl ? (
          <div className="space-y-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewUrl}
              alt="選んだ画像のプレビュー"
              className="max-h-72 w-auto rounded-xl border border-line"
            />
            <p className="text-xs text-faint">{fileName}</p>
          </div>
        ) : null}
      </div>

      {/* --- 試したいこと（＝クイズの正解）------------------------------------ */}
      <div className="space-y-4" data-testid="picker">
        <Label
          hint={`${min}〜${max}件。選んだ項目は、作品を見る人への問題になります`}
        >
          この絵で、どう見えるか試したいもの
        </Label>

        <div className="rounded-xl bg-sunken p-4 space-y-3">
          <p className="text-sm font-bold" data-testid="picked-count">
            選択中 {selected.length} / {max}
          </p>

          {selected.length === 0 ? (
            <p className="text-xs text-faint">
              まだ選んでいません。下の分類から {min} 件以上選んでください。
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2" data-testid="picked">
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

          {!enough ? (
            <p className="text-xs text-faint">
              あと {min - selected.length} 件で投稿できます。
            </p>
          ) : null}
        </div>

        {vocabulary.categories.length === 0 ? (
          <p className="text-xs text-danger">
            いま選べる語を読み込めませんでした。時間をおいて開き直してください。
          </p>
        ) : (
          <>
            {/* 分類。337語を一度に並べない。まず分類、その中で探す */}
            <div className="flex flex-wrap gap-2" data-testid="categories">
              {vocabulary.categories.map((c) => {
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
                    {picked > 0 ? ` ${picked}/${c.capacity}` : ""}
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

                <p className="text-xs text-faint">
                  {category.label}は {category.capacity} 件まで選べます（いま{" "}
                  {pickedIn(category.category_key)} 件）。
                </p>

                <ul className="flex flex-wrap gap-2" data-testid="words">
                  {visibleTags.map((t) => {
                    const picked = selected.some((s) => s.tag.id === t.id);
                    const capacityFull =
                      pickedIn(category.category_key) >= category.capacity;
                    const disabled = !picked && (full || capacityFull);

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

      {/* --- タイトル -------------------------------------------------------- */}
      <div className="space-y-3">
        <Label hint="60字まで">タイトル</Label>
        <input type="text" name="title" required maxLength={60} className={field} />
      </div>

      {/* --- 部門 ------------------------------------------------------------ */}
      <div className="space-y-3">
        <Label hint="投稿後は変更できません。間違えた場合は投稿し直してください">部門</Label>
        <div className="grid gap-3 sm:grid-cols-3">
          {DIVISIONS.map((d) => (
            <label
              key={d.value}
              className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-4 hover:bg-sunken has-checked:border-line-active"
            >
              <input
                type="radio"
                name="division"
                value={d.value}
                checked={division === d.value}
                onChange={() => setDivision(d.value)}
                className="mt-1"
              />
              <span className="space-y-1">
                <span className="block text-sm font-bold">{d.label}</span>
                <span className="block text-xs text-faint">{d.note}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* --- 完成度 ---------------------------------------------------------- */}
      <div className="space-y-3">
        <Label hint="どこまで描いたか。あとから変更できます">完成度</Label>
        <div className="grid gap-3 sm:grid-cols-3">
          {COMPLETENESS_CHOICES.map((c) => (
            <label
              key={c.value}
              className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-4 hover:bg-sunken has-checked:border-line-active"
            >
              <input
                type="radio"
                name="completeness"
                value={c.value}
                defaultChecked={c.value === DEFAULT_COMPLETENESS}
                className="mt-1"
              />
              <span className="space-y-1">
                <span className="block text-sm font-bold">{c.label}</span>
                <span className="block text-xs text-faint">{c.note}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* --- ファンアートのときだけ ------------------------------------------ */}
      {division === "fanart" ? (
        <div className="space-y-5 rounded-xl bg-sunken p-5">
          <p className="text-xs text-muted">
            権利者の許諾範囲を守って投稿してください。二次創作を禁止している作品や、
            公式が個別に定めたガイドラインがある場合はそれに従ってください（R12）。
          </p>

          <div className="space-y-2">
            <Label hint="必須・100字まで">元作品名</Label>
            <input type="text" name="sourceTitle" required maxLength={100} className={field} />
          </div>

          <div className="space-y-2">
            <Label hint="任意・100字まで">キャラクター名</Label>
            <input type="text" name="sourceCharacter" maxLength={100} className={field} />
          </div>

          <div className="space-y-2">
            <Label hint="任意・500字まで。捏造設定・独自解釈などの断り書きに使えます">
              補足
            </Label>
            <textarea name="fanartNote" maxLength={500} rows={3} className={field} />
          </div>
        </div>
      ) : null}

      {/* --- 規約への同意（まだのときだけ）------------------------------------ */}
      {agreement ? (
        <div className={`${surface} space-y-3 border-notice-tint/40`}>
          <h2 className="text-sm font-bold">投稿の前に同意が必要です</h2>
          <input type="hidden" name="termsVersion" value={agreement.termsVersion} />
          <input type="hidden" name="privacyVersion" value={agreement.privacyVersion} />
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" name="agreeDocs" value="on" required className="mt-1 size-4" />
            <span>
              <a href="/terms" target="_blank" className="underline">
                利用規約
              </a>
              と
              <a href="/privacy" target="_blank" className="underline">
                プライバシーポリシー
              </a>
              に同意します。
            </span>
          </label>
          <p className="text-xs text-faint">
            同意した記録として、どの版にいつ同意したかを5年間だけ保存します。
            退会するとこの記録からあなたとの結び付きが外れます。
          </p>
        </div>
      ) : null}

      {/* --- 送信 ------------------------------------------------------------ */}
      <div className="space-y-3 border-t border-ink/10 pt-6">
        <div className="flex flex-wrap gap-3">
          <SubmitButton
            pendingLabel="投稿しています…"
            className={btnPrimary}
            disabled={!enough}
          >
            公開して投稿する
          </SubmitButton>
          <SubmitButton
            pendingLabel="保存しています…"
            name="saveAs"
            value="draft"
            className={btnSecondary}
            disabled={!enough}
          >
            下書きとして保存する
          </SubmitButton>
        </div>
        <p className="text-xs text-faint">
          下書きは自分だけが見られます。あとから作品ページで公開できます。
        </p>
      </div>
    </form>
  );
}
