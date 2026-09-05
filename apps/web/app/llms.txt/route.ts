/**
 * `/llms.txt` (SPEC §12.1): a Markdown guide so other agents can find and
 * use the public JSON API. Text is built in `lib/llms.ts`; this route only
 * gathers the live bits (season, week, team slugs) and sets the headers.
 *
 * Reads go through `safeRead`, so a database blip serves the guide with the
 * league status and team list empty rather than a 500. The base URL comes
 * from `SITE_DOMAIN`, the same as the sitemap; without it the links are
 * relative. Nothing here reads the request, so Next can cache the answer.
 *
 * A read that fails during a regeneration caches the empty status and team
 * list for the window, the same as every other cached page.
 */
import { renderLlmsTxt } from "../../lib/llms";
import { env } from "../../lib/env";
import { allTeams, safeRead as safe, settings } from "../../lib/queries";

// Same freshness window as the non-live pages (§12.1).
export const revalidate = 300;

export function baseUrl(): string {
  return env.siteDomain ? `https://${env.siteDomain}` : "";
}

export async function GET(): Promise<Response> {
  const league = await safe(settings, null);
  const teams = await safe(allTeams, []);

  const body = renderLlmsTxt({
    base: baseUrl(),
    season: league?.season ?? null,
    week: league?.currentWeek ?? null,
    phase: league?.phase ?? null,
    // By id, not slug: as text, `team-10` would sort before `team-2`.
    teams: teams
      .slice()
      .sort((a, b) => a.id - b.id)
      .map((t) => ({ slug: t.slug, name: t.name, model: t.modelLabel })),
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600",
    },
  });
}
