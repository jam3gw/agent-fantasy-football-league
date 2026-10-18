/**
 * `scripts/vercel-ignore-build.sh` decides whether Vercel builds a push. A
 * wrong skip ships nothing and checks nothing; a wrong exit code (anything but
 * 0 or 1) fails the deployment outright. Each case builds a small git repo and
 * runs the script in it with `sh`, as Vercel does.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../scripts/vercel-ignore-build.sh", import.meta.url));

let dir: string;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv(), stdio: "pipe" }).trim();
const gitEnv = (): NodeJS.ProcessEnv => ({
  NODE_ENV: "test",
  PATH: process.env.PATH,
  HOME: dir,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_NOSYSTEM: "1",
});
function commit(file: string, body: string, message: string): string {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), body);
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}
const merge = (branch: string, message: string) => git("merge", "-q", "--no-edit", "-m", message, branch);

/** Run the script as Vercel would; returns its exit code. */
function ignore(env: { VERCEL_ENV?: string; VERCEL_GIT_PREVIOUS_SHA?: string }): number | null {
  const r = spawnSync("sh", [SCRIPT], { cwd: dir, env: { ...gitEnv(), ...env }, encoding: "utf8" });
  return r.status;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ignore-build-"));
  git("init", "-q", "-b", "main");
  commit("apps/a.ts", "a", "init");
  commit("docs/d.md", "d", "docs");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("vercel-ignore-build.sh", () => {
  it("skips a docs-only push and builds a code push", () => {
    const base = git("rev-parse", "HEAD");
    commit("docs/e.md", "e", "more docs");
    expect(ignore({ VERCEL_ENV: "production", VERCEL_GIT_PREVIOUS_SHA: base })).toBe(0);
    commit("apps/b.ts", "b", "code");
    expect(ignore({ VERCEL_ENV: "production", VERCEL_GIT_PREVIOUS_SHA: base })).toBe(1);
  });

  it("builds when the base is missing and HEAD has no parent to fall back to", () => {
    git("checkout", "-q", "--orphan", "fresh");
    commit("apps/x.ts", "x", "root");
    expect(ignore({ VERCEL_ENV: "preview", VERCEL_GIT_PREVIOUS_SHA: "deadbeef".repeat(5) })).toBe(1);
  });

  describe("a preview that merges main", () => {
    let mainTip: string;
    beforeEach(() => {
      git("checkout", "-q", "-b", "feat");
      git("checkout", "-q", "main");
      mainTip = commit("apps/m.ts", "m", "main code");
      git("checkout", "-q", "feat");
    });

    it("skips when the merged code equals main's (the branch carries only docs)", () => {
      const last = commit("docs/notes.md", "n", "branch docs");
      merge("main", "Merge branch 'main' into feat");
      expect(ignore({ VERCEL_ENV: "preview", VERCEL_GIT_PREVIOUS_SHA: last })).toBe(0);
      // A first preview always builds, whatever the commit holds.
      expect(ignore({ VERCEL_ENV: "preview" })).toBe(1);
      expect(mainTip).toBe(git("rev-parse", "HEAD^2"));
    });

    it("builds the same commit on production", () => {
      const last = commit("docs/notes.md", "n", "branch docs");
      merge("main", "Merge branch 'main' into feat");
      expect(ignore({ VERCEL_ENV: "production", VERCEL_GIT_PREVIOUS_SHA: last })).toBe(1);
    });

    it("builds when the branch has code of its own, even if the last preview built it", () => {
      const last = commit("apps/f.ts", "f", "branch code");
      merge("main", "Merge remote-tracking branch 'origin/main' into feat");
      expect(ignore({ VERCEL_ENV: "preview", VERCEL_GIT_PREVIOUS_SHA: last })).toBe(1);
    });

    it("builds on the branch's first preview (no base) when the branch has code", () => {
      commit("apps/f.ts", "f", "branch code");
      merge("main", "Merge branch 'main' into feat");
      expect(ignore({ VERCEL_ENV: "preview" })).toBe(1);
      expect(ignore({ VERCEL_ENV: "preview", VERCEL_GIT_PREVIOUS_SHA: "deadbeef".repeat(5) })).toBe(1);
    });

    it("builds a first preview (no usable base) even when main brought only docs", () => {
      git("checkout", "-q", "main");
      git("reset", "-q", "--hard", "HEAD^");
      commit("docs/only.md", "o", "main docs");
      git("checkout", "-q", "feat");
      commit("apps/f.ts", "f", "branch code");
      merge("main", "Merge branch 'main' into feat");
      expect(ignore({ VERCEL_ENV: "preview" })).toBe(1);
      expect(ignore({ VERCEL_ENV: "preview", VERCEL_GIT_PREVIOUS_SHA: "deadbeef".repeat(5) })).toBe(1);
    });

    it("builds a first preview whose last commit is docs-only", () => {
      commit("apps/f.ts", "f", "branch code");
      commit("docs/notes.md", "n", "branch docs");
      expect(ignore({ VERCEL_ENV: "preview" })).toBe(1);
    });

    it("builds a merge whose message names main but whose tree was edited by hand", () => {
      const last = commit("docs/notes.md", "n", "branch docs");
      git("merge", "-q", "--no-commit", "main");
      writeFileSync(path.join(dir, "apps/m.ts"), "edited during the merge");
      git("add", "-A");
      git("commit", "-q", "-m", "Merge branch 'main' into feat");
      expect(ignore({ VERCEL_ENV: "preview", VERCEL_GIT_PREVIOUS_SHA: last })).toBe(1);
    });

    it("builds a merge of a branch other than main", () => {
      const last = commit("docs/notes.md", "n", "branch docs");
      merge("main", "Merge branch 'other' into feat");
      expect(ignore({ VERCEL_ENV: "preview", VERCEL_GIT_PREVIOUS_SHA: last })).toBe(1);
    });
  });
});
