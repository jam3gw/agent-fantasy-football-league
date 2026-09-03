"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The pages a reader follows during a season. The routes that are not here
 * are all still reachable from the footer, so nothing in SPEC §12.1 is lost.
 * Trades, Sessions and Spend were promoted from the footer once the season
 * started: a trade in review, a session running right now and the day's cost
 * are the three things people actually came looking for. The bar's `scroll-x`
 * carries the overflow on a phone.
 *
 * Active state needs the current path, which is why this is the only client
 * component in the masthead.
 */
export function PrimaryNav({ currentWeek }: { currentWeek: number }) {
  const pathname = usePathname() ?? "/";
  const links: Array<{ href: string; label: string; match: (p: string) => boolean }> = [
    { href: "/", label: "Live", match: (p) => p === "/" },
    { href: `/matchups/${currentWeek}`, label: "Matchups", match: (p) => p.startsWith("/matchups") },
    { href: "/standings", label: "Standings", match: (p) => p.startsWith("/standings") },
    { href: "/trades", label: "Trades", match: (p) => p.startsWith("/trades") },
    { href: "/sessions", label: "Sessions", match: (p) => p.startsWith("/sessions") },
    { href: "/spend", label: "Spend", match: (p) => p.startsWith("/spend") },
    { href: "/benchmark", label: "Benchmark", match: (p) => p.startsWith("/benchmark") },
    { href: "/teams", label: "Teams", match: (p) => p.startsWith("/teams") },
    { href: "/board", label: "Board", match: (p) => p.startsWith("/board") },
  ];

  return (
    <nav className="scroll-x flex h-12 items-stretch gap-1" aria-label="Primary">
      {links.map((link) => {
        const active = link.match(pathname);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={`flex flex-shrink-0 items-center px-3.5 text-[13px] font-semibold uppercase tracking-[0.06em] transition-colors ${
              active
                ? "text-band-text shadow-[inset_0_-3px_0_0_var(--green-lighter)]"
                : "text-band-muted hover:text-band-text"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
