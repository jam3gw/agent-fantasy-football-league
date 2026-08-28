# Build Plan — agent-fantasy-football-league

Maps each milestone (SPEC.md §16) to the packages, tables, workflows, routes, and tests it delivers. Acceptance criteria: §15. One designated dev branch (`claude/agent-fantasy-football-fe0inf`) in this remote session; small conventional commits; review loop per CLAUDE.md before merge to `main`.

## M1 — Engine core (`packages/engine`, `packages/shared`)
- **Packages**: `shared` (Clock, ET↔UTC helpers, ids), `engine` (pure TS, no Next.js imports).
- **Tables**: full Drizzle schema §6 + migrations (all tables land in M1 so later milestones never re-migrate core shapes).
- **Functions**: `setLineup` (§7.1), locks (§3.3, computed), `submitWaiverClaims`/`cancelWaiverClaims`/`runWaivers`/`addFreeAgent`/`dropPlayer` (§7.2), game-start waivers (§7.3), trades + votes lifecycle (§3.5, §7.5, ghosts), schedule generation (circle method, §3.7), standings + playoffs (§7.6), optimal lineup (§7.7), placement/carry-over (§7.8), transactions + events emitted in-transaction.
- **Tests**: §15.1.2–7 + carry-over/ghosts (§15.1.10) on PGlite (in-memory Postgres).

## M2 — Data + scoring (`packages/data`)
- Sleeper clients (players, trending, stats §5.3, projections §5.4), nflverse schedule + stats audit (§5.5–5.6), team-abbrev map, FantasyPros client generated from `docs/fantasypros_v2_public.yaml` with global limiter, cache, per-agent allowance (§5.8), scoring fit (§3.2, Appendix A) against 2025 W1–3 fixtures in `fixtures/`.
- **Tests**: §15.1.1, 8, 9, 11; live poll against fixture.

## M3 — Agent runner (`packages/agent`)
- Zod tool schemas (§8.4), shared system prompt (App C) + briefs (`briefs/*.md`), `runSession` loop (§8.2) as Vercel Workflow, loop guards (§8.3), context snapshot (§8.5), spend ledger per model step (§8.7), BYOK routing (§8.9), transcripts (`session_events`).
- **Acceptance**: smoke test per model (needs `AI_GATEWAY_API_KEY` — in Vercel env; run against preview deploy).

## M4 — Draft
- `ingest.fp_rankings` (§5.7), FP→Sleeper mapping (App B) + `/admin/rankings`, onboarding sessions, order draw, `draftWorkflow` (§10.2), auto-pick (§10.4), draft room page + `/api/draft/state`.
- **Acceptance**: mock draft (§15.2) on a temp Neon branch (needs FP + gateway keys).

## M5 — Website (`apps/web`)
- Public routes §12.1 (`/`, `/matchups/[week]`, `/teams/[slug]`, `/sessions/[id]`, `/board`, `/transactions`, `/waivers`, `/trades`, `/draft`, `/report`, `/benchmark`, `/spend`, `/players/[id]`, `/about`), admin §12.2, public JSON API + rate limit, commissioner auth (signed cookie).
- **Acceptance**: pages render from simulated data. (Next 16 — read `node_modules/next/dist/docs/` first; see AGENTS.md.)

## M6 — Scheduler
- `/api/cron/tick` (per-minute, `CRON_SECRET`), `scheduled_jobs` claim loop, recurring job table (§9.1), `weekPlanWorkflow` (windows, lineup-check booking), events (§9.3), live scoring loop (§13.2), `finalizeWeekWorkflow` + degradation ladder (§13.4).
- **Acceptance**: simulated week (§15.3) with `clock_override`, incl. finalization with Sleeper disabled → FP player-points.

## M7 — Reporter, benchmark, spend
- Reporter tools + workflow (§11), `team_week_results` metrics + `/benchmark`, spend rollups, alarm rules/eval/notify (email, banner, webhook), `/spend` + `/spend/[slug]`, weekly digest (§12.3).
- **Tests**: §15.1.12; a test alarm email arrives.

## M8 — Hardening → M9 — Go-live
- Retry/degradation paths, `/admin/health`, provider-outage detection, `docs/RUNBOOK.md`, load/timing (§15.4), security review (§15.5), §17 checklist.

## Verify checklist (record results in docs/VERIFIED.md)
- [x] §8.1 Gateway model IDs — **done 2026-08-28**: 10/12 exact; `google/gemini-3.1-pro-preview` (not `-pro`), `spacexai/grok-4.6` (xAI → `spacexai/` prefix). Prices + context captured for `model_prices`.
- [ ] §3.2/App A `scoring_settings` fit reproduces `pts_ppr` (2025 W1–3 fixtures)
- [ ] §5.3 Sleeper weekly stats shape (2025 now; re-verify 2026 Week 1)
- [ ] §5.5 nflverse schedules URL (reachable 2026-08-28; confirm columns)
- [ ] §5.6 nflverse player-stats release/file naming
- [ ] §5.7/5.8 FP free-tier daily cap + truncation counts (needs `FANTASYPROS_API_KEY`)
- [ ] §5.8 consensus-rankings default `type` behavior (needs key)
- [ ] §8.7 gateway cost field in provider metadata (needs gateway key, M3)
- [ ] §8.1 any provider requiring a max-output field (M3, per model)
- [ ] §13.2 Sleeper game-finished signal
- [ ] §8.9 Google trial credit applies to Anthropic on Vertex (commissioner console)
- [ ] App G Neon integration set `DATABASE_URL` in Vercel env
