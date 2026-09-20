/**
 * 環境変数の読み取りと検証。
 *
 * ふだん使うのは Project URL と Publishable key の2つだけ。
 * SUPABASE_SECRET_KEY は RLS を迂回できる強力な鍵なので、
 * それが本当に必要な処理まで参照しない方針だった。
 *
 * **退会（P1）でその処理が来た。**auth.users の削除は Admin API でしか
 * できず、Admin API は Secret key でしか呼べない。
 * 使う場所は src/lib/supabase/admin.ts の1か所に閉じてある。
 *
 * NEXT_PUBLIC_ で始まる変数は、ビルド時にブラウザ向けのコードへ埋め込まれる。
 * そのため process.env.NEXT_PUBLIC_XXX という「literal な書き方」が必須で、
 * process.env[name] のような動的アクセスでは値が入らない。
 *
 * SUPABASE_SECRET_KEY には NEXT_PUBLIC_ を付けない。付けるとブラウザに
 * 埋め込まれ、誰でも全データを読み書きできるようになる。
 */

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";

/** サーバー専用。未設定なら空文字。値そのものは絶対にログへ出さない。 */
export const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY ?? "";

/**
 * 運営者本人の Supabase user id。**サーバー専用**。
 *
 * 【なぜ DB の列ではなく環境変数か】
 *   管理者は1人しかいない（`docs/legal-draft.md`「VRO（個人運営）」）。
 *   profiles に role の列を足すと、**その列を誰が書き換えられるか**という
 *   問題が新しく増える（account_status のときは列権限を revoke する
 *   手当てが要った）。1人を見分けるだけなら、DB を1行も変えずに済む。
 *
 * 【NEXT_PUBLIC_ を付けない】
 *   付けるとブラウザに埋め込まれ、管理者の user id が誰にでも読める。
 *   uuid が漏れても直ちに入られはしないが、**照合の片側を配る意味は無い。**
 *
 * 【未設定のとき】
 *   管理画面は誰にも開かない（404）。管理操作もすべて断る。
 *   「未設定だから素通し」にしない。CRON_SECRET と同じ考え方。
 */
export const ADMIN_USER_ID = (process.env.ADMIN_USER_ID ?? "").trim();

/** 管理者の照合ができる状態か。未設定なら管理機能は全部閉じる。 */
export function hasAdminUserId(): boolean {
  return ADMIN_USER_ID !== "";
}

/**
 * Stripe の秘密鍵と、Webhook の署名を確かめる鍵。**どちらもサーバー専用**。
 *
 * 【NEXT_PUBLIC_ を絶対に付けない】
 *   付けるとブラウザに埋め込まれる。秘密鍵が漏れれば、その Stripe
 *   アカウントで返金も送金も課金もできる。**鍵そのものはログにも出さない。**
 *
 * 【なぜ2本要るか】
 *   STRIPE_SECRET_KEY   … こちらから Stripe を呼ぶための鍵（決済ページを作る）
 *   STRIPE_WEBHOOK_SECRET … Stripe から来た知らせが本物かを確かめるための鍵
 *   向きが逆なので、同じ鍵にはならない。
 *
 * 【未設定のとき】
 *   購入の入口を閉じる（503）。**「設定していないから素通し」にしない。**
 *   CRON_SECRET・Turnstile と同じ考え方。
 *   閉じるのは購入だけで、サイトの他の部分は今までどおり動く。
 */
export const STRIPE_SECRET_KEY = (process.env.STRIPE_SECRET_KEY ?? "").trim();
export const STRIPE_WEBHOOK_SECRET = (process.env.STRIPE_WEBHOOK_SECRET ?? "").trim();

/** Stripe を呼べる状態か。購入ページはこれが false なら「準備中」と出す。 */
export function hasStripeSecretKey(): boolean {
  return STRIPE_SECRET_KEY !== "";
}

/** Webhook の live/test を API 鍵と突き合わせる。形式不明なら決済を閉じる。 */
export function stripeSecretMode(): "live" | "test" | null {
  if (STRIPE_SECRET_KEY.startsWith("sk_live_")) return "live";
  if (STRIPE_SECRET_KEY.startsWith("sk_test_")) return "test";
  return null;
}

/** Stripe からの知らせを確かめられる状態か。false なら Webhook は 503 で断る。 */
export function hasStripeWebhookSecret(): boolean {
  return STRIPE_WEBHOOK_SECRET !== "";
}

/**
 * 課金の設定が足りていないときの理由。足りていれば null。
 *
 * **値そのものは1文字も入れない。**入れるのは変数の名前だけ。
 */
export function billingConfigError(): string | null {
  const missing: string[] = [];
  if (!hasStripeSecretKey()) missing.push("STRIPE_SECRET_KEY");
  else if (!stripeSecretMode()) missing.push("STRIPE_SECRET_KEY の形式");
  if (!hasStripeWebhookSecret()) missing.push("STRIPE_WEBHOOK_SECRET");
  if (!hasSupabaseSecretKey()) missing.push("SUPABASE_SECRET_KEY");
  if (missing.length === 0) return null;

  return `課金の設定が足りていません: ${missing.join(", ")}`;
}

/**
 * このサービスの**正規URL**。
 *
 * 確認メールの戻り先に使う。ここを個別 Deployment URL
 * （`…-<ハッシュ>-….vercel.app`）にしてはいけない。
 *
 * 戻り先が正規URLと違うと、確認の引き換えに要る控えが読めない
 * （控えは Cookie にあり、Cookie はホストごとに分かれるため）。
 * だから**環境変数に書いた1つの値だけ**を使い、
 * リクエストのホスト名からは組み立てない。
 *
 * 手元では未設定なので localhost に落とす。
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"
).replace(/\/+$/, "");

/** 正規URL上の絶対パスを作る。`/account` → `https://…/account` */
export function siteUrl(path: string): string {
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Admin API を使えるか。使えないときは退会の第2段階を掃除へ回す。 */
export function hasSupabaseSecretKey(): boolean {
  return SUPABASE_SECRET_KEY.trim() !== "";
}

/** 未設定の環境変数名を返す。空配列なら設定済み。 */
export function missingSupabaseEnv(): string[] {
  const missing: string[] = [];
  if (SUPABASE_URL.trim() === "") missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (SUPABASE_PUBLISHABLE_KEY.trim() === "") {
    missing.push("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  }
  return missing;
}

/** 未設定なら、原因と対処が分かる形で例外を投げる。 */
export function assertSupabaseEnv(): void {
  const missing = missingSupabaseEnv();
  if (missing.length === 0) return;

  throw new Error(
    [
      `Supabase の環境変数が設定されていません: ${missing.join(", ")}`,
      "",
      "対処:",
      "1. プロジェクト直下の .env.local に値を書く",
      "2. 開発サーバーを Ctrl+C で止めて、npm run dev で再起動する",
      "   （.env.local は起動時にしか読まれないため、再起動が必要）",
    ].join("\n"),
  );
}
