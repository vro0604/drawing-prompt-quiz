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
