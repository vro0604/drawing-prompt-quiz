/**
 * 環境変数の読み取りと検証。
 *
 * Step 1 で扱うのは Project URL と Publishable key の2つだけ。
 * SUPABASE_SECRET_KEY は RLS を迂回できる強力な鍵なので、
 * それが本当に必要な処理を実装する時点まで、このファイルでも参照しない。
 *
 * NEXT_PUBLIC_ で始まる変数は、ビルド時にブラウザ向けのコードへ埋め込まれる。
 * そのため process.env.NEXT_PUBLIC_XXX という「literal な書き方」が必須で、
 * process.env[name] のような動的アクセスでは値が入らない。
 */

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";

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
