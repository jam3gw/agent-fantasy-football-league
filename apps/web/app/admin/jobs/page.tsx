import { desc, inArray } from "drizzle-orm";
import { formatEt } from "@league/shared";
import { scheduledJobs } from "@league/engine";
import { Badge, Card, Cell, Empty, PageTitle, Row, Table } from "../../../components/ui";
import { db, leagueClock } from "../../../lib/db";
import { bookJobAction, cancelJobAction, runJobNowAction } from "../../../lib/adminActions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Jobs" };

/** Kept in step with BOOKABLE_JOBS in lib/adminActions.ts. */
const BOOKABLE_JOBS = [
  "ingest.players",
  "ingest.trending",
  "ingest.schedule",
  "ingest.stats",
  "ingest.projections",
  "ingest.season_stats",
  "ingest.rankings",
  "waivers.run",
  "stats.finalize",
  "reporter.run",
  "sessions.book",
  "draft.run",
  "week.plan",
  "book_daily_jobs",
  "digest.weekly",
];

/** The `kind` payloads `reporter.run` and `sessions.book` dispatch on. */
const JOB_KINDS = [
  "reporter_recap",
  "reporter_preview",
  "reporter_draft_grades",
  "weekly_review",
  "post_waivers",
  "trade_window",
];

export default async function AdminJobsPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string }>;
}) {
  const { msg } = await searchParams;
  const database = db();
  const clock = await leagueClock();
  const now = clock.now();

  const open = await database
    .select()
    .from(scheduledJobs)
    .where(inArray(scheduledJobs.status, ["due", "claimed"]))
    .orderBy(scheduledJobs.dueAt)
    .limit(200)
    .catch(() => []);
  const recent = await database
    .select()
    .from(scheduledJobs)
    .where(inArray(scheduledJobs.status, ["done", "failed"]))
    .orderBy(desc(scheduledJobs.doneAt))
    .limit(40)
    .catch(() => []);

  const overdue = open.filter((j) => j.dueAt.getTime() < now.getTime() - 120_000).length;

  return (
    <>
      <PageTitle
        title="Jobs"
        subtitle="The scheduler books everything ahead through idempotency keys, so a missed tick never loses a schedule."
      />
      {msg ? <p className="mb-4 rounded-lg border border-accent/50 bg-accent-soft px-4 py-3 text-sm text-accent">{msg}</p> : null}

      <Card title={`Queue — ${open.length} open, ${overdue} overdue`}>
        {open.length === 0 ? (
          <Empty>Nothing queued.</Empty>
        ) : (
          <Table head={["Type", "Due", "Status", "Payload", ""]}>
            {open.map((j) => (
              <Row key={j.id}>
                <Cell>
                  <span className="font-mono text-xs">{j.type}</span>
                </Cell>
                <Cell>
                  {formatEt(j.dueAt)}{" "}
                  {j.dueAt.getTime() < now.getTime() - 120_000 ? <Badge tone="warn">overdue</Badge> : null}
                </Cell>
                <Cell>{j.status}</Cell>
                <Cell>
                  <span className="font-mono text-xs text-muted">
                    {Object.keys(j.payload).length === 0 ? "—" : JSON.stringify(j.payload).slice(0, 80)}
                  </span>
                </Cell>
                <Cell>
                  <div className="flex gap-2">
                    <form action={runJobNowAction}>
                      <input type="hidden" name="jobId" value={j.id} />
                      <button type="submit" className="rounded border border-border px-2 py-1 text-xs hover:border-accent hover:text-accent">
                        Run now
                      </button>
                    </form>
                    <form action={cancelJobAction}>
                      <input type="hidden" name="jobId" value={j.id} />
                      <button type="submit" className="rounded border border-border px-2 py-1 text-xs hover:border-danger hover:text-danger">
                        Cancel
                      </button>
                    </form>
                  </div>
                </Cell>
              </Row>
            ))}
          </Table>
        )}
        <p className="mt-3 text-xs text-muted">
          &ldquo;Run now&rdquo; claims the row first so the per-minute tick cannot run it at the same time, then runs it inline and
          reports the result here.
        </p>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Book a job">
          <form action={bookJobAction} className="space-y-3 text-sm">
            <label className="block">
              <span className="mb-1 block text-muted">Type</span>
              <select name="type" className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-xs">
                {BOOKABLE_JOBS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-muted">Week (optional — for the ingest and finalize jobs)</span>
              <input name="week" type="number" min={1} max={18} className="w-full rounded border border-border bg-background px-2 py-1.5" />
            </label>
            <label className="block">
              <span className="mb-1 block text-muted">Kind (required for reporter.run and sessions.book)</span>
              <select name="kind" className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-xs">
                <option value="">—</option>
                {JOB_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-background hover:opacity-90">
              Book for now
            </button>
          </form>
        </Card>

        <Card title="Recently finished">
          {recent.length === 0 ? (
            <Empty>Nothing has run yet.</Empty>
          ) : (
            <Table head={["Type", "Finished", "Result"]}>
              {recent.map((j) => (
                <Row key={j.id}>
                  <Cell>
                    <span className="font-mono text-xs">{j.type}</span>
                  </Cell>
                  <Cell>{j.doneAt ? formatEt(j.doneAt) : "—"}</Cell>
                  <Cell>
                    {j.status === "failed" ? (
                      <span className="text-danger">{(j.error ?? "failed").slice(0, 120)}</span>
                    ) : j.error ? (
                      <span className="text-muted">{j.error.slice(0, 120)}</span>
                    ) : (
                      <Badge tone="accent">done</Badge>
                    )}
                  </Cell>
                </Row>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
