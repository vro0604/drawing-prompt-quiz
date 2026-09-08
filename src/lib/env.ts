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
