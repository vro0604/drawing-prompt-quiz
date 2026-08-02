import type { User } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Profile } from "@/types/database";

/**
 * サインイン状態の取得と、匿名ユーザーの発行。
 *
 * このファイルはサーバー専用。Client Component から import しないこと。
 */

/** 匿名サインインが Supabase 側で無効なときのエラーコード */
const ANONYMOUS_DISABLED = "anonymous_provider_disabled";

/**
 * いま誰としてアクセスしているかを返す。未サインインなら null。
 *
 * getSession() ではなく getUser() を使う。
 * getSession() は Cookie の中身をそのまま信じるが、getUser() は
 * Supabase に問い合わせてトークンを検証する。Cookie は書き換えられる前提で扱う。
 */
export async function getCurrentUser(): Promise<User | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();

  // 未サインインは「エラー」ではなく通常の状態なので、null を返して終わる
  if (error) return null;
  return data.user;
}

/**
 * 書き込みの直前に呼ぶ。サインイン済みならその uid を返し、
 * 未サインインならその場で匿名ユーザーを作って uid を返す。
 *
 * ページを開いただけでは呼ばないこと（spec 11-1）。
 * 閲覧しただけの訪問者でユーザー行が増えると、匿名ユーザーが MAU に
 * 計上されて無料枠を圧迫する。呼ぶのは「回答送信」「お題確定」「通報」など、
 * 実際に行が増える操作の直前だけ。
 *
 * 【重要】Server Action か Route Handler からのみ呼べる。
 * サインインはセッション Cookie の書き込みを伴うが、Server Component からは
 * Cookie を書けないため、そこで呼んでも状態が保存されない。
 */
export async function ensureUserId(): Promise<string> {
  const supabase = await createSupabaseServerClient();

  const { data: existing } = await supabase.auth.getUser();
  if (existing.user) return existing.user.id;

  const { data, error } = await supabase.auth.signInAnonymously();

  if (error) {
    if (error.code === ANONYMOUS_DISABLED) {
      throw new Error(
        [
          "匿名サインインが Supabase 側で無効になっています。",
          "",
          "対処:",
          "1. Supabase ダッシュボード → Authentication → Sign In / Providers",
          "2. Anonymous sign-ins（匿名サインイン）を有効にする",
          "3. 保存してから、もう一度試す",
        ].join("\n"),
      );
    }
    throw new Error(`匿名サインインに失敗しました: ${error.message}`);
  }

  if (!data.user) {
    throw new Error("匿名サインインは成功しましたが、ユーザー情報が返りませんでした。");
  }

  return data.user.id;
}

/**
 * 自分の profiles 行を取る。未サインイン、または行がまだ無ければ null。
 *
 * 行は auth.users のトリガーが自動で作る（001_profiles.sql）ので、
 * ここでは読むだけ。サインイン済みなのに null なら、その SQL が
 * まだ実行されていないか、トリガーが付いていない。
 *
 * 問い合わせ自体が失敗した場合（テーブルが無い等）は例外を投げる。
 * 「行が無い」と「読めなかった」は原因がまったく違うので、混ぜない。
 */
export async function getMyProfile(): Promise<Profile | null> {
  const supabase = await createSupabaseServerClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return null;

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", auth.user.id)
    .maybeSingle();

  if (error) throw new Error(`[${error.code}] ${error.message}`);
  return data as Profile | null;
}
