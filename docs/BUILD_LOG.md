# Build Log

Newest entries at the top. Measured numbers, choices made, skipped items, and questions for Jake.

## Questions for Jake



*(none blocking — FYI items below)*

- **Credentials in the build environment**: this remote session has no `.env.local`; `AI_GATEWAY_API_KEY`, `FANTASYPROS_API_KEY`, `WEB_SEARCH_API_KEY`, `RESEND_API_KEY`, `COMMISSIONER_PASSWORD`, `SESSION_SECRET` and `CRON_SECRET` are in Vercel. `COMMISSIONER_PASSWORD` and `SESSION_SECRET` were confirmed live on 2026-08-29 (both were in fact missing until then, so this list is worth probing rather than assuming); `CRON_SECRET` is confirmed by the tick answering 200. The three third-party keys remain unverified from here. Build/tests that need them run against preview deployments (M3 smoke tests, M4 mock draft, M7 alarm email). If you want them runnable locally in this session, add them to the session environment; otherwise no action needed until M3.
- **FantasyPros free-tier measurement** (§5.7/5.8 verify) requires the key — will run the counted probe suite at M4 and record in VERIFIED.md.

## 2026-08-29 — Draft picks auto-fill the lineup by position

Jake's ask during the mock draft. A drafted player now fills his team's first
open eligible starting slot for the coming week (QB, RB1, RB2, WR1, WR2, TE,
FLEX, DST, K; bench only when nothing eligible is open), on both the agent
pick path and the auto-pick path, inside the same transaction as the pick.
`autofillDraftLineupSlot` in `packages/engine/src/lineup.ts`; recorded as a
carve-out under SPEC §3.1 — placement by arrival order is not the engine
choosing a starter. This also retires SETUP.md's "week 1 lineups have no
fallback" gap: the draft itself now produces a full legal lineup, and agents
rearrange with set_lineup. Landed after the mock draft ran (its rosters were
drafted to the bench, as before); verified by engine tests and the updated
make_pick test.

## 2026-08-29 — Team 2: Opus 5 replaced with Mistral Large 3

Slot 2 now runs `mistral/mistral-large-3` (was `anthropic/claude-opus-5`).
**Reason: the price point of Opus 5.** The mock draft's per-session measurements
put one Opus onboarding at $3.34 and its season projection at roughly $335 —
about half of the projected bill for the entire twelve-team league on one seat.
Mistral Large 3 prices at $2/$6 per M (~$16/season projected) and adds a lab
the league did not have.

Done so far:
- id verified against the live gateway catalog (`mistral/mistral-large-3`);
- swapped on the mock branch and re-onboarded there, so the full mock draft
  rehearses the final roster;
- `LEAGUE_MODELS` slot 2 and `MODEL_PRICE_SEED` updated in code (rides the
  mock-draft merge; the seed is `onConflictDoNothing`, so code and data cannot
  fight).

Production landed too, with Jake's explicit go-ahead after the session's
permission classifier blocked the first attempt: one transaction carrying the
`teams` update, the public `model_swapped` transaction, the commissioner-action
audit row, and the `model_prices` seed row. Verified after commit: team 2 reads
`mistral/mistral-large-3`.

## 2026-08-29 — Commissioner login works; both admin secrets confirmed live

`COMMISSIONER_PASSWORD` and `SESSION_SECRET` are both set and scoped to
Production. `/admin` is reachable. Verified from outside without the password:

| Probe | Answer | Means |
|---|---|---|
| `POST /api/admin/login`, wrong password | 303 | `COMMISSIONER_PASSWORD` is set |
| `GET /admin/health` with `<digits>.<junk>` cookie | 307 | `SESSION_SECRET` is set **and the forged signature was rejected** |
| `GET /api/admin/health`, same cookie | 401 | same, on the API branch |
| `GET /admin/health`, no cookie | 307 | proxy redirect, as designed |

The forged-cookie rows are the ones that carry weight: 500 would mean the
secret is missing, but 307/401 means `sign()` ran *and* the signature check
said no. A cookie that merely failed to throw would have been indistinguishable
from one that was accepted.

`/api/cron/tick` is 200 every minute across all four deployments in the window,
so the scheduler is alive and `/admin/health`'s banner has what it keys on.
Vercel's error table shows all three admin-secret error groups last occurring at
15:54:21 or earlier, on deployments already replaced — nothing since.

**It took two rounds, and the middle round is the lesson.** The first fix set
`COMMISSIONER_PASSWORD` only, and that made the *wrong*-password path return a
healthy-looking 303 while a correct password still answered 500 — visible in the
error table as one `SESSION_SECRET is not set` on `/api/admin/login` at 15:54:21,
which is a real login attempt with the real password failing. Anyone reading
that 500 without the stack trace would reasonably conclude the password was
wrong. The order in `login/route.ts` is why: `passwordMatches` returns first,
`issueCookieValue` signs on the next line, so the two secrets fail on opposite
branches of the same handler.

The cheap external check for a signing secret, worth keeping: send a
syntactically valid but bogus cookie (`<digits>.<junk>`). `verifyCookieValue`
returns early on a malformed value and never signs, so only the well-formed
shape reaches `sign()` and exposes whether the key exists.

## 2026-08-29 — Vercel Web Analytics on the public site

`@vercel/analytics` 2.0.1 added to `apps/web`, with `<Analytics />` mounted at
the end of `<body>` in `app/layout.tsx`, beside `<SpeedInsights />` — the App
Router placement from Vercel's quickstart. The `/next` entry is the one used:
it reads the router's params, so the eighteen weeks of `/matchups/[week]` are
one row in the dashboard rather than eighteen rows. The component is
`"use client"` and wraps itself in `Suspense` (it calls `useSearchParams`), so
the root layout stays a server component and no page loses static rendering.

- No new environment variable and no CSP to widen — the site sets none — and
  the beacon is same-origin under `/_vercel/insights/*`, which Vercel adds at
  the edge.
- **Unlike Speed Insights, this package does not no-op in development.** With
  `NODE_ENV` `development` or `test` it injects
  `https://va.vercel-scripts.com/v1/script.debug.js` instead of the same-origin
  script, which logs each view to the console and reports nothing to the
  project. So `next dev` makes one third-party request per page that production
  does not; nothing is recorded either way. The test suite never renders the
  layout, so it makes no request at all.
- **Verified on the branch preview**, not assumed. Web Analytics was already
  enabled on the project — Vercel's build injected the `analytics` key beside
  the `speedInsights` one the last session found, and it only writes that key
  when the feature is switched on:

  ```
  {"analytics":{"scriptSrc":"d90aa5d90e4aa1f2/script.js",
                "viewEndpoint":"d90aa5d90e4aa1f2/view",
                "eventEndpoint":"d90aa5d90e4aa1f2/event",
                "sessionEndpoint":"d90aa5d90e4aa1f2/session"},
   "speedInsights":{"scriptSrc":"c03b0126f6fa88a8/script.js",
                    "endpoint":"c03b0126f6fa88a8/vitals"}}
  ```

  That literal is inlined into the client chunk that carries the package
  (`139e764of_sum.js`), the RSC payload lists `"Analytics"` as a client
  reference exactly as it lists `"SpeedInsights"`, and on
  `league.jake-moses.com` both `/d90aa5d90e4aa1f2/script.js` and
  `/_vercel/insights/script.js` answer 200 with the same 2,495-byte script.
- So this has the same trap Speed Insights has: the path actually used is the
  obfuscated one, unguessable so that blocklists keyed on the literal string
  cannot match it, and it is appended after hydration rather than served in the
  HTML. Anything that greps a deploy's markup for "insights" will conclude,
  wrongly, that this is not installed.
- Reading the preview needed the deployment-protection bypass: the branch host
  302s to Vercel SSO, and `?_vercel_share=<token>` (the token is in that
  redirect's `location`) authenticates the first request and sets the
  `_vercel_jwt` cookie the `/_next/static/*` fetches then need. Without the
  cookie every chunk comes back as the 341 KB SSO page with a 200 — which reads
  as a successful download and greps as an empty result.
- `apps/web/test/analytics.test.ts` guards the import path and the
  render-once-inside-`<body>` placement, the same two silent failures the
  Speed Insights test guards: mounted deeper it misses pages, mounted twice it
  double-counts every view.
- **Confirmed in a browser on the merged production deploy**
  (`dpl_5BETqs1qqAR5daXnDdfxi5WDo8aG`), not by reading the bundle. Chromium
  shows `<script src="/d90aa5d90e4aa1f2/script.js">` appended, `window.va` a
  function, and `window.vam` `"production"` — so the mode detection resolves to
  production and not to the debug script. `window.si` is live alongside it;
  Speed Insights is unaffected.
  - The script request was **aborted in the browser** rather than allowed, so
    the pageview stayed queued in `window.vaq` (length 1) and nothing synthetic
    was written to the dashboard. That queue length is itself the proof the
    component fired.
  - Chromium still cannot reach a deployed host from this session — the egress
    proxy drops the tunnel (`ws_closed_mid_exchange`) while curl to the same
    host is fine, exactly as the Speed Insights session found. So production
    was mirrored (`prod.html` plus its eight `/_next/static/*` assets) and
    served from `127.0.0.1`, which `noProxy` covers.
- Lint, typecheck and the full suite (457 tests) green.
- Data starts when this reaches production. Nothing is backfilled, so the
  dashboard stays empty until then — as of today it reports 0 visitors and
  0 pageviews. The routes have been live on production all along; nothing was
  calling them.

## 2026-08-29 — All twelve models verified, and the benchmark cleaned of my own failures

Third smoke round, on the build with both prompt bugs fixed: **12 of 12 models
succeeded**, every one making 2 tool calls and ending on `write_decision_log`
rather than hitting a ceiling or a deadline. 6.2–12.5 seconds each, $0.05 for the
round.

| | reasoning tokens |
|---|---|
| DeepSeek V4-Pro | 222 |
| Gemini 3.1 Pro | 186 |
| Grok 4.6 | 104 |
| Qwen 3.8-Max | 69 |
| Kimi K3 | 63 |
| Muse Spark 1.2 | 62 |
| GPT-5.6 Terra | 24 |
| Fable 5, Opus 5, Sonnet 5, GPT-5.6 Sol, GLM-5.3 | 0 |

Average 61, max 222. §2 forbids setting any reasoning budget, so the open
question was whether provider defaults would run away on their own; on this task
they do not. The caveat is that a smoke test — one tool call and one line — is
too trivial to bound anything. Re-check on the first real weekly review, where
the work actually invites deliberation.

### Production data delete: 58 junk sessions

Backup: Neon branch `backup-pre-smoke-cleanup` (`br-wandering-scene-avqepb7d`),
taken from `main` immediately before. A snapshot was not possible — the free plan
allows one, and the existing `pre-0002-drop-fantasypros` snapshot is the restore
point for the migration, so overwriting it would have traded one backup for
another.

Deleted 35 `failed` and 23 `skipped` smoke sessions, with their 209
`session_events`, 23 `spend_ledger` and dependent `decision_logs` rows. Every one
was produced by my own broken deploys over the preceding hour — the two prompt
bugs above, plus `requeueFailedSessions` retrying each failure several times.

This is a correctness fix, not tidiness. `/benchmark` publishes a **sessions
failed** column per model, and the retry churn had distributed those failures
unevenly by pure accident of which cycle each landed in:

```
GLM-5.3          4 failed        Claude Fable 5   2 failed
nine others      3 failed        Gemini 3.1 Pro   2 failed
```

Left in place, a published benchmark whose stated purpose is comparing twelve
models would have recorded GLM-5.3 as the least reliable of them, on evidence
that is entirely an artifact of my deploy schedule. Every model now shows its
real result: one succeeded smoke session, nothing failed.

Verified afterwards: 0 orphaned events, ledger rows or decision logs; 12 teams,
12,225 players and 1,756 draft rankings untouched; no league state
(`roster_entries`, `transactions`) existed to touch — the season has not started.

## 2026-08-29 — The smoke test earned its place: no session could run at all

Ran the §8 pre-draft smoke test, one session per model. **All twelve failed, on
every provider, with the same error:**

```
AI_InvalidPromptError: Invalid prompt: System messages are not allowed in the
prompt or messages fields. Use the instructions option instead.
```

Identical across Anthropic, OpenAI and Google, in 3–4 seconds, zero tool calls,
$0 spent. That uniformity is the finding: not a bad model id, not a missing
gateway credit, not a provider quirk — our own call was malformed, so **no
session of any kind could have run**. Onboarding, the draft, weekly reviews,
waivers, the reporter: all of it, dead. The draft would have failed on the day.

**Cause.** `session.ts` builds the conversation as
`[{role: "system", …}, {role: "user", …}]`, which is the right shape for the
transcript and for `withCaching` to find its breakpoint, and `modelStep.ts`
handed that array straight to `generateText` as `messages`. AI SDK v7 (we are on
`ai@7.0.84`) rejects a system-role message inside `messages` outright.

**Fix.** `splitInstructions()` in `modelStep.ts` lifts system messages out and
passes them as the `instructions` option. Read off the installed
`ai@7.0.84` type declarations rather than guessed:
`type Instructions = string | SystemModelMessage | Array<SystemModelMessage>`.
The array-of-messages form is the one used deliberately — passing the prompt
text alone would have silently dropped the Anthropic `cacheControl` breakpoint
that rides on the message's `providerOptions`, turning prompt caching off across
the season without any error to notice. Caching is applied before the split for
the same reason: `withCaching` keys off position in the full list.

Two tests, both confirmed to fail against the un-fixed code before being kept:
the system prompt never appears in `messages` and is actually carried in
`instructions` (checked on three providers), and the cache breakpoint survives
the move.

**Why the suite was green through all of this.** Every test of the model step
passes a `generate` stub, so nothing in 452 tests ever exercised the real SDK's
prompt validation. A stub cannot reject what the real one rejects. The smoke
test is the only thing in the system that would ever have caught it, which is
exactly what §8's checklist puts it there for — and it caught it four days
before the draft rather than on the day.

### Second bug, found by re-running: the tool-result shape

With the system prompt fixed, the re-run got further and failed differently —
`tool_calls: 1`, a real cost recorded, and then:

```
AI_InvalidPromptError: Invalid prompt: The messages do not match the
ModelMessage[] schema.
```

The first model call now worked; the second died carrying the first's tool
result back. `ToolResultPart.output` is a discriminated union in the SDK —
`{type: 'json', value}`, `{type: 'text', value}`, and so on — and the loop was
passing the result object bare. Read off `@ai-sdk/provider-utils@5.0.33`'s
declarations, not guessed.

Three sites built it: the live loop, the resume path's `not_executed` stub, and
`stubOldestToolResults`' context-trimming stub. All three now go through
`toolOutput()`. The trimming stub also had to change how it detects an
already-stubbed part, which now lives one level down under `value`.

A failed tool result is tagged `json`, not `error-json`: §8.4 defines
`{ok: false, error, message, hint}` as data the agent is meant to read and act
on, so it is an ordinary turn rather than a transport failure, and `error-json`
would let providers present it as the latter.

**This one was only reachable on a session's second step**, which is why the
first smoke run could not have found it: those twelve died before any model call
succeeded. Two bugs stacked, and only running the thing end to end got past the
first to see the second.

### The test that closes the class, not just the two bugs

Both bugs share a cause: **every test of the model call passes a stub, and a
stub accepts whatever it is handed.** 452 tests were green through two errors
that made every session on production fail.

`ai` exports `modelMessageSchema` — the same validator `generateText` runs
internally. `packages/agent/test/messageShape.test.ts` drives a real two-step
session and validates every message the loop builds against it: no network, no
key, and it fails on exactly what production failed on. The resume path gets the
same check in `session.test.ts`.

The lesson worth keeping is narrower than "add tests": a stub at a boundary
tests our side of the contract and nothing of theirs. Where the other side has a
published validator, run it.

### A second, smaller finding from the same run

Queueing all twelve at once nearly retired half of them unrun. Smoke sessions
carry a 10-minute deadline (`guards.ts`), the queue sweep runs every five
minutes, and the sweeper starts six at a time — so the second batch of six had
about two minutes of margin before `startQueuedSessions` would have marked them
`skipped`/`deadline`. I extended the deadline on the still-queued rows rather
than lose the run. The deadline is meant to bound a *running* session, not queue
latency, so a queued session arguably should not age against it; noted here
rather than changed, since the draft does not depend on it.

## 2026-08-29 — Rankings moved to Sleeper; FantasyPros removed entirely

Jake's call, after the plan upgrade did not take (entry below). Both Section 2
rows that pinned FantasyPros were changed with his approval: the draft board's
source, and the agents' research tool. SPEC.md is at v1.9.

### Why, and the part that matters more than the paywall

The free tier capping every response at 10 rows is the reason we went looking.
It is not the reason we switched. Measuring the alternatives turned up a defect
that was already in the design and would have bitten us on draft day **even on a
paid plan**:

**Sleeper stopped populating `espn_id` and `yahoo_id` for players who entered the
league from about 2021 on.** Measured against production: of the top 200 by ADP,
**144 carry neither id**. Chase, Gibbs, Bijan, Nacua, Jeanty, Love — all null.
McCaffrey (2017) has both.

Appendix B's mapping chain was yahoo id → espn id → normalized name. So for 72%
of the draft board it would have fallen through to fuzzy name matching, at speed,
against a three-minute pick clock. That is a latent draft-day failure, and it
applies to any outside source, not just FantasyPros. It is written into Appendix B
so the next person to propose an external feed has to answer it.

I checked ESPN's `kona_player_info` as the alternative first: genuinely good data
(1,000 ranked players with PPR rank, ADP, auction value, %owned, no key), but it
is keyed by ESPN id, so **only 56 of the top 200 joined**. Same defect.

Sleeper's own projection feed matches **200 of 200**, because its `player_id` is
already our canonical id.

### What the board is built from now

`GET api.sleeper.com/projections/nfl/2026?season_type=regular&position[]=…&order_by=adp_ppr`
— one call, no key, no quota, 1,756 players with a usable PPR ADP against a gate
of 200.

- `rank`, `pos_rank` — ADP order, and that order within a position.
- `adp` — `adp_ppr` verbatim. Sleeper writes `999` where it has no ADP; those are
  left off the board rather than ranked last.
- `tier` — **not** derived from ADP. I tried: ADP is almost perfectly uniform
  (median consecutive gap 1.00 at every depth from 1 to 400), so gap-based tiers
  are an artifact of where the threshold sits — 1.2 gives 67 tiers in the top 200,
  2.0 gives 7, 2.5 gives 2. There is no cluster structure to find, and an invented
  tier that reads as authoritative is worse than none. Projected points *do*
  cluster: median gaps of 1.5–2.8 against real cliffs of 26–50. So a tier is a
  drop within a position larger than 3× that position's median drop, and a player
  with no projection gets no tier.
- `ecr_delta` — gone; Sleeper has no expert-consensus movement. Column kept, always null.

### The agents' tool

`fantasypros_lookup` → `player_research`, and it reads **our own tables** rather
than any API: rankings from the ingest above, projections from `player_week_proj`,
trending adds and injury status from the hourly player feed. Consequences worth
noting: no key, no 3-per-day allowance to spend, no cache-hit accounting — and
"same information for all twelve agents" (§2) becomes true by construction rather
than by convention, since every agent reads the same rows at the same moment.
There is no `news` kind; Sleeper has no news feed and `web_search` always covered
it better.

### What else went

- `ingest.fp_injuries` — injuries already arrive on the hourly `ingest.players`
  feed, which is what raises `injury.changed` anyway. Nothing was lost.
- **§13.4's scoring ladder is two rungs, not three**: Sleeper, then nflverse.
  FantasyPros player-points sat between them.
- Tables `fp_cache`, `fp_usage`, `fp_player_map`, `rankings_unmatched`; column
  `rankings.fp_player_id`; setting `fantasypros_daily_allowance`; the three
  `FANTASYPROS_*` environment variables; `docs/fantasypros_v2_public.yaml`; the
  unmatched-mapping control on `/admin/rankings`; the FantasyPros cards on
  `/admin/health` and `/benchmark`; the FantasyPros line in the weekly digest.
- The §5.7 draft gate lost its "nothing unmatched in the top 200" clause, because
  an unmatched player is no longer a state that can occur.

**Destructive migration** (`0002_drop_fantasypros.sql`), recorded per the standing
rules. It drops those four tables, two columns, and deletes every `rankings` row.
All of it is derived or operational data — API responses under a TTL, a request
counter, and two tables that existed only to resolve foreign player ids. No league
state (rosters, transactions, results, matchups) references any of them. The
`rankings` rows deleted are the 68 truncated free-tier ones, which are worthless;
the board is rebuilt by the next ingest. Neon snapshot `snap-broad-river-avws9b5v`
(`pre-0002-drop-fantasypros`) was taken before it ran against production.

### Production result

`ingest.rankings` ran on the first tick after the deploy: **1,756 ranked
players, all 1,756 joining to `players`** — a 100% match rate, against the 200
the §5.7 gate needs. 413 carry a tier (the ones with a projection). Board reads
Gibbs 1.90, Bijan 2.60, Chase 3.60, Nacua 4.80. No health error.

### What I got wrong: the migration broke one tick

I dropped `fantasypros_daily_allowance` in the same deploy that stopped reading
it, which is an expand/contract violation. The migration runs during the build,
but the old deployment keeps serving until the alias switches — and in that
window its `getSettings` still names the dropped column. Every tick stage failed
once, at 16:23:31, and recovered on the next tick at 16:24.

One lost tick pre-draft costs nothing, so I am not reverting anything. But the
shape of the mistake is worth keeping, because two versions of it are not
harmless:

- In season, a lost tick can be a missed lock or a missed waiver run.
- **If the build had failed after the migration ran**, production would have been
  left serving old code against a schema that no longer fits it, with no new
  deployment to switch to. The snapshot would have been the only way back.

The rule for next time: **drop a column in the deploy *after* the one that stops
reading it.** Ship the code that no longer selects it, let it become the running
deployment, then drop. Adding a column is safe in one step; removing one is not.

Also deleted the stale `fp.rankings` and `fantasypros` rows from `health`. They
had no writer left, so `/admin/health` would have shown a permanent red error for
a source that no longer exists.

### Checks

452 tests green before the change, and after it with the FantasyPros tests
replaced: 9 new for the ingest and its tiering, 6 for `player_research`, and the
§13.4 ladder test rewritten for two rungs. Lint and typecheck clean.

## 2026-08-29 — FantasyPros re-run after the plan upgrade: still `free`

Jake upgraded the FantasyPros plan and asked for another run of
`ingest.fp_rankings`.

**Production data edit, recorded per the standing rules:** deleted the eight rows
in `fp_cache` on the `main` Neon branch — `/nfl/players` and the seven
`consensus-rankings` calls. `fp_cache` holds nothing but responses from an
external API under a six-hour TTL (§5.8), so this is derived data and the delete
only forces a refetch; nothing in league state depends on it and no backup is
meaningful. Without it the re-run would have been served the earlier free-tier
bodies out of cache and the upgrade would have looked like it had done nothing.

Booked the job (`scheduled_jobs` id 237, `due_at = now()`), the tick claimed it a
minute later, and all eight calls went to the live API at 15:31:34–15:31:41 UTC.
**Every one still answers `"tier": "free", "limit": 10`.** 68 ranked players
again, against §5.7's gate of 200. Numbers in `docs/VERIFIED.md`.

The response says only what tier the key it received is on, so it cannot
distinguish the two causes:

1. the upgrade has not taken effect on FantasyPros' side; or
2. a new key value was saved in Vercel **after** the current production
   deployment was built (15:23:14 UTC), so the running deployment is still
   sending the old one — a deployment only ever sees the environment snapshot
   taken at build time, which is exactly what `CRON_SECRET` did yesterday.

Pushing this commit rebuilt production, which ruled out (2) at no cost.

**Settled: it is (1).** Jake then reset the key and passed the new value to me
directly. I called `consensus-rankings?position=ALL&scoring=PPR&week=0` with it
by hand, out of band from production and from any cache — HTTP 200,
`"tier": "free", "limit": 10, "count": 518`, ten rows. So the key itself is a
free-tier key at the source; nothing about our deployment, our environment
snapshot or our cache is involved. The fix is on the FantasyPros account.

Per §17 the key was **not** written to the repo, to `.env.local`, or to Vercel by
me: I hold no Vercel environment-variable tool, and the value is free-tier anyway,
so installing it would change nothing. It was used once from a scratch file that
was shredded immediately after. Because it has been through a chat transcript it
should be reset again once a paid key is in hand.

From FantasyPros' own documentation, premium API access rides on a **paid Hall of
Fame subscription** — $107.88/year or $71.94/6 months — and two details match
what we are seeing: a HOF *free trial* explicitly does not grant premium API
access, and HOF members activate production API keys as a separate step, so the
upgrade may not promote an existing key in place. (Read from search results;
`www.fantasypros.com` and `support.fantasypros.com` are both blocked by this
session's egress proxy, so the price should be confirmed at checkout.)

Also worth Jake's attention before he buys: the HOF API licence is worded for
personal, non-commercial use and the free tier for non-production use. A public
league site sits awkwardly against both, and commercial use is a separate
agreement with their sales team.

The draft stays blocked until this passes; nothing else in the league is waiting
on it, and the rest of the pre-draft checklist in `docs/SETUP.md` §8 is unaffected.

## 2026-08-29 — Vercel Speed Insights on the public site

`@vercel/speed-insights` added to `apps/web`, with `<SpeedInsights />` mounted at
the end of `<body>` in `app/layout.tsx` — the App Router placement from Vercel's
quickstart. The `/next` entry is the one used: it reads the router's route, so
vitals are attributed to `/matchups/[week]` rather than to twelve separate URLs.
The component is `"use client"` and wraps itself in `Suspense`, so the root
layout stays a server component and no page loses static rendering.

- It collects nothing in development and nothing in the test suite — the package
  no-ops unless `NODE_ENV` is `production` — so no test or local run reports.
- No new environment variable, no CSP to widen: the script and its beacon are
  same-origin under `/_vercel/speed-insights/*`, which Vercel adds at the edge.
- `apps/web/test/speedInsights.test.ts` guards the import path and the
  render-once-inside-`<body>` placement; mounted deeper or twice it would
  under- or double-report, and both are silent failures.
- Jake enabled Speed Insights on the project the same day. **Verified**: both
  `/_vercel/speed-insights/script.js` and the obfuscated `/c03b0126f6fa88a8/
  script.js` answer 200 with the same 12,567-byte script on the branch preview
  *and* on `league.jake-moses.com`. Those routes exist only once the project has
  it switched on, so serving them is the enablement check.
- The obfuscated path is the one that matters and is easy to miss. Vercel's build
  injects `"speedInsights":{"scriptSrc":"c03b0126f6fa88a8/script.js","endpoint":
  "c03b0126f6fa88a8/vitals"}` into the page config, and the component uses it in
  preference to the `/_vercel/...` path — it is per project, and unguessable so
  that blocklists keyed on "speed-insights" cannot match it. Anything that
  greps deploys for the literal string will conclude, wrongly, that this is not
  installed.
- **Verified in a browser**, not just by reading the bundle: the preview build
  was mirrored and served locally, and headless Chromium shows
  `<script src="/c03b0126f6fa88a8/script.js" defer>` appended to `<head>` with
  `window.si` live — the exact success signal the quickstart names. (Chromium
  cannot reach the preview host directly from this session: the egress proxy
  drops its tunnel with `ws_closed_mid_exchange` mid-handshake, though curl to
  the same host is fine. Hence the mirror. Worth knowing before the next
  `scripts/mobile-audit.mjs` run, which drives Chromium the same way.)
- Not yet on production: this is on the branch, and `main` has no Speed Insights
  component, so `league.jake-moses.com` serves the routes but nothing calls
  them. Data starts on merge.

## 2026-08-29 — Vercel Connect evaluated and declined; the gateway key stays persistent

Jake asked whether [Vercel Connect](https://vercel.com/docs/connect) should back
some of our integrations. Two decisions came out of it, both his, both recorded
here so neither gets re-raised as an oversight.

### 1. We do not adopt Vercel Connect

Connect is a credential broker: a connector is configured once at the team level
(Slack, GitHub, Microsoft, Linear, Snowflake, Salesforce, custom OAuth, or a
static API key), and code calls `getToken()` at runtime, authenticating with the
deployment's OIDC token, so no provider secret sits in an environment variable.
It earns its place when you need delegated or user-scoped tokens, OAuth refresh,
multi-tenant installations, or verified webhook fan-out.

We need none of those. Every third-party credential in this league is a static
single-tenant key or a connection string, and no part of the system ever acts on
behalf of a signed-in human:

| Integration | Auth today | Connect fit |
|---|---|---|
| Neon (`DATABASE_URL`) | Postgres connection string | No — not a bearer-token HTTP API; Neon's own Vercel integration manages the variable |
| AI Gateway (`AI_GATEWAY_API_KEY`) | static key | No — see decision 2 |
| FantasyPros | static key | Possible (API-key connector), no benefit |
| Web search (Tavily/Exa/Brave) | static key | Possible, no benefit |
| Resend | static key | Possible, no benefit |
| Sleeper, nflverse | unauthenticated | N/A |
| `COMMISSIONER_PASSWORD`, `SESSION_SECRET`, `CRON_SECRET` | our own secrets | N/A — not third-party credentials |

For the four static-key providers Connect would move a key from a Vercel
environment variable into a Vercel-managed vault: same vendor, same trust
boundary, one owner, one project. What it buys is rotation in one place and a
token-request audit log. What it costs is a runtime dependency in the agents'
hot path and **$3 per 1,000 token requests on Pro** (Hobby's 500/month free
allowance does not apply to us). Agents call `web_search` on every tool step
with no cap (§2, "Information"), so that is a recurring bill and a new failure
mode in the session loop for no security gain.

Revisit if the spec ever grows a Slack or Discord surface (§2 currently says
Discord: none), a GitHub App, or anything acting for a signed-in user.

### 2. `AI_GATEWAY_API_KEY` stays a persistent key — deliberately

While reviewing the above I proposed replacing the gateway key with Vercel's
OIDC authentication. AI Gateway accepts a deployment's injected
`VERCEL_OIDC_TOKEN` in place of an API key: short-lived, auto-renewed, scoped to
one project and environment, nothing stored. The argument for it is that
`AI_GATEWAY_API_KEY` is our highest-value secret — it bills the gateway for all
twelve agents and §2 sets no spend cap — and it neither expires nor is scoped to
anything.

The change would have been small: the agent hot path needs no edit at all
(`modelStep.ts:106` passes a bare model id, so the AI SDK resolves it through
its default gateway provider, which falls back to the OIDC token itself), plus a
one-line fallback at `gateway.ts:23` for the model-catalog check, then removing
the variable from the Vercel production and preview environments. The key would
have stayed in `.env.example` and `.env.local`, since no OIDC token exists
outside a deployment.

**Jake decided a persistent key is fine, so none of this was implemented.** No
code changed. The fallback line is pointless on its own — it only mattered as a
step toward removing the variable — so it was not added either.

This is a choice, not an oversight. A reviewer who later finds a long-lived,
uncapped billing credential in the production environment should read this entry
before filing it as a finding. If the position changes, the work is the four
steps above, and the OIDC path is a **verify** item: neither the fallback
behaviour of our pinned `@ai-sdk/gateway` (^4.0.68) nor whether Vercel Workflow
steps receive `VERCEL_OIDC_TOKEN` on resume has been confirmed against our
versions, and both would need a real preview session and a `VERIFIED.md` row
before the production variable came out.

## 2026-08-29 — The public site is now a broadcast, and the review found ten real defects

Jake handed over a Claude Design bundle — a prototype of a redesigned public
site — and asked for it built for real, all six screens, wired to live data.
It is on `main` now. What is worth recording is not the redesign; it is what
the review loop caught, because most of it was invisible to the eye.

**Three things the design wanted that this league does not store.** A win
chance, power rankings with movement, and a season timeline. None of them are a
new source of truth: the win chance is a logistic on the projected final
margin, the rankings blend win rate, points and lineup efficiency with movement
computed on the same blend a week earlier, and the timeline assembles itself
from transactions and `team_week_results`. Every one says in its own comment
that it is an estimate. The power-ranking notes are facts read off each team's
row — the reporter writes prose on this site, the page does not.

**The win chance was double-counting a live player.** The margin added each
remaining starter's *full weekly projection* on top of the matchup score that
already contained the points he had scored so far. A receiver on 10 of a
projected 15 was worth 25 to his team. It is now the projection less what he
has already scored, floored at zero. On the fixture data this moved one game
from "Cold Start 10% to win" to 27% — the first number was not a rounding
error, it was wrong.

**An unread schedule read as a finished Sunday.** "Slots still to play" comes
from joining a starter to his NFL game. If `nfl_games` is empty for the week —
not ingested yet, or the read degraded — nobody has a game, so nobody is still
to play, so every game rendered `final` with no win chance. A missing schedule
now means *not knowing*: no slots claimed, no chance offered, and only the
matchup's own `final` flag decides.

**Two derived tables disagreed with the standings beside them.** `computeStandings`
counts finalized regular-season games only (`standings.ts:55`); the new form
chips and power-ranking history counted playoff games too, so a chip could
record a result the record next to it did not contain. Both now filter
`is_playoff = false`.

**The activity rail could not name a player.** `describeTransaction` read
`addedName` / `droppedName`; `waivers.ts` writes `playerId` and
`dropPlayerId`. Every transaction in the rail therefore fell back to "Won a
waiver claim." It resolves ids now, and still degrades to a nameless sentence
rather than to "Claimed undefined".

**`benchmarkRows()` ran twice on every home render** — eleven queries duplicated,
because `powerRankings()` fetched its own copy. It takes the rows now.
`seasonTimeline` also scanned the whole `transactions` table to find two rows;
it asks for a bounded oldest-first window of the two types it wants.
`benchmarkRows` additionally called `db()` once *outside* every `safeRead`, and
`db()` throws when `DATABASE_URL` is missing — so the one failure mode the
breaker exists for would have taken the page down instead of emptying it.

**Two colours failed WCAG on every screen.** The design system's slate
`#a39c8c` is 2.57:1 on its own paper, and it is the colour of every small meta
label on all six pages. The band's faint tone was 3.23:1. Darkened to 4.63:1
and lightened to 4.93:1 respectively; the system's original value is kept as
`--slate-soft-decorative` for the places it is a shape rather than a word. This
is a deliberate divergence from the handoff — the prototype's own values fail —
and it is recorded here rather than silently absorbed. Related: the leaderboard
bars below the top three were `#2f5d34` on a near-black track, 1.93:1, and read
as empty rows.

**The leaderboard's "Wins" tab did not rank by wins.** It sorted on points for,
under a label promising wins and a note promising "wins first" — inherited
straight from the prototype. It ranks by record now, points as the tiebreak,
and the bar still draws points because twelve identical two-win bars say
nothing. It is also the default tab again: the previous default, lineup skill,
comes from `team_week_results`, which is empty until the first week finalizes,
so before the first Tuesday of the season the band — the home page's only
standings surface, which §12.1 requires it to have — rendered empty.

**Font Awesome is gone.** The design system asks for it and says not to
hand-draw icons. That is right for a site with an icon set; this one used
exactly one glyph, and the cost was a third-party stylesheet on every route
including `/admin/login`, with no integrity hash available from this network.
One inline arrow replaces it. If a second icon is ever needed, load the real
set rather than growing that SVG.

Also fixed: four pages had no `<h1>` at all (the design system marks its eyebrow
up as `<h2>` and its heading as `<h3>`, so the decorative label outranked the
page title — same pixels, corrected outline); the metric switch declared an
ARIA `tablist` with no panels and no keyboard model, and is now a group of
toggles; reduced-motion stopped the ticker but stranded every game past the
first screenful, and now makes it an ordinary scroller; playoff games were
labelled with the league week instead of the round; and the mirrored lineup
rows lost all team attribution when they stack on a phone.

**Round two found that two of the round-one fixes did not do what they said.**
The "unknown schedule" guard suppressed the `final` flag but not the win
chance, so a week with no ingested games printed a confident number derived
from the score alone; and six call sites still read `slotsToPlay === 0` as
"finished", which is exactly the bug round one had reported. Both are fixed by
making the uncertainty part of the type: `slotsToPlay` is now `number | null`,
null meaning "no schedule, no idea", and the compiler found every call site.
Round two also caught that the leaderboard bar recolour had made ranks 4-12
*brighter* than 2nd and 3rd (4.43:1 against 3.78:1 — the scale is now
monotonic), that the identical bar in the compare panel was left at 2.76:1,
that the active nav underline was 2.26:1 on the band, that the timeline's
first-trade card could be hidden for ever by a 20-row window shared with waiver
claims (now one exact query each), and that awaiting the benchmark rows ahead
of the other home-page reads had put eleven queries in series in front of them.
The remaining-points arithmetic — the round-one bug with the widest blast
radius — had no test, because it lived in the database module; it is now a pure
function with five, including the case where a player has already outscored his
projection.

A full WCAG sweep over the final palette: twenty text pairs and five graphical
ones, zero failures. Enforcing AA has left `--faint` close to `--muted`; that
is the honest consequence of the design's original value failing at 2.57:1.

**How it was checked.** Six independent reviewers over separate dimensions
(§12.1 conformance, derived-logic correctness, data layer, security and the
server/client boundary, accessibility and contrast, design fidelity), each
finding then put to two skeptics prompted to refute it. Thirty-eight findings,
most refuted; the ones above were confirmed by reading the code directly.
Two rounds; the second reviewed the first round's fixes. Verified against a
real Postgres with a seeded week-3 league: all seven screens render at 1320 px
and 375 px with zero horizontal overflow and exactly one `<h1>` each, and that
`<h1>` now names the page. 40 test files, 493 tests.

**Two steps of the review loop could not run here** and are not claimed: a real
agent session against a preview deploy (§CLAUDE.md step 4 — no credentials in
this session), and the post-merge production health check (step 5 — no Vercel
access). The cron/`CRON_SECRET` problem recorded in the entry below is
unrelated to this change and still Jake's to fix; until it is, production has no
league state for these pages to show, and they will correctly render empty.

## 2026-08-29 — Full audit: three findings that would each have stopped the season

Jake asked what is missing. Rather than answer from the build log I checked
production directly, and found the league was already in the failure state.

**1. The cron has been getting 401 every minute since the merge.** Vercel's
runtime logs show `GET /api/cron/tick 401` at 01:52, 01:53, 01:54 and on, every
minute, against production. `CRON_SECRET` is not set in the Vercel project, so
Vercel Cron sends no bearer token and the route correctly refuses it. The
scheduler has therefore never run: production has the twelve teams and the
settings the seed wrote, and **zero players, zero games, zero jobs, zero health
rows**. This is Jake's to fix — one environment variable — but it had been
failing silently for an hour.

**2. Even with the secret set, the queue never starts.** Every recurring job is
booked by `book_daily_jobs`, and `book_daily_jobs` re-books itself, so the chain
sustains itself once running — but nothing ever booked the *first* one.
`bookRecurringJobs` is called only from that job's own handler, from `planWeek`
(which needs a `week.plan` job), and from the admin "book job" button. On a
fresh database the queue stays empty for ever: no ingest, no sessions, no
season. `runTick` now primes it, idempotently, and re-primes a queue that has
somehow drained.

**3. The health page could not report either of them.** Every row on
`/admin/health` is written by the tick, so when the tick is dead the page is not
alarming — it is *empty*, which reads as calm. There is now a banner computed
from the tick's own liveness: "the scheduler has never run", or "has not run for
N minutes", naming `CRON_SECRET` as the usual cause. The one failure the page
could not see was the one that matters most.

The third is the general lesson and worth stating plainly: **a monitoring
surface that is written by the thing it monitors cannot report that thing's
death.** Everything else on that page is fine — it degrades to "never" per feed
— but the tick needed to be checked against the clock instead.

Also confirmed while auditing: production is 10 MB against Neon's 512 MB
free-tier branch limit, with the ingests not yet run. Player and stats rows are
the bulk of it; worth re-checking after the first full week rather than
assuming.

Test suite: **416 tests green**.

## 2026-08-29 — Draw the order before onboarding; preparation gets its own allowance

Both from Jake, and both make preparation time actually worth something.

**The order is drawn first now** (§10.1 reordered; it was onboarding, then the
draw). An agent that does not know its slot writes a generic plan — and twelve
generic plans are the same plan. The onboarding session is now given its slot,
the field size, and the exact pick numbers it owns in every round, computed
off the snake. The brief asks for a plan round by round against those numbers
rather than in the abstract.

`runOnboardingAction` refuses to run before the draw rather than merely
documenting the order. That matters because an onboarding session cannot be
re-run: the idempotency key is fixed, so a session that ran too early is the
plan that team has.

**Preparation has its own check-in allowance**, three, separate from any week.
The bug it fixes: `current_week` is still its default of 1 before the draft, so
a check-in booked on draft eve spent one of the five an agent gets in the real
week 1 *and* counted against week 1's $40 alarm — meaning an agent that
prepared well would start the season with fewer follow-ups than one that did
not, and would trip an alarm on draft day.

Fixing it properly closed a wider hole the fourth reviewer had flagged and I
had left open. The rule is no longer "these two kinds never have a week" but
"a session belongs to a fantasy week only when the league is playing one":
before the draft, nothing is stamped week 1 — not `smoke`, not `manual`, not
`onboarding`, not a check-in. Every pre-draft session used to land in week 1's
spend rollup. Tested from both sides, including that the same kinds *do* carry
a week once the season is under way.

**One gap found while answering, now in §10.1 as step 1**: `ingest.season_stats`
is never booked automatically. That is defensible — last season's totals never
change, so there is nothing to schedule — but the draft board's last-season
points come from it, and nothing said so. Without it every player on the board
shows zero. It is the first step of the setup sequence now.

Test suite: **415 tests green**.

## 2026-08-29 — Five-minute grid for check-ins; the queue sweep matches it

Jake's call, and the two halves belong together.

**The queue is swept every five minutes, not every tick.** The tick itself stays
per-minute — live scoring (§13.2), game-start waivers (§7.3) and trade-review
resolution all need that cadence, and §9.1 fixes the cron at `* * * * *`. What
did not need it is the session queue: a session's own booking decides when it
runs, and five minutes of latency is nothing against a lineup check booked
ninety minutes before kickoff. That is five times fewer scans of `sessions`,
which was the one query the tick repeated forever against a growing table.

The gate is recorded in `health` under `sessions.sweep` rather than derived from
the clock (`minute % 5`). That matters: deriving it would skip a whole cycle
every time a tick was missed, where recording it means a missed tick delays the
sweep by a minute. It also puts the last sweep on `/admin/health` beside every
other feed. Tested both ways, including the eleven-minute gap.

**Check-in times round up to the same grid.** A check-in booked for 10:02 would
sit until the 10:05 sweep regardless, so it is booked at 10:05 and the agent is
told 10:05. Rounding *up* rather than to the nearest is what keeps the minimum
lead a real minimum.

One thing that surfaced while testing and is worth stating, because my first
test asserted the opposite: a request 26 minutes out rounds to 30 and is
**accepted**. The 30-minute minimum is a guarantee about when the check-in
actually runs, and rounding only ever pushes a time later, so the guarantee
holds. Nothing rounding can do rescues "come back in a minute", which is what
the minimum exists to refuse. The test now asserts that invariant rather than
the stricter thing I assumed.

Also checked, since sweeping less often could have cost it: §15.4's criterion
still holds — twelve lineup checks at a cap of six still drain in two waves
inside 45 minutes, because the sweep interval costs at most one interval per
wave.

**Still outstanding, and now slightly more worth doing**: the `sessions(status,
updated_at)` index. Sweeping five times less often cuts the scan rate by 5×, but
each scan is still sequential, and check-in rows sit in that table for days.
Queued for the same migration as §8.10.

Test suite: **412 tests green**.

## 2026-08-29 — Mobile layout: measured, not eyeballed

Jake asked whether the UI is mobile friendly. I measured it rather than reading
the classes: a 375px and 414px Chromium against the deployed pages, checking the
three things that actually break a page on a phone. `apps/web/scripts/mobile-audit.mjs`
is that measurement, kept in the repo so it is repeatable.

Three real defects, all in the shared components, so all of them affected every
page that has a table — including the ones that are empty pre-season and could
not be measured yet:

1. **`/benchmark` scrolled the whole page sideways** — 63px at 375px. A `Card`
   is a grid child, and a grid child defaults to `min-width: auto`, meaning its
   content's minimum width. So a card holding a seven-column table refused to
   shrink and pushed the page wide instead of letting the table scroll inside
   it. `min-w-0` on the card, and `min-width: 0` on `.table-scroll` for the same
   reason.
2. **Wide tables squashed instead of scrolling.** `.table-scroll` had
   `overflow-x: auto`, but the table inside carried `w-full min-w-full` — which
   pins it to the container, so more columns just meant narrower columns. Seven
   of them in 375px, every cell wrapped to three lines. The table now takes a
   minimum width proportional to its column count (6.5rem each, above four
   columns), so it overflows the scroller it was always meant to overflow. Wide
   enough to be a no-op on a desktop.
3. **Rows three and four lines tall** on `/standings` (77px) and `/spend` (77px),
   the same symptom from the other side. Gone once the tables scroll; headers
   also stopped wrapping.

Also: three admin forms forced two columns at any width; they are behind `sm:`
now. And the four `grid-cols-2` grids that remain unprefixed are deliberate — a
pair of short stats reads fine on a phone — so the regression test forbids three
or more columns at the base breakpoint, not two.

Measured after the fix, at both widths, across every public page plus
`/teams/team-1` and `/spend/team-1`: **no page overflow, no squashed table, no
tall rows.**

`apps/web/test/mobile.test.ts` keeps the fixes: it asserts the table is not
pinned to its container, the scroller can shrink, `Card` carries `min-w-0`, and
no layout forces three columns onto a phone.

Test suite: **404 tests green**.

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

## 2026-08-29 — Initial ingests; the draft is blocked on the FantasyPros plan

Booked the three initial ingests on production once the key was set.

- `ingest.players` — **12,225 players**, 11,985 with a position.
- `ingest.schedule` — **272 games** for 2026, the full season.
- `ingest.fp_rankings` — worked, and is **not enough**.

**A silent success, fixed.** The first rankings run reported `done` having
ingested nothing: zero rankings and zero `fp_usage` rows, so no request had even
been attempted. The cause was `if (!fantasyprosApiKey) return;`, commented "skip
rather than fail the tick" — reasoning that was already stale, since these jobs
no longer run inline and the tick's stages are individually isolated. A missing
key is a misconfiguration (§17 requires it) that blocks the draft (§5.7), so it
now writes a `fp.key` health row and throws. Same for `ingest.fp_injuries`.

**The real blocker.** With the key in place the ingest ran properly — eight
calls, all successful — and produced 68 ranked players against a gate that needs
200. This is the §5.7 **verify** item ("free-tier truncation measured"), now
measured: the API's own payload says `tier: free, limit: 10, count: 518`. Every
request is capped at ten rows, so the per-position calls cannot get past it
either. Details in `docs/VERIFIED.md`.

The spec gives no fallback for this, which is the case CLAUDE.md says to bring
to Jake rather than decide alone — the options change the league's character:
upgrade the FantasyPros plan (spec-faithful; §2 fixes FantasyPros as the
rankings source), lower the §5.7 threshold (a 168-pick draft off 68 ranked
players means the board runs dry around round four and auto-pick has nothing to
go on), or seed the board from another source. Recorded here and surfaced on
`/admin/rankings`; everything else continues.

### Questions for Jake

1. **FantasyPros plan.** The free tier caps every response at 10 players, so the
   draft gate is unreachable. Upgrade, or change the gate? This blocks the draft
   and nothing else — the rest of the league is running.

## 2026-08-29 — The scheduler is alive; three bugs only production could find

Jake set `CRON_SECRET` and redeployed. Bringing the tick up surfaced three
things in sequence, each hidden by the one before it.

**1. 401 straight through a fresh deploy.** Vercel Cron was firing every minute
and the tick was answering 401 — including on a deployment built *after* the
variable existed, which is what made it confusing. The cause is that a
deployment only ever sees the environment snapshot taken when it was built, so
the running one never learns about a variable added afterwards; the deploy that
looked new had been built minutes before Jake set it. The health banner and
`docs/SETUP.md` now say this outright, with a table of what each status code on
that route means, because "set the variable" and "redeploy" are two steps and
only the second one is load-bearing.

**2. A bare `Date` in a raw `sql` template.** With auth passing, the tick began
answering 500 once a minute:

    ERR_INVALID_ARG_TYPE: The "string" argument must be of type string or an
    instance of Buffer or ArrayBuffer. Received an instance of Date

Drizzle serializes a value correctly when it knows the column's type, so every
`eq(table.someTimestamp, date)` is fine. A raw `sql` template has no such type,
so the parameter reaches the driver untyped — and the drivers disagree: **PGlite,
which every test runs on, accepts a `Date`; postgres-js, which production uses,
throws.** A raw template holding a `Date` therefore passes the entire suite and
then fails on every single request.

Two existed. The scheduler's job-claim query was the one visibly on fire. The
second, `updateRollups`' day window, is called on every model step and would
have failed every session the moment one ran — so this would have looked like
"the draft is broken" a week from now instead of "the tick is broken" today.

`tstz()` sends the ISO string with an explicit `::timestamptz`, unambiguous for
both drivers. Since no PGlite-backed test can catch the class by running, the
guard is a source scan plus builder-level assertions on the emitted parameters.
The scan's first regex ate the backtick and passed on everything — verified it
actually fails on the un-fixed code before keeping it, because a vacuous guard
here is worse than none.

**3. The heartbeat I had deleted myself.** With the tick finally working, every
stage recorded itself and `cron.tick` did not exist. Wrapping the stages in
their own error handling had replaced the block that ended `runTick`, taking
that write with it — so `/admin/health` would have shown the red "the scheduler
has never run" banner for ever while the league ran perfectly. A false alarm on
the one indicator that says the league is alive is worse than no indicator, and
it is precisely what the stage refactor existed to prevent. Restored last and
unconditional, with a test asserting it sits after the final stage.

**State now.** The tick answers 200 every minute. All six stages green.
`book_daily_jobs` primed itself and booked 221 recurring jobs out to 4
September; `ingest.stats` has run; no job has failed. Players, the schedule and
the FantasyPros rankings are simply not due yet — they sit on their §9.1 slots
(players 6-hourly, schedule and rankings at 05:00/05:30 ET). Booking them by
hand from `/admin/jobs` is the next step before the pre-draft checks.

448 tests green.

## 2026-08-29 — Team naming: already built, one real weakness found

Jake asked for agents to be able to name their own teams. That was already
the case and always has been — `set_team_name` is an onboarding-only tool
(§8.4), the onboarding brief makes it step 1, and the seed deliberately leaves
`teams.name` null so the name is the agent's first act. Verified end to end
against production: all twelve rows still hold `name = null`, waiting for
onboarding that cannot run until `CRON_SECRET` is set.

What the check did turn up is that yesterday's uniqueness guard was weaker than
its own comment claimed. The comment said the write was "serialized on the
settings row above". There is no such lock. Under READ COMMITTED two of the six
concurrent onboarding sessions can both read "not taken" and both write, and
twelve models asked to name a fantasy football team are not unlikely to collide
on something obvious.

- `teams_name_lower_uq` (migration `0001`): a **partial** unique index on
  `lower(name)` where the name is not null. Partial matters — the eleven teams
  still unnamed must not collide with each other on null.
- `setTeamName` keeps the read, but only for the message, and catches the
  constraint violation to return the same clean `name_taken` failure. The
  driver's error shape differs between postgres-js and PGlite, so the match is
  on SQLSTATE 23505 plus the constraint name rather than one driver's type.
- Verified the tests are not vacuous: with the friendly pre-check disabled, all
  four naming tests still pass, so the index and the catch are doing the work
  rather than the read.

The constraint immediately earned itself by failing a fixture in
`apps/web/test/draft.test.ts` that inserted every team as `"T"`.

Also: `TeamLabel` fell back to "(unnamed)", so before onboarding the whole site
was twelve identical rows. It now falls back to the model label, then the slug —
the pre-draft site is mostly unnamed teams, and the model is the thing that
tells them apart.

443 tests green.

## 2026-08-29 — Merged to main; one production data edit

`main` is at `6aa5bde`. CI run 28 green (lint, typecheck, 440 tests, and a
production `next build`); Vercel production deploy READY; migrations and the
seed ran inside the build as designed.

Verified against the live deployment: `/robots.txt` and `/sitemap.xml` serve,
`/admin/health` redirects to the login, and `/api/cron/tick` answers 401 without
the bearer token — which is also the confirmation that `CRON_SECRET` is still
missing from the Vercel project. Nothing has ingested: production holds the 12
teams, the settings row, 12 model prices and 6 alarm rules, and zero players,
jobs, sessions or health rows. That is step 1 of `docs/SETUP.md` and it is Jake's.

**Production data edit** (noted here per the standing rules). The seed is
create-if-absent, so fixing `web_search`'s price in the seed did nothing for the
database that already had the old row. Two statements against Neon `main`:

- `update tool_costs set usd_per_call = 0.008 where tool_name = 'web_search' and usd_per_call = 0`
- `delete from tool_costs where tool_name = 'read_url'`

The first makes production match the seed: at $0 the ledger recorded no cost for
search at all, so `/benchmark`'s cost-per-point excluded the one tool an agent
can call without limit. The second removes a row for a tool that does not exist
— the old seed invented it. No rows were at risk: `tool_costs` is a two-row
configuration table with no foreign-key dependents, and both values are editable
on `/admin/settings`. The seed was deliberately left create-if-absent so it never
overwrites a price the commissioner has set.

**A correction to my own reasoning during this session.** I diagnosed CI runs 26
and 27 as wedged on a lint step and pushed a job timeout on that basis. The
container clock showed only three minutes had passed, not thirty — my `sleep`
calls were not consuming the wall-clock time I assumed. Both runs finished
normally in about eight minutes. The 25-minute timeout is still worth having on
an unattended project, so it stayed, but the commit message asserting a wedged
runner was amended before merge.

## 2026-08-29 — Three audits of what was already built, and what they found

Ran three independent audits with fresh context — spec coverage against §15/§17,
dead-and-unfinished code, and a chronological walk through a season for silent
failures — because the code was reviewed as it was written but never as a whole.
They found more than the four review rounds did. What follows is what was fixed
and, where something was deliberately not fixed, why.

### The ones that would have broken the season

- **Briefs would have failed every session in production.** `apps/web/lib/briefs.ts`
  read `packages/agent/briefs/*.md` at request time with a path relative to
  `process.cwd()`. Inside a Vercel function that path does not exist, so the very
  first real session would have thrown ENOENT. Nothing caught it because every
  test runs from the repo root. The briefs stay markdown (§8.6 is about how they
  read) and are compiled into `packages/agent/src/briefs.generated.ts` by a build
  step; a test fails if the two drift.
- **Two tools shared the name `get_team_week_results`.** `byName` built its index
  with `new Map(entries)`, which keeps the *last* one, so the reporter's thinner
  copy — no paging, therefore no §8.2 character cap, and missing `model` and
  `lineup_efficiency` — was what all twelve agents got. The read-table version
  wins now and a duplicate name throws at module load.
- **Every kicker scored 0 on the nflverse rung.** `STAT_COLUMNS` had no
  field-goal or extra-point columns although the comment said it did. That is the
  rung taken when both Sleeper and FantasyPros are down. Added the bucketed
  columns, with a documented 30–39-rate fallback for older release files that
  only carry `fg_made`.
- **A failed finalization stopped the season silently.** `current_week` never
  advances, so no week is planned, no lineups carry over, and Tuesday's
  `sessions.book` recomputes last week's idempotency keys and creates nothing at
  all — while trade windows keep firing, so the league looks alive. A watchdog in
  the tick now notices three hours after a scheduled finalization, records it,
  re-books the job, and emails once a day.
- **A Sleeper outage took out trade resolution.** `runTick` was one unguarded
  sequence; the live-score poll throws after its retries, so everything ordered
  after it — offer expiry, review resolution, outage detection, the `cron.tick`
  health write — was skipped for as long as Sleeper was down. An accepted trade
  whose 24-hour window ended would simply never have executed. Each stage now
  records its own failure to `health` and the tick continues.
- **Stale weeks in booked `ingest.stats` jobs un-finalized the previous week.**
  Game-day stats jobs are booked two days ahead with the week baked in; Tuesday's
  finalization advances it in between, so Thursday's runs re-upserted the
  finalized week with `final = false` and overwrote the source that scored it.
  The week is resolved at run time now.

### The ones that made a setting a lie

- The system prompt stated seven editable settings as literals — the waiver time,
  the review window, the veto threshold, offers per day, the trade deadline, the
  playoff shape, the FantasyPros allowance. Changing one on `/admin/settings` left
  all twelve agents told the old value, identically and invisibly. All
  interpolated, with a test that fails if a default leaks back in.
- `waivers.run` was booked at a hardcoded 4:30 while `waiverRunTimeEt` moved the
  clear window and what the agents were told. Now booked from the setting.
- The reporter's model was read from `extra.reporterModelId` and written by
  nothing, so a retired Sonnet 5 would have failed every recap, preview, note and
  draft grade until someone ran SQL — while §17 lists "reporter model set" as a
  go-live check. Now on `/admin/settings`, with the same gateway-catalog check the
  team swap got.
- Pausing a team was enforced only where sessions are *booked*, so a team paused
  mid-week still ran everything already queued. A pause now holds queued sessions
  and releases them on unpause; anything time-sensitive still expires on its own
  deadline, and a deadline-less session is retired after a week so a season-long
  pause cannot accumulate a pile that all fires at once.

### Deliberately not fixed, and why

- **Auto-filling an empty week-1 lineup.** The operational audit proposed filling
  empty starting slots from the optimal-lineup solver. §3.1 says plainly that the
  engine never chooses a starter for an agent, and §8.8's "keep the previous
  lineup" fallback is `carryOverLineups`, which has nothing to carry in week 1.
  Auto-filling would overrule a fixed league rule to paper over a bad session, and
  it would corrupt the benchmark — a model that never set a lineup would score
  like one that did. Instead `/admin/health` now warns, before kickoff, which
  active teams have an empty starting slot for the current week, so the
  commissioner can run a session for them. The exposure is real and it is the
  spec's choice, not an oversight.
- **A league-wide spend stop.** §2 is explicit: no cap, alarms notify and never
  stop a session. `pause_agent_at_usd` stays the only brake and stays off by
  default.
- **Lineup checks re-evaluated after every roster change.** §9.2 says membership
  is decided when the checks are booked. `bookLineupChecks` is idempotent per
  session key, so re-running it adds newly-eligible teams without duplicating
  anyone; that is the cheap way to close the gap and it is on the daily
  `book_daily_jobs` path, not on every add.

### Things that were true and are now also visible

- Failed jobs have a card on `/admin/health`; before, a failing ingest or digest
  appeared nowhere on the page the runbook says to check first.
- `sendEmail` records every attempt under the `email.send` health key with the
  provider's own reason. Email is the only channel that pushes anything to the
  commissioner, and every caller but one discarded the result — an unverified
  Resend sending domain (the most likely failure, since `from` is
  `league@$SITE_DOMAIN`) would have meant eighteen weeks of silence.
- §13.4's "Live scores delayed" is on the public pages now, with the last update
  time (§13.2). It existed only on `/admin/health`, which is not the audience the
  rule is written for.
- The digest now carries what §12.3 actually asks for: vote tallies on vetoed and
  failed trades, playoff seeds, per-agent last-week spend, FantasyPros requests
  used, named players on transactions, degraded feeds, and a draft variant with
  grades, auto-picks and the cost of the draft. The post-draft digest reported on
  week 0 before this.

### More, from the same pass

- **Two runners could both work one draft pick.** Reading the attempt number and
  creating the pick's session were separate steps, so a double-clicked resume (or
  a resume racing a run that was still alive) had the first write `draft:5:1` and
  the second read it back, take attempt 2, and start a *second* live session —
  two model calls racing `make_pick`, the loser ending with no pick and getting
  auto-picked. Both steps are now one transaction under an advisory lock, and a
  pick that already has a queued or running session is refused.
- **A dead draft workflow was unmonitored.** `draftWorkflow` returns cleanly on a
  pause or completion; a run that died any other way was never restarted, because
  `draft.run` is only booked by a button, and nothing said the draft had stopped.
  The emergency auto-pick does not help either — the flag is read inside the live
  pick loop. The tick now re-books `draft.run` when the draft is `running` and its
  clock has been dead for three minutes, and records why.
- **A missed recap could not be re-run.** `reporter.run` and `sessions.book` were
  not bookable from `/admin/jobs`, and both dispatch on a `kind` the form had no
  field for. Both added, with the kind.
- **The commissioner audit log was write-only.** Every action writes a
  `commissioner_actions` row (§12.2) and nothing read the table. The last
  twenty-five are on `/admin` now.

### Left alone deliberately

- `runAgentSession`'s `!resuming` branch is unreachable today — the tick claims
  the slot before starting the workflow, so the row is always `running` on entry.
  It is defensive code holding an invariant, not a stub: deleting it would make a
  future caller that passes a queued session run without claiming a slot. Kept.
- `computePoints` in the engine has no production caller; the two live copies are
  in `packages/data` and `apps/web/lib/finalize.ts`. Worth collapsing, but the
  three agree today and moving scoring around before week 1 is the wrong risk.
  Recorded here so it is a decision rather than an oversight.
- Simulation mode (`clock_override.now_at`) is read and never written, so
  `SIMULATION_MODE` silently falls back to the system clock. §15.3's simulated
  week is covered in-process by `apps/web/test/simulatedWeek.test.ts`, which runs
  a full week including the Sleeper-unavailable finalization, so the capability
  the flag exists for is tested. Wiring an admin control for it is not worth a
  new way to move production's clock.

### Smaller corrections

- `/admin/draft` numbered onboarding as step 1 and the draw as step 2, but
  `runOnboardingAction` refuses to run before the order exists (§10.1). A
  commissioner following the numbers got an error on his first click of the
  biggest day of the season. Renumbered.
- Starting the draft re-pulls the FantasyPros draft rankings (§5.7).
- Re-finalization now honours §13.4's Tuesday 9:00 AM cutoff, anchored to the
  week's own finalization rather than the calendar week.
- The trade-deadline sweep (§3.5) existed with no caller; it runs once, on the
  first tick after the deadline week.
- Team names are checked for uniqueness. Board mentions route by name, so two
  teams with the same one would each have received the other's mentions.
- Reversing a trade refuses unless every player is still where the trade left him,
  and re-checks the roster limit. It used to delete roster entries by player id
  alone, so a player since dropped or traded on was silently taken from whoever
  held him.
- `maxActive` was written out three times; one definition now, in `roster.ts`.
- A session can be stopped from `/admin/teams`. There was no way to.
- `web_search` was seeded at $0, so `/benchmark`'s cost-per-point silently
  excluded the one tool an agent can call without limit. Seeded at Tavily's list
  price; the commissioner edits it if the provider changes. The seed also wrote a
  price for `read_url`, which is not a tool.
- `robots.txt` and a sitemap; §17's BYOK checklist line, which could never pass
  since BYOK was removed on 2026-08-28, replaced with the gateway-billing check
  that is actually true.
- `docs/RUNBOOK.md` rewritten against the current code. It described a job queue
  that no longer runs sessions, a "Run now" button that behaves differently from
  what it said, a draft-day order that was reversed by `3e0f08b`, a re-finalization
  cutoff that was not implemented, and it did not mention check-ins at all.

### Questions for Jake

None blocking. Still waiting on him for the environment variables listed in the
go-live section below — `CRON_SECRET` is the one that matters today, because the
cron has been answering 401 every minute since the merge and nothing has ingested.

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
