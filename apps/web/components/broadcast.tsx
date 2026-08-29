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
import type { CSSProperties, ReactNode } from "react";

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
 * The design system's `SectionHeader`, as it is written there: a 13px accent
 * eyebrow, a fluid heading that caps at 2.5rem, and an optional grey intro
 * capped to a 640px measure.
 *
 * The Live hero and the leaderboard band deliberately do not use it. Its
 * heading caps at 2.5rem and paints ink-on-paper colours, which would shrink
 * the hero and make the band's heading invisible — the same reason the
 * prototype hand-sets those two.
 */
export function SectionHeader({
  label,
  heading,
  intro,
  className = "",
}: {
  label?: string;
  heading?: string;
  intro?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      {label ? (
        <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.12em] text-accent">{label}</h2>
      ) : null}
      {heading ? (
        <h3 className="mb-6 text-[clamp(1.75rem,3.5vw,2.5rem)] font-bold leading-[1.2] tracking-[-0.02em] text-foreground">
          {heading}
        </h3>
      ) : null}
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
      <i
        aria-hidden="true"
        className="fas fa-arrow-right text-[12px] transition-transform duration-300 group-hover:translate-x-[3px]"
      />
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
      ? "bg-accent-soft text-accent"
      : result === "L"
        ? "bg-[rgba(138,59,48,0.1)] text-danger"
        : "bg-border text-muted";
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

/** The near-black full-bleed band: masthead, leaderboard, matchup hero. */
export function Band({
  children,
  className = "",
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={`bg-band text-band-text ${className}`} style={style}>
      {children}
    </div>
  );
}

/** An empty state that keeps a section's shape instead of collapsing it. */
export function Nothing({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-[14px] text-muted">{children}</p>;
}

/** Points, to one decimal — the density the broadcast layout is set for. */
export function pts(n: number | null | undefined): string {
  return (n ?? 0).toFixed(1);
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

/** "Sep 20" — the season timeline's card labels. */
export function formatEtDay(d: Date): string {
  return d.toLocaleString("en-US", { timeZone: ET, month: "short", day: "numeric" });
}
