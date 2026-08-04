import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { siteUrl } from "@/lib/env";

/**
 * /auth/confirm ／ 確認メールのリンクが戻ってくる場所。
 *
 * 【なぜ必要か】
 *   `@supabase/ssr` は PKCE という方式を強制している。
 *   この方式では、確認メールのリンクを開いても**それだけでは終わらない**。
 *   戻ってきた `?code=` を、**手元に残した控えと突き合わせて**
 *   はじめてログイン状態が確定する。
 *
 *   この受け口が無いと、リンクを開いた人は
 *   「押したのに何も起きない」画面に落ちる。
 *
 * 【Route Handler にする理由】
 *   引き換えるとセッションの Cookie を書き換える。
 *   Server Component からは Cookie を書けないので、
 *   ページではなく Route Handler で受ける。
 *
 * 【戻り先を正規URLで組み立てる理由】
 *   `request.url` から組み立てると、個別 Deployment URL で開かれたときに
 *   **そのホストへ戻してしまう。**控えは Cookie にあり、Cookie は
 *   ホストごとに分かれるので、別のホストへ渡ると確認が完了しない。
 *   環境変数に書いた正規URL1つだけを使う。
 *
 * 【uid は変わらない】
 *   引き換えは**既にあるユーザーのセッションを更新する**だけで、
 *   新しいユーザーを作らない。ゲストのときに引いたお題・回答・下書きは
 *   持ち主が変わらないのでそのまま残る。
 */

export const dynamic = "force-dynamic";

/** /account へ戻す。理由や結果は短い文で渡す（値そのものは載せない） */
function backToAccount(params: { notice?: string; error?: string }): NextResponse {
  const query = new URLSearchParams();
  if (params.notice) query.set("notice", params.notice);
  if (params.error) query.set("error", params.error);

  const target = query.toString()
    ? `${siteUrl("/account")}?${query.toString()}`
    : siteUrl("/account");

  // 一度きりの引き換えなので、途中の URL を履歴やキャッシュに残さない
  const response = NextResponse.redirect(target, { status: 303 });
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");

  // Supabase 側で断られた場合は、理由が付いて戻ってくることがある。
  // **その文面はそのまま出さない**（英語のまま出ると読めない）。
  const failed = request.nextUrl.searchParams.get("error");

  if (failed) {
    return backToAccount({
      error:
        "確認を完了できませんでした。リンクの有効期限が切れているかもしれません。" +
        "もう一度、同じメールアドレスで登録をお試しください。",
    });
  }

  if (!code) {
    return backToAccount({
      error:
        "確認用の情報が見つかりませんでした。" +
        "メールのリンクをそのまま開いてください。",
    });
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    // 起きうるのは「期限切れ」「もう使った」「別のブラウザで開いた」。
    // どれも利用者の操作としては同じなので、区別せず同じ案内にする。
    return backToAccount({
      error:
        "確認を完了できませんでした。" +
        "リンクの有効期限が切れているか、登録を始めたブラウザと違う可能性があります。" +
        "登録したブラウザで、もう一度お試しください。",
    });
  }

  // ここまで来ればセッションは更新されている。
  // まだ匿名のままなら、確認は通ったが反映が遅れている状態。
  // **成功を装わない。**何をすればよいかだけ伝える。
  if (data.user?.is_anonymous) {
    return backToAccount({
      notice:
        "確認を受け付けました。反映まで少し時間がかかることがあります。" +
        "この画面を読み込み直してください。",
    });
  }

  return backToAccount({
    notice:
      "メールアドレスの確認が完了しました。" +
      "ゲストのときに引いたお題も、これまでの記録もそのまま使えます。",
  });
}
