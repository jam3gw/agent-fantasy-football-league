"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Six links instead of twelve. The routes that came off the bar are all still
 * reachable — they moved to the footer — so nothing in SPEC §12.1 is lost;
 * what changed is that the ones people actually follow during a season are no
 * longer buried in a flat wall of the ones they follow once.
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
                ? "text-band-text shadow-[inset_0_-3px_0_0_var(--accent)]"
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
