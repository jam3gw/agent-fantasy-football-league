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

## Verify checklist (results recorded in docs/VERIFIED.md)
- [x] §8.1 Gateway model IDs — **done 2026-08-28**: 10/12 exact; `google/gemini-3.1-pro-preview` and `spacexai/grok-4.6` corrected. Prices captured for `model_prices`.
- [x] §3.2/App A `scoring_settings` fit — **done**: fitted against all 18 weeks of 2025 (6,053/6,057 exact). Two corrections to Appendix A.
- [x] §5.3 Sleeper weekly stats shape — **done** for 2025; re-verify against 2026 Week 1 in season.
- [x] §5.5 nflverse schedules URL and columns — **done**; the 2026 opener matches §3.7 exactly.
- [x] §3.6 Sleeper status vocabularies — **done**; IR-eligible defaults extended with the long forms Sleeper uses in `status`.
- [x] Next.js 16 breaking changes (AGENTS.md) — **done**; async request APIs, `middleware`→`proxy`, `revalidateTag` arity, Turbopack default, `next lint` removed.
- [x] §8.9 gateway BYOK option shape — **done**; `byok` and `only` confirmed against the installed gateway provider's types.
- [ ] §5.6 nflverse player-stats release naming — both known names are tried at runtime; confirm which responds for 2026.
- [ ] §5.7/5.8 FantasyPros free-tier daily cap and truncation counts — needs `FANTASYPROS_API_KEY`.
- [ ] §5.8 consensus-rankings default `type` behaviour — needs the key.
- [ ] §8.7 gateway cost field in provider metadata — needs a real gateway call; the code prefers it and falls back to the price table.
- [ ] §8.1 any provider that requires a max-output field — needs one real call per model.
- [ ] §13.2 Sleeper game-finished signal — currently 4.5 hours after kickoff plus the nflverse status; confirm in week 1.
- [ ] §8.9 whether the Google Cloud trial credit covers Anthropic models on Vertex — commissioner console; Sonnet is left on the gateway until then.
- [ ] App G Neon integration set `DATABASE_URL` in the Vercel project — confirm in Settings → Environment Variables.
- [x] §12.1 cache windows reach the CDN — **done 2026-08-28**, probed on the deployed preview: only `export const revalidate` works, and a dynamic segment needs `generateStaticParams` to be cached at all. Details in VERIFIED.md.
