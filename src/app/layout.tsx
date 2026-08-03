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
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
