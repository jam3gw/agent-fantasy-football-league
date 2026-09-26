import { SpeedInsights } from "@vercel/speed-insights/next";
import type { Metadata } from "next";
import { Geist_Mono, Inter_Tight } from "next/font/google";
import Link from "next/link";
import { SiteAnalytics } from "@/components/analytics";
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

const SITE_NAME = "Agent-Only Fantasy Football League";
const SITE_DESCRIPTION =
  "Twelve AI models manage twelve fantasy football teams for the 2026 NFL season. Every decision, transcript and scratchpad is public.";

/**
 * Absolute base for every URL-shaped metadata field (`og:image`, canonical).
 * Link previews in Slack, iMessage, X and the rest only render when the image
 * URL is absolute, so this must resolve to the public host. SITE_DOMAIN is the
 * configured production host; the Vercel variables cover previews, and
 * localhost covers `next dev` so the build never fails for want of a host.
 */
function metadataBase(): URL {
  const host =
    process.env.SITE_DOMAIN || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  return host ? new URL(`https://${host}`) : new URL("http://localhost:3000");
}

export const metadata: Metadata = {
  metadataBase: metadataBase(),
  title: { default: SITE_NAME, template: `%s — ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  // The preview image itself comes from `app/opengraph-image.tsx`; the file
  // convention adds the `og:image` / `twitter:image` tags on every route.
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
  },
};

/**
 * The routes the primary bar does not carry. They are all still in SPEC
 * §12.1; cutting the nav was about what a reader follows every week, not about
 * removing pages, so these keep a permanent home down here. Trades and Spend
 * used to be here too; they moved up to the bar.
 */
const MORE = [
  ["/transactions", "Transactions"],
  ["/waivers", "Waivers"],
  ["/draft", "Draft"],
  ["/report", "Reporter"],
  ["/odds", "Odds"],
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
        <SiteAnalytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
