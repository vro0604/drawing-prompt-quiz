import type { AuthError } from "@supabase/supabase-js";

/**
 * Supabase Auth のエラーを、画面に出してよい日本語へ変換する。
 *
 * 【なぜ要るか】
 *   本番の認証試験で、画面にそのまま
 *   **`email rate limit exceeded`** と英語が出た（D89）。
 *
 *   これは Supabase 内蔵メールの送信枠を使い切っただけで、
 *   利用者の入力は何も間違っていない。それなのに英語のまま出すと、
 *   読んだ人は「自分の入力が悪い」と思って**同じ操作を繰り返す**。
 *   繰り返すほど枠は空かないので、いちばんやってほしくない行動を促す。
 *
 * 【方針】
 *   1. 生のエラー文を画面へ出さない（英語・内部用語・コードを含めない）
 *   2. 利用者の落ち度でないものは、**落ち度でないと分かる文**にする
 *   3. 知らないエラーは当てずっぽうに説明せず、ひとまとめの文へ落とす
 *
 * 【文面で分岐しないこと】
 *   照合はまず `code` で行う。Supabase の文言は予告なく変わる（D82）。
 *   文面の照合は、code が付かない古い応答に備えた**保険**として残す。
 */

/** 確認メールの送信枠を使い切った（プロジェクト単位の上限） */
export const EMAIL_RATE_LIMITED = "over_email_send_rate_limit";

/** 入力したパスワードが、いま設定されているものと同じ */
export const SAME_PASSWORD = "same_password";

/**
 * 確認メールの送信上限に当たったときの文。
 *
 * **「登録できませんでした」と書かない。**
 * 登録の申し込み自体は届いていることがあるし、
 * 何より利用者は入力を直しようがない。待てば直ることだけを伝える。
 */
export const EMAIL_RATE_LIMIT_MESSAGE =
  "確認メールの送信上限に達しました。時間をおいてもう一度お試しください。" +
  "（入力の誤りではありません）";

/** 原因を言い当てられないときの文 */
const FALLBACK = "うまく処理できませんでした。時間をおいてもう一度お試しください。";

type Maybe = Pick<AuthError, "message"> & { code?: string; status?: number };

/** 送信枠切れかどうか。code を先に見て、文面は保険 */
export function isEmailRateLimit(error: Maybe | null | undefined): boolean {
  if (!error) return false;
  if (error.code === EMAIL_RATE_LIMITED) return true;
  return /email rate limit/i.test(error.message ?? "");
}

/**
 * 既知のエラーを日本語にする。
 *
 * @param fallback 当てはまらなかったときに出す文。省略すると汎用の文
 * @returns 画面に出してよい日本語。**生のエラー文は決して含まない**
 */
export function authErrorMessage(
  error: Maybe | null | undefined,
  fallback: string = FALLBACK,
): string {
  if (!error) return fallback;

  const code = error.code ?? "";
  const text = error.message ?? "";

  // --- 利用者の落ち度ではないもの ---------------------------------------------
  if (isEmailRateLimit(error)) return EMAIL_RATE_LIMIT_MESSAGE;

  if (code === "over_request_rate_limit" || /rate limit/i.test(text)) {
    return "ただいま混み合っています。少し時間をおいてからもう一度お試しください。";
  }

  // --- 入力を直せばやり直せるもの ---------------------------------------------
  if (code === "invalid_credentials" || /invalid login credentials/i.test(text)) {
    return "メールアドレスかパスワードが違います。";
  }
  if (code === "email_not_confirmed") {
    return "メールの確認がまだ済んでいません。届いているメールのリンクを開いてください。";
  }
  if (code === "user_already_exists" || code === "email_exists") {
    return "このメールアドレスは既に登録されています。サインインしてください。";
  }
  if (code === "weak_password") {
    return "パスワードが短すぎます。6文字以上にしてください。";
  }
  if (code === "email_address_invalid" || code === "validation_failed") {
    return "メールアドレスの形式を確かめてください。";
  }

  return fallback;
}
