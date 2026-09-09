"use client";

import { useState } from "react";
import { SubmitButton } from "@/app/_pending";
import {
  COMPLETENESS_CHOICES,
  DEFAULT_COMPLETENESS,
  DIVISIONS,
  MAX_IMAGE_BYTES,
  type Division,
} from "@/features/work/types";
import type { ArtFirstVocabulary } from "@/features/artfirst/types";
import { VocabPicker, type PickedTag } from "@/features/vocab/picker";
import { createArtFirstWorkAction } from "./actions";
import { btnPrimary, btnSecondary, field, surface } from "@/app/_surface";

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

function Label({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <span className="block space-y-1">
      <span className="block text-sm font-bold">{children}</span>
      {hint ? <span className="block text-xs text-faint">{hint}</span> : null}
    </span>
  );
}

export function ImportForm({ vocabulary }: { vocabulary: ArtFirstVocabulary }) {
  const [division, setDivision] = useState<Division>("original");
  const [fileName, setFileName] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [sizeError, setSizeError] = useState<string | null>(null);

  // 選んだ語そのものは VocabPicker が持つ。ここで要るのは件数だけ
  // （3件に届くまで送信ボタンを押せなくするため）。
  const [pickedCount, setPickedCount] = useState(0);

  const max = vocabulary.max_words;
  const min = vocabulary.min_words;
  const enough = pickedCount >= min;

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

      {/* --- 試したいこと（＝クイズの正解）------------------------------------

          語を選ぶ操作そのものは、プロフィールの得意分野と同じ部品を使う
          （features/vocab/picker.tsx）。**分類ごとの上限を見るのはこちらだけ。**
          お題の枠に入れられる数が決まっているため。 */}
      <VocabPicker
        categories={vocabulary.categories}
        max={max}
        min={min}
        name="tagIds"
        useCategoryCapacity
        onPickedChange={(picked: PickedTag[]) => setPickedCount(picked.length)}
        heading="この絵で、どう見えるか試したいもの"
        hint={`${min}〜${max}件。選んだ項目は、作品を見る人への問題になります`}
        emptyHint={`まだ選んでいません。下の分類から ${min} 件以上選んでください。`}
        shortfallHint={(remaining) => `あと ${remaining} 件で投稿できます。`}
      />

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
