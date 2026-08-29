/**
 * Vercel Web Analytics reports page views for the public site. Like Speed
 * Insights it only works when it is rendered on every page, which for the App
 * Router means the root layout and nowhere else: mounted deeper it would miss
 * the pages it is not under, and mounted twice it would double-count every
 * view. The `/next` entry is the one that resolves the App Router's route, so
 * a plain `@vercel/analytics` import would file all eighteen weeks of
 * `/matchups/[week]` under eighteen separate paths.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const layout = readFileSync(`${appRoot}app/layout.tsx`, "utf8");

describe("Web Analytics (root layout)", () => {
  it("imports the component from the Next.js entry point", () => {
    expect(layout).toMatch(/import \{ Analytics \} from "@vercel\/analytics\/next";/);
  });

  it("renders exactly once, inside <body>", () => {
    const mounts = layout.match(/<Analytics \/>/g) ?? [];
    expect(mounts).toHaveLength(1);

    const mount = layout.indexOf("<Analytics />");
    expect(mount).toBeGreaterThan(layout.indexOf("<body"));
    expect(mount).toBeLessThan(layout.indexOf("</body>"));
  });
});
