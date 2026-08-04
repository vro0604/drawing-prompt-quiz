"use client";

import { useState } from "react";
import {
  ACTUAL_TIME_CHOICES,
  DIVISIONS,
  MAX_IMAGE_BYTES,
  type Division,
} from "@/features/work/types";
import { createWorkAction } from "./actions";

/**
 * 投稿フォーム。
 *
 * 【なぜここだけ Client Component か】
 *   このプロジェクトの画面はすべて Server Component で、状態は DB にしか
 *   持たない方針にしている。ここだけ例外にしているのは2つの理由から。
 *
 *     1. 部門を選ぶと入力欄が増減する（ファンアートのときだけ3項目）
 *     2. 選んだ画像をその場で確認したい
 *
 *   どちらも「送信する前に画面が変わる」動きで、サーバー往復では表せない。
 *
 * 【JavaScript が無効なとき】
 *   form の action に Server Action を渡しているので、送信そのものは動く。
 *   ただし部門による出し分けは効かず、最初に選ばれている
 *   「オリジナル」のまま送られる。投稿はできるので致命的ではない。
 *
 * 【入力の検査について】
 *   required や maxLength はブラウザに親切なだけで、守りではない。
 *   POST は誰でも作れるので、本当の検査は create_work（D27 の6検査）が持つ。
 */

const box =
  "rounded-2xl border border-black/10 bg-white/60 p-6 dark:border-white/15 dark:bg-white/5";

const input =
  "w-full rounded-xl border border-black/15 bg-transparent px-4 py-3 text-sm dark:border-white/20";

function Label({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <span className="block space-y-1">
      <span className="block text-sm font-bold">{children}</span>
      {hint ? (
        <span className="block text-xs text-black/50 dark:text-white/50">{hint}</span>
      ) : null}
    </span>
  );
}

/** 未同意のときだけ渡す。null なら同意欄を出さない */
export type AgreementProps = { termsVersion: string; privacyVersion: string } | null;

export function WorkForm({
  promptId,
  agreement,
}: {
  promptId: string;
  agreement: AgreementProps;
}) {
  const [division, setDivision] = useState<Division>("original");
  const [fileName, setFileName] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [sizeError, setSizeError] = useState<string | null>(null);

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;

    // 前のプレビューを片付ける。createObjectURL は明示的に解放しないと
    // そのページを開いている間ずっとメモリを掴んだままになる。
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
    <form action={createWorkAction} className={`${box} space-y-8`}>
      <input type="hidden" name="promptId" value={promptId} />

      {/* --- 画像 ------------------------------------------------------------ */}
      <div className="space-y-3">
        <Label hint="JPEG / PNG / WebP・5MBまで。1投稿1画像です（仮定A5）">画像</Label>
        <input
          type="file"
          name="image"
          accept="image/jpeg,image/png,image/webp"
          required
          onChange={onPickFile}
          className="w-full text-sm file:mr-4 file:cursor-pointer file:rounded-lg file:border-0 file:bg-black file:px-4 file:py-2 file:text-sm file:font-bold file:text-white dark:file:bg-white dark:file:text-black"
        />

        {sizeError ? (
          <p className="text-xs text-rose-700 dark:text-rose-300">{sizeError}</p>
        ) : null}

        {previewUrl ? (
          <div className="space-y-2">
            {/* next/image は使わない。ここで表示するのは blob: の一時URLで、
                画像最適化の対象にできないため。 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewUrl}
              alt="選んだ画像のプレビュー"
              className="max-h-72 w-auto rounded-xl border border-black/10 dark:border-white/15"
            />
            <p className="text-xs text-black/45 dark:text-white/45">{fileName}</p>
          </div>
        ) : null}
      </div>

      {/* --- タイトル -------------------------------------------------------- */}
      <div className="space-y-3">
        <Label hint="60字まで">タイトル</Label>
        <input type="text" name="title" required maxLength={60} className={input} />
      </div>

      {/* --- 部門 ------------------------------------------------------------ */}
      <div className="space-y-3">
        <Label hint="投稿後は変更できません。間違えた場合は投稿し直してください">部門</Label>
        <div className="grid gap-3 sm:grid-cols-3">
          {DIVISIONS.map((d) => (
            <label
              key={d.value}
              className="flex cursor-pointer items-start gap-3 rounded-xl border border-black/10 p-4 hover:bg-black/[0.03] has-checked:border-black/40 dark:border-white/15 dark:hover:bg-white/5 dark:has-checked:border-white/50"
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
                <span className="block text-xs text-black/55 dark:text-white/55">{d.note}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* --- ファンアートのときだけ ------------------------------------------ */}
      {division === "fanart" ? (
        <div className="space-y-5 rounded-xl bg-black/[0.03] p-5 dark:bg-white/5">
          <p className="text-xs text-black/60 dark:text-white/60">
            権利者の許諾範囲を守って投稿してください。二次創作を禁止している作品や、
            公式が個別に定めたガイドラインがある場合はそれに従ってください（R12）。
          </p>

          <div className="space-y-2">
            <Label hint="必須・100字まで">元作品名</Label>
            <input
              type="text"
              name="sourceTitle"
              required
              maxLength={100}
              className={input}
            />
          </div>

          <div className="space-y-2">
            <Label hint="任意・100字まで">キャラクター名</Label>
            <input type="text" name="sourceCharacter" maxLength={100} className={input} />
          </div>

          <div className="space-y-2">
            <Label hint="任意・500字まで。捏造設定・独自解釈などの断り書きに使えます">
              補足
            </Label>
            <textarea name="fanartNote" maxLength={500} rows={3} className={input} />
          </div>
        </div>
      ) : null}

      {/* --- 実制作時間 ------------------------------------------------------ */}
      <div className="space-y-3">
        <Label hint="自己申告です。公開したあとは変更できません（D25）">実制作時間</Label>
        <select name="actualTimeSeconds" defaultValue="" className={input}>
          {ACTUAL_TIME_CHOICES.map((c) => (
            <option key={c.label} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-black/45 dark:text-white/45">
          時間別ランキングの分類にはお題を引いたときの制限時間を使うため、
          ここでの申告は分類に影響しません。
        </p>
      </div>

      {/* --- 規約への同意（まだのときだけ）------------------------------------ */}
      {/*
        いつも出すのではなく、同意が要るときだけ出す。毎回出すと読まれなくなる。
        版を hidden で持つのは、**同意した瞬間に有効だった版**を記録するため。
        表示中に改定されたら、DB 側が VERSION_MISMATCH で断る。
      */}
      {agreement ? (
        <div className={`${box} space-y-3 border-amber-500/40`}>
          <h2 className="text-sm font-bold">投稿の前に同意が必要です</h2>
          <input type="hidden" name="termsVersion" value={agreement.termsVersion} />
          <input type="hidden" name="privacyVersion" value={agreement.privacyVersion} />
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              name="agreeDocs"
              value="on"
              required
              className="mt-1 size-4"
            />
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
          <p className="text-xs text-black/45 dark:text-white/45">
            同意した記録として、どの版にいつ同意したかを5年間だけ保存します。
            退会するとこの記録からあなたとの結び付きが外れます。
          </p>
        </div>
      ) : null}

      {/* --- 送信 ------------------------------------------------------------ */}
      <div className="space-y-3 border-t border-black/10 pt-6 dark:border-white/10">
        <div className="flex flex-wrap gap-3">
          <button
            type="submit"
            className="rounded-xl bg-black px-6 py-3 text-sm font-bold text-white hover:opacity-85 dark:bg-white dark:text-black"
          >
            公開して投稿する
          </button>
          <button
            type="submit"
            name="saveAs"
            value="draft"
            className="rounded-xl border border-black/20 px-6 py-3 text-sm font-bold hover:bg-black/[0.04] dark:border-white/25 dark:hover:bg-white/10"
          >
            下書きとして保存する
          </button>
        </div>
        <p className="text-xs text-black/45 dark:text-white/45">
          下書きは自分だけが見られます。他の人からは、そのURLを開いても存在しないのと
          同じ扱いになります。あとから作品ページで公開できます。
        </p>
      </div>
    </form>
  );
}
