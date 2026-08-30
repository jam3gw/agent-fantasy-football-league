/**
 * Turn `packages/agent/briefs/*.md` into a TypeScript module.
 *
 * The briefs are authored as markdown so they read as prose (§8.6), but they
 * must not be read from disk at request time: on Vercel a serverless function
 * is rooted at the built app, not at the repo, so `packages/agent/briefs` is
 * simply not there and every session would have failed with ENOENT. Compiling
 * them into a module puts them in the bundle with everything else.
 *
 * The generated file is committed. `briefs.test.ts` fails if it drifts from
 * the markdown, so regenerating is a build step, not a thing to remember.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const BRIEF_DIR = path.join(here, "..", "briefs");
const OUT = path.join(here, "..", "src", "briefs.generated.ts");

export async function renderBriefsModule(): Promise<string> {
  const files = (await readdir(BRIEF_DIR)).filter((f) => f.endsWith(".md")).sort();
  const entries: string[] = [];
  for (const file of files) {
    const kind = file.replace(/\.md$/, "");
    const body = (await readFile(path.join(BRIEF_DIR, file), "utf8")).trim();
    entries.push(`  ${JSON.stringify(kind)}: ${JSON.stringify(body)},`);
  }
  return [
    "// GENERATED FILE — do not edit.",
    "// Source: packages/agent/briefs/*.md. Regenerate with `pnpm --filter @league/agent briefs`.",
    "",
    "/** Every session brief (§8.6), keyed by session kind. */",
    "export const BRIEFS: Record<string, string> = {",
    ...entries,
    "};",
    "",
  ].join("\n");
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  await writeFile(OUT, await renderBriefsModule(), "utf8");
  console.log(`wrote ${OUT}`);
}
