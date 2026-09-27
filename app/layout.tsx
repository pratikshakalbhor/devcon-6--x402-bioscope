import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "bioscope",
  description: "Short reels, sold one at a time.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main className="shell">{children}</main>
      </body>
    </html>
  );
}
