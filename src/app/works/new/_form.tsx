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
import type { ProductionTime } from "@/features/work/types";
import { createWorkAction } from "./actions";
import { btnPrimary, btnSecondary, field, surface } from "@/app/_surface";

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

function Label({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <span className="block space-y-1">
      <span className="block text-sm font-bold">{children}</span>
      {hint ? (
        <span className="block text-xs text-faint">{hint}</span>
      ) : null}
    </span>
  );
}

export function WorkForm({
  promptId,
  production,
}: {
  promptId: string;
  /** サーバーが計測した制作時間。**入力欄ではない。出すだけ** */
  production: ProductionTime | null;
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
    <form action={createWorkAction} data-form="work" className={`${surface} space-y-8`}>
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
          className="w-full text-sm file:mr-4 file:cursor-pointer file:rounded-lg file:border-0 file:bg-accent file:px-4 file:py-2 file:text-sm file:font-bold file:text-on-accent"
        />

        {sizeError ? (
          <p className="text-xs text-danger">{sizeError}</p>
        ) : null}

        {previewUrl ? (
          <div className="space-y-2">
            {/* next/image は使わない。ここで表示するのは blob: の一時URLで、
                画像最適化の対象にできないため。 */}
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
      {/*
        部門（何を描いたか）とは別の軸で、どこまで描いたかを選ぶ（D135）。

        **落書きを最初に置いている。**並び順そのものが「出していい」の合図で、
        仕上げを先頭にすると「まずここを目指すもの」に読める。

        既定は「仕上げ」にしていない。選ばせる。既定があると、
        選ばなかった人の作品が勝手にどこかの棚へ入る。
      */}
      <div className="space-y-3">
        <Label hint="どこまで描いたか。あとから変更できます">完成度</Label>
        <p className="text-xs text-faint">
          落書きのまま出して構いません。ここは上手さを測る欄ではなく、
          <strong>見る人が同じ土俵で見るための欄</strong>です。
        </p>
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
            <input
              type="text"
              name="sourceTitle"
              required
              maxLength={100}
              className={field}
            />
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

      {/* --- 実制作時間（計測値。入力欄ではない） ----------------------------- */}
      {/*
        【2026-09-09 に自己申告をやめた】
          利用者が任意の時間を選んで記録を書き換えられる形にしない。
          ここに出すのはサーバーが計測した値で、送信もしない。
          受け口（DB のトリガー）も、送られてきた値を受け取らず計測値で上書きする。
      */}
      <div className="space-y-2" data-field="production-time">
        <Label hint="サーバーが計測した値です。申告や変更はできません">
          制作時間の記録
        </Label>
        {production ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-faint">最初に選んだ制作時間</dt>
            <dd className="tabular-nums" data-field="chosen-limit">
              {production.chosen_limit_seconds === null
                ? "無制限"
                : formatSpan(production.chosen_limit_seconds)}
            </dd>

            <dt className="text-faint">延長</dt>
            <dd className="tabular-nums" data-field="granted">
              {production.renew_count === 0
                ? "なし"
                : `${production.renew_count} 回・合計 ${formatSpan(production.granted_seconds)}`}
            </dd>

            <dt className="text-faint">実際にかかった時間</dt>
            <dd className="tabular-nums font-bold" data-field="elapsed">
              {formatSpan(production.elapsed_seconds)}
            </dd>
          </dl>
        ) : (
          <p className="text-sm text-faint">計測値を読めませんでした。</p>
        )}
        <p className="text-xs text-faint">
          時間別ランキングの分類には、お題を引いたときに選んだ制限時間を使います。
        </p>
      </div>


      {/* --- 送信 ------------------------------------------------------------ */}
      <div className="space-y-3 border-t border-ink/10 pt-6">
        <div className="flex flex-wrap gap-3">
          <SubmitButton
            pendingLabel="投稿しています…"
            className={btnPrimary}
          >
            公開して投稿する
          </SubmitButton>
          <SubmitButton
            pendingLabel="保存しています…"
            name="saveAs"
            value="draft"
            className={btnSecondary}
          >
            下書きとして保存する
          </SubmitButton>
        </div>
        <p className="text-xs text-faint">
          下書きは自分だけが見られます。他の人からは、そのURLを開いても存在しないのと
          同じ扱いになります。あとから作品ページで公開できます。
        </p>
      </div>
    </form>
  );
}

/** 秒を「1時間30分」の形にする。0秒未満は0として書く */
function formatSpan(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}時間${m}分` : `${h}時間`;
  if (m > 0) return `${m}分`;
  return `${s}秒`;
}
