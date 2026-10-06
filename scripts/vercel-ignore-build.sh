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

docs_only() {
  git diff --quiet "$1" "$2" -- . ':!docs' ':!README.md' ':!CLAUDE.md' ':!AGENTS.md' ':!LICENSE'
}

if docs_only "$base" HEAD; then
  echo "ignore-build: only docs changed since $base; skipping"
  exit 0
fi

# A preview whose newest commit only merges main into the branch: main's side
# was built and checked by its own production deploy, and the branch's side
# (its first parent) changed nothing but docs since the last preview. Skipped
# only when git merged cleanly; a merge with resolved conflicts ("Conflicts:"
# in the message) builds. The production deploy after the pull request merges
# still runs every check on the combined code.
if [ "$VERCEL_ENV" = "preview" ]; then
  # shellcheck disable=SC2046
  set -- $(git rev-list --parents -n 1 HEAD 2>/dev/null)
  subject=$(git log -1 --format=%s HEAD 2>/dev/null)
  if [ $# -eq 3 ] \
    && printf '%s\n' "$subject" | grep -Eq "^Merge (remote-tracking )?branch '(origin/)?main'|^Merge (origin/)?main( |$)" \
    && ! git log -1 --format=%B HEAD 2>/dev/null | grep -q '^# Conflicts:' \
    && git cat-file -e "$2^{commit}" 2>/dev/null \
    && docs_only "$base" "$2"; then
    echo "ignore-build: preview commit only merges main into the branch; skipping"
    exit 0
  fi
fi
exit 1
