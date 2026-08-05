import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseRouteClient } from "@/lib/supabase/server";
import { siteUrl } from "@/lib/env";

/**
 * /auth/confirm ／ 確認メールのリンクが戻ってくる場所。
 *
 * ============================================================================
 * 【なぜ token_hash に変えたか】
 * ============================================================================
 *
 *   最初は `?code=` を `exchangeCodeForSession` で引き換えていた。
 *   これは PKCE という方式で、**引き換えに要る控え（code verifier）が
 *   登録を始めたブラウザの Cookie に入っている。**
 *
 *   本番で実際に起きたこと:
 *     PC で登録 → スマホでメールを開く → **確認できない**
 *
 *   控えは PC にあるので、スマホには無い。当然の結果で、
 *   リンクが壊れているわけでも、期限が切れているわけでもない。
 *
 *   **メールは、送った端末で開かれるとは限らない。**
 *   むしろ登録は PC、メールはスマホ、という組み合わせのほうが普通にある。
 *
 *   token_hash 方式は控えを使わない。リンクに入っている使い捨ての印を
 *   そのまま Supabase へ渡して確かめる。**どの端末で開いても通る。**
 *
 * ============================================================================
 * 【メール本文の形（ダッシュボードで手で直す）】
 * ============================================================================
 *
 *   {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=<種類>
 *
 *   種類はテンプレートごとに違う。
 *     Confirm signup        … email
 *     Change Email Address  … email_change   ← 匿名からの昇格はこちら
 *
 *   手順は docs/launch-checklist.md 手順7-b。
 *
 *   **種類が食い違っても通るようにしてある。**
 *   テンプレートは手で設定するもので、取り違えは起こる。
 *   1つ試して駄目なら、近い種類をもう一度だけ試す（下の ALSO_TRY）。
 *   確かめに失敗した印は使われないので、試しても減らない。
 *
 * ============================================================================
 * 【code 方式も残す】
 * ============================================================================
 *
 *   テンプレートを直す前に送った確認メールが、まだ受信箱にある。
 *   それを開いた人を切り捨てないため、`?code=` も引き続き受ける。
 *   （同じ端末で開けば通る）
 *
 * 【戻り先を正規URLで組み立てる理由】
 *   `request.url` から組み立てると、個別 Deployment URL で開かれたときに
 *   **そのホストへ戻してしまう。**環境変数の正規URL1つだけを使う。
 *
 * 【uid は変わらない】
 *   確認は**既にあるユーザーのセッションを更新する**だけで、
 *   新しいユーザーを作らない。ゲストのときに引いたお題・回答・下書きは
 *   持ち主が変わらないのでそのまま残る。
 */

export const dynamic = "force-dynamic";

/** 確かめに失敗したときの文。**原因を決めつけない** */
const FAILED =
  "確認を完了できませんでした。" +
  "メールのリンクをもう一度開いてください。" +
  "それでも進めない場合は、同じメールアドレスで登録をやり直してください。";

/** リンクに必要な値が入っていなかった */
const NO_TOKEN =
  "確認用の情報が見つかりませんでした。メールのリンクをそのまま開いてください。";

const DONE =
  "メールアドレスの確認が完了しました。" +
  "ゲストのときに引いたお題も、これまでの記録もそのまま使えます。";

/** 受け付けたが、まだこのブラウザに反映されていない */
const ACCEPTED =
  "確認を受け付けました。まだ反映されていない場合は、" +
  "この画面を読み込み直してください。";

/** メールのリンクに入りうる種類。**知らない値は Supabase へ渡さない** */
const KNOWN_TYPES = ["email", "email_change", "signup", "magiclink", "recovery", "invite"];

/**
 * 1回目が駄目だったときに、もう一度だけ試す種類。
 *
 * テンプレートは人が手で設定するので、`email` と `email_change` の
 * 取り違えが起こる。**そのために利用者が確認できないのは割に合わない。**
 */
const ALSO_TRY: Record<string, string[]> = {
  email: ["email_change"],
  email_change: ["email"],
  signup: ["email", "email_change"],
};

/** 試す順に種類を並べる。指定が無ければ、ありがちなものから */
function typesToTry(raw: string | null): string[] {
  const type = raw && KNOWN_TYPES.includes(raw) ? raw : null;
  if (!type) return ["email", "email_change"];
  return [type, ...(ALSO_TRY[type] ?? [])];
}

/**
 * /account へ戻す。
 *
 * **token_hash・type・code は載せない。**戻り先の URL は履歴にも
 * 共有先にも残るので、確認用の値をそこへ置かない。
 */
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
  const params = request.nextUrl.searchParams;

  // Supabase 側が断ると、理由が付いて戻ってくることがある。
  // **その文面はそのまま出さない**（英語のまま出ると読めない）
  if (params.get("error") || params.get("error_code")) {
    return backToAccount({ error: FAILED });
  }

  const tokenHash = params.get("token_hash");
  const code = params.get("code");

  if (!tokenHash && !code) {
    return backToAccount({ error: NO_TOKEN });
  }

  const { supabase, applyCookies } = await createSupabaseRouteClient();

  let verified = false;
  let user = null;
  let session = null;

  if (tokenHash) {
    for (const type of typesToTry(params.get("type"))) {
      const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
      if (error) continue;

      verified = true;
      user = data.user;
      session = data.session;
      break;
    }
  } else if (code) {
    // 昔の形のリンク。控えを持っているブラウザでだけ通る
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      verified = true;
      user = data.user;
      session = data.session;
    }
  }

  if (!verified) {
    // 起きうるのは「期限切れ」「もう使った」「別のブラウザで開いた（code 方式）」。
    // **どれなのかは決めつけない。**利用者の次の一手は同じなので、文も同じにする
    return backToAccount({ error: FAILED });
  }

  // セッションが返らない、またはまだ匿名のまま。
  // 確かめ自体は通っているが、このブラウザはまだ登録済みになっていない。
  // **成功を装わない。**
  if (!session || user?.is_anonymous) {
    return applyCookies(backToAccount({ notice: ACCEPTED }));
  }

  // Supabase が書いた Cookie を、この応答へ貼ってから返す。
  // これをしないと、戻った先でサインインしていない
  return applyCookies(backToAccount({ notice: DONE }));
}
