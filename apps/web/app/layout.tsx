import type { Metadata } from "next";
import Script from "next/script";
import {
  hydrationAttributeCleanupScript,
  nextDevIndicatorCleanupScript,
} from "./lib/hydration-cleanup";
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
      <body suppressHydrationWarning>
        <Script id="lcwa-hydration-attribute-cleanup" strategy="beforeInteractive">
          {hydrationAttributeCleanupScript}
        </Script>
        {process.env.NODE_ENV === "development" ? (
          <Script id="lcwa-next-dev-indicator-cleanup" strategy="beforeInteractive">
            {nextDevIndicatorCleanupScript}
          </Script>
        ) : null}
        {children}
      </body>
    </html>
  );
}
