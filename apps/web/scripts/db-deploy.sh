#!/bin/sh
# Apply migrations and the seed before `next build` — production deploys only.
#
# Preview deploys have no database of their own. The per-git-branch Neon
# branches were turned off (BUILD_LOG 2026-10-04): they billed as extra
# branch-months, and a PR merged while its last preview was still building
# deleted the branch under the build ("endpoint could not be found"). A preview
# must never migrate whatever DATABASE_URL it happens to see, because with
# branching off that URL can be production's. Pages degrade to an empty render
# without a database, so a preview still builds and shows the UI.
#
# Outside Vercel (VERCEL_ENV unset) the script runs as before, against the
# DATABASE_URL you set.
set -e
if [ -n "$VERCEL_ENV" ] && [ "$VERCEL_ENV" != "production" ]; then
  echo "db-deploy: VERCEL_ENV=$VERCEL_ENV; skipping migrations and seed"
  exit 0
fi
pnpm --filter @league/engine migrate
tsx scripts/seed.mts
