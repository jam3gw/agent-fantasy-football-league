/**
 * A matchup card on the home page opens its own matchup, not the top of the
 * week's page (which opens on the closest game). The home links carry a hash
 * and the week page emits a matching anchor for every matchup, the featured
 * one on its hero band so the scores are in view.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appDir = fileURLToPath(new URL("../app/", import.meta.url));

describe("home matchup cards link to their own matchup", () => {
  it("home tiles and rows link to /matchups/<week>#matchup-<id>", () => {
    const source = readFileSync(appDir + "page.tsx", "utf8");
    const links = source.match(/href=\{`\/matchups\/\$\{card\.week\}#matchup-\$\{card\.matchupId\}`\}/g) ?? [];
    expect(links.length).toBe(2);
    expect(source).not.toMatch(/href=\{`\/matchups\/\$\{card\.week\}`\}/);
  });

  it("the week page anchors the featured hero and every other matchup section", () => {
    const source = readFileSync(appDir + "matchups/[week]/page.tsx", "utf8");
    expect(source).toContain("id={`matchup-${featured.matchupId}`} className=\"scroll-mt-6 bg-band");
    expect(source).toContain("id={`matchup-${card.matchupId}`} className=\"mb-10 scroll-mt-6\"");
  });
});
