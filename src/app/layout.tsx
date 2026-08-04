import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * metadataBase は共有カードの URL を絶対パスにするために要る。
 * SNS のクローラーは相対パスを解決できないため、これが無いと
 * og:image が届かない。
 *
 * 本番では NEXT_PUBLIC_SITE_URL を設定する（Step 16）。
 * 手元では localhost に落として、開発中も同じ経路で確かめられるようにする。
 */
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "お題を引いて描くクイズ",
    template: "%s ｜ お題を引いて描くクイズ",
  },
  description:
    "引いたお題で絵を描き、見た人が絵だけからお題を当てるクイズ。ゲストのまま遊べます。",

  // ───────── 【限定公開】検索除外（2/2）─────────
  //
  // もう1か所は next.config.ts の headers()（X-Robots-Tag）。
  // **一般公開に切り替えるときは、この robots ブロックと
  //   next.config.ts の該当ブロックの2か所だけを消す。**
  //
  // 【なぜ meta とヘッダの両方を出すか】
  //   meta は HTML を解釈できたクローラーにしか届かない。
  //   画像・JSON・OGP画像のような HTML でない応答には書けない。
  //   ヘッダなら全部の応答に付く。どちらか片方では穴が残る。
  //
  // 【robots.txt を置かない理由】
  //   `Disallow: /` を書くと、クローラーはページを**取得しなくなる**。
  //   取得しないので、下の noindex を読むこともない。
  //   その結果 URL だけが検索結果に残ることがある。
  //   **取得はさせて、noindex を読ませる**のが正しい。
  //   SNS の共有カードも robots.txt を見るものがあるため、
  //   置かないほうが共有が壊れない。
  //
  // 【sitemap を作らない理由】
  //   出せば「見に来てください」と言うことになる。限定公開と矛盾する。
  //   いまリポジトリに sitemap.ts は無い（作らない）。
  //
  // index / follow を false で書く。noindex / nofollow という
  // キーは Next.js 16 で非推奨（型が never）になっている。
  robots: {
    index: false,
    follow: false,
    noarchive: true,
    // googleBot だけは別のタグに分けて出るため、同じ内容を明示する。
    // 書かないと googlebot 向けタグが出ず、既定の解釈に委ねることになる。
    googleBot: {
      index: false,
      follow: false,
      noarchive: true,
    },
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // lang は画面の言語に合わせる。ここが en のままだと、読み上げソフトが
  // 日本語の本文を英語として発音し、意味が取れなくなる。
  // 検索エンジンや翻訳の判定にも使われる。
  return (
    <html
      lang="ja"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
