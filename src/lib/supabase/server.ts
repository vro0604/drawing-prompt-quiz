import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL, assertSupabaseEnv } from "@/lib/env";

/**
 * サーバー（Server Component / Server Action / Route Handler）から使う
 * Supabase クライアント。
 *
 * ブラウザ用との違いは、ログインセッションを Cookie でやり取りする点だけ。
 * 使う鍵は同じ Publishable key で、アクセス制御は RLS が担う。
 *
 * Next.js 16 では cookies() が非同期なので await が必要。
 * 解説記事によっては await なしで書かれているが、このバージョンでは動かない。
 *
 * ============================================================================
 * 【この2行の順番を入れ替えないこと】
 * ============================================================================
 *
 *   `cookies()` を先に、`assertSupabaseEnv()` を後に呼ぶ。**逆にすると、
 *   環境変数の無いビルドが落ちる。**
 *
 *   `next build` は、どの経路が静的にできるかを確かめるために、
 *   ページを一度実行する。`cookies()` はリクエストのときにしか無いものなので、
 *   ここに来た時点で Next.js は「この経路は静的にできない」と判断し、
 *   **その場で実行を打ち切って dynamic に印を付ける。**
 *
 *   検査を先に置くと、その打ち切りより前に例外が飛ぶ。すると Next.js には
 *   「dynamic だと分かった」ではなく「ページが壊れている」と見え、
 *   ビルド全体が止まる。
 *
 *     Error occurred prerendering page "/saves"
 *     Error: Supabase の環境変数が設定されていません
 *
 *   本番には値が入っているので本番のビルドは通っていた。だが
 *   **PR ごとのプレビューには入っていない**ので、PR を出すたびに
 *   デプロイが赤くなっていた（docs/QUEUE.md の完了「PENDING 9」）。
 *   「本番で通る」と「どこでも通る」は別（D123・D152・D154 と同じ形）。
 *
 *   【検査が弱くなっていないこと】
 *     リクエストのときは `cookies()` がふつうに返るので、そのすぐ後で
 *     検査が走る。**落ちる条件も、出るメッセージも、前と同じ。**
 *     クライアントを組み立てる前に検査する、という順序も変わっていない。
 *     変わったのは「ビルド中の下見では、検査に届く前に打ち切られる」ことだけ。
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  assertSupabaseEnv();

  return createServerClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Component からは Cookie を書き込めないため、ここで例外になる。
          // セッションの更新は proxy.ts（Next.js 16 で middleware.ts から改名）で
          // 行うので、ここでは無視してよい。Step 2 で proxy.ts を追加する。
        }
      },
    },
  });
}

/**
 * Route Handler 用。**自分で作った応答へ Cookie を確実に載せる**。
 *
 * 【なぜ別に要るか】
 *   確認メールの受け口は、引き換えたあと `NextResponse.redirect` を
 *   自分で組み立てて返す。このとき Supabase が書いた Cookie が
 *   その応答に載っていないと、**戻った先でサインインしていない**。
 *
 *   `cookies()` 経由の書き込みが自作の応答にも反映されるかは、
 *   その時々の実装に依る。**依存したくない。**
 *   書かれた内容を控えておいて、返す応答へ自分で貼り直す。
 *
 * @returns supabase と、応答へ Cookie を貼る applyCookies
 */
export async function createSupabaseRouteClient() {
  assertSupabaseEnv();
  const cookieStore = await cookies();

  /** Supabase が「これを書いて」と言ってきた Cookie */
  const pending: { name: string; value: string; options?: Record<string, unknown> }[] = [];

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        pending.push(...cookiesToSet);
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // 応答へは applyCookies で貼るので、ここが失敗しても構わない
        }
      },
    },
  });

  function applyCookies<T extends NextResponse>(response: T): T {
    for (const { name, value, options } of pending) {
      response.cookies.set({ name, value, ...(options ?? {}) });
    }
    return response;
  }

  return { supabase, applyCookies };
}
