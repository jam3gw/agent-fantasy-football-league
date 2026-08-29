/** Small shared presentation pieces so every page looks like one site. */
import Link from "next/link";
import type { ReactNode } from "react";

export function PageTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-5">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
    </div>
  );
}

export function Card({ title, children, action }: { title?: string; children: ReactNode; action?: ReactNode }) {
  return (
    // `min-w-0`: a grid or flex child defaults to `min-width: auto`, which is
    // its content's minimum width — so a card holding a wide table refuses to
    // shrink and pushes the whole page sideways instead of letting the table
    // scroll inside it. Measured on a 375px viewport before this was here.
    <section className="min-w-0 rounded-lg border border-border bg-surface p-4">
      {title ? (
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" | "warn" | "danger" }) {
  const tones = {
    neutral: "bg-border/50 text-muted",
    accent: "bg-accent-soft text-accent",
    warn: "text-warn border border-warn/40",
    danger: "text-danger border border-danger/40",
  } as const;
  return <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

/** A team's name with its model, the pairing shown everywhere on the site. */
export function TeamLabel({
  slug,
  name,
  model,
}: {
  slug?: string | null;
  name: string | null;
  model?: string | null;
}) {
  const label = name ?? "(unnamed)";
  const inner = (
    <>
      <span className="font-medium">{label}</span>
      {model ? <span className="ml-1.5 text-xs text-muted">{model}</span> : null}
    </>
  );
  return slug ? (
    <Link href={`/teams/${slug}`} className="hover:text-accent">
      {inner}
    </Link>
  ) : (
    <span>{inner}</span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted">{children}</p>;
}

/**
 * Roughly the narrowest a column stays readable. Below about this, a phone
 * wraps every cell to three or four lines instead of showing a table.
 */
const MIN_COLUMN_REM = 6.5;
/** Up to this many columns a table fits a phone; beyond it, it scrolls. */
const COLUMNS_THAT_FIT = 4;

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  // `min-w-full` used to be here, which is why wide tables squashed rather
  // than scrolled: it pins the table to the container's width, so the columns
  // compress to fit however many there are. A real minimum, proportional to
  // the column count, makes the table overflow its scroller — which is what
  // `.table-scroll` was for. Wide enough to be a no-op on a desktop.
  const minWidth = head.length > COLUMNS_THAT_FIT ? `${head.length * MIN_COLUMN_REM}rem` : undefined;
  return (
    // Bleeds to the card's edge on a phone so it is visible that it scrolls,
    // and back to normal once there is room.
    <div className="table-scroll -mx-4 px-4 sm:mx-0 sm:px-0">
      <table className="w-full text-sm" style={minWidth ? { minWidth } : undefined}>
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            {head.map((h, i) => (
              <th key={i} className="whitespace-nowrap px-2 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <tr className="border-b border-border/60 last:border-0">{children}</tr>;
}

export function Cell({ children, align = "left" }: { children: ReactNode; align?: "left" | "right" }) {
  return <td className={`px-2 py-2 ${align === "right" ? "text-right tabular-nums" : ""}`}>{children}</td>;
}

export function money(n: number | null | undefined): string {
  return `$${(n ?? 0).toFixed(2)}`;
}

export function points(n: number | null | undefined): string {
  return (n ?? 0).toFixed(2);
}

export function Banner({ children, tone }: { children: ReactNode; tone: "accent" | "warn" | "danger" }) {
  const tones = {
    accent: "border-accent/50 bg-accent-soft text-accent",
    warn: "border-warn/50 text-warn",
    danger: "border-danger/50 text-danger",
  } as const;
  return <div className={`mb-4 rounded-lg border px-4 py-3 text-sm ${tones[tone]}`}>{children}</div>;
}

/**
 * §13.2 and §13.4 on the public pages: while games are live, say when the
 * scores last updated, and say plainly when the feed has gone quiet. §13.4
 * makes this a rule about the *site*, not the admin page, because the people
 * it protects are the ones reading the scores.
 */
export function LiveScoreNotice({
  liveGames,
  lastUpdateAt,
  delayed,
  formatTime,
}: {
  liveGames: number;
  lastUpdateAt: Date | null;
  delayed: boolean;
  formatTime: (d: Date) => string;
}) {
  if (liveGames === 0) return null;
  if (delayed) {
    return (
      <Banner tone="warn">
        <strong>Live scores delayed.</strong> The stats feed has been quiet for more than ten minutes with{" "}
        {liveGames} game{liveGames === 1 ? "" : "s"} in progress, so these are the last scores we received
        {lastUpdateAt ? ` (${formatTime(lastUpdateAt)})` : ""}. Nothing is lost — the week still finalizes on Tuesday.
      </Banner>
    );
  }
  return (
    <p className="mb-4 text-xs text-muted">
      {liveGames} game{liveGames === 1 ? "" : "s"} live. Scores last updated{" "}
      {lastUpdateAt ? formatTime(lastUpdateAt) : "—"}.
    </p>
  );
}
