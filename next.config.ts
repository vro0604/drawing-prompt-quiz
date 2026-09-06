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
 *
 * 【3】検索除外（限定公開のあいだだけ）
 *   下の headers() を参照。一般公開に切り替えるときに消す。
 */

/**
 * 画像の配信元。**組み立て先の URL から、そのまま写す。**
 *
 * もとは protocol を "https" と直接書いていた。本番はそれでよいが、
 * 手元で検証用のサーバー（http）に向けたとき、作品画像だけが 400 になって
 * 画面が確かめられなくなる。環境変数に書いてある通りの方式を使う。
 */
const supabaseOrigin = (() => {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (raw.trim() === "") return null;
  try {
    const u = new URL(raw);
    return {
      protocol: u.protocol.replace(":", "") as "http" | "https",
      hostname: u.hostname,
      port: u.port,
    };
  } catch {
    // 環境変数が壊れていてもビルドは通す。画像が出ないことで気づける。
    return null;
  }
})();

const nextConfig: NextConfig = {
  images: {
    remotePatterns: supabaseOrigin
      ? [
          {
            protocol: supabaseOrigin.protocol,
            hostname: supabaseOrigin.hostname,
            ...(supabaseOrigin.port ? { port: supabaseOrigin.port } : {}),
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

  // ───────── 【限定公開】検索除外（1/2）─────────
  //
  // もう1か所は src/app/layout.tsx の metadata.robots（<meta>）。
  // **一般公開に切り替えるときは、この headers() と
  //   layout.tsx の robots ブロックの2か所だけを消す。**
  //
  // ヘッダにするのは、HTML でない応答にも付けるため。
  // 画像・OGP画像・Server Action の応答・404 の本文にも同じ札が付く。
  // meta タグだけだと、そこに穴が残る。
  //
  // `/:path*` は全経路。静的ファイルより先に評価される。
  // 環境で切り替えない（新しい環境変数を増やさない）。
  // 限定公開をやめる判断は、コードを消すことで表す。
  headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        ],
      },
    ];
  },
};

export default nextConfig;
