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
# parent commit on production; no usable base at all builds.
base="${VERCEL_GIT_PREVIOUS_SHA:-HEAD^}"
git cat-file -e "${base}^{commit}" 2>/dev/null || base="HEAD^"
git cat-file -e "${base}^{commit}" 2>/dev/null || exit 1
# A preview with no usable previous deployment (a branch's first push, or a
# base outside the clone) builds: HEAD^ says nothing about the earlier commits
# of a first push, and for a merge it is the branch's own side.
if [ "$VERCEL_ENV" = "preview" ] && [ "$base" = "HEAD^" ]; then
  exit 1
fi

docs_only() {
  git diff --quiet "$1" "$2" -- . ':!docs' ':!README.md' ':!CLAUDE.md' ':!AGENTS.md' ':!LICENSE'
}

if docs_only "$base" HEAD; then
  echo "ignore-build: only docs changed since $base; skipping"
  exit 0
fi

# A preview whose newest commit merges main into the branch and leaves the
# branch's code identical to main's (it differs from the second parent, main's
# tip, only in docs): that code was already built and checked by main's own
# production deploy. The tree comparison, not the commit message, is what makes
# this safe: a merge that resolved conflicts or brought any code of the
# branch's own differs from main in code and builds. The subject check only
# makes sure the second parent is main and not some other branch.
if [ "$VERCEL_ENV" = "preview" ]; then
  # shellcheck disable=SC2046
  set -- $(git rev-list --parents -n 1 HEAD 2>/dev/null)
  subject=$(git log -1 --format=%s HEAD 2>/dev/null)
  if [ $# -eq 3 ] \
    && printf '%s\n' "$subject" | grep -Eq "^Merge (remote-tracking )?branch '(origin/)?main'|^Merge (origin/)?main( |$)" \
    && git cat-file -e "$3^{commit}" 2>/dev/null \
    && docs_only "$3" HEAD; then
    echo "ignore-build: preview commit merges main and its code equals main's; skipping"
    exit 0
  fi
fi
exit 1
