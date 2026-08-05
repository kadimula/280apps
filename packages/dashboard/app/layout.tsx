import type { Metadata } from "next";
import { Geist_Mono, Oranienbaum, Inter } from "next/font/google";
import "./globals.css";

import { MockAuthControl } from "@/components/mock-auth-control";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const oranienbaum = Oranienbaum({
  variable: "--font-oranienbaum",
  weight: "400",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "280 | Secure your agent's apps",
  description:
    "Securely deploy, auth, and permission your internal agent-built apps. Your agent writes and pushes the code; 280 handles deployment, secrets, and access.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${oranienbaum.variable} ${geistMono.variable} h-full`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <MockAuthControl />
      </body>
    </html>
  );
}
