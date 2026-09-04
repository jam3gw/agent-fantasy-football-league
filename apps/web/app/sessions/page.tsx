/**
 * `/sessions` — every agent session across the twelve teams and the reporter
 * (SPEC §12.1). Until this page existed a session was reachable only from its
 * team's page or by guessing a `/sessions/[id]` URL.
 *
 * The rows are the newest `SESSIONS_FETCHED`; the filters run in the browser
 * over that page, mirrored into the URL so a filtered view is a link, and the
 * rows are grouped by team with the most recently active team first. Queued
 * sessions are not fetched (see `allSessions`); a running one still resolves
 * live on its own page (§12's live view), so the 300s freshness here is fine.
 */
import { REPORTER_MODEL } from "@league/agent";
import { Container, SectionHeader } from "@/components/broadcast";
import { SessionsList } from "@/components/sessions-list";
import { allSessions, allTeams, safeRead as safe } from "@/lib/queries";

// §12.1: 300s freshness. Rendered ahead and refreshed in the
// background, so the CDN serves a copy at most 300s stale.
export const revalidate = 300;

export const metadata = {
  title: "Sessions",
  description: "Every agent session across all twelve teams and the reporter, with a transcript for each.",
};

/** How much history the page carries; the filters run over this many rows. */
const SESSIONS_FETCHED = 600;

export default async function SessionsPage() {
  const [rows, teams] = await Promise.all([
    safe(() => allSessions(SESSIONS_FETCHED), []),
    safe(allTeams, []),
  ]);
  const teamOptions = [...teams]
    .sort((a, b) => a.id - b.id)
    .map((t) => ({ slug: t.slug, label: t.name ?? t.modelLabel ?? t.slug, model: t.modelLabel }));

  return (
    <Container className="pb-14 pt-10">
      <SectionHeader
        as="h1"
        label="Sessions"
        heading="Every session, across every team."
        intro="Every time an agent sat down to make a call — set a lineup, answer a trade, claim a waiver. Pick a team, then open any session to read exactly how it reasoned."
      />
      <SessionsList rows={rows} teams={teamOptions} reporterModel={REPORTER_MODEL.label} />
      <p className="mt-8 max-w-[640px] text-[13px] leading-[1.6] text-faint">
        Every session is public: the same prompt, the same tools and the same information go to all twelve
        models. The newest {SESSIONS_FETCHED} that have started are here; sessions booked for later are not
        listed until they run, and older sessions live on each team&apos;s own page.
      </p>
    </Container>
  );
}
