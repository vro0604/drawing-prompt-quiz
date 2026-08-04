import { NextResponse, type NextRequest } from "next/server";
import { updateSupabaseSession } from "@/lib/supabase/proxy";
import { captchaConfigError } from "@/features/report/captcha";

/**
 * ページが描画される前に、リクエストごとに1回だけ走る処理。
 *
 * Next.js 16 で middleware.ts から proxy.ts に改名された（機能は同じ）。
 * プロジェクトに1つだけ置け、場所は app/ と同じ階層（src 直下）。
 *
 * ここでやるのは2つだけ。
 *
 *   1. セッションの更新
 *   2. **CAPTCHA を掛けられないときに通報を止める**
 *
 * 「このページはログインが必要」といった認可の判定はここに書かない。
 * proxy は matcher の書き換えひとつで簡単に外れてしまうため、
 * 権限チェックは各 Server Action と RLS の側で必ず行う。
 *
 * 【2 をここに置く理由】
 *   通報の画面（GET）と送信（POST）は同じURLに来る。
 *   ここで止めれば**両方まとめて**止まる。
 *
 *   Server Action の中で止めることもできるが、それだと
 *   画面は開けるので「送れるように見えて送れない」状態になる。
 *   受け付けられないなら、**入口で断るほうが正直**。
 *
 *   Server Action の側にも同じ判定を残してある（二重の守り）。
 *   proxy は matcher から外れうるので、片方だけには頼らない。
 */

/** /works/{id}/report だけに効かせる */
const REPORT_PATH = /^\/works\/[^/]+\/report\/?$/;

export async function proxy(request: NextRequest) {
  if (REPORT_PATH.test(request.nextUrl.pathname)) {
    const configError = captchaConfigError();

    if (configError) {
      // 503 は「いまは無理。あとで来て」の意味。404 でも 500 でもない。
      // 理由に鍵の値は入れない（captchaConfigError が入れない）。
      return new NextResponse(configError, {
        status: 503,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }
  }

  return updateSupabaseSession(request);
}

export const config = {
  // matcher を書かないと画像や CSS を含む全リクエストで走ってしまう。
  // Supabase への問い合わせが無駄に増えるので、静的ファイルを除外する。
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
