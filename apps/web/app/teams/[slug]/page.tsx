/**
 * `/teams/[slug]` — a team's page for the current week. The page itself is
 * `team.tsx`; this file is the route.
 */
import { Team } from "./team";

// §12.1: 300s freshness. Rendered ahead and refreshed in the
// background, so the CDN serves a copy at most 300s stale.
export const revalidate = 300;

/**
 * The twelve teams are known only from the database, so none is prerendered.
 * Declaring the list anyway is what makes Next treat the route as
 * static-with-revalidation: without it the segment is server-rendered per
 * request and answers `no-store`, so §12.1's window never reaches the CDN.
 */
export function generateStaticParams() {
  return [];
}

export default async function TeamPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <Team slug={slug} />;
}
