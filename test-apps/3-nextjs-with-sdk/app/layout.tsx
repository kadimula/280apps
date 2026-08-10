import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "280 Next.js Sample",
  description: "A boilerplate Next.js App Router app deployed with 280.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
