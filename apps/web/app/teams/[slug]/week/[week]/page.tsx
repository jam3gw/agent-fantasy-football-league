/**
 * `/teams/[slug]/week/[week]` — a team's page for a chosen week: that week's
 * lineup and bench, with everything else the team page shows.
 */
import { notFound } from "next/navigation";
import { MAX_WEEK, Team } from "../../team";

// §12.1: 300s freshness. Rendered ahead and refreshed in the
// background, so the CDN serves a copy at most 300s stale.
export const revalidate = 300;

/**
 * Teams come from the database, so nothing is prerendered. Declaring the list
 * anyway is what makes Next treat the route as static-with-revalidation
 * instead of rendering it per request.
 */
export function generateStaticParams() {
  return [];
}

export default async function TeamWeekPage({ params }: { params: Promise<{ slug: string; week: string }> }) {
  const { slug, week: weekParam } = await params;
  const week = Number(weekParam);
  if (!Number.isInteger(week) || week < 1 || week > MAX_WEEK) notFound();
  return <Team slug={slug} week={week} />;
}
