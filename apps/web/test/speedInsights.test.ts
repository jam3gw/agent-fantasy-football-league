/**
 * Vercel Speed Insights reports real-user Core Web Vitals for the public site.
 * The component only works when it is rendered on every page, which for the
 * App Router means the root layout and nowhere else: mounted deeper it would
 * miss the pages it is not under, and mounted twice it would double-report.
 * The `/next` entry is the one that reads the App Router's route, so a plain
 * `@vercel/speed-insights` import would attribute every vital to a raw URL.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const layout = readFileSync(`${appRoot}app/layout.tsx`, "utf8");

describe("Speed Insights (root layout)", () => {
  it("imports the component from the Next.js entry point", () => {
    expect(layout).toMatch(
      /import \{ SpeedInsights \} from "@vercel\/speed-insights\/next";/,
    );
  });

  it("renders exactly once, inside <body>", () => {
    const mounts = layout.match(/<SpeedInsights \/>/g) ?? [];
    expect(mounts).toHaveLength(1);

    const mount = layout.indexOf("<SpeedInsights />");
    expect(mount).toBeGreaterThan(layout.indexOf("<body"));
    expect(mount).toBeLessThan(layout.indexOf("</body>"));
  });
});
