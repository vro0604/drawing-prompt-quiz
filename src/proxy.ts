import type { NextRequest } from "next/server";
import { updateSupabaseSession } from "@/lib/supabase/proxy";

/**
 * ページが描画される前に、リクエストごとに1回だけ走る処理。
 *
 * Next.js 16 で middleware.ts から proxy.ts に改名された（機能は同じ）。
 * プロジェクトに1つだけ置け、場所は app/ と同じ階層（src 直下）。
 *
 * ここでやるのはセッションの更新だけ。
 * 「このページはログインが必要」といった認可の判定はここに書かない。
 * proxy は matcher の書き換えひとつで簡単に外れてしまうため、
 * 権限チェックは各 Server Action と RLS の側で必ず行う。
 */
export async function proxy(request: NextRequest) {
  return updateSupabaseSession(request);
}

export const config = {
  // matcher を書かないと画像や CSS を含む全リクエストで走ってしまう。
  // Supabase への問い合わせが無駄に増えるので、静的ファイルを除外する。
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
