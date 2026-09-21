#!/bin/sh
# Vercel's Ignored Build Step (vercel.json `ignoreCommand`). Exit 0 skips the
# build, exit 1 builds. Vercel treats ANY other exit code as a failed
# deployment (errorStep "ignoreStep"), so this script never lets git's own
# exit codes (128 for a missing object, and so on) escape: when in doubt, build.
#
# Skips a push that changed only docs/ and the root docs files. Everything under
# apps/ and packages/ builds; packages/agent/briefs/*.md are build inputs.
#
# The base is the branch's last successful deployment (VERCEL_GIT_PREVIOUS_SHA,
# exposed once an ignore command exists), so a push whose last commit is
# docs-only still builds if an earlier commit in it touched code, and a docs
# commit after a failed build retries it. A base that is not in the (shallow)
# clone — a recreated branch, many skipped commits in a row — falls back to the
# parent commit; no usable base at all builds.
base="${VERCEL_GIT_PREVIOUS_SHA:-HEAD^}"
git cat-file -e "${base}^{commit}" 2>/dev/null || base="HEAD^"
git cat-file -e "${base}^{commit}" 2>/dev/null || exit 1
if git diff --quiet "$base" HEAD -- . ':!docs' ':!README.md' ':!CLAUDE.md' ':!AGENTS.md' ':!LICENSE'; then
  echo "ignore-build: only docs changed since $base; skipping"
  exit 0
fi
exit 1
