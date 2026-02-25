import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Local Codex Web App",
  description: "Gateway control plane home",
  other: {
    "format-detection": "telephone=no, date=no, email=no, address=no",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
