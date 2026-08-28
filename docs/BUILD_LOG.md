# Build Log

Newest entries at the top. Measured numbers, choices made, skipped items, and questions for Jake.

## Questions for Jake

*(none blocking — FYI items below)*

- **Credentials in the build environment**: this remote session has no `.env.local`; `AI_GATEWAY_API_KEY`, `FANTASYPROS_API_KEY`, `WEB_SEARCH_API_KEY`, `RESEND_API_KEY`, `COMMISSIONER_PASSWORD`, `SESSION_SECRET`, `CRON_SECRET`, and BYOK keys are only in Vercel. Build/tests that need them run against preview deployments (M3 smoke tests, M4 mock draft, M7 alarm email). If you want them runnable locally in this session, add them to the session environment; otherwise no action needed until M3.
- **FantasyPros free-tier measurement** (§5.7/5.8 verify) requires the key — will run the counted probe suite at M4 and record in VERIFIED.md.

## 2026-08-28 — Preview deploys were failing; fixed

Every preview build of the branch errored with:

> The pattern "apps/web/app/api/cron/tick/route.ts" defined in `functions` doesn't match any Serverless Functions.

The `functions` block in `vercel.json` cannot resolve those paths in this layout: the build command runs at the repo root while the app lives in `apps/web`, so Vercel looks for the pattern relative to the app it built and finds nothing. It was also unnecessary:

- the tick route already sets `export const maxDuration = 800` (route segment config, which Vercel honours), and
- the Workflow SDK generates its step and flow routes with `maxDuration: "max"` in `app/.well-known/workflow/v1/config.json`.

So §4.1's requirement is met without the glob, and the block is gone. **Lesson recorded: a green local `next build` does not mean a green Vercel deploy** — `vercel.json` is only interpreted by Vercel. Deploys are now checked on every push.

## 2026-08-28 — Go-live status (SPEC §17)

What is done, what needs Jake, and what needs the season to start. Nothing below is blocked on code.

### Done in this session
- [x] Migrations applied automatically on every deploy (build script), so production and preview each migrate their own database.
- [x] Cron tick every minute, protected by `CRON_SECRET`; `/admin/health` shows its last success.
- [x] Scoring fit verified and recorded (`docs/VERIFIED.md`) — the strongest verification available: all 18 weeks of 2025.
- [x] All 12 model IDs verified against the live gateway catalog; two corrected. `model_prices` seed captured.
- [x] Commissioner password login, signed cookie, admin routes guarded in `proxy.ts`, server actions re-check auth themselves.
- [x] `docs/RUNBOOK.md` written: re-run a job, swap a model, correct a score, recover from a dead feed.
- [x] Security properties from §15.5 enforced as tests, not just intentions.
- [x] The app builds with no database reachable, so a database blip cannot fail a deploy.

### Needs Jake (credentials or console access)
- [ ] **Confirm the environment variables in Vercel** for Production and Preview — every name is in `.env.example`. `DATABASE_URL` should already be there from the Neon integration.
- [ ] **Attach the custom domain** and set `SITE_DOMAIN` (the agents' web tools block it).
- [ ] **Enable Neon backups/PITR.**
- [ ] **Provider accounts for BYOK** (§8.9, §17): OpenAI data sharing on, xAI data-sharing credit visible, Google Cloud trial with a Vertex service account. Then `BYOK_*` in Vercel. The routes are already configured; a model with no credential simply bills the gateway.
- [ ] **Confirm whether the Google Cloud trial credit covers Anthropic models on Vertex.** Until it does, Sonnet stays on the gateway — deliberately, per §8.9.

### Needs a preview deploy (code is ready; these are runs, not builds)
- [ ] Smoke test per model (§8.1) — the `smoke` session kind and the admin button exist.
- [ ] FantasyPros free-tier measurement (§5.7/5.8) — daily cap and truncation counts, recorded in VERIFIED.md before the mock draft.
- [ ] Rankings pull fresh, ≥ 200 ranked players, no unmatched player in the top 200 — `/admin/rankings` shows the gate and `startDraftAction` refuses below it.
- [ ] Mock draft on a temporary Neon branch (§15.2), then delete the branch.
- [ ] One test alarm and one test digest to `ALERT_EMAIL_TO`.
- [ ] One session per BYOK-routed model showing `billed_to = byok:<provider>` in the ledger.

### Then
- [ ] Onboarding sessions, draw the order, start the draft — all buttons on `/admin/draft`.

## 2026-08-28 — M1 through M4 built; M5/M6 in progress

**Test suite: 266 tests green** across 22 files (`pnpm test`), lint and typecheck clean in every package.

### M1 — Engine core (complete)
- Full §6 schema (32 tables) with one generated migration; every league write goes through an engine function that validates, applies, records a transaction, and emits events inside one database transaction.
- `setLineup` returns *all* §7.1 violations at once (25 tests), waivers implement the §7.2 rolling-priority loop exactly (26 tests), the trade lifecycle covers freezes, reservations, votes, the deadline and ghost entries (14 tests), schedule/standings/playoffs (32 tests), optimal lineup, scoring and carry-over (21 tests), plus board/scratchpad/log/name writes.
- **Optimal lineup is an exhaustive backtracking search, not greedy.** Greedy per-position selection is wrong whenever a player carries several `fantasy_positions` (Sleeper does this constantly), which §7.7 anticipates by asking for exhaustive search. Verified against an independent brute-force solver on 250 random rosters.
- Two defects found by the M1 test review and fixed: head-to-head standings tiebreaks were applied inside a sort comparator (non-transitive when a tied group is not fully connected, so the order depended on the sort implementation — now grouped and sorted per group), and `seedPlayoffs`/`advancePlayoffs` wrote league state without recording a transaction, against the standing rule.

### M2 — Data and scoring (complete)
- Sleeper (players, trending, weekly/season stats, projections), nflverse (schedule + weekly stats for the audit and the scoring ladder), FantasyPros client with a 1 rps limiter, global daily cap, normalized-URL cache and the 3-per-ET-day per-agent allowance.
- **Scoring fit verified against all 18 weeks of 2025** (6,053/6,057 exact) — see VERIFIED.md. Appendix A was right except `pts_allow_14_20` (0, not 1) and a missing `idp_blk_kick` (2).
- FantasyPros→Sleeper mapping per Appendix B, tested against the real cached player pool.

### M3 — Agent runner (complete apart from the live smoke test)
- All 38 tools (17 read, 13 write, 3 draft, 6 reporter) as zod-schema'd definitions that re-validate their own arguments; per-kind tool sets asserted against the §8.6 tables, including that a team agent can never read another team's scratchpad or transcripts.
- Session loop per §8.2 with both loop guards, the ceiling nudge, the five-invalid-call nudge, the closing rules per kind, full transcripts, and a spend-ledger row per model step.
- **No model-side limits anywhere**: no `maxOutputTokens`, no temperature, no reasoning or effort flag. Anthropic cache breakpoints on the stable prefix; other providers cache prefixes themselves.
- BYOK routing per §8.9 with provider pinning, verified against the live gateway option schema.

### M4 — Draft (workflow complete; mock draft pending credentials)
- Snake order, inline draft sessions against the 180-second clock, §10.4 auto-pick with position caps and the must-fill-starters rule, pause/resume that preserves the remaining clock, and crash-safe resume.
- FantasyPros rankings ingest with the §5.7 merge rule and per-call counts for the truncation gate.

### M5/M6 — Website and scheduler (in progress)
- Scheduler tick, job dispatch, week planning with kickoff windows, the §13.4 finalization ladder, the weekly digest, commissioner auth (signed cookie checked in `proxy.ts`), and the draft state API are built.
- Public pages, admin pages, benchmark and spend pages are being written now.

### Still outstanding
- Live smoke tests per model, the mock draft, and the simulated week all need credentials that live only in Vercel; they run against a preview deploy.
- `/spend` "paid cost" needs one real session per BYOK-routed model to confirm `billed_to` (§17).

## 2026-08-28 — Environment limitation: direct database access from the build sandbox

The remote build container reaches the outside world only through an HTTPS egress proxy. Two consequences, neither of which affects production:

- **Postgres over TCP (port 5432) is blocked**, so `postgres-js` / `node-postgres` cannot connect to Neon from here.
- **Neon's SQL-over-HTTP host** (`api.c-11.us-east-1.aws.neon.tech`) is not in the proxy allowlist, so the Neon HTTP driver returns 403 from here. (The Neon MCP connector reaches the same database by a different path and works fine, which is how infrastructure was inspected.)

Decisions:
- `packages/engine/scripts/migrate.ts` uses Neon's HTTP driver and is wired into `apps/web`'s `build` script, so **every Vercel deploy applies migrations before `next build`**. That is the right production path regardless of the sandbox: preview deploys migrate the branch database, production migrates `main`.
- Engine and data tests run against **PGlite** (in-memory Postgres) with the real migration files, so schema and rules are fully covered without a network database.
- If Jake wants live database work from a future Claude session, adding `api.*.neon.tech` to the session's egress allowlist is all that is needed.

## 2026-08-28 — Session start: recon, docs, plan

- Read SPEC.md v1.8 in full (twice). Kit files were not yet in the repo (starter Next app only); copied `docs/SPEC.md`, `docs/fantasypros_v2_public.yaml`, standing-rules `CLAUDE.md` (keeping the repo's `AGENTS.md` Next 16 warning via `@AGENTS.md`), wrote `.env.example`, monorepo `.gitignore`, `docs/PLAN.md`, `docs/VERIFIED.md`, this log.
- **Environment**: remote build container. Node v22 local (Vercel project is 24.x — CI will use 24; engines field set accordingly). pnpm 10.33. Git branch for all work in this session: `claude/agent-fantasy-football-fe0inf` (remote session's designated branch; milestone PRs open from it).
- **Network**: initially `api.sleeper.app`, `api.sleeper.com`, `ai-gateway.vercel.sh` were blocked by the session egress policy; Jake widened access mid-session — all reachable now. FantasyPros reachable (403 without key, as expected).
- **Infrastructure confirmed live** (Appendix G): Vercel team `jake-moses-personal` (Pro), project `agent-fantasy-football-league` (`prj_k6qNYEikbH78EUElfZrdFSex8rfm`, Node 24.x, starter deployed READY on production). Neon project `small-unit-52703563` (Postgres 18, aws-us-east-1, free plan 512MB/branch). Neon + Vercel are also operable from this session through their MCP connectors (SQL, branches, deploy inspection) — used for migrations and mock-draft branch work.
- **Verified** (details in VERIFIED.md): all 12 gateway model IDs resolve; two corrected (`google/gemini-3.1-pro-preview`, `spacexai/grok-4.6` — xAI now under `spacexai/`). Catalog prices captured for `model_prices` seed.
- **Choices**:
  - Unit tests run against **PGlite** (in-memory Postgres) so `packages/engine` is fully testable with no server and no network; the same Drizzle schema runs on Neon PG 18 in deploys. Live-API tests are tagged and skipped when the key/fixture is absent (CLAUDE.md convention).
  - The starter app is Next 16.2.4 (React 19.2, Tailwind 4) — per `AGENTS.md`, Next 16 has breaking changes; I read `node_modules/next/dist/docs/` before writing any `apps/web` code (M3+/M5).
