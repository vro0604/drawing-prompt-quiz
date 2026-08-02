import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
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
 */
export async function createSupabaseServerClient() {
  assertSupabaseEnv();
  const cookieStore = await cookies();

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
