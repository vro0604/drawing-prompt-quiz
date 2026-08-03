"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  LINK_FIELDS,
  callUpdateMyProfile,
  callUpdateMyVisibility,
} from "@/features/profile/rpc";
import { VISIBILITY_FIELDS } from "@/features/profile/types";

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

/**
 * プロフィール（ID・表示名・自己紹介・外部リンク）を更新する。
 *
 * 【空欄の扱い】
 *   未入力は空文字で届く。それをそのまま渡すと DB 側で
 *   「空にはできません」と断られてしまうので、空欄は
 *   **「変更しない」（null）** に寄せてから渡す。
 *
 *   そのため、この画面から値を消すことはできない。
 *   消す操作が要るようになったら、専用のボタンを足して区別する
 *   （空欄と「消したい」を同じ入力に載せると取り違える。D49）。
 *
 * 【リンク】
 *   キーは LINK_FIELDS で固定してある。入力があったものだけを集める。
 *   値が http(s) で始まるかは DB 側が見る（javascript: を弾くため）。
 */
export async function updateProfileAction(form: FormData): Promise<void> {
  const handle = str(form, "handle");
  const displayName = str(form, "displayName");
  const bio = str(form, "bio");

  const links: Record<string, string> = {};
  for (const field of LINK_FIELDS) {
    const value = str(form, `link_${field.key}`);
    if (value !== "") links[field.key] = value;
  }

  try {
    await callUpdateMyProfile({
      handle: handle === "" ? null : handle,
      displayName: displayName === "" ? null : displayName,
      bio: bio === "" ? null : bio,
      // リンクは「1つも入力が無い」と「全部消したい」を区別できないため、
      // 何か入力があるときだけ送る。
      links: Object.keys(links).length > 0 ? links : null,
    });
  } catch (e) {
    back(e instanceof Error ? e.message : String(e));
  }

  revalidatePath(PAGE);
  // 一覧や作品ページの投稿者名も変わるので、まとめて描き直させる
  revalidatePath("/works");
  back(undefined, "プロフィールを更新しました。");
}

/**
 * 公開設定（3つのチェックボックス）を更新する。
 *
 * 【チェックボックスは「外したこと」が届かない】
 *   HTML のチェックボックスは、入っているときだけ値が送られる。
 *   だから「入っていない ＝ フォームに無い」で false を作る。
 *   ここで null（変更しない）に寄せてしまうと、**一度入れた設定を
 *   二度と外せなくなる**。プロフィールの空欄とは扱いが逆になる。
 *
 *   その代わり、この画面は必ず3つとも送る。1つだけ更新する経路を
 *   作らないので、フォームに無い＝外した、と読んで間違いがない。
 */
export async function updateVisibilityAction(form: FormData): Promise<void> {
  const update: Record<string, boolean> = {};
  for (const field of VISIBILITY_FIELDS) {
    update[field.key] = form.get(field.key) !== null;
  }

  try {
    await callUpdateMyVisibility(update);
  } catch (e) {
    back(e instanceof Error ? e.message : String(e));
  }

  revalidatePath(PAGE);
  revalidatePath("/saves");
  back(undefined, "公開設定を更新しました。");
}

export async function signOutAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();

  revalidatePath(PAGE);
  back(undefined, "サインアウトしました。");
}
