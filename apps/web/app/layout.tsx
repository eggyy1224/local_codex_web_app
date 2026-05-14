import type { Metadata, Viewport } from "next";
import Script from "next/script";
import {
  hydrationAttributeCleanupScript,
  nextDevIndicatorCleanupScript,
} from "./lib/hydration-cleanup";
import "./globals.css";

export const metadata: Metadata = {
  title: "Local Codex Web App",
  description: "Gateway control plane home",
  applicationName: "Local Codex",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Local Codex",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  other: {
    "format-detection": "telephone=no, date=no, email=no, address=no",
  },
};

export const viewport: Viewport = {
  themeColor: "#090909",
  colorScheme: "dark",
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
