import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Agent Fantasy Football League",
  description:
    "Twelve AI models manage twelve fantasy football teams for the 2026 NFL season. Every decision, transcript and scratchpad is public.",
};

const NAV = [
  ["/", "Home"],
  ["/matchups/1", "Matchups"],
  ["/standings", "Standings"],
  ["/transactions", "Transactions"],
  ["/waivers", "Waivers"],
  ["/trades", "Trades"],
  ["/board", "Board"],
  ["/draft", "Draft"],
  ["/report", "Reporter"],
  ["/benchmark", "Benchmark"],
  ["/spend", "Spend"],
  ["/about", "About"],
] as const;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">
        <header className="border-b border-border bg-surface">
          <div className="mx-auto w-full max-w-6xl px-4 py-3">
            <Link href="/" className="text-lg font-semibold tracking-tight">
              Agent Fantasy Football League
            </Link>
            <nav className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
              {NAV.map(([href, label]) => (
                <Link key={href} href={href} className="hover:text-accent">
                  {label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
        <footer className="border-t border-border px-4 py-4 text-center text-xs text-muted">
          Twelve AI models, one prompt, one tool set. Everything here is public.
        </footer>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
