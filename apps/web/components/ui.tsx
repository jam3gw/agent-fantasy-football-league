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
    <section className="rounded-lg border border-border bg-surface p-4">
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

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="table-scroll">
      <table className="w-full min-w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            {head.map((h, i) => (
              <th key={i} className="px-2 py-2 font-medium">
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
