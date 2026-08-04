/**
 * 通報の CAPTCHA（P6）。Cloudflare Turnstile。
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
 * ============================================================================
 * 【いちばん大事な決まり：鍵が無いときは通報を止める】
 * ============================================================================
 *
 *   前の版は「鍵が無ければ検証を飛ばす」だった。開発中に手が止まらない
 *   ようにするためだが、**これは公開時にそのまま穴になる。**
 *
 *   環境変数を1つ入れ忘れただけで、CAPTCHA が付いていない状態が
 *   できあがる。しかも**画面は何も変わらない**ので、気づけない。
 *
 *   なので本番では、鍵が足りなければ**通報そのものを 503 で止める。**
 *   「守れないなら受け付けない」。素通しにはしない。
 *
 *   止めるのは proxy（src/proxy.ts）で、通報の画面と送信の両方に効く。
 *
 * ============================================================================
 * 【開発では Cloudflare の公式テスト鍵を使う】
 * ============================================================================
 *
 *   Cloudflare が公開しているテスト用の鍵で、**秘密ではない。**
 *   常に通る鍵と常に落ちる鍵があり、検証の道筋をそのまま試せる。
 *
 *   テスト鍵を使っているときだけ hostname と action の照合を緩める。
 *   Cloudflare のテスト応答はこちらのサイトを指さないため。
 *
 *   **本番でテスト鍵を使うのは設定の誤りとして扱う。**
 *   緩めた照合が本番で効くことは、これで起こりえない。
 */

/** Cloudflare の公式テスト鍵（公開値。秘密ではない） */
const TEST_SITE_KEYS = new Set([
  "1x00000000000000000000AA", // 常に通る
  "2x00000000000000000000AB", // 常に落ちる
  "3x00000000000000000000FF", // 手動で操作させる
]);

const TEST_SECRET_KEYS = new Set([
  "1x0000000000000000000000000000000AA", // 常に通る
  "2x0000000000000000000000000000000AA", // 常に落ちる
  "3x0000000000000000000000000000000AA", // すでに使われた扱い
]);

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** widget に渡す action。siteverify の応答と突き合わせる */
export const CAPTCHA_ACTION = "report";

/** widget を描くスクリプト */
export const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js";

/**
 * ブラウザに出てよい鍵。**秘密鍵はこのファイルから外へ出さない。**
 * 関数の外に出すのはサイト鍵だけで、秘密鍵は読み取り関数すら作らない。
 */
export const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";

function secretKey(): string {
  return (process.env.TURNSTILE_SECRET_KEY ?? "").trim();
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** テスト鍵で動いているか（本番では設定の誤りとして扱う） */
export function usingTestKeys(): boolean {
  return TEST_SITE_KEYS.has(TURNSTILE_SITE_KEY.trim()) || TEST_SECRET_KEYS.has(secretKey());
}

/**
 * 設定が通報を受け付けられる状態か。
 *
 * **理由の文字列に鍵の値を入れない。**画面にも記録にも出るため。
 * 返すのは「何が足りないか」だけ。
 *
 * @returns 問題なければ null。あれば人に見せてよい短い理由
 */
export function captchaConfigError(): string | null {
  const site = TURNSTILE_SITE_KEY.trim();
  const secret = secretKey();

  if (isProduction()) {
    if (site === "" || secret === "") {
      return "CAPTCHA の設定が完了していないため、いま通報を受け付けられません。";
    }
    // 本番でテスト鍵を使うと、常に通る／常に落ちるだけの飾りになる。
    if (TEST_SITE_KEYS.has(site) || TEST_SECRET_KEYS.has(secret)) {
      return "CAPTCHA の設定が正しくないため、いま通報を受け付けられません。";
    }
    return null;
  }

  // 開発。片方だけ設定されている状態は、たいてい設定ミスなので止める。
  if ((site === "") !== (secret === "")) {
    return "CAPTCHA の鍵が片方だけ設定されています（開発）。両方入れるか、両方消してください。";
  }
  return null;
}

/** widget を出すか */
export function captchaEnabled(): boolean {
  return TURNSTILE_SITE_KEY.trim() !== "" && captchaConfigError() === null;
}

/**
 * サーバー側で検証するか。
 *
 * 開発で鍵をどちらも入れていないときだけ false。
 * 本番では captchaConfigError() が先に止めるので、ここが false になることはない。
 */
export function captchaRequired(): boolean {
  return secretKey() !== "";
}

export type CaptchaResult = { ok: true } | { ok: false; reason: string };

/**
 * 合言葉を確かめる。
 *
 * **通ったときだけ ok を返す。**次のいずれかに当たれば通さない。
 *
 *   ・トークンが空
 *   ・siteverify に届かない／応答が壊れている（**通信の失敗も拒否**）
 *   ・success が false
 *   ・hostname がこちらのサイトと違う
 *   ・action が通報のものと違う
 *
 * 「確かめられなかったから通す」にすると、検証先を落とすだけで
 * CAPTCHA を無効化できてしまう。**届かない＝通さない。**
 *
 * hostname と action を見るのは、**別のサイトで取ったトークンを
 * 持ち込む使い回しを防ぐため。**success だけでは、同じ鍵を使う
 * 別のフォームで取ったトークンが通ってしまう。
 */
export async function verifyCaptcha(token: string, ip?: string): Promise<CaptchaResult> {
  if (!captchaRequired()) return { ok: true };

  if (token.trim() === "") {
    return { ok: false, reason: "確認が完了していません" };
  }

  let json: {
    success?: boolean;
    hostname?: string;
    action?: string;
    "error-codes"?: string[];
  };

  try {
    const body = new URLSearchParams({ secret: secretKey(), response: token });
    if (ip) body.set("remoteip", ip);

    const res = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      // 応答が返らないときに通報の画面が固まらないようにする
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return { ok: false, reason: "確認に失敗しました" };
    json = (await res.json()) as typeof json;
  } catch {
    // 通信できなかった。**通さない。**
    return { ok: false, reason: "確認に失敗しました" };
  }

  if (json.success !== true) {
    return { ok: false, reason: "確認に失敗しました" };
  }

  // テスト鍵のときは照合を緩める。Cloudflare のテスト応答は
  // こちらのサイトを指さないため。本番でテスト鍵は設定の誤りなので、
  // この緩和が本番で効くことはない。
  if (usingTestKeys()) return { ok: true };

  const expected = expectedHostname();
  if (expected && json.hostname && json.hostname !== expected) {
    return { ok: false, reason: "確認に失敗しました" };
  }

  if (json.action && json.action !== CAPTCHA_ACTION) {
    return { ok: false, reason: "確認に失敗しました" };
  }

  return { ok: true };
}

/**
 * トークンが発行されたはずのホスト名。
 * NEXT_PUBLIC_SITE_URL から取る。取れなければ照合しない
 * （設定が無いことを理由に、正しい通報まで落とさない）。
 */
function expectedHostname(): string | null {
  const override = (process.env.TURNSTILE_EXPECTED_HOSTNAME ?? "").trim();
  if (override !== "") return override;

  const site = (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim();
  if (site === "") return null;

  try {
    return new URL(site).hostname;
  } catch {
    return null;
  }
}
