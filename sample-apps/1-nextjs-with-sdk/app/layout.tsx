import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "280 SDK Identity",
  description: "A Next.js application using the 280 SDK identity API.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
