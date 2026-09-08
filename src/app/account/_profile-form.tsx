"use client";

import { useState } from "react";
import Image from "next/image";
import { SubmitButton } from "@/app/_pending";
import { btnPrimary, field } from "@/app/_surface";
import {
  LINK_FIELDS,
  SPECIALTY_MAX,
  SPECIALTY_SECTIONS,
} from "@/features/profile/types";
import { AVATAR_DISPLAY_SIZE, AVATAR_MAX_BYTES } from "@/features/profile/avatar";
import { VocabPicker, type PickedTag } from "@/features/vocab/picker";
import type { VocabCategory } from "@/features/vocab/types";

/**
 * アカウント画面の「プロフィール」欄。
 *
 * 【なぜ Client Component か】
 *   アイコンを選んだら、送信する前にその場で見えないと、
 *   何を選んだのか分からない。得意分野の選択も、押した数がすぐ変わる。
 *   どちらもサーバー往復では表せない。
 *
 * 【1つのフォームにまとめてある】
 *   アイコン・ID・表示名・自己紹介・得意分野・外部リンクを、
 *   1つの「プロフィールを保存する」で保存する。
 *   出所: ユーザー指示（2026-09-08）のアカウント画面の情報構造
 *   「プロフィール ──── アイコン / ID / 表示名 / 自己紹介 / 描くのが得意 /
 *   見るのが得意 / 外部リンク / プロフィール保存」。
 *
 * 【得意分野は成績ではない】
 *   ここで選ぶのは自己申告。実際の正答率とは関係が無く、
 *   次の作品の配られ方（D169）も変わらない。画面にもそう書く。
 */

const MB = Math.floor(AVATAR_MAX_BYTES / 1024 / 1024);

function AvatarPreview({
  url,
  initial,
}: {
  url: string | null;
  initial: string;
}) {
  if (url) {
    return (
      <Image
        src={url}
        alt="いまのプロフィールアイコン"
        width={AVATAR_DISPLAY_SIZE}
        height={AVATAR_DISPLAY_SIZE}
        className="size-20 rounded-full border border-line object-cover"
      />
    );
  }
  return (
    <span
      aria-label="プロフィールアイコンは未設定です"
      className="flex size-20 items-center justify-center rounded-full border border-line bg-sunken text-2xl font-bold text-faint"
    >
      {initial}
    </span>
  );
}

export function ProfileForm({
  action,
  handle,
  displayName,
  bio,
  links,
  avatarUrl,
  avatarInitial,
  categories,
  initialDrawing,
  initialViewing,
}: {
  action: (form: FormData) => void | Promise<void>;
  handle: string;
  displayName: string;
  bio: string;
  links: Record<string, string>;
  avatarUrl: string | null;
  avatarInitial: string;
  categories: VocabCategory[];
  initialDrawing: PickedTag[];
  initialViewing: PickedTag[];
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;

    setPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return file ? URL.createObjectURL(file) : null;
    });

    if (file && file.size > AVATAR_MAX_BYTES) {
      setFileError(`このファイルは ${MB}MB を超えています。`);
    } else {
      setFileError(null);
    }
    if (file) setRemoveAvatar(false);
  }

  return (
    <form action={action} className="space-y-6">
      {/* --- アイコン --------------------------------------------------------- */}
      <div className="space-y-3" data-testid="avatar-field">
        <span className="block space-y-1">
          <span className="block text-sm font-bold">プロフィールアイコン</span>
          <span className="block text-xs text-faint">
            JPEG / PNG / WebP・{MB}MBまで。正方形で表示します。
          </span>
        </span>

        <div className="flex items-center gap-4">
          {previewUrl ? (
            // 選んだ直後の見本。まだ送っていないので一時的なURLを直接出す
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewUrl}
              alt="選んだアイコンのプレビュー"
              className="size-20 rounded-full border border-line object-cover"
            />
          ) : (
            <AvatarPreview
              url={removeAvatar ? null : avatarUrl}
              initial={avatarInitial}
            />
          )}

          <div className="flex-1 space-y-2">
            <input
              type="file"
              name="avatar"
              accept="image/jpeg,image/png,image/webp"
              onChange={onPickFile}
              className="w-full text-sm file:mr-4 file:cursor-pointer file:rounded-lg file:border-0 file:bg-accent file:px-4 file:py-2 file:text-sm file:font-bold file:text-on-accent"
            />
            {avatarUrl && !previewUrl ? (
              <label className="flex items-center gap-2 text-xs text-faint">
                <input
                  type="checkbox"
                  name="avatarRemove"
                  value="1"
                  checked={removeAvatar}
                  onChange={(e) => setRemoveAvatar(e.target.checked)}
                  className="size-4"
                  data-testid="avatar-remove"
                />
                いまのアイコンを外す（保存すると既定の表示に戻ります）
              </label>
            ) : null}
          </div>
        </div>

        {fileError ? <p className="text-xs text-danger">{fileError}</p> : null}
      </div>

      {/* --- ID -------------------------------------------------------------- */}
      <label className="block space-y-1">
        <span className="block text-xs text-faint">
          ID（3〜20字・小文字の英数字とハイフン）
        </span>
        <input
          type="text"
          name="handle"
          defaultValue={handle}
          maxLength={20}
          pattern="[a-z0-9][a-z0-9\-]{1,18}[a-z0-9]"
          placeholder="my-handle"
          className={field}
        />
        <span className="block text-xs text-faint">
          {handle
            ? "早い者勝ちです。変えると、いまの ID は他の人が取れるようになります。"
            : "早い者勝ちです。ほかの人が使っている ID は取れません。"}
        </span>
      </label>

      {/* --- 表示名 ---------------------------------------------------------- */}
      <label className="block space-y-1">
        <span className="block text-xs text-faint">表示名（30字まで）</span>
        <input
          type="text"
          name="displayName"
          defaultValue={displayName}
          maxLength={30}
          className={field}
        />
      </label>

      {/* --- 自己紹介 -------------------------------------------------------- */}
      <label className="block space-y-1">
        <span className="block text-xs text-faint">自己紹介（500字まで）</span>
        <textarea
          name="bio"
          defaultValue={bio}
          maxLength={500}
          rows={3}
          className={field}
        />
      </label>

      {/* --- 得意分野 -------------------------------------------------------- */}
      <div className="space-y-6 border-t border-ink/10 pt-6">
        <p className="text-xs text-faint">
          ここから下は自己申告です。実際の正解率やクイズの出題には影響しません。
          0件でもかまいません。
        </p>

        <VocabPicker
          categories={categories}
          max={SPECIALTY_MAX}
          min={0}
          name="drawingTagIds"
          testPrefix="drawing"
          useCategoryCapacity={false}
          initial={initialDrawing}
          heading={SPECIALTY_SECTIONS[0].label}
          hint={SPECIALTY_SECTIONS[0].hint}
          emptyHint="まだ選んでいません。下の分類から選べます（0件のままでもかまいません）。"
        />

        <VocabPicker
          categories={categories}
          max={SPECIALTY_MAX}
          min={0}
          name="viewingTagIds"
          testPrefix="viewing"
          useCategoryCapacity={false}
          initial={initialViewing}
          heading={SPECIALTY_SECTIONS[1].label}
          hint={SPECIALTY_SECTIONS[1].hint}
          emptyHint="まだ選んでいません。下の分類から選べます（0件のままでもかまいません）。"
        />
      </div>

      {/* --- 外部リンク ------------------------------------------------------ */}
      <div className="space-y-3 border-t border-ink/10 pt-6">
        <span className="block text-xs text-faint">
          外部リンク（http:// または https:// で始まる URL）
        </span>
        {LINK_FIELDS.map((f) => (
          <label key={f.key} className="block space-y-1">
            <span className="block text-xs text-faint">{f.label}</span>
            <input
              type="url"
              name={`link_${f.key}`}
              defaultValue={links[f.key] ?? ""}
              placeholder={f.placeholder}
              className={field}
            />
          </label>
        ))}
      </div>

      <SubmitButton
        pendingLabel="保存しています…"
        className={`${btnPrimary} w-full`}
        disabled={fileError !== null}
      >
        プロフィールを保存する
      </SubmitButton>
    </form>
  );
}
