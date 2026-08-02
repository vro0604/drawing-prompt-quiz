"use client";

import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL, assertSupabaseEnv } from "@/lib/env";

/**
 * ブラウザ（Client Component）から使う Supabase クライアント。
 *
 * ここで使う Publishable key はブラウザに公開される前提の鍵。
 * データを守るのは鍵の秘匿ではなく RLS（Row Level Security）なので、
 * 公開されること自体は問題ない。
 *
 * ファイル先頭の "use client" は、Server Component から誤って
 * 呼び出したときに気づけるようにするための保険。
 */
export function createSupabaseBrowserClient() {
  assertSupabaseEnv();
  return createBrowserClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
}
