@AGENTS.md

# agent-fantasy-football-league — standing rules for Claude Code

This repo is an agent-only fantasy football league: twelve LLM agents manage twelve teams for the 2026 NFL season, a public website shows everything, and the league is also a benchmark. You build, review, test, deploy, and operate it on your own. Jake is the commissioner; he does not review code.

## Sources of truth

- `docs/SPEC.md` — the implementation spec. Read it before any change. Section 2 is fixed; Sections marked **default** are settings; **verify** items need a recorded check.
- `docs/fantasypros_v2_public.yaml` — FantasyPros OpenAPI document. Generate types from it.
- `docs/PLAN.md`, `docs/VERIFIED.md`, `docs/BUILD_LOG.md`, `docs/RUNBOOK.md` — you keep these current.

## Autonomy

- You own the repo. Commit and push without asking. Merge your own pull requests after the review loop below passes. Never wait for Jake on a non-blocking question: pick the option closest to the spec, write it in `docs/BUILD_LOG.md`, and continue.
- Ask Jake only when a fixed decision in SPEC.md Section 2 conflicts with reality, or when a **verify** item fails and the spec gives no fallback. Put the question in `docs/BUILD_LOG.md` under "Questions for Jake" and keep working on everything else.
- All credentials are in `.env.local` locally and in the Vercel project. If one is missing, build and test everything that does not need it, note it in the build log, and move on.

## Review loop (every milestone, before merge)

1. Run lint, type check, and the full test suite. All green.
2. Spawn a reviewer with a fresh context. Give it the diff, `docs/SPEC.md`, and the milestone's acceptance criteria (SPEC.md Section 15). It must report contradictions with the spec, missing tests, unhandled cases, and security issues (secrets, auth on admin routes, public endpoints).
3. Fix every finding or record why not in the build log. Repeat step 2 until the reviewer reports nothing new.
4. For M3 and later, also run one real session end to end against the deployed preview and read the transcript.
5. Merge to `main`. Confirm the production deploy is healthy (`/admin/health`).

## Branches, deploys, data

- `main` is production. Vercel project `agent-fantasy-football-league` (team `jake-moses-personal`) deploys it on push. Milestone work happens on `m<N>-<name>` branches with Vercel preview deploys.
- Neon project `small-unit-52703563` (see SPEC.md Appendix G): branch `main` (`br-restless-field-av8feznp`) is production data; branch `dev` (`br-nameless-wildflower-av2oxeoe`) is for local work and CI; make a temporary branch from `main` for the mock draft and delete it afterwards. Never run a destructive migration or a data delete against production without a backup and a note in the build log.
- Keep `main` deployable at all times. A failing `main` is the top priority.

## Non-negotiables from the spec

- No model limits: no `maxOutputTokens`, no reasoning or thinking settings, no temperature. Provider defaults. Prompt caching on. Loop guards only (Section 8.3).
- Every league-state write goes through an engine function inside one transaction: validate, apply, record a transaction, emit events.
- No manual data entry anywhere. No file uploads. Finalization never waits for a person.
- Never commit, log, or return a secret. `.env.example` lists every variable.
- Same prompt, same tools, same information for all twelve agents.
- Costs are recorded per model step and shown on `/spend`; alarms notify, they do not stop sessions.

## Conventions

- pnpm monorepo, TypeScript strict, Node 24 (matches the Vercel project). `packages/engine` has no Next.js imports and is fully unit-tested.
- Small commits. Conventional messages (`feat(engine): rolling waiver priority`).
- Tests next to code. Fixtures in `fixtures/`. A test that hits a live API is tagged and skipped in CI unless the key is present.
- Times in `America/New_York` for schedules, UTC in the database, all reads through `Clock.now()`.
