/**
 * 通報の CAPTCHA（P6）。Cloudflare Turnstile を使う。
 *
 * 【なぜ通報にだけ付けるか】
 *   通報はゲストでも送れる（spec 8-4）。登録を求めると、いちばん多くの
 *   作品を見ている層からの報告が届かなくなるため、そこは変えたくない。
 *
 *   代わりに穴が開く。`create_report` の「同じ作品への2回目」と
 *   「24時間で10件」は**ふつうの操作ミス**を防ぐ水準で、
 *   ブラウザのデータを消して新しいゲストになれば何度でも送れる。
 *   その回数を人手の速度に落とすのが CAPTCHA の役目。
 *
 * 【鍵が無いとき】
 *   検証を飛ばす。開発中に CAPTCHA のために手が止まらないようにするため。
 *   **これは公開前に必ず塞ぐ。**最終チェックリストに入れてある。
 *
 * 【鍵の置きかた】
 *   NEXT_PUBLIC_TURNSTILE_SITE_KEY … ブラウザに出てよい（widget が使う）
 *   TURNSTILE_SECRET_KEY           … サーバー専用。NEXT_PUBLIC を付けない
 */

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY ?? "";

/** widget を出すか（サイト鍵があるとき） */
export function captchaEnabled(): boolean {
  return TURNSTILE_SITE_KEY.trim() !== "";
}

/** サーバー側で検証するか（秘密鍵があるとき） */
export function captchaRequired(): boolean {
  return TURNSTILE_SECRET_KEY.trim() !== "";
}

/**
 * 合言葉を確かめる。
 *
 * **通ったときだけ true を返す。**検証に行けなかった場合も false にする。
 * 「確かめられなかったから通す」にすると、Cloudflare を落とすだけで
 * CAPTCHA を無効化できてしまう。
 */
export async function verifyCaptcha(token: string, ip?: string): Promise<boolean> {
  if (!captchaRequired()) return true;
  if (token.trim() === "") return false;

  try {
    const body = new URLSearchParams({
      secret: TURNSTILE_SECRET_KEY,
      response: token,
    });
    if (ip) body.set("remoteip", ip);

    const res = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      // 応答が返らないときに通報の画面が固まらないようにする
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return false;

    const json = (await res.json()) as { success?: boolean };
    return json.success === true;
  } catch {
    return false;
  }
}
