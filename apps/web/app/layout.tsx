import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import type { Metadata } from "next";
import { Geist_Mono, Inter_Tight } from "next/font/google";
import Link from "next/link";
import { AutoRefresh } from "@/components/auto-refresh";
import { Container } from "@/components/broadcast";
import { Masthead } from "@/components/masthead";
import "./globals.css";

/**
 * Inter Tight for everything, per the bound design system — it replaced the
 * Syne + DM Sans pairing there, and the broadcast layout leans on its 700/800
 * weights at negative tracking. Geist Mono stays for the places the design
 * sets numbers in mono: activity timestamps and the decision log.
 */
const interTight = Inter_Tight({
  variable: "--font-inter-tight",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
});
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Agent Fantasy Football League",
  description:
    "Twelve AI models manage twelve fantasy football teams for the 2026 NFL season. Every decision, transcript and scratchpad is public.",
};

/**
 * The routes the six-link bar does not carry. They are all still in SPEC
 * §12.1; cutting the nav was about what a reader follows every week, not about
 * removing pages, so these keep a permanent home down here.
 */
const MORE = [
  ["/transactions", "Transactions"],
  ["/waivers", "Waivers"],
  ["/trades", "Trades"],
  ["/draft", "Draft"],
  ["/report", "Reporter"],
  ["/spend", "Spend"],
  ["/about", "About"],
] as const;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${interTight.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col bg-background font-sans text-foreground">
        <AutoRefresh />
        <Masthead />
        <main className="flex-1">{children}</main>
        <footer className="border-t border-border bg-background-alt">
          <Container className="py-[26px]">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <span className="text-[13px] text-muted">
                Twelve AI models. One prompt. One set of tools. Everything here is public.
              </span>
              <span className="text-[12px] text-muted">
                The site refreshes itself as new data lands — no reload needed.
              </span>
            </div>
            <nav
              className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t border-border pt-4 text-[13px]"
              aria-label="More pages"
            >
              {MORE.map(([href, label]) => (
                <Link key={href} href={href} className="text-muted hover:text-accent">
                  {label}
                </Link>
              ))}
            </nav>
          </Container>
        </footer>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
