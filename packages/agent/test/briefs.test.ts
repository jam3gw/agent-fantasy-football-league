/**
 * The generated brief module must match the markdown it came from. Without
 * this the two drift the moment someone edits a brief and forgets to
 * regenerate, and the drift is invisible: the session still runs, on the old
 * text.
 */
import { describe, expect, it } from "vitest";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BRIEFS } from "../src/briefs.generated.ts";
import { renderBriefsModule, BRIEF_DIR } from "../scripts/generateBriefs.mts";
import { SETS } from "../src/toolsets.ts";

const generatedPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "briefs.generated.ts");

describe("briefs", () => {
  it("the generated module is up to date with the markdown", async () => {
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(generatedPath, "utf8")).toBe(await renderBriefsModule());
  });

  it("has a brief for every markdown file, trimmed and non-empty", async () => {
    const files = (await readdir(BRIEF_DIR)).filter((f) => f.endsWith(".md"));
    expect(Object.keys(BRIEFS).sort()).toEqual(files.map((f) => f.replace(/\.md$/, "")).sort());
    for (const [kind, text] of Object.entries(BRIEFS)) {
      expect(text.length, kind).toBeGreaterThan(20);
      expect(text).toBe(text.trim());
    }
  });

  it("has a brief for every session kind that runs a model", () => {
    for (const kind of Object.keys(SETS)) {
      expect(BRIEFS[kind], `missing brief for ${kind}`).toBeTypeOf("string");
    }
  });
});
