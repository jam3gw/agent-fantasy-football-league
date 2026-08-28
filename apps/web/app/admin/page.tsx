import Link from "next/link";
import { and, eq, gte, isNull } from "drizzle-orm";
import { costAlarms, getSettings, scheduledJobs, sessions, teams } from "@league/engine";
import { Badge, Card, PageTitle } from "../../components/ui";
import { db, leagueClock } from "../../lib/db";
import { getDraft } from "../../lib/draft";

export const dynamic = "force-dynamic";
export const metadata = { title: "Commissioner" };

const PAGES: Array<{ href: string; title: string; blurb: string }> = [
  { href: "/admin/health", title: "Health", blurb: "Feeds, ingests, failed sessions, scoring discrepancies, jobs, alarms, digest." },
  { href: "/admin/teams", title: "Teams", blurb: "Pause or unpause a team, run a session now, swap a model with a public reason." },
  { href: "/admin/trades", title: "Trades", blurb: "Reverse an executed trade. Bugs only, reason required." },
  { href: "/admin/scores", title: "Scores", blurb: "Which source scored each week, re-run finalization, correct one player's points." },
  { href: "/admin/settings", title: "Settings", blurb: "Editable league settings, loop guards, cost alarm rules, tool costs, the optional hard stop." },
  { href: "/admin/rankings", title: "Rankings", blurb: "The FantasyPros pull, the unmatched list with a mapping control, refresh now." },
  { href: "/admin/draft", title: "Draft", blurb: "Onboarding, draw the order, start / pause / resume, emergency auto-pick." },
  { href: "/admin/jobs", title: "Jobs", blurb: "The scheduled job queue: run now, cancel, book." },
];

export default async function AdminIndexPage() {
  const database = db();
  const clock = await leagueClock();
  const now = clock.now();

  // Every read is defensive: an empty database must render this page.
  const [settings, allTeams, draftState, openAlarms, overdue, failedSessions] = await Promise.all([
    getSettings(database).catch(() => null),
    database.select().from(teams).catch(() => []),
    getDraft(database).catch(() => undefined),
    database.select().from(costAlarms).where(isNull(costAlarms.acknowledgedAt)).catch(() => []),
    database
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.status, "due"))
      .catch(() => []),
    database
      .select()
      .from(sessions)
      .where(and(eq(sessions.status, "failed"), gte(sessions.createdAt, new Date(now.getTime() - 7 * 864e5))))
      .catch(() => []),
  ]);

  const overdueCount = overdue.filter((j) => j.dueAt.getTime() < now.getTime() - 120_000).length;
  const paused = allTeams.filter((t) => t.paused).length;

  return (
    <>
      <PageTitle
        title="Commissioner"
        subtitle="Buttons and settings only. Nothing here is ever a file upload, and nothing waits for a person."
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Phase" value={settings?.phase ?? "—"} note={settings ? `week ${settings.currentWeek} of ${settings.season}` : "no settings row"} />
        <Stat label="Draft" value={draftState?.status ?? "not started"} note={draftState?.currentPick ? `pick ${draftState.currentPick}` : "no picks yet"} />
        <Stat label="Teams" value={String(allTeams.length)} note={paused > 0 ? `${paused} paused` : "none paused"} />
        <Stat
          label="Needs attention"
          value={String(openAlarms.length + overdueCount + failedSessions.length)}
          note={`${openAlarms.length} alarms · ${overdueCount} overdue jobs · ${failedSessions.length} failed sessions`}
          tone={openAlarms.length + overdueCount + failedSessions.length > 0 ? "warn" : "neutral"}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {PAGES.map((p) => (
          <Link key={p.href} href={p.href} className="block rounded-lg border border-border bg-surface p-4 hover:border-accent">
            <h2 className="text-sm font-semibold">{p.title}</h2>
            <p className="mt-1 text-sm text-muted">{p.blurb}</p>
          </Link>
        ))}
      </div>

      <div className="mt-5">
        <Card title="Session">
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
            <span>Every action on these pages is written to commissioner_actions and shown publicly in /transactions.</span>
            <form method="post" action="/api/admin/logout" className="ml-auto">
              <button type="submit" className="rounded border border-border px-3 py-1.5 text-sm hover:border-danger hover:text-danger">
                Sign out
              </button>
            </form>
          </div>
        </Card>
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  note,
  tone = "neutral",
}: {
  label: string;
  value: string;
  note: string;
  tone?: "neutral" | "warn";
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold">
        {tone === "warn" ? <Badge tone="warn">{value}</Badge> : value}
      </div>
      <div className="mt-1 text-xs text-muted">{note}</div>
    </div>
  );
}
