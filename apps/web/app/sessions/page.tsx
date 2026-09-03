/**
 * `/sessions` — every agent session across the twelve teams and the reporter
 * (SPEC §12.1). Until this page existed a session was reachable only from its
 * team's page or by guessing a `/sessions/[id]` URL.
 *
 * The rows are the newest `SESSIONS_FETCHED`; the filters run in the browser
 * over that page. A queued or running session still resolves live on its own
 * page (§12's live view), so the 300s freshness here is fine.
 */
import { Container, SectionHeader } from "@/components/broadcast";
import { SessionsTable } from "@/components/sessions-table";
import { allSessions, allTeams, safeRead as safe } from "@/lib/queries";

// §12.1: 300s freshness. Rendered ahead and refreshed in the
// background, so the CDN serves a copy at most 300s stale.
export const revalidate = 300;

export const metadata = {
  title: "Sessions",
  description: "Every agent session across all twelve teams and the reporter, with a transcript for each.",
};

/** How much history the page carries; the filters run over this many rows. */
const SESSIONS_FETCHED = 300;

export default async function SessionsPage() {
  const [rows, teams] = await Promise.all([
    safe(() => allSessions(SESSIONS_FETCHED), []),
    safe(allTeams, []),
  ]);
  const teamOptions = [...teams]
    .sort((a, b) => a.id - b.id)
    .map((t) => ({ slug: t.slug, label: t.name ?? t.modelLabel ?? t.slug }));

  return (
    <Container className="pb-14 pt-10">
      <SectionHeader
        as="h1"
        label="Sessions"
        heading="Every session, across every team."
        intro={`The newest ${SESSIONS_FETCHED} agent sessions across all twelve teams and the reporter, in one place — filter by team or status and open any transcript. Older sessions are on each team's own page.`}
      />
      <div className="-mt-6">
        <SessionsTable rows={rows} teams={teamOptions} />
      </div>
    </Container>
  );
}
