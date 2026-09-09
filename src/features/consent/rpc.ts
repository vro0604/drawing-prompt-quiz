import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readableRpcError } from "@/features/draft/rpc";

/**
 * 規約同意の関門（P5）。サーバー専用。
 *
 * 【この関門が答える問い】
 *   「いま有効な規約に同意していない人を、どの時点で止めるか」。
 *
 *   止める時点を決めているのは **DB の consent_status()** で、
 *   このファイルは判定をしない。読んで、止めると言われたら送るだけ。
 *   版の比較も時刻の比較も画面側では行わない。
 *
 * 【どこで止まるか】
 *   通常サービスのページの入口で requireConsent() を呼ぶ。
 *   未同意で止めるべきなら /consent へ送る。
 *   **URL を直に叩いても止まる**（サーバー側で判定しているため）。
 *
 * 【止めないもの】
 *   ・ゲスト … 登録していないので同意の対象ではない（spec 11-1）
 *   ・規約とポリシーの本文、同意の画面そのもの
 *   ・アカウントの画面（退会とサインアウトの経路を塞がないため）
 *   ・確認メールの戻り先（/auth/confirm）と API
 *
 * 【投稿の穴は別で塞いである】
 *   画面から同意欄を外したので、未同意のまま投稿の受け口へ直接送られたら
 *   どうなるかが問題になる。そこは DB の門番（app_guard_works）が
 *   works への INSERT を断る。**画面を消したことで穴は開いていない。**
 */

export type ConsentStatus = {
  is_anonymous: boolean;
  terms_version: string | null;
  privacy_version: string | null;
  terms_agreed: boolean;
  privacy_agreed: boolean;
  /** いま有効な版に同意していないか */
  needs_consent: boolean;
  /** この場で止めるべきか。**判定は DB が持つ** */
  gate_required: boolean;
  /** このセッションが始まった時刻（JWT の iat）。読めなければ null */
  session_started_at: string | null;
};

/** 同意の画面の場所。1か所に書く */
export const CONSENT_PATH = "/consent";

/**
 * いまの同意の状態を読む。
 *
 * 未サインインとゲストは判定の対象外なので null を返す。
 * 読めなかったときも null（**読めないことを理由に止めない。**
 * 止める根拠が無いのに止めると、通信の失敗で全員が入れなくなる）。
 */
export async function fetchConsentStatus(): Promise<ConsentStatus | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("consent_status");

  if (error) return null;
  return (data as ConsentStatus | null) ?? null;
}

/**
 * 通常サービスのページの先頭で呼ぶ。止めるべきなら /consent へ送る。
 *
 * **戻り値を使う必要は無い。**送るときは redirect が例外を投げるので、
 * この行より先は実行されない。
 */
export async function requireConsent(): Promise<void> {
  const status = await fetchConsentStatus();
  if (status?.gate_required) redirect(CONSENT_PATH);
}

/** 同意を記録する。版が食い違っていれば DB が断る。 */
export async function callAgree(
  termsVersion: string,
  privacyVersion: string,
): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("agree_to_documents", {
    p_terms_version: termsVersion,
    p_privacy_version: privacyVersion,
  });

  if (error) throw new Error(readableRpcError(error.message));
}
