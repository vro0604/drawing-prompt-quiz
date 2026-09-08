import { cache } from "react";
import { notFound } from "next/navigation";
import { ADMIN_USER_ID, hasAdminUserId } from "@/lib/env";
import { getCurrentUser } from "@/features/auth/session";

/**
 * 管理者かどうかの判定。**このファイルが唯一の判定場所。**
 *
 * 【どう見分けるか】
 *   サーバー専用の環境変数 ADMIN_USER_ID に、運営者本人の
 *   Supabase user id（uuid）を1つだけ入れておく。
 *   いまアクセスしている人の id と突き合わせて、一致したら管理者。
 *
 *   DB には管理者という概念を1つも置いていない（role の列を作らない）。
 *   管理用の RPC は service_role にしか実行権限が無いので、
 *   **DB 側の関門は「秘密鍵を持っているか」まで。「誰か」はここが決める。**
 *
 * 【getUser を使う理由】
 *   getSession() は Cookie の中身をそのまま信じる。Cookie は書き換えられる
 *   前提で扱うので、Supabase に問い合わせて検証する getUser() を使う
 *   （src/features/auth/session.ts と同じ方針）。
 *
 * 【画面を隠すことを守りにしない】
 *   Next.js 16 の同梱文書がこう書いている。
 *   「Render-time gating (only rendering a form on an authenticated page)
 *     is not a security boundary, because requests can be sent without
 *     going through the UI.」
 *   （node_modules/next/dist/docs/01-app/02-guides/server-actions.md）
 *
 *   だから **画面でもここを呼び、Server Action の中でも毎回ここを呼ぶ。**
 *   片方だけにしない。proxy.ts には書かない（あそこは matcher の書き換え
 *   ひとつで外れる、と proxy.ts 自身が書いている）。
 *
 * 【未設定のときは全員を断る】
 *   ADMIN_USER_ID が空なら誰とも一致しない。
 *   「設定していないから素通し」にはしない。
 */

/**
 * いまの人が管理者か。画面側の分岐に使う。
 *
 * cache() で包むのは、**1回の要求の中で何度呼んでも Supabase への
 * 問い合わせを1回にするため。**画面と Server Action と層の3か所で
 * 呼ぶ設計なので、包まないと同じ検証が3往復する。
 * 要求をまたいでは共有されない（React の per-request キャッシュ）。
 */
export const isAdmin = cache(async (): Promise<boolean> => {
  if (!hasAdminUserId()) return false;

  const user = await getCurrentUser();
  if (!user) return false;

  // 匿名ゲストは対象外。念のため明示する（ゲストの uuid が
  // ADMIN_USER_ID と一致することは無いが、条件を読んで分かるようにする）
  if (user.is_anonymous) return false;

  return user.id === ADMIN_USER_ID;
});

/**
 * 管理画面のページで最初に呼ぶ。管理者でなければ **404 を返す。**
 *
 * 403 ではなく 404 にするのは、存在そのものを教えないため
 * （D40 と同じ考え方。/health も本番で同じことをしている）。
 * この関数は返らない（notFound() が例外を投げる）。
 */
export async function requireAdminPage(): Promise<string> {
  if (!(await isAdmin())) notFound();
  return ADMIN_USER_ID;
}

/**
 * 管理の Server Action で最初に呼ぶ。管理者でなければ **例外を投げる。**
 *
 * 画面側で通っていても、ここでもう一度確かめる。
 * Server Action は UI を通らずに直接叩けるため。
 *
 * 投げる文言は他の RPC の合図と同じ形（大文字の合図 ＋ コロン ＋ 説明）に
 * そろえてある。画面側はこの合図で分岐できる。
 */
export async function requireAdmin(): Promise<string> {
  if (!(await isAdmin())) {
    throw new Error("ADMIN_REQUIRED: この操作を行う権限がありません。");
  }
  return ADMIN_USER_ID;
}
