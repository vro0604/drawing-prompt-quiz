import type { NextConfig } from "next";

/**
 * Next.js の設定。
 *
 * 【1】作品画像の配信元を許可する
 *   next/image は、外部ホストの画像を既定で拒否する。
 *   許可を書かないと 400 になるので、Supabase Storage の公開URLだけを通す。
 *   ホスト名は環境ごとに違うため、環境変数から組み立てる。
 *   pathname を /storage/v1/object/public/** に絞っているのは、
 *   同じホストの他のAPIを画像最適化の入口にしないため。
 *
 * 【2】Server Action の本文サイズ
 *   既定は 1MB。作品画像の上限は 5MB（spec 8-6 / R17）なので、
 *   投稿フォームの送信がそのままでは弾かれる。
 *   multipart の区切りやヘッダのぶんだけ余裕を足して 6MB にする。
 *   **画像そのものの上限は 5MB のまま**で、それはバケットの
 *   file_size_limit と投稿処理の両方が見ている。
 */

const supabaseHost = (() => {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (raw.trim() === "") return null;
  try {
    return new URL(raw).hostname;
  } catch {
    // 環境変数が壊れていてもビルドは通す。画像が出ないことで気づける。
    return null;
  }
})();

const nextConfig: NextConfig = {
  images: {
    remotePatterns: supabaseHost
      ? [
          {
            protocol: "https",
            hostname: supabaseHost,
            pathname: "/storage/v1/object/public/**",
          },
        ]
      : [],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "6mb",
    },
  },
};

export default nextConfig;
