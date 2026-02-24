import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Local Codex Web App",
  description: "Gateway control plane home",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
