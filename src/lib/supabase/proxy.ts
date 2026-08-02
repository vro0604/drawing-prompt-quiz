import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL, missingSupabaseEnv } from "@/lib/env";

/**
 * Supabase クライアントの3つめ。リクエストのたびにセッションを更新する。
 *
 * ログイン状態はアクセストークンで表され、これは1時間で切れる。
 * 切れる前にリフレッシュトークンで取り直し、新しい値を Cookie に書き戻す
 * 必要があるが、Server Component からは Cookie を書けない（server.ts のコメント参照）。
 * そこでレンダリングより前に走る proxy でこれを行う。
 *
 * Next.js 16 では middleware.ts が proxy.ts に改名された。
 * 中身の書き方は同じなので、middleware 時代の解説記事もそのまま読める。
 */
export async function updateSupabaseSession(request: NextRequest): Promise<NextResponse> {
  // 環境変数が無いときは何もせず素通しする。
  // ここで例外を投げると全ページが真っ白になり、原因が分かりにくくなるため。
  // 未設定であること自体は /health が知らせてくれる。
  if (missingSupabaseEnv().length > 0) {
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        // 新しい Cookie を2箇所に書く。両方必要。
        //   request  … このリクエストの続き（＝ページ側）が新しい値を読めるように
        //   response … ブラウザに保存させるように
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }

        response = NextResponse.next({ request });

        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }

        // ライブラリが渡してくる no-store 系のヘッダ。
        // これを付けないと、CDN が「誰かのセッション Cookie 付きレスポンス」を
        // キャッシュして別人に配ってしまう危険がある。
        for (const [key, value] of Object.entries(headers)) {
          response.headers.set(key, value);
        }
      },
    },
  });

  // ここと createServerClient の間に処理を挟まないこと。
  // getUser() がトークンを検証し、必要なら更新して上の setAll を呼ぶ。
  // 間に別の処理（特に早期 return）を書くと、更新済み Cookie を返し損ねて
  // 「ときどきログアウトする」という再現しにくい不具合になる。
  await supabase.auth.getUser();

  return response;
}
