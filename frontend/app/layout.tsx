import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";

import { AppI18nProvider } from "@/i18n/provider";
import { getRequestLanguage } from "@/i18n/server";

import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  weight: ["400", "500", "600"],
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
  title: "Network Monitoring",
  description: "Network traffic monitoring dashboard",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const language = await getRequestLanguage();

  return (
    <html lang={language}>
      <body className={`${inter.variable} ${jetBrainsMono.variable}`}>
        <AppI18nProvider language={language}>{children}</AppI18nProvider>
      </body>
    </html>
  );
}
