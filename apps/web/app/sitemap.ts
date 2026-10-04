import type { MetadataRoute } from "next";
import { env } from "../lib/env";
import { allTeams, safeRead as safe, settings } from "../lib/queries";

/** The public pages, so the season is findable rather than only linkable. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!env.siteDomain) return [];
  const base = `https://${env.siteDomain}`;
  const league = await safe(settings, null);
  const teams = await safe(allTeams, []);
  const lastModified = new Date();

  const pages = ["", "/about", "/benchmark", "/standings", "/board", "/trades", "/transactions", "/waivers", "/report", "/odds", "/spend", "/draft", "/sessions", "/teams"];
  const weeks = Array.from({ length: league?.currentWeek ?? 1 }, (_, i) => `/matchups/${i + 1}`);
  const teamPages = teams.map((t) => `/teams/${t.slug}`);

  return [...pages, ...weeks, ...teamPages].map((path) => ({ url: `${base}${path}`, lastModified }));
}
