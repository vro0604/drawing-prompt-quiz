"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * /account のボタンから呼ばれる Server Action。
 *
 * 【この画面の位置づけ】
 *   spec 13 の Step 6（登録／匿名→昇格＋handle 設定）の**最小版**。
 *   handle・表示名・プロフィールの設定は Step 6 本体で作る。
 *   ここにあるのは「作品投稿は登録ユーザーだけ」（spec C3 / D27-1）を
 *   ブラウザで満たすために要る最低限だけ。
 *
 * 【昇格を signUp でやらない理由】
 *   ゲストの状態で signUp を呼ぶと **別の uid のユーザーが新しくできる**。
 *   引いたお題は元のゲストのものなので、新しいアカウントからは投稿できない
 *   （create_work の検査2で弾かれる）。
 *
 *   updateUser でメールを結びつけると **uid はそのまま**で永続アカウントに
 *   変わる（spec 11-2）。auth.users のトリガーが profiles.is_anonymous も
 *   false に直す（001_profiles.sql の 4-b）。
 *
 * 【refreshSession を必ず呼ぶ理由】
 *   投稿できるかどうかの判定は JWT の is_anonymous で行う（spec 9-1）。
 *   updateUser はユーザー情報を書き換えるだけで、手元のアクセストークンは
 *   古いまま（is_anonymous: true）残る。取り直さないと、
 *   登録できたのに投稿だけ断られる、という分かりにくい状態になる。
 */

const PAGE = "/account";

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

function back(message?: string, notice?: string): never {
  const params = new URLSearchParams();
  if (message) params.set("error", message);
  if (notice) params.set("notice", notice);
  const query = params.toString();
  redirect(query ? `${PAGE}?${query}` : PAGE);
}

/** メールとパスワードでサインインする（既にあるアカウントへ） */
export async function signInAction(form: FormData): Promise<void> {
  const email = str(form, "email");
  const password = str(form, "password");

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) back(`サインインできませんでした: ${error.message}`);

  revalidatePath(PAGE);
  back(undefined, "サインインしました。");
}

/**
 * アカウントを登録する。
 *
 * ゲストとして来ている場合は昇格（同じ uid のまま）、
 * まったくの未サインインなら新規作成。
 */
export async function registerAction(form: FormData): Promise<void> {
  const email = str(form, "email");
  const password = str(form, "password");

  const supabase = await createSupabaseServerClient();
  const { data: current } = await supabase.auth.getUser();

  // --- ゲストからの昇格（uid を保つ）-----------------------------------------
  if (current.user?.is_anonymous) {
    const { error } = await supabase.auth.updateUser({ email, password });

    if (error) back(`登録できませんでした: ${error.message}`);

    // JWT を取り直して is_anonymous を false にする（上のコメント参照）
    const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession();

    if (refreshError) {
      back(
        [
          "メールとパスワードは登録できましたが、ログイン情報の取り直しに失敗しました。",
          `原因: ${refreshError.message}`,
          "いったんサインアウトして、登録したメールでサインインし直してください。",
        ].join("\n"),
      );
    }

    revalidatePath(PAGE);

    // メール確認が必要な設定のときは、確認するまで匿名のまま。
    back(
      undefined,
      refreshed.user?.is_anonymous
        ? "確認メールを送りました。リンクを開くと登録が完了し、作品を投稿できるようになります。"
        : "登録が完了しました。ゲストのときに引いたお題はそのまま使えます。",
    );
  }

  // --- 新規作成 ---------------------------------------------------------------
  const { data, error } = await supabase.auth.signUp({ email, password });

  if (error) back(`登録できませんでした: ${error.message}`);

  revalidatePath(PAGE);

  // メール確認が必要な設定だと session が返らない。その場合は
  // このブラウザはまだサインインしていない。
  back(
    undefined,
    data.session
      ? "登録が完了しました。"
      : "確認メールを送りました。リンクを開いてから、もう一度サインインしてください。",
  );
}

export async function signOutAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();

  revalidatePath(PAGE);
  back(undefined, "サインアウトしました。");
}
