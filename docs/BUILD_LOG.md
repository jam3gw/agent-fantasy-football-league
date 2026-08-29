# Build Log

Newest entries at the top. Measured numbers, choices made, skipped items, and questions for Jake.

## Questions for Jake



*(none blocking — FYI items below)*

- **Credentials in the build environment**: this remote session has no `.env.local`; `AI_GATEWAY_API_KEY`, `FANTASYPROS_API_KEY`, `WEB_SEARCH_API_KEY`, `RESEND_API_KEY`, `COMMISSIONER_PASSWORD`, `SESSION_SECRET` and `CRON_SECRET` are only in Vercel. Build/tests that need them run against preview deployments (M3 smoke tests, M4 mock draft, M7 alarm email). If you want them runnable locally in this session, add them to the session environment; otherwise no action needed until M3.
- **FantasyPros free-tier measurement** (§5.7/5.8 verify) requires the key — will run the counted probe suite at M4 and record in VERIFIED.md.

## 2026-08-29 — Agent-scheduled check-ins (§8.10, new)

Jake asked for it; spec'd as §8.10 and built. An agent can book its own
follow-up — "check whether Achane practised before I commit to the FLEX" — and
the reason it writes becomes that session's brief.

The plumbing was already there: since the queue rework, a queued session row
with `due_at` **is** the queue, so a check-in is an ordinary session the tick
starts like any other. Nothing new runs it.

What "just a tool" actually meant, in the end: three agent-facing tools
(`schedule_check_in`, `cancel_check_in`, `list_check_ins` — without the last
two an agent cannot see or undo what it booked, and will duplicate), a session
kind, a loop-guard entry, a tool set for the kind itself, a brief, sweeper
priority, an engine module owning the limits, and a spec section.

The limits are the design, and they live in the engine rather than the tool so
they hold however a check-in is created: 3 pending, 5 a week, 30 minutes'
minimum lead, a 14-day horizon, and no check-in may book another. Each is the
answer to a failure I expect from a model rather than a hypothetical — an
anxious agent booking twenty, a chain that never terminates, and "come back in
one minute" as a way around the tool-call ceiling.

Two design calls worth recording:

- **A check-in may act, but not initiate.** It can set the lineup, work the
  wire, and answer a trade — that is why it was booked. It cannot propose a
  trade or post to the board, which have their own windows and their own
  limits. So a check-in can never become a second weekly review.
- **It is always started last.** The league's schedule outranks anything an
  agent scheduled for itself; a check-in must never take the slot a lineup
  check needs before kickoff. Tested by booking the check-in *first* and due
  *first*, so ordering by age alone would start it — the test fails without
  the priority sort, which I verified rather than assumed.

**This changes what the benchmark measures**, and §8.10 says so plainly: the
number of sessions is now partly a choice, so cost per point and cost per win
measure foresight and self-restraint alongside football judgment. It is
deliberate, it will be stated on `/about` and `/benchmark`, and it forces a
scheduling constraint — **the feature has to be in before week 1 or not at all
this season**, because introducing it mid-season makes the season's own weeks
non-comparable.

Still to do for this feature: the `/about` and `/benchmark` copy, and the
per-kind row on `/spend` (the kind is already in the ledger, so it appears
there; what is missing is naming it as self-scheduled).

Test suite: **399 tests green**, 23 of them new.

## 2026-08-29 — Merged to `main`; production is live

`main` fast-forwarded from the starter commit to `a6ae4e4` — 45 commits, four
review rounds. CI green (run 17), and the production deploy verified by probe
rather than assumed:

- Build: `migrations applied` → `seed complete` → 37 pages, no errors, 47 s.
- Every public route answers 200 with `x-vercel-cache: HIT` or `PRERENDER`, so
  §12.1's freshness windows are in force on the production CDN.
- The seeded league renders: all twelve models on `/about`, twelve teams in the
  standings, on a database nobody touched by hand.

Production and preview each migrate and seed their own Neon branch, so this ran
against `main` (`br-restless-field-av8feznp`) for the first time.

**Still gated on Jake**, unchanged by the merge: the custom domain (Vercel SSO
covers everything except custom domains, so the public site is not reachable
until it is attached), the environment variables for Production, and Neon
backups/PITR.

## 2026-08-29 — Fourth review round (max effort, ten finder angles)

Round 4 read round 3's own fixes. Four of them were wrong or incomplete, and
two of those reopened the very bug round 3 was written to close. All fixed;
384 tests green.

**The reclaim had no counterpart on the runner side.** Round 3 made idleness
the only test for a stuck session, but every status write in `runSession`
still keyed on `sessions.id` alone. So the tick could fail a session, hand its
team's slot to the next one, and the original invocation would then write
`succeeded` straight over the reclaimed row — the reclaim erased, the duplicate
run invisible, exactly the "overwrites the row seconds later leaving no trace"
outcome round 3 described and believed it had fixed. The three status writes
(`running`, terminal, catch) now carry a status predicate, and a session whose
row was reclaimed returns without a single model call.

**Fifteen minutes was under the platform's own step cap.** The step budget is
9 minutes and is only checked *between* model calls, so a call starting at 8:59
runs to the 800-second kill — and §8.1 forbids capping a call. That left ~100
seconds before the reclaim fired, and nothing at all for the workflow runtime's
retry backoff. The idle cutoff is now 30 minutes.

**And the per-row heartbeat that bought those fifteen minutes was too
expensive.** Round 3 bumped `updated_at` after every transcript row: a 120-call
weekly review writes ~285 rows, so ~285 extra round trips and row versions on
the hottest tuple in the schema, and ~90 of them inside a draft pick's
180-second clock. The bump is now once per model step, immediately *before* the
call — which is the only span that writes nothing, and therefore the only span
the reclaim needs covered.

**A failed `start()` no longer stalls the league.** Round 3 was right that
requeueing is unsafe, but leaving the row `running` for the full idle window
meant a systematic start outage burned one of the six slots per tick: six
minutes of outage, then nothing in the league starts for the rest of the
window. The reclaim now has a second, short cutoff for a claimed row that has
written no transcript row at all — a workflow that was accepted writes its
first row in seconds, so five minutes cleanly separates "never started" from
"mid model call".

**The draft-pick exclusion was on the query, not the decision.** It therefore
also removed draft picks from the deadline-expiry branch — the only place in
the repo that retires a queued session. An orphan queued pick (the workflow
dying in the exact window round 3 described) would have sat `queued` for the
season. The `continue` moved to the start decision. `requeueFailedSessions`
also stopped minting queued `draft_pick` retries the tick refuses to start: the
draft owns its own retries through `nextAttemptNumber` and auto-pick.

**The pre-season week exclusion never fired for onboarding.** The caller's
context was spread *after* the conditional, and `runOnboardingAction` passes
`week` explicitly — so twelve onboarding sessions still landed in week 1, which
is what the change existed to prevent. Only `draft_pick` was actually excluded,
by the accident of its caller not passing a week. The exclusion now runs last,
`PRE_SEASON_KINDS` is typed `Set<SessionKind>` (a renamed kind is a compile
error, not a silent regression) and exported, and `/spend`'s "plus the draft"
line reads it instead of repeating the two kind names.

**Un-stamping the draft broke the reporter's week filter.** `list_sessions`
treated a missing week as "matches every week", which was harmless only while
every session had one. All 168 draft picks were matching every week query.

Also: `parseDate` lifted to `@league/shared` — `/admin/health`'s new queue card
had its own copy without the NaN guard, and `formatEt` throws `RangeError` on
an Invalid Date, so one malformed context timestamp would have 500'd the page
whose job is reporting outages. The card's two racing queries became one
(`inArray`), which also removes the duplicate React key when a session changes
status mid-render; the waiting predicate is written once instead of twice; the
cap in the title is `MAX_CONCURRENT_SESSIONS` rather than a literal `6`; and
the orphaned `createSession` docblock that still promised "the job that starts
it" is back on its function with that clause gone.

**Tests.** Eight new: both reclaim cutoffs separately, the never-started slot
release, draft-pick expiry, the no-draft-pick-retry rule, the pre-season week
rule (caller-supplied week included), and the reclaimed-row guard. Each was
checked against the un-fixed code.

Two of round 3's own new assertions were vacuous and were rewritten. The "sets
no provider options at all" test called the step with `messages: []`, so nothing
is emitted per message and the check passed whatever the code did — and
`billedTo: "gateway"` has been a hardcoded literal in `modelStep.ts` since
before round 3, so both of its gateway tests passed unchanged against the
un-fixed tree, contrary to what round 3 recorded. They now run against real
messages, and prompt caching (§8.1, "Prompt caching on") has its first test at
all: `withCaching` must put an Anthropic breakpoint on the system prompt and the
brief and on nothing after them. The ledger-level `billed_to` assertion round 3
deleted is back alongside the step-level one — `recordSpend` is what writes the
column that `/spend`, `/spend/[slug]` and `/benchmark` all filter on.

**Questions for Jake.** None blocking.

**Open, not fixed here.** `docs/VERIFIED.md` (BYOK notes) and `docs/SPEC.md`
§1175's go-live checklist still describe `byok_routes` and a `billed_to =
byok:<provider>` check, which the 2026-08-28 gateway-only decision made
unsatisfiable. That is a docs edit against a fixed §2 decision, so it is queued
for the M8 doc pass rather than done mid-review.

## 2026-08-29 — Third review round

Round 3 read only round 2's fixes and the two commissioner changes. It found
one high-severity gap and a set of real medium ones. All fixed.

**The sweeper could start a draft pick.** `runDraftPick` commits the session
row `queued` and only then runs it inline against the 180-second clock; in the
few round-trips between, a tick could claim it and start a second copy. Two
model calls racing `make_pick`, and whichever loses ends without a pick and
gets auto-picked — on a clock nobody can redo, roughly 168 chances per draft.
The sweeper now skips `draft_pick` entirely: the draft workflow owns those.

**`reclaimStuckSessions` could have killed a live session.** It failed a
`running` session that was past its deadline and had not been touched for
fifteen minutes — but `sessions.updated_at` was only bumped by a status write
or a ledger row, and a turn spent on free tool calls (`web_search` and
`read_url` are seeded at $0) writes neither. A session doing eight searches
goes ten minutes silent; a session running its closing step is past its
deadline by definition. The tick would have failed it, the live invocation
would have overwritten the row `succeeded` seconds later leaving no trace, and
in between the sweeper would have started a second session for that team — the
one-per-team breach round 2 had just closed. Now every transcript row bumps
`updated_at`, and idleness alone is the test: fifteen minutes without writing
anything is dead whatever the deadline says. Failing rather than skipping is
also what lets §8.8 retry it, which the comment claimed and the old condition
made impossible.

**The compensation for a failed `start()` could itself make two runners.**
`start` can throw *after* the workflow was accepted — a timeout reading the
response — and putting the row back in the queue then gives it a second
runner. The row stays `running`; the reclaim path owns it.

**The session queue had become invisible.** `session.run` rows were the only
place a pending session showed up in the admin UI, and removing them left
nothing anywhere selecting queued sessions. `/admin/health` now has a card:
running out of six, queued, and how many are waiting for a slot.

**The draft is out of the weekly totals again.** Defaulting `context.week` for
every kind put fourteen pick sessions plus onboarding into week 1, which would
have tripped the $40 weekly alarm for every agent on draft day. The pre-season
kinds keep their "no week" meaning; §8.7 counts them under "plus the draft".

Also: the ending-tool check moved ahead of the deadline check, so a session
that already published is not recorded `skipped` when its window closes;
`ModelStepRequest.providerOptions` and an orphaned BYOK doc comment removed;
three pieces of admin and module text that still described the `session.run`
job corrected.

**Tests.** The review was right that the riskiest lines of round 2 shipped
uncovered and that one of my assertions was vacuous. Added: the unpaired
tool-call repair, the ending-tool early exit, the invalid-call flag round-trip,
both halves of the reclaim condition separately, and the draft-pick exclusion.
The gateway assertion now runs against `createModelStep`'s own output rather
than restating a test helper's input. Each new test was checked against the
un-fixed code: three of them fail without it.

**One-off worth knowing.** Transcript rows written before this deploy carry no
`invalid` flag, so a session resumed across the deploy counts its past invalid
calls as ordinary ones — the five-invalid-call nudge would not fire for it.
Only affects sessions in flight at deploy time.

Test suite: **376 tests green**.

## 2026-08-28 — Second review round: a critical bug in the first round's own fix

The reviewer read only the fixes, and found that one of them was worse than
what it replaced.

**Critical, and mine.** Adding the tick's queued-session sweeper without
removing the `session.run` job left **two starters for every session**. In one
tick: the job's workflow started session 42, then the sweeper — seeing it still
`queued` — claimed it and started it again; and because the resume path treats
`running` as "carry on" rather than "refuse", neither run backed off. Two loops
ran the same session at once: duplicate model calls, doubled cost, interleaved
transcript rows, and duplicate *writes* — two board posts, two trade proposals
against the three-a-day limit, two waiver-claim replacements. On essentially
every booked session. The queued session row is now the queue: `createSession`
books no job, the sweeper is the only starter, and `session.run` means "this is
due now". `due_at` moved into the session context so the stagger still holds.

The rest of the round, all real:
- The sweeper stopped the whole sweep when a session could not get a slot, but
  that also happens when *that team* is busy — so one team's 90-minute session
  idled five free slots behind it and every lineup check queued after it was
  skipped at kickoff. `claimSlot` now says why it refused.
- A session left `running` by an invocation that died held its slot, and blocked
  its team, forever. The tick reclaims one that is past its deadline and has
  written nothing for fifteen minutes.
- The new week rollup attributed a step through `sessions.context.week`, which
  `createSession` omitted for exactly the event-driven kinds — trade responses,
  votes, board replies, injury responses. By the spec's own weekly mix that is
  roughly 40% of a week's spend missing from `/spend` and from the alarm the
  same commit was fixing. Every booking now carries its week.
- The nflverse audit compared against `engine_pts`, which is 0 on a week scored
  by FantasyPros — so the exact §13.4 scenario it exists for would have logged a
  discrepancy for every player. It compares against the points that scored the
  week. The §3.2 fit check had the same problem from the other end and now only
  runs on Sleeper-scored rows.
- The read breaker treated `ECONNRESET` as an outage. That is how a pooler drops
  an idle connection — one of them would have blanked the home page, and ISR
  would then have cached the empty render for five minutes.
- Two of my new audit tests were vacuous (`toBeGreaterThanOrEqual(0)`, and a
  loop over a list that was always empty) and one made real calls to Sleeper.
  Rewritten to assert exact counts against a stubbed feed.
- The §15.4 test re-implemented the sweeper instead of calling it, which is why
  it could not see either of the two bugs above. It drives the real one now, and
  seven new tests cover exactly-once starting, head-of-line blocking, the
  stagger, deadline expiry and reclaiming.
- Smaller: a resumed session repairs tool calls whose results were never
  written (every provider rejects an unpaired call) and stops immediately if the
  ending tool already succeeded; invalid-call counts are recorded rather than
  inferred; a waiver resubmission with nothing valid in it keeps the previous
  list; `claimSlot` uses the league clock.

**A process note worth keeping.** I had been running `pnpm -s typecheck`, and
`-s` silences the per-package output — so packages with type errors reported
green to me. Two real errors were hiding behind it, and a missing export that
only `next build` caught.

Worse: **CI had been failing on it and I had not looked.** Runs 11, 12 and 13
on this branch are all red, for exactly those three commits — the root
`pnpm typecheck` exits non-zero correctly, so the pipeline was right and my
local invocation was wrong. I had been checking the Vercel deploy after each
push (which passed, because Vercel does not run the typecheck) and not the
GitHub Actions run. Run 14 is green. Both are checked after every push from
here on, and checks are run unsilenced.

Test suite: **368 tests green**.

## 2026-08-28 — Commissioner's decisions: gateway-only billing, and schema+seed on every deploy

**Everything bills the AI Gateway.** Jake's call, superseding §8.9's BYOK
routing. Removed: `DEFAULT_BYOK_ROUTES`, `ByokCredentials`,
`byokCredentialsFromEnv`, `gatewayCallOptions`, the `providerOptions.gateway`
BYOK/`only` payload, and every `BYOK_*` variable from `.env.example`.
`spend_ledger.billed_to` keeps the column §6 defines and always reads
`gateway`, so the ledger stays comparable if this is ever revisited, and
`/spend` and `/benchmark` no longer talk about a provider account absorbing
cost. §8.9 in the spec is marked superseded rather than deleted.

What this buys: one price list, one balance to watch, and no provider
credential that can expire mid-season and silently reroute a model at a
different price. What it costs: the free provider credits in Appendix F go
unused. Three items drop off the go-live list — the OpenAI, xAI and Google
Cloud provider accounts, and the open question about whether the Vertex trial
credit covers Anthropic models.

**The schema was already applied by the Vercel build; the data was not.** Every
deploy has run `pnpm --filter @league/engine migrate` before `next build` since
M1 — the build log for each deploy says `migrations applied` — so no schema is
ever applied by hand. But the build log also said, thirty times per deploy:

    [page query failed] league_settings singleton missing — initLeagueSettings was never run

The schema was there and the league was not. `apps/web/scripts/seed.ts` now runs
between the migration and the build, and is create-if-absent throughout: the
settings singleton, the twelve teams (name left null — the agent names its own
in onboarding), the model price seed, the default alarm rules, and the tool
costs. Nothing it writes overwrites anything the league or the commissioner has
since changed, so re-running it on every deploy is a no-op. A preview branch, a
restored backup or the first production deploy now comes up as a complete
league with nobody touching it, which is what §2's "no manual data entry" asks
for.

## 2026-08-28 — Independent review before merge: findings and fixes

A reviewer with a fresh context read the whole branch against SPEC.md. It found
one state-corrupting bug and a set of real contradictions; all are fixed, each
with a test that fails without the fix. What it found, and what changed:

**Critical.** `trade.vote_cast` and `trade.failed` shared a switch case with
`draft.completed`, so every vote on every trade ran the season setup: it rewound
`current_week` to `start_week`, cleared every player's `waiver_until`, and reset
the rolling waiver order to reverse draft order. Ten times per trade,
mid-season. The trade tests passed throughout because none of them looked at
settings or waivers afterwards — which is exactly why the regression test now
does.

**A session that lost the concurrency race waited forever.** Twelve lineup
checks were booked for the same instant; six lost the race for one of the six
slots, were left `queued`, and their jobs were marked `done`. Nothing ever ran
them, and the comment claiming the next tick would retry described code that did
not exist. The tick now sweeps queued sessions every minute — that is §9.2's
wait-for-slot — expiring the ones whose deadline passed, and the bookings are
staggered a minute apart. The slot check itself took no lock, so twelve starts
could all read "0 running": it is now one advisory-locked transaction that
counts and claims together. §15.4's criterion is now a test: twelve sessions
drain in two waves inside 45 minutes, never more than six at once, none left
behind.

**The `agent_week` alarm could never fire.** There was no `agent/week` rollup at
all, and the `league/week` row held the season total, so `/spend`'s per-agent
week column read $0.00 forever. Both periods now come from one pass over the
ledger, with a step's week taken from the session it belongs to rather than the
calendar. §15.1.12 had no test at all; it has twelve now.

**Other spec contradictions fixed**: the nflverse audit (§5.6, §13.3) did not
exist; `ingest.stats`, the game-day hourly `ingest.players` and the Sunday
`ingest.fp_injuries` were never booked; `waivers.run` and `reporter.*` ignored
§4.3's gating; waiver claims rejected the whole list on one bad claim instead of
per claim; `applyOptionalPause` was dead code reading a settings key the admin
form never wrote; `propose_trade` was stricter than the engine; the `exa` search
provider §14 allows threw; §8.1 context management was unimplemented.

**Security.** `get_trade` checked nothing, and trade ids are sequential, so any
agent could walk every open negotiation in the league and read its private
message. Offers in `proposed` are now visible only to the two teams in them.
Everything else the reviewer checked came back clean: no secret is committed,
logged, or returned; admin auth is layered (proxy, plus every server action
re-checking for itself — now asserted as a test); the cookie resists forgery.

**The 800-second step cap.** A session and the whole draft each ran inside a
single workflow step, against a 90-minute session deadline and a 1.5–4 hour
draft. Both would have been killed. Each draft pick is now its own step, and a
session stops cleanly between model calls when its budget runs out and resumes
from its transcript — which meant recording the assistant message and tool call
ids verbatim, so a resumed step replays exactly what the model saw. The tick
also stopped running heavy jobs inline: a 5 MB player ingest inside the
per-minute cron would starve the live score poll behind it.

**Known and accepted**, recorded rather than fixed:
- The commissioner cookie signs only its own expiry, so changing
  `COMMISSIONER_PASSWORD` does not invalidate outstanding cookies — rotating
  `SESSION_SECRET` does. Acceptable for a single-operator admin area.
- The public API's rate limit is per warm instance, so §12.1's 60/minute is a
  courtesy limit rather than a control. Vercel's own limits are the real one.

Test suite: **353 tests green**, up from 293.

## 2026-08-28 — §12.1 cache windows: the third attempt is the one that works

Probing the live preview showed every public page answering

    cache-control: private, no-cache, no-store, max-age=0, must-revalidate

after two attempts at setting the windows elsewhere. The rule, verified on the
deploy rather than reasoned about: **a page's own `Cache-Control` wins over
both `proxy.ts` response headers and `next.config` `headers()`**, and Next
writes `no-store` itself for any page rendered per request. So neither of the
first two places could ever have worked. `export const revalidate` — what
§12.1 asks for — is the only thing that makes the CDN hold a copy.

Going back to ISR means `next build` prerenders the pages, so an unreachable
database has to degrade fast instead of failing the deploy. Three things were
needed, and the first was the real culprit:

- **`backoff: () => 0` on the pool.** postgres-js backs off exponentially
  between reconnect attempts (`3^retries/100` seconds, capped at 20) and keeps
  the retry count *shared across the pool*, never resetting it until a
  connection succeeds. A page issuing a dozen reads therefore waited minutes,
  not seconds: `/`, `/spend` and `/standings` each blew through Next's
  60-second per-page budget and failed the build three attempts running.
- **A breaker in `safeRead`**: the first connection failure short-circuits the
  rest of that page's reads for five seconds, then closes on its own. The seven
  pages that each carried their own copy of the guard now share this one.
- **`DB_CONNECT_TIMEOUT_SECONDS`** so an environment with no database at all
  (CI) fails in a second rather than eight.

`next build` with no database now finishes in 23 s with every page rendering
its empty state, and the freshness windows are asserted in
`apps/web/test/caching.test.ts` so a future `force-dynamic` cannot silently
remove them.

**Deliberate deviation from §12.1**: `/transactions` and `/teams/[slug]` read
`searchParams` (type/team filters; the week selector) and so render per
request and are not shared-cached. A filtered view cannot be cached by path
alone, and moving the filters client-side would mean shipping the full
transaction list to the browser. Every other public page carries its window.

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
- [x] `next build` renders every page with no database reachable, so a blip during the render step cannot fail a deploy. The migrate and seed steps that run before it *do* require the database — a deploy that cannot reach its own database should not ship.

### Needs Jake (credentials or console access)
- [ ] **Confirm the environment variables in Vercel** for Production and Preview — every name is in `.env.example`. `DATABASE_URL` should already be there from the Neon integration.
- [ ] **Attach the custom domain** and set `SITE_DOMAIN` (the agents' web tools block it).
- [ ] **Enable Neon backups/PITR.**
- ~~Provider accounts for BYOK~~ — **dropped 2026-08-28**: everything bills the AI Gateway. Keep the gateway balance topped up; that is the only account that matters.

### Needs a preview deploy (code is ready; these are runs, not builds)
- [ ] Smoke test per model (§8.1) — the `smoke` session kind and the admin button exist.
- [ ] FantasyPros free-tier measurement (§5.7/5.8) — daily cap and truncation counts, recorded in VERIFIED.md before the mock draft.
- [ ] Rankings pull fresh, ≥ 200 ranked players, no unmatched player in the top 200 — `/admin/rankings` shows the gate and `startDraftAction` refuses below it.
- [ ] Mock draft on a temporary Neon branch (§15.2), then delete the branch.
- [ ] One test alarm and one test digest to `ALERT_EMAIL_TO`.

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
- ~~BYOK routing per §8.9~~ — removed 2026-08-28; every call bills the AI Gateway (see the entry at the top).

### M4 — Draft (workflow complete; mock draft pending credentials)
- Snake order, inline draft sessions against the 180-second clock, §10.4 auto-pick with position caps and the must-fill-starters rule, pause/resume that preserves the remaining clock, and crash-safe resume.
- FantasyPros rankings ingest with the §5.7 merge rule and per-call counts for the truncation gate.

### M5/M6 — Website and scheduler (in progress)
- Scheduler tick, job dispatch, week planning with kickoff windows, the §13.4 finalization ladder, the weekly digest, commissioner auth (signed cookie checked in `proxy.ts`), and the draft state API are built.
- Public pages, admin pages, benchmark and spend pages are being written now.

### Still outstanding
- Live smoke tests per model, the mock draft, and the simulated week all need credentials that live only in Vercel; they run against a preview deploy.

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
