import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://nekofans-mindgames-20261109.earlyplum36.chatgpt.site"),
  openGraph: { title: "Nekofans.Game", description: "发现原创智斗游戏，分享天马行空的规则。", images: ["/assets/duel-concept.webp"], type: "website", locale: "zh_CN" },
  title: "Nekofans.Game — 游戏人生，规则由你来写",
  description: "发现玩家创造的智斗游戏，分享原创规则。Nekofans.Game，与人类和 AI 队友一起，走进由想象力定义的游戏世界。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
