/**
 * The presentation pieces the redesigned public pages are built from.
 *
 * `components/ui.tsx` is still the vocabulary for the admin pages and the
 * public pages the redesign does not cover, so it is left alone; this file is
 * the broadcast layer that sits beside it. Where a piece here has a
 * counterpart in the bound design system (`SectionHeader`, `CardLink`, `Tag`),
 * the sizes, weights, spacings and hover behaviour are taken from that
 * component's source rather than eyeballed.
 */
import Link from "next/link";
import type { ReactNode } from "react";

/** 1240px and 28px gutters — the measure every band in the design shares. */
export function Container({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-[1240px] px-5 sm:px-7 ${className}`}>{children}</div>;
}

/**
 * The small tracked label above a heading. Accent green on paper; callers pass
 * a colour for the dark band, where the accent goes nearly invisible.
 */
export function Eyebrow({
  children,
  className = "text-accent",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`text-[12px] font-bold uppercase tracking-[0.12em] ${className}`}>{children}</div>
  );
}

/**
 * The design system's `SectionHeader`: a 13px accent eyebrow, a fluid heading
 * that caps at 2.5rem, and an optional grey intro capped to a 640px measure.
 *
 * One deliberate departure from its source. The system marks the eyebrow up as
 * an `<h2>` and the heading as an `<h3>`, which would leave every page that
 * uses it with no `<h1>` at all and with a decorative label outranking the
 * page's own title. The eyebrow is a label, so it is a `<p>`, and the heading
 * takes the level the page needs — `h1` where this is the page title. Every
 * pixel is identical; only the outline changes.
 *
 * The front page's lead deliberately does not use this. Its heading caps at
 * 2.5rem, which would shrink the 54px headline — the same reason the
 * prototype hand-sets it.
 */
export function SectionHeader({
  label,
  heading,
  intro,
  as: Heading = "h2",
  className = "",
}: {
  label?: string;
  heading?: string;
  intro?: string;
  as?: "h1" | "h2" | "h3";
  className?: string;
}) {
  const eyebrow = label ? (
    <span className="mb-3 block text-[13px] font-semibold uppercase tracking-[0.12em] text-accent">
      {label}
    </span>
  ) : null;
  const title = heading ? (
    <span className="block text-[clamp(1.75rem,3.5vw,2.5rem)] font-bold leading-[1.2] tracking-[-0.02em] text-foreground">
      {heading}
    </span>
  ) : null;

  return (
    <div className={className}>
      {/*
        The eyebrow names the page and the heading says what is on it, so when
        this is the page title both belong inside the one heading element —
        an outline reading "Through week 2." with "Standings" nowhere in it
        names nothing. Elsewhere the eyebrow stays a plain label above the
        heading. Identical pixels either way.
      */}
      {heading ? (
        <Heading className="mb-6">
          {eyebrow}
          {title}
        </Heading>
      ) : (
        eyebrow
      )}
      {intro ? (
        <p className="mb-14 max-w-[640px] text-[17px] leading-[1.7] text-muted">{intro}</p>
      ) : null}
    </div>
  );
}

/**
 * The design system's `CardLink`: a 14px accent link whose arrow slides 3px
 * right on hover. The system does this with React hover state; a `group` and a
 * CSS transition get the same movement without making every page that uses a
 * link a client component.
 *
 * The system asks for Font Awesome and says not to hand-draw icons. That is
 * the right rule for a site with an icon set; this one needs exactly one glyph,
 * and the alternative was a third-party stylesheet on every route — including
 * the commissioner login — that cannot carry an integrity hash from this
 * network. One inline arrow costs nothing and removes the dependency. If a
 * second icon ever appears, load the real icon set rather than growing this.
 */
export function CardLink({
  href,
  children,
  className = "",
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`group inline-flex items-center gap-1.5 text-[14px] font-medium text-accent transition-colors hover:text-accent-hover ${className}`}
    >
      {children}
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="transition-transform duration-300 group-hover:translate-x-[3px]"
      >
        <path d="M2 8h11M9 4l4 4-4 4" />
      </svg>
    </Link>
  );
}

/** The design system's `Tag`: an accent capsule, `sm` for chips, `md` for skills. */
export function Tag({ children, size = "md" }: { children: ReactNode; size?: "sm" | "md" }) {
  const dims = size === "md" ? "text-[13px] px-3.5 py-1.5" : "text-[12px] px-2.5 py-1";
  return (
    <span
      className={`inline-block rounded-full bg-accent-soft font-medium text-accent ${dims}`}
    >
      {children}
    </span>
  );
}

/** The paper card the design uses everywhere: 1px hairline, 12px radius. */
export function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`min-w-0 rounded-xl border border-border bg-surface ${className}`}>{children}</div>
  );
}

/** A KPI tile: tracked label, big tabular number, one line of context. */
export function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Panel className="p-[18px]">
      <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-faint">{label}</div>
      <div className="mt-2.5 text-[31px] font-extrabold tabular-nums tracking-[-0.03em]">{value}</div>
      {sub ? <div className="mt-1 text-[13px] leading-[1.45] text-muted">{sub}</div> : null}
    </Panel>
  );
}

/**
 * A horizontal bar. `align="right"` fills from the right instead, which is
 * what the away side of a mirrored matchup row needs.
 */
export function Bar({
  pct,
  className = "bg-accent",
  track = "bg-background-alt",
  height = 6,
  align = "left",
}: {
  pct: number;
  className?: string;
  track?: string;
  height?: number;
  align?: "left" | "right";
}) {
  const width = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  return (
    <div
      className={`flex overflow-hidden rounded-full ${track} ${align === "right" ? "justify-end" : ""}`}
      style={{ height }}
    >
      <div className={`rounded-full ${className}`} style={{ width: `${width}%`, height }} />
    </div>
  );
}

/** A win or a loss in a team's recent form, newest on the right. */
export function FormChip({ result }: { result: "W" | "L" | "T" }) {
  const tone =
    result === "W"
      ? "bg-[rgba(47,93,52,0.14)] text-accent"
      : result === "L"
        ? "bg-[rgba(138,59,48,0.1)] text-danger"
        : "bg-border text-foreground";
  return (
    <span
      className={`flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold ${tone}`}
      title={result === "W" ? "win" : result === "L" ? "loss" : "tie"}
    >
      {result}
    </span>
  );
}

/** The pulsing dot that marks anything live. */
export function LiveDot({ className = "bg-accent" }: { className?: string }) {
  return <span aria-hidden="true" className={`live-dot h-[7px] w-[7px] rounded-full ${className}`} />;
}

/** An empty state that keeps a section's shape instead of collapsing it. */
export function Nothing({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-[14px] text-muted">{children}</p>;
}


const ET = "America/New_York";

/** "4:41 PM ET" — the masthead's freshness stamp. */
export function formatEtTime(d: Date): string {
  return `${d.toLocaleString("en-US", { timeZone: ET, hour: "numeric", minute: "2-digit" })} ET`;
}

/** "Sep 20, 2:14 PM" — timestamps in the activity rail and on board posts. */
export function formatEtStamp(d: Date): string {
  return d.toLocaleString("en-US", {
    timeZone: ET,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "4:38 PM" — the mono column down the left of the activity rail. */
export function formatEtClock(d: Date): string {
  return d.toLocaleString("en-US", { timeZone: ET, hour: "numeric", minute: "2-digit" });
}

/**
 * "10:14 AM" today, "Thu 9:02 PM" within the week, "Aug 28" before that —
 * the stamp on a wire item, down the left of the front-page stream, and the
 * masthead's "Last move". A bare clock on yesterday's item would read as
 * this morning's, and a weekday on a three-week-old trade as last Thursday.
 * `zone` appends " ET" to the forms that carry a clock; a date needs none.
 * "Now" is render time, which on an ISR page is at most the revalidate
 * window old — the same clock the reads' defaults use.
 */
export function formatEtRecent(d: Date, { now = new Date(), zone = false }: { now?: Date; zone?: boolean } = {}): string {
  const day = (x: Date) => x.toLocaleDateString("en-US", { timeZone: ET });
  const clock = d.toLocaleString("en-US", { timeZone: ET, hour: "numeric", minute: "2-digit" });
  const suffix = zone ? " ET" : "";
  if (day(d) === day(now)) return `${clock}${suffix}`;
  if (now.getTime() - d.getTime() < 6 * 86_400_000) {
    return `${d.toLocaleString("en-US", { timeZone: ET, weekday: "short" })} ${clock}${suffix}`;
  }
  return d.toLocaleString("en-US", { timeZone: ET, month: "short", day: "numeric" });
}

/**
 * "Wed 8:20 PM ET" within the week ahead, "Sep 20, 8:20 PM ET" beyond it —
 * the stamp on something that has not happened yet. `formatEtRecent` reads
 * the other way: a date ahead of `now` is always "within six days" to it,
 * so a kickoff two Sundays out would read as this Sunday's.
 */
export function formatEtAhead(d: Date, { now = new Date() }: { now?: Date } = {}): string {
  const clock = d.toLocaleString("en-US", { timeZone: ET, hour: "numeric", minute: "2-digit" });
  if (d.getTime() - now.getTime() < 6 * 86_400_000) {
    return `${d.toLocaleString("en-US", { timeZone: ET, weekday: "short" })} ${clock} ET`;
  }
  return `${d.toLocaleString("en-US", { timeZone: ET, month: "short", day: "numeric" })}, ${clock} ET`;
}

/** "Sep 20" — the season timeline's card labels. */
export function formatEtDay(d: Date): string {
  return d.toLocaleString("en-US", { timeZone: ET, month: "short", day: "numeric" });
}
