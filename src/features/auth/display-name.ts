export const DISPLAY_NAME_MAX_LENGTH = 30;

export type DisplayNameResult =
  | { ok: true; value: string }
  | { ok: false; message: string };

/** 新規登録で確定する表示名を、画面とサーバーで同じ規則にそろえる。 */
export function validateRegistrationDisplayName(raw: unknown): DisplayNameResult {
  const value = typeof raw === "string" ? raw.trim() : "";

  if (value === "") {
    return { ok: false, message: "表示名を入力してください。" };
  }
  if (value.length > DISPLAY_NAME_MAX_LENGTH) {
    return {
      ok: false,
      message: `表示名は${DISPLAY_NAME_MAX_LENGTH}文字以内で入力してください。`,
    };
  }
  if (value === "ゲスト" || value.toLowerCase() === "guest") {
    return { ok: false, message: "この名前は使用できません。" };
  }

  return { ok: true, value };
}
