import { createClient } from "@supabase/supabase-js";
import { SUPABASE_SECRET_KEY, SUPABASE_URL, hasSupabaseSecretKey } from "@/lib/env";

/**
 * Supabase クライアントの4つめ。**RLS を迂回する。**
 *
 * 使ってよい場所はここに書いた1つだけ。
 *
 *   ・退会の第2段階（auth.users の削除と、遮断表への進み具合の記録）
 *
 * ほかの用途で使わないこと。RLS を迂回するということは、
 * このプロジェクトが12の遮断表とRPCで積み上げてきた守りを、
 * **全部飛び越える**ということ。
 *
 * 【なぜ必要か】
 *   auth.users は Supabase が持つ認証用の表で、SQL の RPC からは触らない
 *   方針にした（指定10）。行の削除は Admin API だけが正しい経路で、
 *   セッションの無効化や関連レコードの後始末も一緒に行ってくれる。
 *
 * 【import 時に例外を投げない】
 *   鍵が未設定でもアプリ全体が止まらないようにする。
 *   退会の第2段階だけが「あとで掃除する」状態になり、
 *   第1段階（個人データの消去と締め出し）は鍵が無くても完了する。
 *
 * 【クライアントから import しないこと】
 *   server-only パッケージは入れていないので、機械的には止まらない。
 *   このファイルを import してよいのは Server Action だけ。
 *   NEXT_PUBLIC_ が付いていない環境変数はブラウザ側では空になるため、
 *   誤って import しても鍵は漏れないが、動かないコードができる。
 */

export function canUseSupabaseAdmin(): boolean {
  return hasSupabaseSecretKey() && SUPABASE_URL.trim() !== "";
}

/** 使えないときは null を返す。呼ぶ側で必ず分岐すること。 */
export function createSupabaseAdminClient() {
  if (!canUseSupabaseAdmin()) return null;

  return createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
    auth: {
      // 管理用なのでセッションを持たない。Cookie も触らない。
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
