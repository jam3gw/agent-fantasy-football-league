# Build Log

Newest entries at the top. Measured numbers, choices made, skipped items, and questions for Jake.

## 2026-09-08 — Front page: two defects seen on the live page after the layout pass

Looked at the deployed page an hour after the merge (the last trade window
was running). Two things were wrong. Branch
`claude/league-homepage-layout-4kkfii`, restarted from `main`.

- The "Next up" strip was a four-column grid; with three things ahead
  (nothing in review) the fourth column showed as an empty grey box. The
  strip is a flex row now, one cell per thing ahead, two per row on a
  phone.
- The stream read "Moves 0 · Talk 13": the agents had posted more than
  fourteen board messages since noon, and only board posts had reserved
  slots, so every move — the trades declined that morning, the adds — fell
  out of the window while the ticker still carried them. `reserveWindow`
  (pure, in `broadcastLogic.ts`, tested) holds slots per reservation:
  three for board posts as before, four for moves (anything not a board
  post and not the reporter), the rest newest first, the result re-sorted.
- Review (fresh reviewer): the move hold used its own rule where the Moves
  tab uses `laneOf` — a "board reply" decision is talk to the tab and was
  a move to the hold, so a hot board hour could fill the move slots with
  replies and read "Moves 0" again; the hold uses `laneOf` now. A window
  smaller than the holds' total could drop the newest item of all, which
  is the lead — the newest item is held first, whatever it is. Tests for
  both and for the overlap case. Noted, no change: held moves about one
  trade still fold under the lead as "the story so far", so the Moves tab
  can read a smaller number than the window holds.
- Review round 2 (fresh reviewer): the decision log is one table for every
  session kind, so the fourteen-row cap on that source could be all
  `board_reply` lines before the window's holds ran — it is read as two
  sources now, the board kinds and the rest, each with its own cap. The
  reservation list moved into `activityWindow` (pure, `homeLogic.ts`) so
  the wiring itself is tested: a board reply takes no move slot, the
  reporter's failed session is not a move, the newest item is the lead.
- Review round 3 (fresh reviewer): nothing new. It ran the two decision
  queries against a PGlite database seeded with every session kind:
  `like 'board%'` returns `board_reply` alone, `notLike` the other twelve,
  and `kind` is NOT NULL so nothing is lost. Not done: a DB-backed test of
  the split — `leagueActivity` reads `db()` rather than taking an
  `EngineDb`, so the test needs the injection `readLastMove(db)` has;
  the pure window is tested and the query was checked as above.

## 2026-09-08 — Front page: next-up strip, story folding, stream tabs, compact matchups

Jake asked for a better front-page layout. Measured against the live page
(week 1, Tuesday before kickoff): the lead was a raw decision line with
parentheses at 54px; the same trade filled the lead, the first stream item
and the ticker; the stream column had no title; six matchup tiles all said
"Scheduled · not started"; the power rankings were twelve paragraphs; the
season timeline had two cards; the next kickoff sat in an 11px label.
Branch `claude/league-homepage-layout-4kkfii`. Spec §12.1 is unchanged: the
page still carries every item the `/` row lists.

- `lib/homeLogic.ts` (pure, tested): stream lanes, story folding by trade or
  thread number, the power-rankings split, the "Next up" cells, the
  countdown, and the small layout decisions.
- Lead: headline cut at 120 characters and body at 220 at a word; older
  items about the same trade or thread fold under it as "The story so far".
  Folding is presentational and keyed on the number the agents themselves
  write ("Trade 41", "Thread 130"); items that name none stay separate.
- "Next up" strip: the week's next kickoff, trades in review (count and the
  soonest clock; nothing about votes, §3.5), the next daily waiver run
  (only when the waiver job is gated on, §6), and the reporter's next
  scheduled session (§11 times, ET). Soonest first; a cell exists only for
  something ahead. Hidden before the draft.
- Stream: titled "Around the league" with All / Moves / Talk / Reporter
  tabs in a small client component; the items render on the server and
  the tabs only choose which show. Board posts keep their reserved slots.
  Activity window widened from 8 to 14 because folding compresses it.
- Matchups: a compact two-line row per game until a game of the week has
  begun, then the tiles as before. W-L records next to names once a game
  has been played (`computeStandings`, not a formula of the page's own).
- Power rankings: top three with reasons, the biggest riser and faller
  below them with reasons (none on a first edition), the rest as a ladder,
  and a link to the full edition. Still the reporter's edition and
  movement, nothing computed here.
- Season timeline: the cards wait for four events; until then one line of
  text under the same links row.
- Not done from the brainstorm: a game-day reorder (matchups above the
  stream while games are on) and a model scoreboard strip. The strip is
  close to the leaderboard band the commissioner cut on 2026-09-05, so it
  waits for Jake.
- Local check: the sandbox cannot open a TCP connection to Neon (postgres-js
  on 5432; only HTTPS leaves the sandbox, same as the 2026-08-28 note), so
  the visual check is against the Vercel preview deploy, not a local run.
- Review round 1 (fresh reviewer): the ladder had dropped the reasons for
  places 4–12, against §11 and §12.1 — every place shows its reason again,
  the ladder only sets them at 12px; story folding swallowed board posts
  and reporter items that named a trade, against the reserved slots — only
  the moves lane folds now; the reporter countdown ignored the §4.3 job
  gate — `jobsGatedOn` (pure, tested) gates both the waiver and reporter
  cells; `storyKey` read "trade 2 RBs" as Trade 2 — a name is now a
  capitalised "Trade N"/"Thread N" or a "#N"; `formatEtRecent` on a future
  date lost the date past six days — `formatEtAhead` for the strip; the
  reporter's own decision-log lines were bylined "The league". Tests for
  each, plus `inLane`, the DST and on-the-dot reporter cases, the
  "clock unknown" review cell, and `compactMatchups` with an unknown game.
- Review round 2 (fresh reviewer): nothing against the spec. Fixed: a
  sentence-opening imperative ("Trade 2 bench WRs for an RB2") or a ratio
  ("Trade 3-for-1") still keyed a story — a name that opens a sentence and
  is followed by a lower-case word is no name now, and a number followed by
  a hyphen never is; the cost, recorded in the code, is that "Trade 43
  clears review" stays its own story. The "Next up" countdowns were frozen
  at render time in an open tab (the pulse stamp carries no clock) — a
  small client component now ticks them every half minute, hydrating on
  the server's text. A failed reporter session was filed under Moves —
  `laneOf` takes the actor. Tests for each, the reporter case of story
  folding, and the six-day boundary of `formatEtAhead`. Not done: a unit
  test for `nextWaiverRun`'s gate with stubbed settings — the gate itself
  is `jobsGatedOn`, tested; the wrapper is two lines.
- Review round 3 (fresh reviewer): the page read `new Date()` where §4.3
  wants `Clock.now()` — it reads `leagueClock()` now, like `/trades` and
  `/spend`, so the strip follows the override under simulation (the
  ticking countdown in the browser necessarily uses the browser clock);
  "Plan: Trade 2 bench WRs" slipped past the sentence-opening rule — a
  colon, semicolon, dash or line break opens a sentence too; the ticking
  countdown said "now" where a fresh render says "clearing" — each cell
  carries its past-word and the component uses it. Tests for each, the
  `at: null` assertion, and a DOM test for the countdown (hydrates on the
  server's text, ticks, clears its timer on unmount).
- Review round 4 (fresh reviewer): nothing against the spec. Fixed: the
  headline and body were joined with a space, so a body that opened with
  the imperative read as mid-sentence — joined with a line break now; a
  bracket or a quote opens a sentence too. Tests for both.
- Review round 5 (fresh reviewer): nothing against the spec. Fixed one
  real bug: an unfoldable item (a board post, the reporter) that named a
  trade still registered the story key, so it took the older moves about
  that trade under itself and split the moves' story in two. Only a
  foldable item opens a story now, and only the first under a key. Test
  for the three-item case (move, post, move).
- Review round 6 (fresh reviewer): nothing against the spec, no bug. One
  wording point: the kickoff cell said "Week N kickoff" for the week's
  next game even after Thursday's had been played — it says "Next
  kickoff" once a game of the week has begun. Test. The loop ends here.

## 2026-09-08 — Cost tracking checked on session 2598; sub-cent step costs now visible

Jake asked whether cost tracking is working for `/sessions/2598`. It is:
ledger rows, session totals, token columns, team and league rollups, and
both pages agree with each other, and the gateway's own cost matches the
price table on all 12 steps (full table in `docs/VERIFIED.md`). This closes
the §8.7 **verify** on the gateway cost field.

Two things came out of the check:

- Every step on that page read "$0.00" because `money()` rounds to the
  cent and the Contributor-tier model costs $0.0002–$0.0031 a step. Added
  `stepMoney` (four places under a cent, "<$0.0001" below that, two
  otherwise) for the per-step figure on the transcript. Totals unchanged,
  including the live thinking card, which shows the session's running
  total — a fresh-context review caught the first draft applying the step
  formatter there.
- Anthropic steps (Fable 5, Sonnet 5) record `source = price_table`: the
  gateway reports no cost for them, so the spec's fallback applies. Left
  as is — the fallback uses the same catalog prices — and noted so nobody
  reads the `/spend` source column as a billing gap.

## 2026-09-08 — Production health sweep: unchanged, but kickoff (and spend) resumes tomorrow

Ran the standing ops checklist against production. No code changes.

- `/api/healthz` — `200`, `lastTickAt` under a second old.
- `health` table — `cron.tick`/`sessions.sweep`/`tick.capacity` all fresh.
  The same 2026-08-29 `tick.*` errors (fixed `league_settings` query) sit
  under otherwise-current keys, not current faults. `nflverse.player_stats`
  still 404s, unchanged since 2026-09-01; `sleeper.stats` remains healthy
  and primary.
- `scheduled_jobs` — 759 done, 140 due and none overdue, the same 6
  `failed` rows from 2026-08-29/30 — not reproduced since, no new failures.
- `sessions` — 0 `running`, 0 queued past `due_at` by 15+ minutes, 0 new
  failed/timed_out since the last sweep (the same 8 `timed_out` rows on
  record). Still quiet since Sept 5 (no spend); the 119 queued rows (105
  `lineup_check` + 14 `self_check_in`) are booked for week 1 and correctly
  not due yet — the first of them (Thursday night kickoff) comes due
  tomorrow, Sept 9 ~22:00 UTC.
- `gateway.credits` — balance still **$78.93**, unchanged for the third
  day running because no sessions have run since Sept 5. Kickoff is now
  tomorrow: once lineup checks and self check-ins start firing Sept 9,
  spend resumes and could run through $78.93 fast. Already flagged
  directly to Jake on 2026-09-06 and reconfirmed unchanged on 2026-09-07;
  flagging once more since this is the last sweep before spend resumes —
  he still needs to top up the Vercel AI Gateway balance (and check
  auto-top-up) before tomorrow evening, or every team's session fails at
  $0.
- Vercel — latest production deploy `READY`
  (`dpl_HhLLxfbnM3yfR2BuDbJbyZRVMju7`), zero runtime errors in the last
  24h.

Nothing to fix in code; the one open item is Jake funding the AI Gateway
balance before Sept 9 evening.

## 2026-09-07 — Production health sweep: unchanged from yesterday, no new alarm

Ran the standing ops checklist against production. No code changes.

- `/api/healthz` — `200`, `lastTickAt` 26s old.
- `health` table — `cron.tick`/`sessions.sweep`/`tick.capacity` all fresh. The
  same 2026-08-29 `tick.*` errors (fixed `league_settings` query) sit under
  otherwise-current keys, not current faults. `nflverse.player_stats` still
  404s (`player_stats_2026.csv` not published), unchanged since 2026-09-01;
  `sleeper.stats` remains healthy and primary.
- `scheduled_jobs` — 711 done, 105 due and none overdue, the same 6 `failed`
  rows from 2026-08-29/30 (retired FantasyPros ingest, one `digest.weekly`
  `toFixed` bug) — not reproduced since, no new failures.
- `sessions` — 0 running, 0 queued past `due_at` by 15+ minutes, 0 new
  failed/timed_out since the last sweep (the same 8 `timed_out` rows on
  record, all Aug 30 draft day / Sept 2-3). No `scheduled_jobs` row stuck
  `claimed`. Quiet since Sept 5 15:37 ET (2 sessions, $0.37) — expected: no
  lineup/waiver activity between the trade-deadline stretch and week 1's
  first kickoff (Sept 10 00:20 UTC); the 119 queued `lineup_check` rows are
  booked for that week, correctly not due yet.
- `gateway.credits` — balance still **$78.93**, same as yesterday's flag,
  because zero sessions have run since Sept 5 (no spend). Not worsening
  today, but still under the $100 alarm line with kickoff three days out;
  already flagged directly to Jake in the 2026-09-06 entry below, so not
  re-flagged — he still needs to top up the Vercel AI Gateway balance before
  Sept 10.
- Vercel — latest production deploy (`dpl_12R3TCLiNGksMfoE4z2xRSUQ44cz`,
  yesterday's health-sweep merge, PR #11) `READY`; zero runtime errors in
  the last 24h.

Nothing to fix; nothing new to flag.

## 2026-09-06 — Production health sweep: green except the AI Gateway balance

Ran the standing ops checklist against production. No code changes.

- `/api/healthz` — `200`, `lastTickAt` seconds old. `cron.tick` is current.
- `health` table — every `tick.*` key has a fresh `last_success_at`; the
  errors sitting under `tick.stall_watchdog`/`tick.trades`/`tick.retries`/
  `tick.live_scores`/`tick.games` are all dated 2026-08-29 (a since-fixed
  `league_settings` query) and every one of those keys has succeeded every
  tick since — not current faults.
- `scheduled_jobs` — 625 done, 157 due and none of them overdue, 6 failed
  (all from 2026-08-29/30, the retired FantasyPros ingest and one
  `digest.weekly` `toFixed` bug — old news, not reproduced since).
- `sessions` — 0 `running`, 0 `queued` past its `due_at` by more than a few
  minutes (the 119 `queued` rows are `lineup_check`s booked for this coming
  week, correctly not due yet), 0 `failed`/`timed_out` since the last
  sweep (the 8 `timed_out` rows on record are all Aug 30 draft-day gateway
  hiccups and Sept 2-3 board-reply timeouts).
- Vercel — latest production deploy `READY`, zero runtime errors in the
  last 24h.
- **`gateway.credits` is genuinely alarming**: balance $78.93, under the
  $100 line, and the tick's own daily notice already fired today. Spend
  ran $10-18/day on the active days this week (Sept 1-4) and week 1 games
  are live today, so the balance heading toward $0 this week is real, not
  a stale alarm — at $0 every team's session fails at once. This needs
  Jake to top up the Vercel AI Gateway balance (and check auto top-up);
  nothing in code fixes it. Flagged to Jake directly rather than left for
  the next digest email.
- `nflverse.player_stats` 404s since 2026-09-01 (`player_stats_2026.csv`
  not published yet) — expected for the secondary source this early in
  the season; `sleeper.stats`, the primary, is healthy. Not actioned.

## 2026-09-05 — Home page redesign: the agents' activity leads, the ticker is the wire

Jake mocked the new home page up in Claude Design (`Home.dc.html` in the
handoff) and chose the direction in the design chat: the agents' activity
feed front and centre, the leaderboard band cut, everything else kept, and
the score ticker replaced by a news ticker until games are actually on.
His words: "too much irrelevancy going on, and the headlines are not popping
off the page". Implemented as designed; the pieces:

- **Lead story.** The newest item in the activity stream is the headline:
  54px, with the rest of what was said as the standfirst, a byline (team and
  model; "The reporter" and its model; "The league") and a link into the
  session that produced it when one is known, else the page it lives on.
  `splitHeadline` (broadcastLogic) breaks an agent's paragraph at its first
  sentence that is long enough to say something and short enough to set big,
  never inside an inline token; the body is whatever the headline did not
  use, so nothing is said twice. Tested.
- **The stream** runs under it beside compact matchup tiles. The reporter's
  posts join the stream as a fifth source. Board posts keep their reserved
  slots (§12.1 still wants them on the home page). Eight items: one lead,
  seven in the stream.
- **The wire** (`leagueWire`): trades as they move through their statuses,
  processed waiver claims, waiver runs, and reporter headlines — read
  separately and merged newest first, ten lines, looping at 64 s. It never
  carries an offer's message (§11). While an NFL game is live the ticker
  swaps fully back to scores with the "N games live" pill; before the wire
  has anything to say the week's games are the fallback so the band is not
  empty in week 1. The masthead stamp reads "Last move 10:14 AM ET" between
  games (`lastMoveAt`, one statement of scalar subqueries) and "Updated …"
  during them.
- **Leaderboard band removed** (`components/leaderboard.tsx` deleted). It was
  the home page's standings surface; §12.1's row for `/` is updated, and the
  standings are one click away in the bar and in the "Season so far" links.
  The "Around the league" card grid went with it — the design carries those
  links as a row on the timeline header instead. `benchmarkRows` stays for
  `/benchmark`; the home page no longer reads it (its team names come from
  the cached `allTeams`, and the power rankings are the reporter's).
- **Report and power rankings** swap sides on the alt band (report left, as
  designed). Quiet text there is `--muted`, not `--faint`, which is under AA
  on that surface (globals.css). The rankings are the reporter's edition,
  all twelve teams with a reason each (§11) — see "Merged main" below; the
  design's four rows was a placeholder count.
- Matchup tiles show one number a side: the projected total before kickoff
  (marked `proj`), the score once started. The bar is the away side's win
  chance while the game is on rather than the design's share of points,
  because the chance is the number the site already stands behind.

Checks: lint, typecheck, 859 tests, and `next build` against an unreachable
database (every read degrades; `/` prerenders at 30 s).

### Review round 1 (fresh-context reviewer, 24 findings, none blocking)

Fixed:

- `superseded` on the wire credited the proposer with replacing its offer;
  the engine supersedes an offer when another trade in review takes one of
  its players. Reworded, and every ending now has an exact test.
- Stamps. `formatEtRecent` is a clock today, weekday + clock within six
  days, and a date after that — the wire keeps the five newest of each kind
  whatever their age, so a three-week-old trade read as last Thursday. The
  masthead's "Last move" and the matchups header use the same format instead
  of a bare clock. Tested (`test/formatRecent.test.ts`).
- The matchups header showed a past kickoff as upcoming all Monday night
  through Tuesday. `nextKickoff` offers the kickoff only while it is ahead
  (the comparison sits in the read, where a test can pass `now`; render
  time is still the clock, the same as every read's default), and a fully
  played week says "all final".
- `splitHeadline` on a heading over bullets was one run-on cut mid-list.
  A line break now counts as a sentence end: `closeLines` puts a full stop
  on every line that stops without one, outside fenced code, leaving rules
  and lines ending in `:`/`,`/`;` alone. Abbreviations (`vs.`, `e.g.`) no
  longer end a sentence. The old test enshrined the run-on; replaced.
- The reporter's newest post led the page, headed the weekly-report card
  and ran on the wire — three times every Tuesday and Thursday morning.
  The stream now leaves the newest report out (its section is on the same
  page); older posts stay in.
- The body under a headline was re-flattened, which stripped a "2." it
  started with. `truncateFlat` is the cut without the flatten; tested.
- A failed session as the lead wore accent green and a live dot. It is
  `--danger` with no dot now.
- Wire lines were links: ten tab stops ahead of the primary nav on every
  route, and focusing one the track had carried out of view scrolled the
  viewport off the loop's seam. They are text, like the score ticker's
  items. The track pauses on hover and on focus-within.
- Masthead query count went from 6 to 16–17 per render, and the home page
  repeated seven of them. `settings`, `allTeams`, `liveStatus`,
  `leagueWire` and `lastMoveAt` are React `cache`d per request;
  `lastMoveAt` is one statement of scalar subqueries (the pulse pattern)
  and now also covers `trades.updated_at` and `waiver_claims.processed_at`,
  which move without writing a transaction. Masthead: 6 + 6 + 1 = 13 on a
  cold render, of which the home page re-runs none.
- `/llms.txt` described the old home page. Updated.
- "Week N matchups" and "Season so far" are `h2`s. Stale leaderboard
  comments removed. `describeWaiverRunWire`'s dead week branch removed.

Not fixed, and why:

- A paragraph that is one bold token longer than the window still strands
  `**` at the cut. Pre-existing in `summarizeBody`; `tokenSafeCut` has no
  earlier point to retreat to when the token starts the string.
- Reporter items link to `/report`, not to the session that wrote them: a
  reader who clicks "Read the full report" wants the report.
- "Read it on the board" lands at the top of `/board`; posts carry no DOM
  id. Worth a `post-{id}` anchor on the board page in its own change.
- The pulse stamp does not cover `trades`/`waiver_claims`, so a wire line
  produced by cron (expiry, window-end veto) waits for the next ISR window
  in an open tab. A one-line addition to `pulse.ts`, but that stamp has its
  own tests and is not this change's.
- `decision_logs` has no `created_at` index; `leagueActivity` sorted on it
  before this change too. Worth an index migration on its own.

### Review round 2 (11 findings, none blocking)

Two were regressions from round 1's `closeLines`, both fixed and tested:
a stop inside a closing token (`**Start Gibbs.**`) got a second stop after
it, and a one-line fence (```` ```quick``` aside ````) flipped the fence
state and swallowed every line after it. Also fixed:

- "No." and "St." are abbreviations only ahead of a number, so a sentence
  can end in "no.". Marker-only lines and table rows get no stop.
- `nextKickoff` is now the week's next unplayed kickoff, not only the
  first: on a Saturday the matchups header says "kickoff Sun 1:00 PM ET"
  rather than falling back to the last move.
- "Last move Aug 28 ET" no more: `formatEtRecent` takes the zone itself and
  adds it only to the forms that carry a clock.
- `lastMoveAt` also covers failed sessions and waiver runs — the two
  sources the stream and the wire read that it missed — and is split into
  `readLastMove(db)`, exercised against a real schema in
  `test/lastMove.test.ts` source by source (the correlated-subquery trap),
  and the cached, degrading `lastMoveAt` the pages call.
- `WireItem.href` was dead once the lines became text; removed.
- `plainExcerpt` keeps underscores, like the renderer (`pts_allow_14_20`).
- Stale wording in this log's top entry and in a `SectionHeader` comment.

### Review round 3 (4 findings, none blocking)

- Round 2 made "St." an abbreviation only ahead of a digit, and the
  headline cut "Amon-Ra St. Brown" in half. "St." holds ahead of a capital
  or a digit now; tested.
- The fallback `Week N` score ticker labelled every unplayed game "live"
  beside 0.00 · 0.00. Pre-existing, but this branch shows that ticker only
  when nothing is live, so it was wrong every time. It says "scheduled".
- A line that was only a number became "12." and the flattener dropped it
  as a list marker. Bare numbers are not prose to close; tested.
- Round 1's note said the kickoff comparison left the page because the
  purity lint rejects `Date.now()`; round 2 then wrote `new Date()` in two
  components. The note now gives the real reason (a read can take `now`
  from a test), and `formatEtRecent` takes `{ now, zone }` with render time
  as its own default, so no component body constructs a clock.

### Review round 4 (5 findings, none blocking)

A test title promised "St." still ends a sentence on its own, which the
round-3 rule does not do (every next sentence starts with a capital);
retitled to what it asserts. Three stale comments corrected. The fallback
score ticker now says "in progress" for a game with points on the board
between windows rather than "scheduled" — reachable only while the wire is
empty, fixed so nothing later leans on it.

### Merged main, 2026-09-05

`main` gained the reporter's power rankings (an edition per
`reporter_power_rankings` session, a reason per place) and retired the
scheduled trade window while this branch was in review. Merged rather than
rebased so the reviewed commits keep their SHAs. The alt band's power
rankings are the reporter's edition now — its week, the publish time, a
"How it decided" link to the session, and all twelve rows with the
reporter's reason (§11), where this branch had shown six computed rows.
Before an edition exists the heading says the reporter has not ranked the
teams yet, with a line on what will appear. The home page no longer reads
`benchmarkRows` (`/benchmark` and `/teams` still do); the `/` row in §12.1
carries main's wording about the rankings.

## 2026-09-05 — No scheduled trade window; agents book a check-in to trade or post

Jake asked whether the league forces agents to look for trades. It did: a
`trade_window` session for every team at noon on Wednesday and Friday, with a
brief that starts "Look for trades". Jake's decision: do not force it. An agent
that wants to look for trades, or to post on the board, books a check-in for it
(§8.10). Same rules for all twelve, so the benchmark stays fair — the option is
equal, the use of it is the agent's.

- Scheduler: `bookRecurringJobs` no longer books `sessions.book` for
  `trade_window`. A row already queued in production for the next 48 hours
  books nothing when it fires (`runJob` returns early on that kind), so no
  data delete was needed.
- Check-in tool set gains `propose_trade`, `cancel_trade`, `post_message`. It
  still cannot book another check-in or vote. The 3-offers-per-day limit
  (§3.5) and the check-in limits (3 pending, 5 per week) bound trade activity.
  I did not raise the per-week check-in limit: five looks a week is more than
  the two trade windows the league ran this morning.
- Briefs: `self_check_in` carries the old trade-window steps for a check-in
  booked for that reason; `weekly_review` and `post_waivers` tell the agent the
  league runs no trade window and that it is not required to trade. The
  `schedule_check_in` description and the `scheduled_sessions` note say the
  same. `trade_window` stays as a kind for the commissioner's manual button on
  `/admin` and for the sessions already in the transcripts; its brief now says
  the commissioner opened it.
- Removed the `extra.tradeWindowDays` setting, its `/admin/settings` field,
  and the `tradeWindowDays`/`parseTradeWindowDays`/`isTradeWindowDay`
  helpers. Any value still in `league_settings.extra` in production is inert.
- Spec 1.11: §2, §8.5 context, §8.6, §8.10, §9.1, Appendix F. README, about
  page, and tests updated. `pnpm check` green: 868 tests.
- Review round 1 (fresh reviewer): fixed stale comments in `jobs.ts`,
  `context.test.ts`, `watchdogs.test.ts`; dropped `trade_window` from the
  `/admin/jobs` kind list so no admin path books one; the check-in brief now says
  to skip trades after the deadline (the engine refuses them anyway); added
  `self_check_in` rows to the §8.3 and §8.6 tables (a pre-existing gap); a
  test that `propose_trade` and `post_message` reach the engine from a
  `self_check_in` session; §15.3 and Appendix F wording. Not changed: the
  "3 offers per rolling 24 hours" literal in the brief mirrors the
  `trade_window` brief and the system prompt renders the setting too.
- Review round 2: the round-1 version made a queued `trade_window` booking row
  throw, which would have put the one row already on the production calendar
  under "Failed jobs" on `/admin/health` for a week. Reverted to "books
  nothing" with a log line: the row was queued before the change, no admin
  path can queue another, and a false failure is noise for Jake.
- Not run: the review loop's live session against the preview. This session
  has no `.env.local` and no admin credential, so it cannot open a `manual`
  or check-in session on the preview. The tool path is covered by
  `writeTools.test.ts` (propose and post from a `self_check_in`), and the
  first real check-in that shops a trade will show on `/sessions`; I will
  read that transcript when it lands.
- Cost: Appendix F's note updated. If agents do not book trade looks at all,
  the saving is the whole trade-window share (about 44% of tokens before this
  morning's cut). If every agent books five check-ins a week for trades it is
  a net increase over two windows, which the `agent_week` alarm will show.

## 2026-09-05 — Jake: the reporter ranks the teams, with a reason for every place

Jake looked at the home page's power rankings — "The Grimm Reapers, 1: spends
the most in the league at $20.25, for 0.0 points" — and asked whether the
reporter should be ranking the teams instead, with reasoning. It should; §11
had said so since v1 and the page had quietly grown its own formula on
2026-08-29 (win rate 0.5, points 0.35, lineup efficiency 0.15) because the
redesign wanted a rankings block before the first recap existed. Before a game
is played every input is zero, so the order was team-id order, and the "note"
under each team was a fact chosen from a fixed list (spend, bad tool calls,
bench points) that has nothing to do with why a team is ranked where it is.

**What changed.**

- A new reporter session kind, `reporter_power_rankings`, whose only ending
  tool is `publish_power_rankings`: every team once, ranks 1–12 with no
  repeats, one or two sentences of reasoning each (≤ 400 chars). The engine
  validates the whole set and writes it as one edition in one transaction;
  a session publishes once. `publish_report` is not in this kind's set, and
  `publish_power_rankings` is not in the post kinds' sets, so no session can
  end on the wrong tool (`toolsets.test.ts` walks every reporter kind).
- `get_power_rankings` (all reporter kinds): the newest edition with each
  team's reason and its movement, so the reporter can explain what changed
  and the recap can point at the list instead of repeating it. The recap brief
  loses its "rankings 1–12" item.
- Booked Tuesday 10:30 AM ET, ahead of the 11:00 recap and the 11:30 digest,
  and once after `draft.completed` (20 minutes after the grades) for a
  preseason edition. The site shows the newest edition; movement is against
  the one before, so an arrow means the reporter changed its mind.
- The home page reads the edition (all twelve, with the reason as the line
  under each team and a link to the session that decided it); `/report`
  carries the same list above the posts. `powerScore` and `rankingBefore`
  and their tests are gone. `benchmarkRows()` is still read once for the
  leaderboard band.
- Table `power_rankings` (migration 0007): unique on `(session_id, team_id)`
  and `(session_id, rank)`. `pulse` includes its max id so the pages refresh
  when an edition lands.

**Choices.** An edition is keyed by session, not by week, so a re-run never
overwrites and a preseason edition and a Tuesday edition in the same fantasy
week both survive. `week` on the row is the week in play when it was
published, for the heading. The reporter is told to rank on results, roster,
moves, and lineup management — and, before the first game, on the draft and
the trades — and to read its previous edition first. It is not shown the
retired formula.

**Review round (fresh context).** Two real findings, both fixed. (1) A
rankings session was keyed by week like the recap, and `createSession` is
on-conflict-do-nothing — so next Tuesday's 10:30 run, in the same fantasy
week as today's edition, would have created nothing, silently, and so would
the runbook's "book it again". Rankings sessions now key on the booking
minute; post kinds keep the week key. Test added. (2) A session interrupted
between the engine insert and the recorded tool result would resume, call
`publish_power_rankings` again, be refused, and fail `no_report` with a live
edition on the site. The engine now returns the edition already under that
session as a success (`already_published: true`); the check moved inside the
transaction. Spec §8.2 step 4 and the §9.3 `draft.completed` row now name the
new kind. Round two: keying on the booking minute reopened a narrower hole
— a `reporter.run` row the tick re-runs after a stale-claim release would
have booked a second edition — so a rankings session is keyed to its job
row (`job<id>`), with the minute only as the fallback for a direct call; and
the edition-on-file check now runs before validation, so a resumed model
that resends a broken set still ends on the edition it already published.
Both have tests, including the resume itself in `session.test.ts`. Not done, recorded: the write records no `transactions` row and
emits no event — the same as `reporter_posts`, since a ranking is the
reporter's opinion and not league state; the zod cap of 12 mirrors the
league's fixed size (§2) while the engine checks against the real team count.

**Today's edition.** Jake asked for a ranking now, since the draft and six
trades are in. After the production deploy (migration 0007 applied by the
build; `/api/healthz` ok) I booked `reporter.run` with kind
`reporter_power_rankings` — the same row `/admin/jobs` "Book a job" writes.
Job 2126 ran on the next tick and booked session 2261 (key
`...:1:job2126`); the sweeper started it and it ended on
`publish_power_rankings` after 5 tool calls. Two of them were invalid, both
handled by the §8.8 nudge: the first sent the arguments as a JSON string
instead of an object, the second ran two reasons past the 400-character
cap. The cap stays — the reasons it then published run 250–400 characters
and read as one or two dense sentences, which is what the page wants.
Preseason edition, week 1: The Gibbs Sample first ("the deepest, most
talented 15 in the league"), The Gibbs Factor twelfth (fewest projected
starting points, an empty FLEX, three lateral trades). It named the empty
FLEX on Five Alarm Spark too, and Moonshot Marauders' twenty lineup flips
in an hour — the kind of reason the formula could never have given. Live
on `/` and `/report` once the 300 s cache turned over.

## 2026-09-05 — Sitemap: dropped the `/players` index URL

The sitemap listed `/players`, but no players index page exists. Only
`/players/[id]` does, and SPEC §12.1 specifies only the player card. The
URL returned a 404 to crawlers. Removed `/players` from the sitemap's page
list. No index page was built: the spec does not ask for one.

## 2026-09-05 — `/llms.txt` for outside agents

Jake asked whether an `llm.txt` would help agents (ChatGPT, Claude Code)
read league stats from the site. Yes: §12.1 already promised the public JSON
API "for future tools" but nothing on the site told a tool it existed. Added
`/llms.txt` in the llmstxt.org shape (H1, summary quote, H2 link sections).

- Built by `apps/web/lib/llms.ts` and served by `app/llms.txt/route.ts`, not a
  static file, so it carries the live season, week, phase, and team slugs,
  and its links are absolute. Base URL: `SITE_DOMAIN`, else Vercel's
  production URL, else relative links. Route cached 300 s like the other
  non-live pages.
- Reads go through `safeRead`; with the database down the guide still
  serves, with the status and team list empty.
- `test/llms.test.ts` compares the documented routes to the files under
  `app/api/public`, so a new route without a line in the guide fails CI.
- Not rate limited: it is one cached document, and it should not eat a
  tool's 60-per-minute data budget before the tool makes its first call.
- Skipped: a `/llms-full.txt` with full response schemas. The route
  handlers are the schema; the guide names the fields a reader needs.
- Review round (fresh-context reviewer): six statements in the text were
  loose or wrong (which responses carry the current week, the real matchup
  lineup keys, the separate rate-limit windows for pulse and live, the 404
  shape, missing pages, vague playoff fields). All fixed. The transaction
  type list now lives in `lib/transactionTypes.ts`, used by the route, the
  guide, and the test, with a compile-time completeness check against the
  engine's union. The `VERCEL_PROJECT_PRODUCTION_URL` fallback is dropped:
  §15.5 says public pages expose no environment values, the sitemap uses
  `SITE_DOMAIN` only, and on a preview it pointed every link at production.
  Tests added for the base URL and for a season with no week yet.
- Known: a database blip during a regeneration caches the empty status and
  team list for the 5-minute window, the same as every other cached page.
- Found by the reviewer, outside this change: `sitemap.ts` lists `/players`
  but no such page exists (only `/players/[id]`). Queued as a separate task.

## 2026-09-05 — Two transcript findings: no vote tool in a trade window, and why a player is frozen

Jake asked whether two findings from the trade-window transcripts were fixed.
They were not. Both are fixed here.

**No vote tool in trade-window sessions.** Votes are cast in the separate
`trade_vote` session the league starts for each uninvolved team (§8.6), but
every session kind saw `votes_owed` in its context and nothing said where
the vote happens. Several agents in a trade window looked for a vote tool;
Gemini (session 1906) concluded there was no way to vote, GLM invented a
board-vote rule. An earlier audit had left this alone because one session
handled it well. Now:

- The context snapshot and `get_league_state` add a `votes_note` next to
  `votes_owed` in every kind except `trade_vote`: the vote happens in a
  separate trade_vote session, this session has no vote tool.
- The system prompt gets one bullet, bound to the trade tools, saying the
  same. It names no tool the session cannot call (the prompt test for that
  rule still holds), and the trade_vote prompt does not carry it.

**Why a player is frozen.** Jake's rule change earlier today already removed
the hidden case (an open offer between two other teams no longer freezes
anyone; only a trade in review does, and review is league-visible). What was
left: the `frozen` failure named the player but not the trade, and no roster
tool showed the freeze, so an agent still had to search.

- `frozenPlayerTrades` (engine) maps each frozen player to the trade that
  holds him and its status; `frozenPlayerIds` is now its key set. A trade in
  review wins over an open offer for the same player.
- Engine failures name the trade: "frozen in trade 12 (in review)", "frozen
  in trade 12 (your open offer)", and for offers "P1 (trade 12)".
- `get_my_team` / `get_team_roster` carry `frozen_in_trade: {trade_id,
  status}` (null otherwise). `get_league_rosters` carries the trade id only
  when set. A trade in review shows to everyone; an open offer shows only to
  its owner (narrower than `get_trade`, which shows a `proposed` offer to
  both parties; the counterparty already sees it in `offers_to_me`).

Tests: engine messages, the three roster tools and the visibility rule, the
snapshot and `get_league_state` note, and the prompt bullet per kind.

Reviewer findings, fixed: Appendix C and §8.5 now carry the new bullet and
field; the bullet no longer says "ten" teams or promises a session that may
not come (paused and eliminated teams get none, and the session runs at
accept time, not "before the review ends"); `submitWaiverClaims` names the
trade too; a player in two open offers is named by the oldest one, stable
across calls; the dead `frozenPlayerIdsExcluding` wrapper is gone; tests
added for the reporter view, a `team_ids` subset, `addFreeAgent` and the
claim path, precedence and determinism.

Second pass: `get_pending_trades` said `i_can_vote: true` to every
uninvolved reader in every session kind, even after it had voted — the same
misdirection. It now carries `my_vote` (`not_a_voter`, `cast`, `owed`),
`i_can_vote` only in a `trade_vote` session, and the same `votes_note`
otherwise.

Left alone: `runWaivers` keeps the `invalid_drop` reason for a claim that
fails at run time because its drop is frozen — the reason is an enum shown
on the public transactions page, and the claim's own player row shows
`frozen_in_trade` by then. `get_matchup` and `get_trade` roster views carry
`locked` but not `frozen_in_trade`; neither is a place to decide a drop.

## 2026-09-05 — Jake: the same player may be offered to several teams; the first accept wins

Jake's decision, replacing the §3.5 freeze rule for open offers. Before, a
proposer's give-side player was frozen the moment an offer went out, so a team
could not shop one player to two teams and had to wait for a rejection or an
expiry (48 hours) before the next offer. Now:

- An open (`proposed`) offer binds nobody for other offers. A team may offer
  the same player to several teams at once, and another team may ask for a
  player who is already in an outgoing offer. Only a trade in review
  (`accepted`) freezes its players for offers.
- **First accept wins.** On accept, every other open offer that names any
  player in the accepted trade — either side, any team — ends as
  `superseded`, `resolution_reason` "superseded by trade N", `resolved_at`
  now. Its queued `trade_response` session is skipped with
  `MOOT_OFFER_REASON` (a healthy no-op, kept out of the digest's failure
  table like the retired vote sessions). `trade.superseded` is emitted per
  offer. The accept result and the `respond_to_trade` tool return the ids.
- Drops stay strict: a proposer's give-side player still cannot be dropped
  while an offer is open (`roster.ts` `frozenPlayerIds` is unchanged), so a
  player is never dropped out from under the offers he is in.
- The accept re-check now ignores other open offers, so the old failure mode
  — accept fails with `player_moved` because the counterparty had shopped
  the same player elsewhere — is gone; that side offer is superseded instead.

Reviewer findings, fixed: `respondToTrade` now locks the trade row and both
the accept and the supersede update are guarded on `status = 'proposed'`, so
two overlapping offers accepted at the same instant serialise instead of both
entering review (or the second flipping a superseded row back to accepted).
Second pass: row locks alone deadlock — accept A holds its row and wants
every other open offer, accept B the reverse — so propose and respond take
one transaction-scoped advisory lock (`pg_advisory_xact_lock`) before any
row lock. Accepts and proposes queue behind each other for a few
milliseconds; nothing else waits on it.
The expiry sweeps now retire an expired offer's queued `trade_response`
session too (`MOOT_OFFER_REASON_EXPIRED`); before, that session ran only to
get `bad_status`. Noted, not changed: superseded offers still count toward
the 3-offers-per-day limit — shopping one player to three teams spends the
day's quota. That is the spec's "offers per day", and the tool description
says the same player may go to several teams, so the agent can weigh it.

New trade status `superseded`: schema type, `/trades` offer list (verb and
reason shown), the agent's `get_trade` resolved set, tool descriptions for
`propose_trade` and `respond_to_trade`, SPEC §3.5 and §17. No migration: the
status column is plain text.

Tests: shop one player to two teams plus a third team asking for the other
side's player; accept one → the two overlapping offers are superseded with
the reason, their response sessions skipped, an unrelated offer stays open,
the superseded offer cannot be answered, and the player is frozen for new
offers while in review.

## 2026-09-05 — Trade roster reservation counted incoming players without crediting outgoing ones

Trade 34 (Second Overall → Gridiron Gambit, Addison for Aaron Jones, one for
one) failed on accept with `roster_illegal`: "the trade would put the
counterparty at 15 active players". Gridiron Gambit had a separate one-for-one
(trade 31) in review at that moment. `incomingReservedCount` held one spot for
that trade's incoming player and gave no credit for the outgoing one, so a
14-man team with any trade in review could not accept a second one-for-one.
Gridiron Gambit then read the error as Second Overall's roster being full and
asked it to drop a player, which would not have helped.

Fix, in `packages/engine/src/roster.ts`:

- The reservation is now the net gain of each trade in review, floored at
  zero, summed over trades. A trade executes or fails as a unit and its outgoing
  players are frozen, so the roster after any subset of these trades executes is
  at most the current size plus this sum.
- An outgoing player who sits in the week's IR slot frees the IR slot, not an
  active spot, so he does not offset an incoming player (reviewer finding).
- The helper takes `week` and an optional `excludeTradeId`; the duplicate copy
  in `trades.ts` is gone. Free-agent adds, waiver claims and trade checks all
  use the one function.

Spec reading: §3.5 and §7.2 say "incoming players count toward the limit" and
give the reason — so a later add cannot block execution. Net-per-trade keeps
that guarantee (new test: add to 14 beside a one-for-one in review, then the
trade executes) and stops the false rejections. Recorded here because it
departs from the literal text.

Not changed: board-reply sessions still have no roster tools (§8.6). Second
Overall said on the board it would drop a player and resend; it gets a trade
window session today at 12:00 PM ET with `drop_player` and `propose_trade`.
Also not changed: a lineup change can move a frozen IR occupant out of IR
without any reservation check; that was true before and is out of scope.

Checked on request: the same player offered to two different teams at once.
The engine already refuses the second offer with `frozen` (§3.5: a
proposer's give-side player is frozen while the offer is `proposed`), and
refuses a third team asking for him. The freeze lifts when the first offer is
rejected, countered, cancelled or expires. Production has no case of two open
offers sharing a give-side player. Added an explicit test that names the
scenario and checks the player is offerable again after the first offer ends.
## 2026-09-05 — Weekly price sync from the gateway catalog; Mistral seed corrected

Jake asked for discounts the league could take without changing a model. The
catalog scan (all 373 entries) found none left beyond the two seats already
moved (Muse Spark contributor, GLM promo); the levers that remain are provider
programs on Jake's own keys (xAI data-sharing credit, OpenAI flex tier and
data-sharing tokens, Google Cloud trial via Vertex BYOK), recorded in the
chat for Jake to set up, each to be verified with one session when he does.

Found on the way: `model_prices` had never been refreshed after the
2026-08-29 seed, though §8.7 says "refreshed weekly", and Mistral Large 3 sat
at $2 / $6 against the catalog's $0.50 / $1.50. Nothing was misbilled —
gateway-billed steps record the gateway's own cost, and the four BYOK models'
rows matched the catalog — but the table prices BYOK steps and needs to be
right the day a price moves.

- `syncModelPrices` (`packages/agent/src/gateway.ts`) reads the catalog and
  upserts every id in the table plus every league and reporter model: base
  price per million (never the region-pinned rate; the ledger matches base for
  every gateway-billed seat), cache-read price or null, context window kept
  when the catalog omits it. An id the catalog lacks keeps its row and is
  reported; one a seat runs on becomes a `prices.sync` error row on
  `/admin/health` naming the swap as the fix — the GLM promo can end.
- Job `prices.sync`, Monday 3:00 AM ET, booked with the weekly fixtures;
  bookable by hand on `/admin/jobs`. A catalog that cannot be read fails the
  job (Failed jobs card) and changes nothing. Spec §9.1 row added.
- Mistral seed corrected in `MODEL_PRICE_SEED`; the production row updated
  by hand the same way the sync would (0.5 / 1.5 / no cache price / 256k).

Reviewer round (fresh context): job not in the bookable lists, a missing
`context_window` would have nulled a stored one, missing league ids only
logged, four test gaps, a doc comment overstating what `/spend` recomputes.
All fixed. Lint, typecheck, agent 206 and web 381 tests green.

## 2026-09-05 — Team 12: GLM-5.3 moves to the gateway's 50%-off entry

Slot 12 now runs `zai/glm-5.3-promo-50` (was `zai/glm-5.3`). **Reason:
price.** Jake's call ("might as well"). Same model, same features, 1,048,576
context; $0.70 / $2.20 per M (cache read $0.13) against the $1.40 / $4.40
US-regional rate the ledger had been paying, and the promo entry carries zero
data retention and no training for all requests where the standard entry
says "some". Catalog check in `docs/VERIFIED.md`. The seat had cost $3.57 for
the season, about $1 a day, so this is worth about $0.50 a day.

Done on production first (Jake's go-ahead), one transaction: the
`model_prices` row, the `teams` row, the twelve queued sessions for team 12
moved to the new id, the commissioner-action audit row and the public
`model_swapped` transaction — the same five writes `swapModelAction` makes.
Verified after commit: team 12 reads the promo id, no queued session carries
the old one. Then `LEAGUE_MODELS` slot 12 and `MODEL_PRICE_SEED` in
`packages/agent/src/models.ts` (the old id's seed stays for history), and a
`smoke` session queued for team 12 as §8.1 asks after a model change.

Label stays "GLM-5.3": same weights. No tier note on the site, unlike Muse
Spark's Contributor tier — the promo carries no training term. **A promo can
end.** If the id leaves the catalog, `checkGatewayModelId` in the outage
detector will not see it, but the sessions will fail; the fix is the swap
action on `/admin/teams` back to `zai/glm-5.3`, which moves the queued
sessions too.

## 2026-09-05 — Two trade windows, reasoning billed once, get_league_rosters (deployed)

Jake's three asks from the cost analysis below. Merged to `main` as `31e00f4`
after two reviewer rounds (round 1: the snapshot's calendar note still said
Wed–Sat, `/about` said four windows, an already-booked window would still
fire on a removed day; round 2: my "reasoning beyond output" hedge made the
visible output free — fixed, and the expected value in the test corrected).
Lint, typecheck, 824 tests green. Production healthy after the deploy
(`/api/healthz` ok, `/spend` 200, `/about` shows "Wednesday and Friday").

1. **Trade windows: two a week.** `extra.tradeWindowDays` (default `[3, 5]`,
   Wednesday and Friday) on `/admin/settings`; `bookRecurringJobs` reads it,
   and `sessions.book` re-checks it when a booked row fires, so a day removed
   after booking books nothing. Why Wed and Fri: the waiver run has just
   moved rosters on Wednesday, and a Friday offer, its response and a 24-hour
   review all finish before Sunday's kickoffs, which a Saturday window cannot.
   Production: `scheduled_jobs` 446 (Sat 2026-09-05) and 1846 (Thu
   2026-09-10) marked done with the reason in `error`; no session rows were
   ever created for them. Spec §2, §8.6, §9.1 and Appendix F updated. Saves
   about $10 a week at Friday's rate.
2. **Reasoning billed once.** `computeStepCost` no longer adds
   `reasoning_tokens × output price` on top of an output count that already
   includes them (the SDK reports reasoning as a share of output;
   `output ≥ reasoning` on all 628 price-table steps). A model with its own
   reasoning price pays the difference on that share; reasoning a provider
   reports beyond its output (none does) is billed in full alongside the
   output. Tests cover null, cheaper and dearer reasoning prices, and the
   beyond-output case.
3. **`get_league_rosters`.** Every roster in one call, one short row a player
   (`id, name, pos, nfl, slot, proj` plus `inj, bye, bye_now, season_pts,
   locked` only when set), starters first, paged by team under the §8.2 cap,
   `team_ids` filter. In `READ_TOOLS`, so every kind with read tools has it;
   `trade_vote`, `board_reply`, `draft_pick` and `smoke` keep their narrow
   sets. The scouting bullet in the prompt names it. Spec §8.4 row added.
   Measure next Wednesday: `get_team_roster` calls per trade window (was 11
   for most agents) and trade-window input tokens a step (was 46k).

**Reprice of the 628 overstated ledger rows: done 2026-09-05 ~04:05 UTC**
on Jake's go-ahead ("bulk update"). Backup first:
`spend_ledger_backup_20260905`, 628 rows, $44.1705 as recorded. After: $37.0781,
so $7.0923 removed (Fable $3.61, Grok $2.06, Sonnet $1.11, GPT Sol $0.19, GPT
Terra $0.12). Session totals and every rollup row recomputed from the ledger;
no session is out of step with its ledger sum. The statements, in order, all
against the production branch:

```sql
-- 1. the ledger rows (only the backed-up ids; no new row qualifies, checked)
update spend_ledger l
   set cost_usd = round((l.cost_usd
         - least(l.reasoning_tokens, l.output_tokens)
           * coalesce(p.reasoning_usd_per_m, p.output_usd_per_m) / 1e6)::numeric, 6)
  from model_prices p
 where p.model_id = l.model_id
   and l.id in (select id from spend_ledger_backup_20260905);

-- 2. session totals
update sessions s set cost_usd = x.total
  from (select session_id, sum(cost_usd) as total from spend_ledger
         where session_id in (select distinct session_id from spend_ledger_backup_20260905)
         group by session_id) x
 where x.session_id = s.id;

-- 3. rollups (cost only; token and session counts are unchanged)
update spend_rollups r set cost_usd = coalesce((
  select sum(l.cost_usd) from spend_ledger l join sessions s on s.id = l.session_id
   where (r.scope = 'league' or coalesce(l.team_id::text, 'reporter') = r.scope_key)
     and case r.period
           when 'day'    then (l.created_at at time zone 'America/New_York')::date::text = r.period_start
           when 'week'   then 'W' || (s.context ->> 'week') = r.period_start
           when 'season' then true end), 0);
```

Undo: `update spend_ledger l set cost_usd = b.cost_usd from
spend_ledger_backup_20260905 b where b.id = l.id`, then steps 2 and 3
again. Drop the backup table once the numbers are confirmed.

## 2026-09-05 — Cost analysis: where the $10–19 a day goes (§8.7)

Jake asked whether the league is token-inefficient or managing context
badly. Read the production `spend_ledger` and `session_events` for
2026-09-01 to 2026-09-04. Ledger by ET day: $5.31 (Tue, partial), $18.95
(Wed), $15.49 (Thu), $10.36 (Fri). About 60 sessions a day.

Where it goes (2026-09-01 onward, $50 in the ledger):

- **Trade windows: half.** $25.40 across 36 sessions, $0.71 each, 9.4 model
  steps and 46k input tokens a step. Every agent but Fable, Kimi, GLM and
  Mistral calls `get_team_roster` for all 11 other teams (6.5k characters
  each, about 19k tokens together) and then re-reads them on every later
  step. The daily trade-window bill fell from $10.14 (Wed) and $10.09 (Thu)
  to $5.18 (Fri) once the 2026-09-03 caching change was live.
- **One seat: a quarter.** Fable 5 is $12.96 of the $50 on 17 sessions;
  Fable and Sonnet together are 38%. Fable's input is 5× Sonnet's price and
  its output 5×. Nothing in the harness makes it dearer; the price does.
- **The fixed prefix: 11k–17k tokens a session.** System prompt 2.5k
  characters; first user message 19k–24k characters (scratchpad 8–10k, board
  6k, roster 3k, calendar 1.8k, recent decisions 1.6k); tool schemas about
  6k tokens for the full kinds (a `trade_window` step 1 reads 17.2k tokens,
  a `board_reply` 11.3k with the same snapshot size). `board_reply` and
  `trade_vote` — 35 sessions a day — carry the full scratchpad and board
  without a scratchpad tool. Step 1 is 47% of a board reply's cost.
- **Output is not the problem.** Output plus reasoning is about 30% of Fable's
  cost and 35–45% of Kimi, Qwen and GLM; §8.1 leaves it alone anyway.

Two findings that are the ledger's, not the agents':

1. **Reasoning tokens are billed twice on price-table steps.** The AI SDK's
   `outputTokens` already includes reasoning (`output_tokens ≥
   reasoning_tokens` on all 410 price-table steps since 2026-09-01) and
   `computeStepCost` adds `reasoning_tokens × output price` on top. Since
   2026-09-01 that is $1.88 on Fable, $1.37 on Grok, $0.80 on Sonnet, $0.20
   on the two GPT seats: $4.25 of $50, about 8%. Gateway-priced steps are
   not affected. The BYOK bills are lower than `/spend` shows by that much.
   Fixed the same day and the old rows repriced (entry above).
2. **Caching now works** (VERIFIED.md, item closed): session 2117's cached
   input rose 15.5k → 20.0k → 27.7k → 29.2k step by step, cache writes were
   reported on every step, and input ≥ cached + write held throughout.

Options, cost-only, same information for every agent, in order of size:

- Compact league-wide rosters for scouting: `get_team_roster` taking
  `team_ids[]`, or a `get_all_rosters` with one short row a player (id,
  name, position, NFL team, slot, projection, injury). 11 calls × 6.5k
  characters becomes one call of about 12k. Roster rows also carry fields
  a scout never uses (`kickoff_et`, `points_final`, `on_bye_this_week`,
  `acquired_via`, `status`); halving the row halves every re-read.
- Leave the scratchpad and board out of the snapshot for the two kinds that
  cannot use them (`board_reply` gets the thread as kind data already;
  `trade_vote` sees the trade). §8.5 lists the scratchpad for every session,
  so this is a spec default to change, not a bug. About 2.5k tokens × 35
  sessions a day.
- The Fable seat, and four trade windows a week instead of two, are Jake's
  calls (§8.1 fixed list; 2026-09-03 entry).

Not worth doing: an Anthropic 1-hour cache TTL (steps are 16–21 s apart,
longest gap 156 s); trimming the system prompt (700 tokens, cached).

## 2026-09-04 — Speed Insights: the four pages under 90

Vercel Speed Insights put `/matchups/[week]` at 56, `/benchmark` at 61,
`/teams` at 85 and `/teams/[slug]` at 88; every other public page scored
100. The per-metric breakdown is not readable from this session, so the
work went to what the code shows is slow on those pages:

- `/teams/[slug]` read its `?week=` query string, and a page that reads its
  query string is rendered per request — the same `no-store` trap the
  matchups page comment describes — so its 300 s window never reached the
  CDN and every visit paid the full database render. The week is a path now:
  `/teams/[slug]` is the current week and `/teams/[slug]/week/[week]` a
  chosen one; both declare `generateStaticParams` and revalidate. Old
  `?week=N` links redirect (308) to the new path for N in 1–18; any other
  value falls through to the team page and its current week, as before.
  (The reviewer caught the first cut of the redirect sending `?week=19` to
  a 404.) The page body moved to
  `app/teams/[slug]/team.tsx`, unchanged apart from the loader: the team
  and the settings read together, and the projections are chained off the
  roster reads inside the same `Promise.all` instead of a fourth round.
- `/matchups/[week]` loaded the twelve lineups one team at a time, three
  queries each, then projections, then the clock, then locks, then the
  marquee game's reasons — about forty serial round trips on every
  regeneration. `teamLineups` in `lib/queries.ts` fetches every team's
  lineup in three queries, and projections, locks and reasons go out
  together. `teamLineup` is now a one-team call into it, and `teamBench`
  runs its two independent reads together.
- `/teams` and `/benchmark` were already static and already loaded in
  parallel; nothing in the code explains their scores (15 and 8 samples,
  so a couple of slow visits move them). Left alone; re-read Speed Insights
  after a week of the new build before touching them.

Tests added: the two team routes in `caching.test.ts`'s window list, a guard
that no windowed page reads `searchParams` (`/transactions` is the allowed
one), the redirect rule's range, and a PGlite test for `teamLineups`.

Verified locally: lint, typecheck, the full test suite, and a production
build whose route table lists `/teams/[slug]` and `/teams/[slug]/week/[week]`
as static with revalidation.

Seen in that route table and not touched here: `/transactions` reads its
query string too, so it is the one remaining public page rendered per
request. It was not in the list Jake sent; same fix applies when it is.

## 2026-09-04 — Team page rebuilt to Jake's `Team.dc.html` design

From Jake's second Claude Design handoff. What changed on `/teams/[slug]`:
- Header: model label and "Drafted Nth overall" above the name, the motto,
  the two links, and the four stats as one row.
- Left column (sticky on a wide screen, scrolling inside its own box when
  taller than the viewport): the week's lineup as one card of rows — slot,
  player and position, "proj N", points — with the week picker as chips and
  "N scored · M projected" beside the heading; the bench as a second card.
- Right column: the scratchpad card collapses to 300px with a fade and a
  "Read the full notes" button once it runs past 900 characters; "See all N
  versions" reveals the history under the card. Then an Activity section
  with Moves / Sessions / Check-ins as a segmented control, each with its
  count and its own intro line. Moves clamp to three lines with "More" past
  220 characters; Sessions is the shared row; Check-ins is a two-column list.
- `components/team-page.tsx` holds the three client pieces (notes card,
  tabs, clamp); everything inside them is still server-rendered.

Left out, deliberately: the design's three "Wants / Will trade / Next
session" cards above the notes. They are free-text summaries with no field
behind them — the agent writes one scratchpad, not those three lines — so
showing them would mean inventing them. If Jake wants them, the prompt would
have to ask every agent for a structured summary (§8.1: same prompt for all),
which is a spec change and is noted as a question below. Also not carried
over: the "Rejected"/"Allow" verdict tag on a move, which the decision log
does not record separately from its text. Two additions beyond the design:
the notes only collapse once they run past 900 characters (a short note got
a pointless button), and the sticky lineup column scrolls inside its own box
when it is taller than the viewport — the design's plain `sticky` would pin
the top and hide the bench until the page ends.

Review round (fresh-context reviewer, all fixed): the version history was
unreachable while the current scratchpad was empty; the Activity counts
were the fetch caps (100) rather than true totals, now two `count(*)`
queries; every tab panel stays in the document (hidden) so `aria-controls`
resolves; Left/Right/Home/End move between tabs; collapsing the notes
brings the card back into view.

### Questions for Jake

- Do you want the three quick-read cards ("Wants", "Will trade", "Next
  session") on the team page? That needs every agent to write those three
  lines at the end of a session, which is a prompt and schema change.

## 2026-09-04 — `/spend/[slug]` lists sessions the way `/sessions` does

Same ask, third page. The nine-column token table on an agent's spend page
is now the shared session row, with the token counts and any invalid tool
calls folded into the sub-line ("12k in · 1.9k out · 940 reasoning · 2
invalid"). Queued sessions are left out — they have cost nothing yet — and
the "Sessions" stat counts the same rows the list shows.

## 2026-09-04 — Team pages list sessions the way `/sessions` does

Jake asked for the team page's sessions to match. The seven-column table
with the numeric id as its only link is gone; the team page now uses the
same row as `/sessions` — what the agent decided, then kind, tool calls and
id, with status, time and cost on the right, the whole row the link, and
queued sessions left out. The row lives in `components/session-rows.tsx`
so the two pages cannot drift; `teamSessions` in `lib/queries.ts` fetches a
team's rows in the same shape, sharing the decision-log lookup with
`allSessions`. On a phone the status line now drops under the title on both
pages instead of squeezing it into a third of the width.

## 2026-09-04 — `/sessions` leaves out queued sessions

Jake's call after the redesign went live: the "Live now" strip was a wall of
forty-odd "Lineup check · queued" links, because the week plan books every
team's lineup checks days ahead (§9) and a queued session has nothing to
show. `allSessions` now filters `status != 'queued'`, so queued sessions
appear neither in the strip, the counts, nor the cards until they start;
`/admin/teams` still shows what is booked. The page's footnote says so.
SPEC §12.1's `/sessions` row updated. The `queued` URL value is still
accepted and simply matches nothing.

## 2026-09-04 — `/sessions` redesigned: team-grouped, outcome-first rows

From Jake's Claude Design handoff (`Sessions.dc.html`). The old page was a
seven-column table whose only click target was a numeric id; his three
complaints were "can't tell what's clickable", "titles aren't descriptive",
"too dense".

Done:
- Rows are grouped under their team, most recently active team first, each
  group a card with the team's name, model, session count and a Team-page
  link. Four rows show per team; "Show N more" expands the card. Once one
  team is picked its card shows forty.
- The whole row is the link. It leads with what the agent decided — the
  first sentence of the decision log it ended with, cut at a word past 120
  characters — with the kind, tool-call count and session id underneath and
  the status, relative time and cost on the right. `allSessions` now reads
  the log in a second query over the page's ids rather than a join, so a
  session with two logs still yields one row.
- Sessions with no log say what happened instead: "Queued — waiting for a
  turn", "Working through the lineup check…", "Ended with an error before
  making a call", "Ran out of time before making a call", "Skipped — nothing
  left to decide". The reporter and a draft pick never write a log, so those
  fall back to the kind label.
- The three dropdowns are chips: a scrollable team picker (name, model in
  lighter text, count, live dot) and status and kind chips. `live` folds
  queued and running, `failed` folds in a time-out, `trade` is every trade
  kind, `waivers` is the weekly review plus the post-waivers check. The exact
  statuses and kinds still work as URL values, so every old link keeps its
  meaning, including the team page's "All of its sessions".
- Relative times ("12 min ago") are only true in the browser: the page is
  prerendered and served for up to 300 s, so the server renders the stamp and
  the relative form takes over after hydration, ticking once a minute.
- `KIND_LABEL` moved from `session-view.tsx` to `lib/sessionsFilter.ts` so
  both pages share one set of names; SPEC §12.1's `/sessions` row updated.

Review round (fresh-context reviewer, all fixed): the runner's
`(no summary written)` placeholder log was showing verbatim as a row title —
it is now a constant in `@league/shared` (`NO_SUMMARY_PLACEHOLDER`) that both
the runner and the page use, and the page treats it as no log; the `kind`
URL value is checked against every kind the enum knows rather than the
kinds on the current page, so an old `?kind=trade_vote` link filters even
when no vote is among the newest 600; the "Live now" strip's negative top
margin only applies when the strip renders; the "All teams" chip no longer
carries a live dot the prototype does not show; "Show N more" carries
`aria-expanded` and `aria-controls`; tests for the placeholder, an empty
page and a team that has not named itself yet. Second round: a paused
session's dot and status are amber, not the green of a finished one; the
reporter's card names its model like its chip does; rows inside a card sort
by the time they show; the status and kind chip groups are real flex boxes,
not `display: contents`, so their group labels reach the accessibility tree.

Departures from the prototype, all deliberate: its Font Awesome link and the
design system's React `Button` are not used (the site has no icon set, and the
ghost button is one class string); density and rows-per-team are constants,
not props, because nothing on the site sets them.

## 2026-09-03 — Team 11: Muse Spark 1.2 moves to Meta's Contributor tier

Slot 11 now runs `meta/muse-spark-1.2-contributor` (was `meta/muse-spark-1.2`).
**Reason: price.** Jake's call. Contributor is a pricing tier, not a different
model: same weights, same features, same 1,048,576-token context. The gateway
lists it at $0.10 / $0.20 per M (cache read $0.002) against $1.25 / $4.25
(cache read $0.15) for the standard tier, so about 92% off. In exchange, Meta
may use the inputs and outputs to train its models.

Why that trade is fine here: the league is public by design (§2). Every prompt
an agent sees is league state, player data, news and its own past decisions,
all of which the site already shows to anyone. The tools expose no
credential, no file system and no terminal, so the model cannot read anything
outside the league. The benchmark is unaffected: same model, same prompt, same
tools, same information as the other eleven.

Done:
- id verified against the live gateway catalog today (369 models; entry in
  `docs/VERIFIED.md`);
- `LEAGUE_MODELS` slot 11 and `MODEL_PRICE_SEED` updated; the price seed is
  `onConflictDoNothing`, so code and data cannot fight;
- `swapModelAction` now also moves a team's **queued** sessions to the new id.
  A session carries its own `model_id` from the moment it is queued and the
  runner reads that, so the eight lineup checks already queued for team 11
  would have run on the standard tier until a later trigger created fresh
  sessions. Running sessions keep the id they started on;
- lint, typecheck and the full suite green (786 tests).

Production landed on 2026-09-04 with Jake's explicit go-ahead, after the
session's permission classifier blocked the first attempt (as on 2026-08-29):
one transaction carrying the `teams` update, the eight queued lineup-check
sessions, the `model_prices` row, the commissioner-action audit row and the
public `model_swapped` transaction. Verified after commit: team 11 reads
`meta/muse-spark-1.2-contributor` and no queued session for it carries the
old id.

Label stays "Muse Spark 1.2" on the site and in the agent's identity, because
it is the same model. The site says which seat runs under the training term
(Jake's ask): `modelTierNote()` in the registry keys off the `-contributor`
suffix, so it follows the production `teams` row rather than a hard-coded
slot. It shows as a "contributor tier" tag plus one sentence on the team page,
in the subtitle of the team's `/spend` page, and in the `/spend` footnote.

## 2026-09-03 — Cost: cache the whole conversation, carry each fact once, show the calendar

Jake asked what would cut agent cost without touching the experiment. Spend to
date is $73 ($37 draft day; a full regular-season week runs about $75–80 at the
current rate, well under Appendix F's $150). The data is in `docs/VERIFIED.md`
(two entries dated today). The short version: the cost is context size, not
activity counts. Each step re-sends the whole conversation; a `weekly_review`
step averages 125k input tokens against an 11k snapshot, and the Anthropic
cache never covered anything past the snapshot.

Three changes, all cost-only — no agent sees different information, and every
agent sees the same thing:

1. **Caching (`packages/agent/src/modelStep.ts`).** Anthropic breakpoints now
   sit on the system prompt, the snapshot, and the two newest user/tool turns
   (four is the provider's maximum; the second-newest is kept so a hit is found
   even when a step adds more content blocks than the automatic lookback
   covers). A tool message carries the breakpoint on the message and on its
   last part. Simulated on the real ledger, assuming every later step is a
   full-prefix hit and the gateway reports cache writes: −41% Anthropic input
   cost, −26% Anthropic total, about −10% league-wide. Not yet measured live. The ledger gains
   `cache_write_tokens` (migration 0006) and prices a write at 1.25× input for
   table-priced steps, so the saving is reported honestly rather than
   flattered; the gateway's own cost is unchanged. **Verify item open:** the
   first Anthropic session after deploy must show `cached_input_tokens` rising
   step by step. Recorded in VERIFIED.md as pending.
2. **Payloads (`packages/agent/src/tools/read.ts`).** A `lineup` transaction
   returns its `diff` only (the before/after maps repeated it); kickoffs drop
   the UTC twin of `kickoff_et` on roster rows, player-stats rows and the
   league state's lock times (`get_nfl_schedule` keeps both forms);
   `fantasy_positions` appears only when it adds a slot; the roster's team
   header drops `slug`, `model_id` and `paused: false`. The first three are a
   fact stated once instead of twice. The header fields are dropped outright:
   §8.4 asks for the model's name, which stays, and the slug and gateway id
   are website and billing identifiers no tool takes. Expected effect is
   modest — a few percent of context — and it applies to every model equally.
   Spec §8.4 records the rule.
3. **Calendar in the snapshot (`packages/agent/src/context.ts`).**
   `scheduled_sessions` lists my pending check-ins and the league's sessions
   for me: queued rows, plus the `lineup_check` the week plan will book 90
   minutes before every window I have a player in, computed from the week's
   games so it shows before the row exists. Eight of the fifteen queued
   check-ins duplicated exactly that check. The four briefs that can book a
   check-in (`weekly_review`, `post_waivers`, `lineup_check`,
   `injury_response`) say where to look. `groupKickoffWindows` moved from
   `apps/web/lib/weekPlan.ts` into the engine so both sides compute the same
   windows; `weekPlan` re-exports it.

Measured and deliberately not changed:

- **Trade proposals per week.** Proposals, responses and votes cost $4.3 so far
  (a response session is $0.14; an accepted trade's ten votes about $0.74).
  Not where the money is.
- **Board replies.** 50 sessions, $4.93, $0.09 each; already capped at three
  per team per ET day and reply depth two. Not worth the experiment cost.
- **Trade windows four → two.** Would save about $19 a week (a quarter of a
  week) and halve trade activity. Jake's call, not a cost fix.
- **Cost-aware prompts.** Jake asked. Not done here: it changes the experiment
  mid-season (§8.10 explains why that makes the weeks non-comparable) and
  turns cost-per-point into a measure of prompt compliance. If Jake wants it,
  the least invasive form is information, not instruction: each agent's spend
  to date and the league median in the snapshot. Same information for all,
  and recorded on `/about`. Awaiting his decision; see "Questions for Jake".
- **Repeated identical reads** (`get_transactions` 28 times, `set_lineup` 23,
  `get_free_agents` 19 across all sessions) and the one Gemini session that
  paged `get_transactions` 56 times for $8.84. A same-args short-circuit would
  change what the model receives, so it stays a note. The ceiling did its job.
- `session.ts` sizes the context-trim check as `inputTokens + cachedInputTokens`,
  but the SDK's `inputTokens` already includes cached tokens, so the estimate
  runs high and trims a little early. Harmless; noted for a later pass.

### Questions for Jake

- Cost-aware agents: do you want each agent to see its own spend to date (and
  the league median) in its context? It is a mid-season change to what the
  agents see, so it goes on `/about` with the date. Default if no answer: no.
## 2026-09-03 — Tool audit from agent transcripts: dead ros_rankings, moot vote sessions, cap-rejection hints

Jake asked for a check that the agents' tools all work, done by mining 48h of
production transcripts (subagents read five sessions end to end; aggregates
over every tool_result). Zero hard tool errors — the crash class is gone.
Three real findings, all fixed:

- **`ros_rankings` never worked.** `player_research` has offered the
  rest-of-season kind since the FantasyPros replacement, but nothing ever
  ingested the `ros` set — 30 calls in 48h all failed "no ros rankings are
  loaded". The in-season `ingest.rankings` job now also builds `ros` from the
  season projections (the ingest already supported it; only the booking was
  missing).
- **Six moot vote sessions per early-resolved trade.** §3.5 executes at the
  allow threshold, hours before the 24h reviewEndsAt the ten `trade_vote`
  sessions were booked with as their deadline; nothing lowered it. Trades 3,
  7, 16: 18 sessions (~$1.53) ran to discover there was nothing to vote on.
  Trade resolution now retires the still-queued vote sessions in the same
  transaction (a running one is left to finish — it may be mid-vote). Also
  aligned the context snapshot's `votes_owed` with `get_league_state`'s
  reviewEndsAt guard; the two had drifted.
- **Size-cap rejections now name the remedy.** The transcript audit found
  100% recovery from cap rejections, but the scratchpad's prescriptive hint
  ("use mode=replace") recovers in one retry while bare zod text cost one
  board reply two (it trimmed to the wrong number). The generic invalid_args
  hint now says to shorten the named field when the failure is a length cap.

Left alone deliberately: `get_trade` not_visible/not_found and
`propose_trade` roster/frozen rejections are clear, correct rule enforcement
agents adapt to; `votes_owed` stays visible to all kinds per §8.5 (the one
session that noticed it lacked a vote tool handled it gracefully).

## 2026-09-03 — Filters and sorts on the public pages

Jake asked for filters and sort on the trades page and the others. Built in
one pass, all recorded in the §12.1 table:

- **Trades**: one filter bar over all three sections — team on either side,
  status, period (24h/7d/30d) — and a sort by newest or by size of swing;
  forty cards per section with "show more"; the page now carries 200
  resolved trades and 200 offers. A team page links to its own filtered view.
- **Sessions**: kind filter joins team and status; filters mirrored into the
  URL; 600 rows fetched, a hundred shown at a time.
- **Transactions**: week filter and a by-week sort, applied in SQL like its
  existing team and type filters.
- **Board**: filter by a team that posted anywhere in the thread; sort by
  newest thread or newest reply.
- **Waivers**: the last run's results filter by team.
- **Spend**: the per-agent table sorts by any column, direction toggles.

**How, and why.** Reading `searchParams` on the server makes a route dynamic
and drops its §12.1 cache (`/transactions` already pays that, and keeps its
pattern). Everywhere else the server renders every card and a small client
component picks which to show: the filter state is read from
`window.location` after mount and written with `history.replaceState`, so a
filtered view is a link, the page stays prerendered, and no Suspense
bailout is needed (the prerendered HTML is the unfiltered list). The trade
cards, board threads and waiver rows cross to the client as rendered React
nodes with a few filterable fields beside them — the client never sees a
row it should not render. The pure filter and sort functions
(`lib/listControls.ts`, `tradesList.ts`, `boardList.ts`, `spendSort.ts`,
`sessionsFilter.ts`) carry unit tests; unknown values sort last in both
directions.

Review round (fresh context), five findings, all fixed: the spend table
formatted numbers with the viewer's locale in a client component (a
hydration mismatch off en-US) — fixed to a pinned locale, and the name
tiebreak likewise; `aria-sort` sat on a button where it has no effect —
replaced with screen-reader text; the board filter searched 40 threads and
its empty state overstated that — now 100, and the text names the reach;
the transactions week filter accepted weeks past the current one — bounded;
tiebreak paths and the URL-patch rule (now the pure `patchQuery`) gained
tests.

**Not done.** Trades has no week filter: the `trades` table has no week
column, so the period filter stands in. Board threads cap at 100 with no
"show more".

## 2026-09-03 — `/trades` lists offers that never reached review

Jake asked whether the page should show offered trades. It now does: a
third "Offers" section under "In review" and "Resolved" lists the newest 40
offers in `proposed`, `rejected`, `countered`, `cancelled`, `expired` or
`failed` at accept, with both sides' season projections, the swing badge,
the ending stamp (`responded_at` for a rejection or counter, `resolved_at`
for the rest — `lib/tradeOffers.ts`, tested), the failed-accept reason, and
the counter chain through `parent_trade_id` in both directions.

Review round (fresh context), four findings:
- **Message hidden (changed from what I first proposed).** I had planned to
  show the offer message, arguing that §3.5 does not forbid it and the
  transcript already carries it. The reviewer showed that is wrong: the
  agents' prompt (SPEC Appendix, `prompt.ts`) promises the message "stays
  between the two of you unless the trade enters league review", §11 forbids
  the reporter from revealing it, and `get_trade` hides it from the ten
  uninvolved teams. A public page must not break a promise the prompt makes.
  Offers are listed without their message; the §12.1 row says so.
- **Two producers of `failed`.** Execution after a review can also fail, and
  those trades have public votes. `review_ends_at` (set once, on accept) now
  splits them: failed-after-review sits with the resolved trades, votes and
  all, which the page previously omitted entirely; failed-at-accept sits
  with the offers.
- Tests cover the split and a null ending date.
- Cross-references read "#N" for both offers and trades.

## 2026-09-03 — Nav promotion: Trades, Sessions and Spend on the bar; `/sessions`; projections on `/trades`

From Jake's design handoff (`Fantasy League Nav Update.dc.html`, a reference
prototype, not ported). Four changes in `apps/web`:

- **Primary nav** carries Trades, Sessions and Spend. Benchmark stays: the
  handoff's eight-item list omitted it, but dropping a page was not part of
  the ask. Nine links; the bar's `scroll-x` handles a phone. Trades and Spend
  left the footer's "more" list.
- **`/sessions`** (new, recorded in SPEC §12.1): the newest 300 sessions across
  every team and the reporter, left-joined to `teams`, with client-side team
  and status filters and a "live now" panel. The `sessions` route segment's
  classic layout moved down to `[id]` so the index uses the broadcast
  container. Filter logic is in `lib/sessionsFilter.ts` with tests.
- **`/trades`** shows each player's week-0 (season-long, §5.4) projection and
  a net-swing badge to the proposer on offers in review. A missing row is a
  dash, and a side with no projection at all produces no swing — omit rather
  than fabricate. Logic in `lib/tradeProjection.ts` with tests.
- **Home** gets a seven-card section grid under the hero, copy verbatim from
  the handoff.

Checks: web lint, typecheck and 318 tests green; production build run from
the sandbox.

Review round (fresh context), six findings:
- Fixed: the handoff labelled the number "proj ROS", but week 0 is the
  full-season total, not rest-of-season. Labelled "season proj" instead; the
  §12.1 row says so.
- Fixed: nothing scheduled refreshes week 0 in season, so `/trades` now calls
  `ensureFreshProjections` (never throws) before reading, as the draft does.
- Fixed: `/sessions` added to the §12.1 freshness table test.
- Fixed: the page and spec said "every session"; it is the newest 300. Copy
  and spec say so and point at the team pages for the rest.
- Not changed: the swing badge is green whatever the sign. The handoff asks
  for that on purpose — it is information, not a verdict on fairness.
- Not changed: resolved trades show today's week-0 rows, not the values at
  execution time; the league does not store a snapshot, and the page does not
  claim one.

## 2026-09-02 — Observed: board replies shed under slot saturation (no change made)

Monitoring sweep, 20:07 UTC. Between 16:00 and 17:30 UTC a Wednesday
post-waivers board flurry saturated the six session slots: of 28 `board_reply`
sessions today, 5 were skipped at their 30-minute deadline while still queued
and 3 got a slot with under two minutes left and were retired mid-run (one of
those, session 1741, still posted its reply first — its `timed_out` is
cosmetic). This is §9.2's designed load-shedding: the league's own schedule
outranks board chatter, and a stale reply dying beats it posting an hour late.
No code change. Recorded because game weeks will amplify the pattern; if reply
loss starts to matter, the levers are the concurrency cap and the board-reply
deadline — settings decisions, not bug fixes.

## 2026-09-01 — INCIDENT: week 1 finalized 0–0 nine days before kickoff; guard added, data repaired

Caught by the 08:15 UTC monitoring sweep: `stats.finalize` at Tuesday 4:00 AM
ET (the first Tuesday of the regular phase) finalized week 1 as six 0.00–0.00
matchups and advanced `current_week` to 2 — week 1's games start September 10.
The ladder found no stats anywhere (Sleeper empty for the unplayed week;
nflverse `player_stats_2026.csv` does not exist yet, HTTP 404), flagged
"finalized with no stats source", and finalized anyway. Left alone, every
Tuesday would finalize another empty week and the fantasy calendar would
desync from the NFL season entirely.

**Root cause.** `bookRecurringJobs` books `stats.finalize` for every next
Tuesday by the calendar, and nothing anywhere checked that the week's games
had been played. §7.4's "for a week with no matchups finalization is a no-op
that still advances" covers only matchup-less weeks; week 1 has matchups, so
the full finalization ran. (§7.4 also says the job runs "from the Tuesday
before Week 1 (September 8)" — the Sept 1 booking predates even that, but a
date-based booking gate would not have survived the Sept 8 run anyway; the
real invariant is games-complete.)

**Fix.** New engine `weekGamesComplete` (scoring.ts): a week may finalize
when it has no matchups (the spec'd no-op), or when every `nfl_games` kickoff
for it is 4.5 hours past (elapsed time, the same backstop as §13.2 — never
`status`, which only advances while the tick polls). Matchups with *no*
games rows is a missing schedule: defer and raise `stats.finalize` health
error rather than finalize blind. `finalizeWeek` returns `deferred` and
touches nothing; the workflow skips the next-week plan; §13.4's "never
skipped, never waits for a person" now reads as intended — finalization
waits for games, only for games. `checkFinalizationStall` treats an
unplayed week as deferred, not stalled — without that, the watchdog would
have re-booked finalization every half hour after the repair below and
re-corrupted the data. Regression tests for all three (fail on the old
code); full suite 708 green.

**Production data repair, with backups per the standing rules** (tables
`repair_20260901_*` on the production branch): reverted the six week-1
matchups to unplayed (`final=false`, points and winner null), deleted the
twelve premature `team_week_results` week-1 rows, deleted the week-2
`lineup_entries` the premature carry-over wrote (they would have made the
real September carry-over skip every team, freezing week-2 lineups at
September 1st's state), set `current_week` back to 1, and removed
`weekScoringSources["1"]`. The week-2 lineup-check sessions the premature
plan booked are left in place: their idempotency keys match what the real
week-2 plan will book, and their due times are correct for week 2's games
either way. Cleared the `stats.finalize` health error after the repair.

**Sequencing note**: the guard was merged and deployed *before* the data
repair, because reverting `current_week` under the old code would have armed
the stall watchdog (3 hours after the 08:00 UTC due time) to re-book — and
re-run — the same premature finalization every half hour.

**Repair executed 09:12 UTC, after the deploy, before the 9:00 AM ET
session bookings.** Also deleted: the twelve `carried_over` lineup
`transactions` rows the premature carry-over recorded (reviewer finding —
they would have shown a phantom Sept-1 carry-over and duplicated on Sept
15). Verified before touching anything: all twelve teams were carried and
zero pre-existing week-2 or week-3 lineup entries existed, so no agent
decision was destroyed; the 4:30 AM waiver run processed zero claims (no
ghost cleanup needed); zero sessions ran under the corrupted settings.
Decisions recorded: the already-booked Sept-8 `stats.finalize` job keeps
its stale `{week: 2}` payload (its idempotency key is due-time-only so it
cannot be corrected in place; it produces one harmless week-2 deferral,
traced safe under the new watchdog logic). Today's 9:00 AM ET
`weekly_review` booking now runs with week-1 keys (`…:2026:1:1`), which
means Sept 8's identical booking dedupes to nothing — one preseason
review set instead of two, accepted. The Tuesday 11:30 digest will report
an empty "week 1" today; noise, not damage.

## 2026-08-31 — Two bugs the draft data exposed: a prompt that promised tools the session had not bound, and a reason cap nobody could learn

Both found by mining the completed draft (168 picks, 280 sessions, 4,530 session
events) for agent behaviour rather than by reading code. Both are cases where the
harness, not the model, produced the failure.

**Bug — the shared system prompt advertised tools the session does not bind.**
`buildSystemPrompt` took no session kind, so all twelve agents got Appendix C's
"How to work" bullets verbatim in *every* kind. Those bullets name
`get_league_state`, `get_team_roster`, `get_matchup`, `get_team_week_results`,
`get_transactions`, `set_lineup`, `post_message` and `write_decision_log`. The
`draft_pick` set (§8.6) binds nine tools and none of those nine is on that list.
So on draft night every agent on the clock was told "check on your rivals whenever
you want" and "End every session by calling write_decision_log", and neither was
possible.

One model believed it. At pick 80 DeepSeek V4-Pro wrote a 27,676-character
deliberation, crossed Tucker Kraft off its list by name ("Tucker Kraft (TE6, Q) -
I already have Loveland, no need"), then spent the end of its clock on four
parallel `get_team_roster` calls. Each answered "There is no tool named
get_team_roster". The session died and the engine auto-picked it Tucker Kraft.
`c636e64` stopped a hallucinated tool name from killing the session; it did not
stop the prompt from inviting one.

`buildSystemPrompt(vars, toolNames)` now emits only the bullets whose tools are
bound, and both call sites pass the same list they bind, so prompt and tool set
cannot drift. Where the tools are present the Appendix C wording is unchanged —
`weekly_review`, `post_waivers` and `trade_window` are byte-identical to before.

**This is not a §2 change.** §2's Prompt row fixes "Same system prompt for all 12
agents. Only the model differs." That constrains variation across the twelve
*models*: every agent running the same kind still gets byte-identical text, and no
model sees a bullet another model does not. A prompt that describes capabilities
the session cannot reach is not the spec's intent, it is a defect against it —
§8.6 exists precisely because the kinds have different tools. Appendix C stays the
source of the wording; the bullets are its sentences, unedited, each gated on the
tool it names.

**Bug — the `make_pick` reason cap produced every invalid tool call in the draft.**
Ten invalid tool calls across 168 picks, and all ten were the same thing: `reason`
over `MAX_PICK_REASON_CHARS` (200). Not one was a rules violation — no position
cap, no `must_fill_starters`, no already-drafted. The models never broke a league
rule; they broke a schema limit on a free-text field. GLM-5.3 hit it seven times in
fourteen picks, Mistral Large 3 twice, Kimi K3 once.

Seven times is the interesting number. The rejection is recoverable and every retry
landed, but it costs a model step against a 180-second clock, and a pick is a fresh
session — the only thing that carries across is the scratchpad, and GLM never wrote
the cap into it. The old rejection did name the field and the cap (the runner
prefixes the Zod issue path, so the model read "make_pick: reason Too big: expected
string to have <=200 characters"); what it never said is that resubmitting a shorter
reason is the fix. The message now says so. That is the one genuinely new lever here,
and it is worth being precise about why:

**Stating the cap up front has already been tried, and it failed.** `make_pick`'s tool
description read "Give a one-line reason (at most 200 characters)" throughout the
draft, transmitted with the schema on every model step of every one of the 168 picks.
GLM-5.3 had that sentence in front of it on all fourteen of its picks and blew the cap
on seven. So the brief now stating the cap too is a *second* bet on a mechanism with a
losing record, not the fix — it costs nothing and may help a model that weights the
brief above the schema, but it should not be credited in advance. If reasons overflow
again next draft, the question to ask is whether a fourth restatement helps at all,
not where to put the third. The cap stays 200 (§8.4).

**Tests.** The load-bearing one walks every kind in `SETS` and asserts the prompt
names no tool that kind cannot call; it fails on the old code. Plus the Appendix C
text held verbatim for a full team kind, the draft kind's bullets checked both ways,
`make_pick` over/at/under the cap, the cap present in the tool description, and the
brief pinned against the constant so the markdown cannot drift from the schema.

**Not fixed here, recorded instead.** Qwen 3.8-Max lost two picks (24 and 97) to the
clock the same way both times: it reasoned to a decision, correctly worked out that
`make_pick` ends the session and so the scratchpad had to be written first, wrote
the scratchpad, and was auto-picked 237 ms later at pick 24. The brief already says
"Update your scratchpad only if you can do it quickly." Making the ordering advice
sharper is a prompt change to a live benchmark and belongs in its own decision, not
smuggled into a bug fix — the draft is over and this cannot recur before next
season.

**Review round 1 (fresh-context reviewer, four lenses, findings adversarially
verified).** Nineteen findings raised, five confirmed real, all should-fix or nit:

- *SPEC left stale* (three lenses found it independently, and they were right). The
  change altered emitted prompt text but touched no spec file, so Appendix C and §8.2
  still described the exact prompt the fix removed. CLAUDE.md names SPEC the source of
  truth, and the repo precedent is explicit (`prompt.ts` + Appendix C kept in sync,
  2026-08-29). A future session reconciling code to the spec would have had spec text
  on its side for reverting this. Fixed: Appendix C now scopes "identical for all
  models" to the twelve models within a kind, carries a table of which bullet is gated
  on which tool, and names `buildSystemPrompt` as the authority; §8.2's "system prompt
  (Appendix C)" is qualified.
- *The new rule was one-directional.* It asserted the prompt names no tool the kind
  cannot call, so a bug that dropped a bullet the kind CAN act on would have passed
  silently. Added the positive direction for every kind, plus the unconditional
  bullets. Verified load-bearing: stubbing the `set_lineup` gate to false fails it.
- *Prose capability claims were uncovered.* The rule matched tool identifiers, but an
  agent acts on sentences — "before you offer it a trade" names no tool. Added prose
  assertions and a test pinning the short scouting tail for `lineup_check`.

Fourteen findings were dismissed on verification. One of them was half right and is
worth recording: the claim that the recorded root cause for the cap was wrong. The
old rejection *did* name the field — the runner prefixes the Zod issue path, so the
model read "make_pick: reason Too big: expected string to have <=200 characters". The
code comment and the entry above overstated that; both corrected. The remedy was
still missing, which is the part that mattered.

**Review round 2 (three lenses over the full change; the loop's stopping condition
is a reviewer finding nothing new).** Twelve findings raised, three confirmed. The
reviewer's ship verdict was merge, no blockers.

- *"Eight tools" was nine.* `toolsForKind("draft_pick")` returns nine —
  §8.6's table writes the two scratchpad tools as one row, and counting the table
  gives eight. The wrong number reached SPEC, `prompt.ts` and this log, in each case
  as the evidence for how narrow the draft set is. Corrected in all three, and pinned
  by a test so prose and code cannot drift again.
- *An efficacy claim contradicted by the same paragraph.* This entry credited the
  brief's new statement of the cap as "the half that can actually break the cycle".
  But `make_pick`'s tool description already read "at most 200 characters",
  transmitted with the schema on every model step of all 168 picks — GLM-5.3 had it
  in front of it fourteen times and blew the cap seven. Stating the cap up front is a
  mechanism with a losing record, not the fix. Rewritten to say so, and the schema
  comment with it. The remedy sentence in the rejection is the only new lever.
- Two stale headers of the same class round 1 caught in SPEC: `prompt.ts` still said
  the text is "identical for all twelve agents … only the model, team name, id, date,
  phase and week differ", and `toolsets.ts` still said "only the kind changes which
  tools are on the table". Both now describe the gating. (The verifiers dismissed
  these; they were wrong to — the round-1 finding was precisely that a doc left
  describing the old behaviour gives a future session a case for reverting.)

Nine findings were dismissed on verification, including two worth naming because they
are real gaps that are simply not this change's to close: `buildReporterSystemPrompt`
has no gating check of its own (the reporter kinds do bind everything its text names,
checked by hand), and the new cap test exercises `defineTool`'s formatter rather than
the runner path production hits first — the custom message is on the schema, so it is
identical down both, but only one is covered.

**Benchmark integrity.** The 2026 draft ran under the old prompt, and every team ran
under the same old prompt, so the draft remains internally comparable. From this
commit forward, draft sessions would see the corrected text; that is a difference
between seasons, not between models, and it is recorded here so a future reading of
`/benchmark` knows which prompt produced the draft.

## 2026-08-30 — Monitoring round 2: hallucinated tool names killed sessions; Gemini thoughtSignature dropped on replay

Jake asked for a check on any other errors. Beyond the morning pass:

**Bug — a hallucinated tool name killed the session (draft pick 1014).**
deepseek called `get_team_roster`, which does not exist; the next step died
with `AI_InvalidPromptError: messages do not match the ModelMessage[] schema`
and the pick went to auto-pick. Root cause in `modelStep.ts`: the replayed
assistant message was built from `result.content` — the SDK's *output* parts,
where an unknown or unparsable call is a dynamic part carrying
`invalid`/`error`/`dynamic` fields the ModelMessage schema rejects. Now built
from `result.responseMessages`, the SDK's own sanitized replay form. The same
change fixes the **Gemini thoughtSignature warnings** (~145 in the Vercel
runtime log): output parts carry `providerMetadata`, replay needs
`providerOptions`, and `toResponseMessages` maps one to the other — the
gateway had been injecting `skip_thought_signature_validator` to keep Gemini
requests from 400ing. Regression test drives the real `createModelStep`
through the real `streamText` against a mock model that hallucinates a tool
name; it fails on the old code. `messageShape.test.ts`'s own header explains
why the stubbed tests could not see this.

**Checked, no action:**
- `get_free_agents` tool errors (69 in 24h): the drizzle correlation fix
  (ea81525) deployed ~23:00 UTC; zero occurrences since. Confirmed resolved.
- A 2-hour `password authentication failed` (28P01) stream in the Vercel
  runtime errors, 19:24–21:28 UTC, every public page: it is the `mock-draft`
  branch's *preview* deployment, whose baked `DATABASE_URL` points at the
  temporary Neon branch deleted after the mock draft. One visitor on the
  stale preview URL. Production was never affected.
- Draft-night session failures besides 1014: one gateway 500 after three
  retries and two 180-second-clock timeouts — provider weather, auto-pick
  covered them, nothing to fix.
- The rest of the Vercel "runtime errors" are AI SDK reasoning-part warnings
  (Grok/OpenAI/Anthropic reasoning metadata skips) — log noise, left alone
  deliberately: silencing `AI_SDK_LOG_WARNINGS` would also hide real
  warnings like the thoughtSignature one this round acted on.

Full check green: lint, typecheck, 689 tests.

## 2026-08-30 — Workflow run streams (commissioner request)

Jake sent a screenshot of an `agentSessionWorkflow` run's Streams tab in the
Vercel Workflows dashboard reading "No Streams Yet — call `getWritable()` in a
step" and asked to add streams.

- New `apps/web/lib/runStream.ts`: `emitRunChunk` writes one JSON chunk to the
  current run's default stream (per-write acquire/release, the SDK's supported
  pattern); `createRunStreamPartialSink` turns the model step's cumulative
  partials into append-only deltas so the stream carries each character once,
  not the whole partial re-sent every flush.
- Wired where the long runs live: `agentSessionWorkflow` steps emit a
  `session_step` outcome chunk plus live `model_delta` chunks while a model
  streams (runSession.ts pairs the new sink with the existing §12.1 DB sink);
  `draftWorkflow` emits a `draft_pick` chunk per pick plus the same deltas
  (draft.ts pairing).
- Everything is observability-only by design: `getWritable()` throws outside a
  workflow/step context (unit tests, scripts), so the helper swallows that and
  all write errors — a stream hiccup can never fail a session, mirroring the
  partial-sink philosophy. The durable record stays `session_events`.
- Single-step workflows (waivers, ingest, finalize, week plan, reporter) got no
  stream: they finish in seconds and their return value already shows in the
  dashboard. Streams are auto-closed when a run completes, so no explicit
  close step was added.
- Tests: `apps/web/test/runStream.test.ts` — delta math (first flush, suffix,
  step change, non-extension restart, closing step `-1`), sink emit/skip
  behavior, reconstruction by concatenation, workflow-step-retry re-emission,
  and the failure paths (no context, rejected write, locked stream). Full
  `pnpm check` green: lint, typecheck, 679 tests (682 after review fixes).

Review round 1 (fresh-context reviewer over the diff): no spec violations, no
security findings; three fixes applied — `getWriter()` moved inside the try
(it throws synchronously on a locked stream, and outside the try it would
have propagated into the model step, the exact failure the module promises
away), `reset: boolean` added to `model_delta` (a retried workflow step
re-streams a `stepNo` the stream already carries, since stream writes bypass
the event log; readers had no discard signal), and the "readers reconstruct
the partial" claim corrected to "as of the last throttled flush" (the tail
past the final flush reaches only `session_events`). `writableSource` made
injectable so the write-failure paths are actually tested. Recorded, not
done: `draft_pick` chunks carry counters but no `pickNo`/`teamId`
(`DraftRunResult` doesn't expose them; enrichment when someone needs it);
`session_step` chunks are emitted for `queued` no-slot outcomes on purpose
(a run visibly waiting beats a silent one); stream writes have no timeout —
error swallowing covers rejection, not a write that never settles, accepted
as a platform concern.

Review round 2: two contract defects inside round 1's own fix, both applied —
`emitRunChunk` now reports success and the sink advances `prev` only past
chunks the reader actually received (partials are cumulative, so the next
flush's delta covers a dropped write's hole instead of concatenating around
it), and `partialDelta` no longer swallows a contentless restart (only an
empty *extension* is silent — a step's first flush can be empty, and dropping
its `reset` would make a reader keep a failed attempt's chunks). Recorded,
not done: a wiring test for the two-sink `onPartial` pairing in
runSession.ts/draft.ts — the pairing is two awaited calls whose halves are
each tested (DB sink in `packages/agent/test/streaming.test.ts`, stream sink
here), and pinning it needs a full session harness for marginal value.

Review round 3: nothing new — both round-2 fixes verified (the cursor
invariant holds across any interleaving of drops, resets, and extensions;
the contentless-reset path is reachable and pinned), lock handling matches
the DevKit's documented pattern, and no spec or security findings. Merged.

## 2026-08-30 — Log/health monitoring pass: two production bugs found and fixed

Routine monitoring sweep (Jake asked for it as a one-off plus a recurring
task; the recurring run is a scheduled session, every 4 hours). Production
state at the time: tick alive, `/api/healthz` 200, all feeds green.

**Bug 1 — the queue sweep could starve every newly booked session for weeks.**
`startQueuedSessions` paged the queue by `created_at` with a 40-row page, and
`week.plan` had just booked ~56 week-1 lineup checks (due Sept 9–13) in one
instant. Those far-future rows filled the whole page, so every session created
after that instant — five `board_reply` rows due immediately, and anything
`requeueFailedSessions` would re-queue — was never even examined; five slots
sat free while they aged. Observed live: board replies queued 20+ minutes past
due with one session running. Fix: the page is ordered by
`coalesce(context->>'due_at', created_at)`, so sessions sort by when their turn
comes; past-deadline and stale rows sort first, which the two retirement
branches need. Regression test proves a 45-row future pile cannot starve a
due-now session (fails on the old ordering).

**Bug 2 — the draft digest died on a numeric string and was never sent.**
`digest.weekly` (the post-draft digest, 22:37 UTC) failed with
`TypeError: K.toFixed is not a function`: `digest.ts`'s draft-cost query was
the one raw `sum(cost_usd)` in the app without a `::float8` cast, so the
driver returned a string. Cast added; `apps/web/test/digest.test.ts` builds
the draft digest against real driver types (fails without the cast). Re-booked
`digest.weekly` with `{reason: "draft"}` on production after the deploy so
Jake gets the missed draft digest.

**Production data edits, recorded per the standing rules:** marked the two
still-open `ingest.fp_injuries`/`ingest.fp_rankings` jobs (ids 166, 167, due
2026-08-31 09:30/09:35 UTC) `failed` with an explanatory error. They were
booked 2026-08-29 14:07, before the FantasyPros removal, and would only have
failed tomorrow as `unknown job type` like their three siblings did today.
Nothing re-books them. And the `digest.weekly` re-book above.

**Noted, no action available to me:**
- `gateway.credits` alarm live: balance $91.67, under the $100 line. The
  daily email to Jake is already going out; topping up is his side.
- 2026-08-29 16:23 UTC: every tick stage failed once with a truncated
  `Failed query: select … from league` — a one-minute database blip during
  the pre-draft window; outage notices for all twelve models followed at
  17:06–17:17 as their sessions failed together. Everything recovered on its
  own; the per-stage isolation and requeue behaved as designed.

Full `pnpm check` green: lint, typecheck, 673 tests.

## 2026-08-30 — get_free_agents SQL error: drizzle drops the correlation qualifier

Every `get_free_agents` call in production failed with a `tool_error` (reported
by Gridiron Gambit's session; confirmed in `session_events` rows 4613/4664/4700).
Root cause: the three "correlated" scalar sub-selects in the tool interpolate
`${players.playerId}` into raw SQL, and drizzle renders a column embedded in a
**select-list** expression unqualified (where/order-by columns stay qualified).
The generated `s.player_id = "player_id"` rebinds to the subquery's own alias —
`s.player_id = s.player_id`, always true — so the last-week and projection
sub-selects returned one row per player with data: Postgres 21000, "more than
one row returned by a subquery used as an expression". It broke the moment the
2026 week-1 stats/projection feeds populated more than one player, which is why
it "worked" all preseason and then failed for every position and sort at once.

- Fix: the outer reference is now the literal `players.player_id` in the raw
  SQL, with a comment stating the constraint. Same for the season-total
  sub-select, which never threw but summed the whole league's points.
- Why tests missed it: the fixture seeded a stats row for exactly one player,
  so the uncorrelated subquery still returned one row. The sort test now seeds
  stats for three players and projections for two, asserts per-player values
  for all four sorts, and reproduced the exact production error (PG 21000 on
  PGlite) before the fix.
- No other occurrence of the pattern in the repo (only these three
  expressions embed a column inside a select-list `sql` template).

## 2026-08-30 — Win-odds fixes and lineup projections on the public pages (commissioner request)

Jake asked how the win odds are computed and for starting-lineup projections on
the scoreboard (big before kickoff, small beside the score once games start)
and on the team page.

- Odds recap (unchanged mechanism, `lib/broadcastLogic.ts`): projected final
  margin — live score plus each starter-still-to-play's remaining projection —
  through a logistic with scale 18.5, so a 10-point projected edge ≈ 70%.
- **Fix: no more "100% to win".** Rounding could print 0/100 against a lopsided
  enough margin (Jake's screenshot: a side with one starter still to play read
  100%). New `winChancePercent` pins the printed percent to 1–99 while the game
  can be played; both pages use it. Tested.
- **Fix: pre-kickoff weeks no longer read as live.** `GameCard` gains
  `started` (any starter's NFL game flipped off "scheduled" by the tick, or
  points on the board). The home hero was announcing "6 games are live" on a
  Wednesday; tiles/hero/matchups badge now say Scheduled until kickoff.
- `GameCard` gains `awayProjected`/`homeProjected`: points so far plus what the
  starters still to play have left — before kickoff, the lineup's projected
  week total. Null (nothing shown) when the week's schedule or projections are
  not ingested, and once the game is over. Rendered big-muted pre-kickoff and
  small beside the live score on home tiles; on the matchups hero under each
  score and beside each other game's score line; per-player projections were
  already in the matchup lineup rows.
- Team page: per-player "projected X.X" in each lineup/bench/IR row's meta
  line, and the header line now reads "Starters have scored X so far, of a
  projected Y."
- Review round 1 (fresh-context reviewer) found: (1) the home tile could read
  "Final" up top and "Not started" under the bar during the Monday-done,
  Tuesday-not-finalized hours; (2) a matchup with two empty lineups (zero
  occupied slots, e.g. week 1 before the first lineup sessions) read "Final
  0.0 – 0.0"; (3) the started/projected gating was untested server-side code.
  Fixed by extracting `gameStatus` (final/live/upcoming/unknown — zero slots
  is final only once the matchup started) and `cardProgress` into
  `broadcastLogic.ts`, using them on both pages, and testing both. Also
  swept the adjacent copy: hero "not kicked off" no longer fires over a done
  week, the matchups marquee prefers actually-live games over scheduled 0–0s,
  and the hero's "finished level"/"every slot is done" lines no longer show
  pre-kickoff.
- Recorded, not fixed (reviewer finding 4, low likelihood): the projections
  gate is week-wide, so a week the feed projected where one side's starters
  happen to have no rows (all byes) would still show that side "proj 0.0".
- Lint, typecheck, full suite green (271 web tests + packages; now 282 web).

## 2026-08-30 — Agent-written text renders as Markdown on the public pages (commissioner request)

Jake sent screenshots of a team page's "What this agent is thinking" panel and
the home page's activity rail showing raw `**bold**` and `###` markers — the
agents write their scratchpads, board posts, and decision summaries in
Markdown, and only `/report` rendered it.

- The report page's dependency-free subset renderer (headings, lists, quotes,
  rules, inline bold/italic/code; plain-text fallthrough; links shown as text,
  never anchors — nothing model-written becomes a clickable href) moved to
  `apps/web/components/markdown.tsx` unchanged, plus an `InlineMarkdown`
  variant that renders only the inline tokens for one-line contexts.
- Now rendered as Markdown: the scratchpad and its version history (team
  page), board posts (`/board`), decision summaries (team page "Recent
  moves"), the home activity rail's bodies, and `/report` as before.
- `summarizeBody` (the rail's board-post excerpter) now drops block markers
  line-wise before flattening, since flattening strands `###`/`- ` mid-sentence
  where the inline renderer can't use them; inline tokens survive for it.
- Chose the existing subset renderer over adding a Markdown dependency: it is
  already the site's safety story for model-written text (no hrefs, nothing
  swallowed), and the agents' notes use exactly the subset it covers.
- Tests: `apps/web/test/markdown.test.ts` (subset renders, tables fall through
  literally, links never become anchors) and a `summarizeBody` marker case.
  Full `pnpm check` green: lint, typecheck, 643 tests.

Review round (fresh-context reviewer over the diff): no blockers, no spec or
security findings — confirmed no XSS path, no anchors ever emitted, no key
collisions, all regexes linear with length-capped inputs. Fixed from its list:

- Fenced ``` blocks now render verbatim in a monospace `<pre>` instead of
  being block-parsed (a `# comment` inside a fence was becoming a heading);
  an unclosed fence still renders rather than swallowing text.
- Decision summaries now go through the same block-marker strip as board-post
  excerpts (`flattenMarkdown`, extracted from `summarizeBody`), at both the
  rail and the team page — a summary is one line by convention, not contract.
- `***bold italic***` renders instead of leaving stray asterisks; spaced
  thematic breaks (`- - -`) render as rules; the excerpt marker-strip repeats
  for nested markers (`> - x`) and no longer eats a leading year
  (`2026. …` is prose, list markers are ≤3 digits); an excerpt cut that lands
  inside `**bold**` retreats to the token start so no stranded `**` reaches
  the rail.
- Added the tests it asked for: raw HTML stays escaped, `![img]()` never
  becomes an `<img>`, fence contents stay literal, unbalanced `**` degrades to
  literal text, CRLF input.

Accepted, not fixed (recorded per its nit): the scratchpad panel lost its
monospace `<pre>` — hand-aligned ASCII outside a fence now sits in a
proportional font. That is the cost of rendering; agents that want alignment
have fences, which keep it.

Review round 2 (fresh reviewer): confirmed round 1's fixes empirically, then
found three new fence-shaped should-fixes, all fixed:

- A one-line fence (` ```code``` `) was swallowing its content and dragging
  the rest of the document into code. The fence parser now handles one-line
  fences (code renders, trailing prose stays prose), distinguishes an info
  string (bare language tag, dropped) from content on the opening line
  (kept), and only closes a fence with the character that opened it.
- `flattenMarkdown` now drops paired fenced blocks whole from rail excerpts
  (code is not prose; half-flattening stranded backtick runs) and drops an
  unpaired fence-marker line alone, its lines flattening as prose.
- When the only sentence end in an excerpt window sits inside an inline token
  (`**Bold. Sentence**`), the retreat off the token also abandons the
  sentence break — the excerpt now carries an ellipsis in that case instead
  of ending mid-phrase unmarked.
- Nits: the two inline-token regexes (renderer and excerpter) now name each
  other as twins to be changed together. `**a* b**` rendering `*` + em +
  `b**` was noted and accepted as lossless fallthrough.

All fixed cases have tests. `pnpm check` green: 660 tests.

Review round 3 (fresh reviewer): confirmed round 2, found three should-fixes
(renderer/excerpter divergences on fence edges) and three nits, all fixed:

- A closing fence must now be at least as long as its opener (CommonMark), so
  a ````-fence can show a ```-example without the example's fence closing the
  block early and the rest of the document being swallowed into code.
- `flattenMarkdown` gained the renderer's one-line-fence handling: the code
  drops, prose after the closing run survives, and the one-liner's marker can
  no longer pair with a later block's fence. Paired-fence closers now mirror
  the renderer exactly (same character, at least as long).
- The renderer got the flattener's ≤3-digit list-marker rule — `2026. The
  season begins.` was rendering as an ordered list item "1." — and ordered
  lists now carry `start`, so a list beginning at 3 numbers from 3.
- Nits: a one-line fence's trailing strip takes only the closing character's
  run (a literal `~~~` after ```` ```code``` ```` survives); draft-pick and
  commissioner reasons in `describeTransaction` are flattened like decision
  summaries before reaching the rail.

All cases have tests. `pnpm check` green: 667 tests.

Review round 4 (fresh reviewer): confirmed round 3 in full, one should-fix and
two nits, all fixed:

- Text that flattens to nothing (a board post or reason that is entirely
  fenced code) was leaving blank rail rows and empty curly quotes. A
  draft-pick reason that flattens empty now drops its quote; a commissioner
  reason falls back to "The commissioner acted." (the truthiness check moved
  after flattening); decision summaries and board-post excerpts fall back to
  "(nothing outside a code block)" on the rail and the team page.
- The renderer now accepts up to three leading spaces on headings and quotes
  (CommonMark), matching the excerpter, and a vacuous test assertion was
  tightened.

`pnpm check` green: 669 tests.

Review round 5 (fresh reviewer): confirmed round 4, one should-fix and two
nits, all fixed:

- `/matchups/[week]`'s "Why {team} picked this lineup" panel was a missed
  call site — it rendered `decisionLogs.summary` raw. It now flattens and
  inline-renders like the other three surfaces, with the same empty-flatten
  fallback.
- The excerpter now keeps non-tag content from an unclosed fence's opening
  line (` ```{"json": 1} ` kept, ` ```ts ` dropped), matching the renderer.
- The home page's pre-existing `excerpt()` (reporter teaser) was a divergent
  near-duplicate flattener; it now builds on `flattenMarkdown` and only adds
  link/image reduction and inline-mark stripping for its plain-text output.

`pnpm check` green: 670 tests.

Review round 6 (fresh reviewer, with an explicit sweep of every agent-text
surface in `apps/web/app`): confirmed round 5; four more raw surfaces and one
nit, all fixed the same way (`InlineMarkdown` over `flattenMarkdown`):

- `/draft` board's reason column, `/transactions`' draft-pick reason line,
  `/trades`' vote reasons, and the team page's check-in reasons.
- The team page's motto (already inline-rendered elsewhere).
- Left as-is on the reviewer's own advice: the `/transactions` commissioner
  case's `k: v` payload dump (reads as a data dump, like the players-page
  JSON), engine-composed strings (power-ranking notes, timeline bodies,
  waiver failure reasons, trade resolution reasons), and session transcripts
  (intentionally verbatim).

`pnpm check` green: 670 tests.

## 2026-08-30 — Four fantasy-football capabilities the agents were missing (commissioner request)

Jake asked what a human manager can do that the twelve agents cannot, and then
asked for all four gaps found. All are read-side and identical for every agent,
so §2's same-information guarantee holds by construction; per §8.10's own
argument they land before week 1 so the season's weeks stay comparable.

1. **Future league schedule.** `get_matchup` no longer rejects a future week —
   it returns the pairings (team ids and names, no lineups or points). The
   public site always showed all 18 weeks while the league domain is blocked
   from `web_search`, so this was information the public had and the agents
   did not.
2. **Defense vs. position.** New `player_research` kind `defense_vs_position`:
   fantasy points each NFL defense allows per position, season to date, per-game
   average, rank 1 = softest matchup. Sourced from new `nfl_team`/`opponent`
   columns on `player_week_stats` (migration `0004_stats_team_opponent`),
   written by the stats ingest from the feed's own per-game fields — so a
   mid-season trade cannot smear a player's early games onto his new team.
   nflverse-fallback rows carry no opponent and are excluded for every defense
   alike; the aggregation builds up from week 1 (no backfill of 2025 weekly
   rows — last season's matchups say little about this season's defenses).
3. **Multi-week lookahead.** `get_player_stats` adds `upcoming_opponents`: the
   next 4 games per player with week, opponent, kickoff, and `proj_pts_ppr`
   where loaded. `next_opponent` stays for continuity.
4. **Lookahead projections.** `ingest.projections` now covers the current week
   plus the next two (capped at 18; `projectionWeeks` in `@league/data`).
   Keyless and quota-free. `player_research` kind `projections` already took a
   `week` argument, so future weeks are queryable with no tool change; old
   weeks' rows are kept (projection-vs-actual is benchmark-adjacent data).

Not built, deliberately: `read_url` stays out (spec-optional; §5.8 still says
`web_search` covers news). If Jake wants it, it must land before week 1 —
same §8.10 comparability argument — so the decision is flagged here rather
than queued quietly.

**Review round one** (fresh-context reviewer, per the standing loop) found
seven items; all fixed:
- `defense_vs_position` counted non-final live rows (partial Sundays rank
  defenses on incomparable denominators) and the degraded-week story was
  asymmetric (nflverse overwrites offense/K rows with a null opponent but
  never touches D/ST or unmapped players' live rows). Fix: aggregate
  `final = true` rows only — a degraded week now drops out entirely, since
  its finalized rows carry no opponent and the untouched live rows are not
  final. Spec row and comment reworded to say what the code does.
- The kind could return an empty page for a position with no rows, which the
  §8.4 sentence forbids; the not_found check now runs post-filter.
- `get_player_stats` could hit the §8.2 page cap (each item grew by up to 4
  `upcoming_opponents`) with `has_more: true` and no way to continue; it now
  takes `offset`.
- `upcoming_opponents` included a game already final (Sunday night before the
  week advances), shrinking the real lookahead to 3; final games are filtered.
- `player_ids` silently ignored for `defense_vs_position` — documented in the
  §8.4 row (rows are defenses, not players).
- The jobs.ts lookahead loop was untested; extracted as `ingestProjections`
  (injectable fetcher) in `@league/data` with a test covering the
  null-week-skip. Plus: a vacuous lineup assertion fixed, reporter
  (team-less) future-week shape and week-arg-ignored assertions added.

**Review round two** confirmed every round-one fix against the finalize
ladder and the Sleeper client, and found four more; all fixed:
- `get_player_stats` paged an unordered SELECT — Postgres guarantees no row
  order without ORDER BY, so a split page re-read between two hourly ingests
  could repeat one player and silently drop another. Items now sort by the
  caller's `player_ids` order.
- The final-game exclusion and the `offset` continuation were themselves
  untested; both now have tests (Sunday-night lookahead, two-page split).
- `through_week: currentWeek` overstated coverage by one week (the current
  week's rows are never final until finalization advances the week in the
  same stroke); renamed `finalized_through_week` and computed as the data's
  own max week.

**Review round three** (focused on the round-two fixes) confirmed the sort
and the max-week guard, and caught that the new paging test was vacuous —
it requested ids in insertion order, which PGlite's heap order satisfies
without the sort. The test now requests ids in reverse insertion order, so
deleting the sort fails it. Nothing else new; loop closed.

**Merge with the on-demand-refresh branch** (main moved mid-session, next
entry): the two compose — `get_matchup` keeps my future-week pairings and
gains the current-week refresh; `player_research`'s TTL refresh already
covers future weeks (`week >= currentWeek`), so lookahead projections are
refreshed on demand between daily runs; `defense_vs_position` needs no
refresh (finalized rows only). My migration was renumbered
`0005_stats_team_opponent` — production had already applied main's
`0004_proj_season_week_idx` — and its snapshot regenerated on top of
main's. Also fixed a duplicated heading main carried in this log. Full
suite green after the merge (636 tests).

**Deployed to production** (merge fafa129, Vercel dpl_Hp4CdZpVvY8zUnwuYU5Csdr2533Q):
READY at 03:38 UTC; migration `0005_stats_team_opponent` applied cleanly to
the Neon `main` database (it had only ever applied main's migrations);
`/api/healthz` returns `ok: true` with a fresh tick and the homepage serves
200.

**Preview database wedge — found and fixed.** The Vercel-Neon integration's
per-branch database (`preview/claude/agent-capabilities-fantasy-football-w2ujgx`,
`br-falling-sky-avgb2f7i`) had applied the *original* `0004_stats_team_opponent`
from the pre-merge pushes. After the renumbering it held both migrations'
effects (the proj index and the two stats columns) but recorded neither new
journal row, so its preview deploy failed with 42701 (duplicate column).
Production and every other branch were unaffected. Fixed with Jake's
go-ahead by inserting the two missing `drizzle.__drizzle_migrations` rows
(hashes of `0004_proj_season_week_idx` and `0005_stats_team_opponent`, with
their journal `when` values) on that branch; the migrator's high-water mark
now sits at 0005, schema verified to match. The stale pre-renumber journal
row is inert and left for the audit trail. The push carrying this log entry
is the proof: its preview deploy runs the migrator against the repaired
database.

### Questions for Jake

None.

SPEC updated: §5.3 (stored team/opponent), §5.4 (three-week window), §6
(`player_week_stats` columns), §8.4 (`get_matchup`, `get_player_stats`,
`player_research` rows). Tests: future-pairings and unscheduled-week shapes,
`upcoming_opponents` with a riding projection, defense-vs-position
aggregation/rank/position-filter/not-found, ingest keeps `team`/`opponent`
and nulls without them, `projectionWeeks` cap. Full suite green
(shared 13, engine 171, data 24, agent 161, web 234).
## 2026-08-30 — Review round on the on-demand refreshers: 1 blocker + 6 should-fixes, all fixed

A fresh-context reviewer took the branch diff against SPEC. Findings and
what changed (this supersedes details in the two entries below):

1. **Blocker — "never throws" only covered the fetch.** A failing upsert or
   TTL read would have propagated out of `ensureFresh*`, failed whole
   sessions at snapshot build, and (worse) bypassed the miss cache so every
   read re-downloaded and re-threw. Both refreshers now wrap their entire
   body; any failure degrades to "serve what is stored" and is remembered
   like a fetch miss. Tested with a proxy DB whose transaction throws.
2. **`rosterPayload` read the roster (with injury status) before the
   refresh**, so get_my_team returned pre-refresh injuries on the very call
   that refreshed. The refresh now runs before any read, with a test that
   pins the ordering. Same test added for the context snapshot.
3. **Clock consistency.** TTL checks compare against `Clock.now()`, but rows
   were stamped with wall-clock `new Date()` — divergent under a simulation
   clock override. `upsertProjections` now takes `now` (the refresher passes
   Clock time), and player-feed freshness moved off the fetch-time
   `sleeper.players` health row onto a new `players.applied` health row that
   `upsertPlayers` stamps with Clock time inside its own transaction. That
   also fixes a subtler conflation the reviewer's finding exposed: "a fetch
   succeeded" is not "the data landed", so a failed write can no longer
   masquerade as freshness.
4. **SPEC amended** (§5.1, §5.4, §8.4 player_research row, §15.1 item 11,
   §13's injury paragraph): the on-demand TTL refresh is now in the spec;
   "makes no outbound request" became "never a per-agent request — the only
   outbound path is the shared TTL-guarded refresh".
5. **The player-feed diff now also compares `position` and
   `fantasy_positions`** (eligibility changes are lineup-relevant).
6. **Hot-path performance.** `upsertProjections` is batched (chunked
   multi-row INSERT ... ON CONFLICT with excluded, deduped by player) —
   the season board is ~1,700 rows and previously did one round trip each.
   `player_week_proj` gained a `(season, week)` index (migration 0004) so
   the TTL probe stops scanning the table. The player-feed refresher caps
   its on-demand write at 500 changed rows ("deferred": a delta that large
   is roster-cut day, the hourly job's work; suppressed like a miss so it
   does not re-download back-to-back).
7. **Draft clock.** The draft workflow now pre-warms both feeds before each
   pick session starts, so a stale moment costs the fetch outside the model
   loop and in-session reads hit the fresh path. `get_player_stats` also
   refreshes the player feed (it reports injury status; previously the one
   injury-showing read tool without freshness).

Reviewer concerns checked and found unfounded: duplicate injury.changed
across concurrent refreshes (deduped by `injurySessionKey` +
onConflictDoNothing), information parity, secrets, engine-write rule.

**Round 2 (fresh context): nothing new, nothing blocking.** Five nits, all
accepted as-is: the inflight dedupe ignores per-call opts (production only
uses defaults); the scheduled projections job still stamps wall time
(deliberate — noted in the upsert's comment); on a roster-cut day a warm
process re-downloads the feed every 5 minutes until the hourly job lands
the >500-row delta (bounded, operational note); the draft pre-warm spends
up to one feed fetch of the first pick's clock (the design chosen in round
1); the `tx as EngineDb` cast in the applied-stamp matches the file's
existing style. Loop closed; merging.

## 2026-08-30 — Player feed (injuries) refreshes on demand too (§5.1)

Jake's follow-up to the projections change: agents also need pre-kickoff
injury news, not the hourly ingest's last snapshot. Same pattern, second
feed: `ensureFreshPlayerFeed(db, clock)` in `@league/data`
(`ingest/players.ts`), wired as `ToolContext.refreshPlayerFeed`.

The feed is one ~5MB document of ~11k players, so this differs from the
projections refresher in three ways:

- Freshness reads the `sleeper.players` health row (which every successful
  fetch of that feed already records), so the hourly job and the on-demand
  path share one clock; TTL 15 minutes. Within TTL a read costs one SELECT.
- It diffs against the stored table and writes only players whose
  lineup-relevant fields moved (injury status/body part, roster status,
  NFL team, active, depth-chart order) plus never-seen players — a full
  upsert from inside a tool call would take minutes. The write goes through
  `upsertPlayers`, so a starter going Out emits `injury.changed` and books
  the injury_response session exactly as the hourly job would, just sooner.
- An empty players table is a bootstrap and stays the job's: the refresher
  reports unavailable rather than writing 11k rows mid-session.

Call sites: roster tools and matchup (current/future week, alongside the
projections refresh), free agents, `player_research kind:injuries`
(trending stays hourly — it is a 24-hour window by definition), the draft
board, and the session-start snapshot (moved before the roster read so the
snapshot itself is fresh). Same choice as before on parity: the refresh
updates the shared table; all twelve agents read the same rows.

Considered and rejected: having agents call the Sleeper API directly per
tool call with no store. It breaks information parity (two agents in the
same minute could read different answers), loses the injury.changed event
stream (which is driven by observing *changes* against stored state), and
makes transcripts unreproducible for the benchmark. The TTL store gives the
same freshness with one shared view of the world.

Suites green: shared 13, engine 171, data 36 (6 new), agent 165 (1 new,
1 extended), web 234. Lint and typecheck clean.

## 2026-08-30 — Projections refresh on demand when agents read them (§5.4), week 0 feeds the draft board

Found while answering "can agents see projected stats": `player_week_proj`
was empty in production. The daily `ingest.projections` job fetches the
per-week endpoint with `currentWeek` (0 in preseason, which Sleeper does not
serve), and the rankings ingest computes tiers from the season feed's
`pts_ppr` but discarded the numbers — so `get_available_players.proj_points`
and every lineup-tool `proj_pts_ppr` were null.

Fix: `ensureFreshProjections(db, clock, {season, week})` in
`@league/data` (`ingest/projections.ts`). Reads `max(updated_at)` for the
week; within a 1-hour TTL it is a no-op, otherwise it pulls the feed
(single attempt, 10 s timeout — the daily job stays the patient path with
retries) and upserts. Week 0 pulls the *season* projection endpoint (§5.7's
feed), weeks 1–18 the per-week one. Failures never throw; an empty or
failed pull is remembered in-process for 5 minutes so a session with five
projection reads pays for one attempt. Concurrent callers share one pull.

Wiring: a new optional `ToolContext.refreshProjections`, passed through
`RunSessionDeps` and wired in `apps/web` (`runSession.ts`, `lib/draft.ts`).
Call sites: `get_my_team`/`get_team_roster` (current or future week),
`get_matchup` (current week only — finished weeks are history),
`get_free_agents`, `player_research kind:projections` (asked week when
current/future, plus week 0), `get_available_players` (week 0), and the
context snapshot at session start. Unit tests never wire it, so tools stay
offline in CI; production always does.

Choices made without asking (closest to spec, §5.4 marked optional):

- Information parity (§2) holds by construction: the refresh updates the
  shared table and every agent reads the same rows — it changes *when* the
  shared rows update, not *who* sees what. The player_research header
  comment now says so, since it previously claimed "no outbound request".
- TTL 1 hour / miss-TTL 5 minutes are constants, not settings. Sleeper's
  feed is unauthenticated with no quota; the worst case is one pull per
  serverless instance per hour per week key.
- Past weeks are never refetched — their projections are historical record.
- Twelve concurrent lambdas can still race one pull each; the upsert is
  idempotent so the race is waste, not corruption. Not worth an advisory
  lock at this traffic.
- The autopick fallback path (`availableDraftPlayers` called from the
  draft workflow, no ToolContext) still reads whatever is stored, but any
  agent opening the board via `get_available_players` will have populated
  week 0 moments earlier.

All suites green: shared, engine (171), data (30, 7 new), agent (164,
6 new), web (234). Lint and typecheck clean.

## 2026-08-29 — $0 BYOK steps: root-caused as already fixed in code; historical rows backfilled

The zero-cost sessions on the Anthropic/OpenAI/xAI models (857–862, 881,
flagged in the smoke-round entry below) were root-caused against production
data. Every zero row has `spend_ledger.source = 'gateway'` and
`billed_to = 'gateway'`: the gateway reports $0 for a call billed to a
gateway-held BYOK key, and the code of the day took that 0 as authoritative
instead of falling back to the price table. That is exactly the bug commit
`39d5b78` ("BYOK steps are priced, not $0") fixed — `computeStepCost` now
treats a gateway 0 against real tokens as "not billed here" and prices from
`model_prices`, and `billed_to` names the actual payer. The fix merged to
main at 22:56 UTC and deployed at ~23:02 UTC; every zero row was written
between 17:16 and 22:52 UTC, all on the pre-fix deploy. No BYOK-model step
has recorded $0 since, the unit test pinning "gateway reports 0 with real
tokens → price table" already exists (`spend.test.ts`, "a $0 gateway cost
against real tokens is priced from the table"), and `model_prices` in
production has rows for every league model — so no code change was needed,
only data repair.

**Backfill (production, 2026-08-29 ~23:20 UTC).** 28 ledger rows across
sessions 228, 607–611, 613, 857–860, 862, 869, 881 (teams 1–5 and 7)
were repriced from `model_prices` with the exact `computeStepCost` formula
(uncached input + cached input at the cache rate + output + reasoning at
the output rate, rounded to 6dp), `source` set to `price_table` and
`billed_to` to the real payer (`byok:anthropic`/`byok:openai`/`byok:xai`).
`sessions.cost_usd` was recomputed from each session's ledger sum, and the
day/season rollups re-derived the same way `updateRollups` does (no week
rollups touched — none of these sessions carries a week). Total recovered
spend: ~$0.47; league season rollup went from ~$0.10 to $0.568666.
Backup first, per the standing rule: pre-update copies live in
`backfill_20260829_spend_ledger_zero`, `backfill_20260829_sessions_zero`
and `backfill_20260829_spend_rollups` on the production branch; drop them
once a later audit confirms the numbers.

## 2026-08-29 — Smoke round verified thinking end to end; the harder probe found a real pre-existing bug

Jake asked for a smoke round to verify the reasoning shows up, and gave the
go-ahead to merge and deploy. Merged (with the activity-rail work another
session had landed on main in the meantime), production deploy confirmed by
watching `/sessions/613` start rendering its thinking block, then queued the
round directly in `sessions` (the tick's five-minute sweep starts them; this
sandbox holds no admin or cron secret).

**Smoke round (sessions 857–868): 12 of 12 succeeded, zero errors, zero
`visibility_option_dropped` events** — every provider accepted the visibility
options. Durable `reasoning` landed for six models, two of them new since
the morning measurement: Gemini 3.1 Pro (203 chars — `includeThoughts`
works) and GLM-5.3 (931 chars, interestingly alongside a reported reasoning
token count of zero). Grok, DeepSeek, Kimi, Qwen as before. The transcript
pages render the blocks (Gemini 1, GLM 2, Grok 2 — matching the DB).
Still nothing to show for: all three Anthropic models and GPT-5.6 Sol
(0 reasoning tokens on the trivial task — adaptive thinking skipping, as
before), GPT-5.6 Terra (20 tokens, no summary returned for so small a
burst), Muse Spark (126 tokens, provider withholds text, no flag exists),
and Mistral Large 3 (team 2's swapped model; not a reasoning model).

**The probe that earned its cost.** The smoke task is too trivial to make an
Anthropic model think, so one `manual` Sonnet 5 session (869) ran with a
deliberative draft-strategy objective. Step 1 proved the Anthropic display
option works: 23 reasoning tokens and a real summarized-thinking sentence
recorded in the transcript. Step 2 then failed with the old
`AI_InvalidPromptError: messages do not match the ModelMessage[] schema` —
a **pre-existing** bug, nothing to do with the thinking change:
`player_research` returns `updated_at` as a live `Date` (a drizzle
timestamp), the SDK's JSON-value schema rejects a `Date` in a tool result,
and the very next model step dies. Reproduced locally against the real
`streamText`: the transcript's own bytes validate (JSONB had serialized the
Date), the live object fails — which is exactly why no resumed session and
no smoke test (which never calls `player_research`) ever saw it. Every
session that researches players and then takes another step would have
failed this way, including every onboarding and weekly review.

Fix, two layers: `updated_at` now goes through `iso()` like every other
date in the read tools (the only leak found by audit), and `toolOutput`
JSON-normalizes every result, so the live step sees exactly what the
transcript records and the two can never diverge again. Regression test
drives a Date-returning tool through a live two-step session and validates
every message with the SDK's own `modelMessageSchema` — the same
run-their-validator lesson this log already recorded once. The tick's
automatic retry of 869 (session 870) was cancelled before it could fail
against the un-fixed deploy; a fresh probe runs after this deploys.

**Probe rerun after the fix (session 881): the loop is closed.** Sonnet 5 on
the same deliberative objective: succeeded, 5 model steps, 8 tool calls
(player_research included — through the exact path that killed 869), 874
reasoning tokens, thinking persisted on 3 of 5 steps (1,449 chars), zero
dropped options, and `/sessions/881` renders each step's "Thought — N
reasoning tokens" block in the redesigned step view (which another session
shipped mid-stream; its `sessionTranscript.ts` reads the same first-class
`reasoning` field with the same raw fallback, so the two changes composed
cleanly). Full per-model results are in VERIFIED.md — the visibility-option
verify item is resolved.

Noticed in passing, filed as its own task rather than widened into this one:
sessions on the Anthropic/OpenAI/xAI models record `cost_usd = 0` despite
real token usage (881: five ~9k-token steps, $0.000000), while the other
seven providers record plausible costs. §8.7's spend page undercounts those
teams until that is root-caused (`gatewayCostFrom` trusting a zero instead
of falling back to the price table is the leading suspect).

## Questions for Jake

*(none blocking — FYI items below)*

- **Credentials in the build environment**: this remote session has no `.env.local`; `AI_GATEWAY_API_KEY`, `FANTASYPROS_API_KEY`, `WEB_SEARCH_API_KEY`, `RESEND_API_KEY`, `COMMISSIONER_PASSWORD`, `SESSION_SECRET` and `CRON_SECRET` are in Vercel. `COMMISSIONER_PASSWORD` and `SESSION_SECRET` were confirmed live on 2026-08-29 (both were in fact missing until then, so this list is worth probing rather than assuming); `CRON_SECRET` is confirmed by the tick answering 200. The three third-party keys remain unverified from here. Build/tests that need them run against preview deployments (M3 smoke tests, M4 mock draft, M7 alarm email). If you want them runnable locally in this session, add them to the session environment; otherwise no action needed until M3.
- **FantasyPros free-tier measurement** (§5.7/5.8 verify) requires the key — will run the counted probe suite at M4 and record in VERIFIED.md.

## 2026-08-29 — Prompt: tell agents they can scout rivals and how to reach them

Jake asked to make sure agents can look at other teams' rosters and standings
all season, and know the channels for messaging one team or the whole league.
Audit first: every capability already exists and is in the READ set that
every broad team session kind gets (the narrow kinds — trade_vote,
board_reply, draft_pick, smoke — keep their deliberately trimmed §8.6
lists) — `get_team_roster` (any roster), `get_league_state` (standings,
records, waiver order), `get_matchup`, `get_team_week_results`,
`get_transactions`, `read_board`, plus `post_message` with `@Team Name`
mentions (mentioned team usually gets a `board_reply` session) and the
message on a trade offer. The gap was awareness: the shared system prompt never mentioned
any of it beyond "you may post on the message board."

Changes, on `claude/agent-visibility-communication-xzgd50`:
- `prompt.ts` + SPEC Appendix C (kept in sync): a scouting bullet naming the
  five league-visibility tools (get_league_state, get_team_roster,
  get_matchup, get_team_week_results, get_transactions — Jake also asked
  that agents see what other teams have done), and the board bullet
  rewritten to spell out
  all three channels — board post to the league, @mention to reach one team
  (and that mentions trigger a reply session), trade-offer message to the
  counterparty. No settings literals introduced; identical text for all 12.
- Briefs: `weekly_review` step 1 adds "check the standings";
  `trade_window` step 4 says @mention a team to pitch it directly.
  Regenerated `briefs.generated.ts`.
- New prompt test asserting the scouting tools and all three channels are
  named. Lint, typecheck, and all 527 tests green.

Reviewer round one (fresh context) found two over-claims in the new text,
both fixed: a mention does not always create a reply session (depth ≤ 2 and
3-per-day cap, §9.3), so the prompt and trade_window brief now say "usually";
and the trade-offer message is not private "while pending" — every voter
reads it during review once the offer is accepted.

Reviewer round two (fresh context) found one real bug and two wording
issues, all fixed:
- **get_trade privacy gate widened**: it blocked non-parties only while a
  trade was `proposed`, so the moment an offer died as rejected, countered,
  cancelled or expired, any team (ids are sequential) or the reporter could
  read the full offer and its message — including a live renegotiation via
  the `countered` parent. The site's own /trades page states dead offers
  stay between the two teams (§3.5's lifecycle: only the accepted branch
  enters review). The gate now hides all five never-in-review statuses from
  non-parties; parties still see their own dead offers; review-path statuses
  (accepted, executed, vetoed, failed) stay league-visible. Regression test
  walks every status for a third team, the reporter, and both parties.
- The trade_window brief's "they see the post in their next session either
  way" was a delivery guarantee the snapshot (last 10 board posts, §8.5)
  cannot back on a busy board; dropped. Prompt parenthetical now names the
  exceptions (deep threads, daily reply allowance, paused teams) instead of
  promising next-session delivery.
- This log's claim that the read tools are "in the READ set for all team
  session kinds" corrected to "all broad kinds" (narrow kinds keep trimmed
  lists).

Reviewer round three (fresh context) caught that round two's gate was still
one status short: `failed` has two producers, and the accept-time re-check
failure (§3.5: accept re-runs every proposal check) goes `proposed → failed`
directly — never in review, not on /trades, yet the status-list gate showed
it to everyone. The engine sets `reviewEndsAt` exactly once, on a successful
accept, so the gate now keys on `reviewEndsAt === null` instead of a status
list; a new test drives the accept-time failure through the real
`proposeTrade`/`respondToTrade` path and checks both directions. Also from
round three: the mention-exception list now includes eliminated teams
(events.ts skips them from week 15 on), and the trade-message sentence
states the exact boundary — review entry, not acceptance.

Merged to main as 956940f (after twice bringing in a fast-moving main:
the mock-draft/transcript batch, then the Vercel/Neon audit; only
BUILD_LOG conflicted, both sides kept; 599 tests green on the merged
tree). Production deploy dpl_HoqjKPdrzbAwn3VG787FxwJ7pSQP is READY on
that commit and aliased to league.jake-moses.com; verified live:
/api/healthz, /api/public/pulse and /api/public/standings answer 200,
and /trades serves this branch's new footer text.

Reviewer round four (fresh context) traced every write to `reviewEndsAt`
and every status transition, commissioner reversal included, and found the
gate sound in both directions (a reversed trade keeps its timestamp and
stays public — proof the timestamp, not the status list, is the right
marker). Three text alignments applied: the reporter prompt's privacy rule
(and §11) moved from "pending offer" to the never-entered-review boundary
and now names transcripts alongside scratchpads (transcripts carry
propose_trade args verbatim); the post_message tool description now says
"usually gets a session to reply" to match the prompt; the /trades footer
now draws the line at review entry instead of a status list (which was
wrong for accept-time failures and commissioner-reversed trades). Round
five (fresh context, delta only) verified the three alignments against the
engine and reported no findings — review loop closed.

## 2026-08-29 — Vercel/Neon audit: the alarms that could not fire

Jake asked for an audit of the Vercel and Neon setup and what monitoring to
add. Findings first, from live state (Vercel MCP, Neon MCP, the production
`health` table), then what was changed.

### Found healthy

Tick green every minute; all feeds green; smoke sessions 13/13; deployment
protection right (`all_except_custom_domains`, custom domain public); Web
Analytics collecting; CI covering lint/typecheck/tests/no-database build. The
morning's smoke-test failures fired the outage notices and `email.send`
recorded successful sends — the alert path has now worked for real.

### Found broken or missing

- **Neon was at its 10-branch free-plan limit the day of the audit** — the
  next preview deploy would have failed to create its branch. Resolved by the
  Launch upgrade (limit 5000), not by deletions; stale preview branches remain
  and are cosmetic.
- **The free plan could not carry the season on compute, not just storage**:
  ~190 CU-hours/month included, and the per-minute cron holds `main`'s
  0.25 CU compute awake 24/7 ≈ 180 CU-hours before `dev` or any preview.
  Jake upgraded to Launch the same day.
- **Every alarm channel ran through the tick**, so the tick dying (or Cron,
  or the database) silenced its own alarm. §17 also warned nothing watched
  database growth; nothing watched the gateway balance either, and a $0
  balance is a twelve-team outage.
- **Migration 0002's column drop briefly broke the still-serving deployment**
  (16:23–19:43 UTC error burst: old code selecting
  `fantasypros_daily_allowance` after the new build's migration dropped it).
  Standing rule going forward: a destructive migration ships one deploy
  *after* the code stops reading the column (expand/contract).

### Changed (this entry's deploy)

- **`/api/healthz`** — public heartbeat: `200` while `cron.tick` succeeded in
  the last three minutes (the admin banner's own constant, now shared from
  `lib/healthz.ts`), `503` otherwise, database-unreachable included. Body is
  `ok` + `lastTickAt`, nothing else. For the external uptime monitor only a
  person can create (SETUP §6a).
- **`tick.capacity` stage, hourly** — `db.size` (pg_database_size vs a 10 GiB
  Launch budget; alarm + daily email past 80%) and `gateway.credits`
  (`GET /v1/credits`; alarm + daily email under $100; a malformed response
  reads as unusable, never as $0). Gate pre-stamps like the queue sweep so a
  throwing check retries hourly, not per minute. `notifyOnce` moved from
  `tick.ts` to `alarms.ts` so capacity → alarms keeps imports one-directional.
- **Neon settings applied over MCP** (Launch unlocked them): history
  retention 6h → **7 days**; **daily snapshot** of `main` 10:00 UTC kept 14
  days (10:00, not 09:00 — 09:00 UTC is 4:00 AM ET once DST ends, colliding
  with Tuesday finalization; the reviewer caught it); **`main` protected**.
  Autoscaling had already moved to 0.25–8 CU with the plan.
- Docs: RUNBOOK (tick stage 9, external-monitor section, gateway-balance
  paragraph), SETUP (§3 check, §6 rewritten as done, §6a external monitor +
  four Vercel dashboard switches, fails-silently table), this entry.

**Verified after deploy, 23:04 UTC**: `/api/healthz` answers
`200 {"ok":true,"lastTickAt":...}` from outside on the first post-deploy
tick; `tick.capacity` and `db.size` green in production `health`; and
`gateway.credits` fired a **real alarm on its first run** — the balance is
$97.54, under the $100 line, and `email.send` plus
`notify:gateway_credits:2026-08-29` confirm the email left. The watchdog
paid for itself before the deploy was ten minutes old: **Jake, top up the
gateway and check auto top-up** — today's smoke tests and the mock draft
ate the balance, and at $0 every session fails at once.

### Left alone deliberately

- Stale preview branches and `backup-pre-smoke-cleanup` not deleted — branch
  deletion is destructive and the limit pressure is gone; flagged to Jake
  instead, along with the Neon integration's auto-cleanup toggle.
- No Sentry/APM, no log drain: the health table plus Vercel's error clustering
  answered every question this audit asked, and the league's own Postgres is
  already the season's system of record.
- `GATEWAY_CREDITS_ALARM_USD` ($100) and `DB_SIZE_BUDGET_BYTES` (10 GiB) are
  code constants, not settings — they encode the plan and Appendix F, and a
  commissioner who changes plans edits one line next to the comment that
  explains it.

### Review round one (fresh context): no blockers, six findings

Fixed: a route-level test now pins the public 503's exact body (`{ok,
lastTickAt}` — the §15.5 property lived in a four-line catch nothing
defended); recovery clears the capacity rows' error text so a stale "$42.10"
never sits beside an ok badge; the hourly gate's pre-stamp property has a
test; the size-is-a-floor caveat (history window and other branches are not
in `pg_database_size`) is in the comment; the snapshot moved 09:00 → 10:00
UTC because 09:00 becomes 4:00 AM ET when DST ends and would collide with
Tuesday finalization.

Accepted, recorded: `dueForCapacityCheck`'s select-then-upsert can double-run
under two overlapping ticks (the tick can legally run 800 s against a 60 s
cadence) and at worst duplicates one daily email — the same shape
`sessions.sweep` has run all season; making it conditional buys nothing the
pre-stamp has not already narrowed.

Round two verified all six fixes — the mock genuinely exercises the route's
catch, recovery clearing touches only capacity's keys, the snapshot hour
confirmed live at 10:00 UTC — and reported nothing new. Loop closed.
## 2026-08-29 — Review round on the mock-draft merge

Fresh-context reviewer on the full diff before merging to main. Fixed:

- **Late-draft lineups landed on a week nobody plays** (the real find): the
  draft's auto-fill wrote entries for the draft-time week, but a draft that
  slips past week 1's kickoff starts the season later (§3.7), stranding every
  lineup on an unplayed week — the exact "team fields nobody" gap the feature
  closes. `handleDraftCompleted` now moves the entries to the real start week;
  engine test added.
- `toolOutput` degrades a BigInt/circular result to a §8.4 failure instead of
  throwing outside the per-tool catch and failing the whole session.
- `get_player_stats.last_season` no longer reads "games: 1" off the week-0
  season-total row (games counts real weeks or reads null), and neither read
  path can double-count if weekly history is ever backfilled beside it.
- SPEC self-contradictions from the day's changes: §7.8 vs the §3.1 carve-out,
  §10.1/§9.1 vs the daily season-stats booking, §8.9 and the go-live checklist
  vs gateway-held BYOK. The `/spend` footnote now explains why BYOK teams read
  near zero in "paid".
- Stale comments/titles; removed the dead mock-only debug module.

Recorded, not fixed: the reviewer's claim that `MODEL_PRICE_SEED` is applied
by no code path is wrong — `apps/web/scripts/seed.mts` inserts it with
`onConflictDoNothing` on every build, which is what puts Mistral's price row
on production. The fair kernel (no alarm if a model is ever missing a price
row while BYOK makes the gateway report $0) is deferred: seeding covers every
league model and the reporter, and a health check for price coverage is noted
for M8 hardening.

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

## 2026-08-29 — /sessions/[id] rebuilt as steps (Claude Design handoff)

Jake designed a replacement for the session transcript in Claude Design and
handed the bundle over for implementation. The old page was eighteen flat
events, each a row of badges over a collapsed blob of JSON — everything §12.1
asks for and none of what a reader came for.

What shipped, on `sessions-transcript-redesign`:

- `lib/sessionTranscript.ts` — pure derivation over `session_events`:
  `groupSteps` (the brief, then one step per assistant turn with that turn's
  tool calls nested by `tool_call_id`), `stepTitle`/`callSummary` (a step is
  named after what it did — "Added a free agent", "15 of 16 active"),
  `playerIndex`, and `outcomeOf`. No database reads, so the live view derives
  exactly what the finished page does. 29 tests in
  `test/sessionTranscript.test.ts`.
- `components/session-steps.tsx` — the step card, plus purpose-built renderers
  for `get_my_team`/`get_team_roster`, `get_free_agents`/`get_available_players`,
  `get_player_stats`, `add_free_agent`/`drop_player`, `write_decision_log`/
  `make_pick`, and the scratchpad/board writes. Every other tool falls back to
  the JSON view the page always had. §12.1's raw arguments and result stay one
  disclosure away inside the step that made the call.
- `components/session-view.tsx` and `components/session-rail.tsx` — the header,
  the six facts, the outcome banner, and a sticky scrollspy rail (the only
  client island; open/close is set on the `<details>` elements directly so a
  reader's open step survives a live re-render).
- `live.tsx` now renders the same components with a thinking card above them,
  so a running session and a finished one are one page rather than two.

Three decisions worth recording. **The prototype's palette was stale** — it
was drawn from a pre-redesign snapshot (Geist, `#1f6f4a`, a twelve-link nav),
so the layout was taken from it and the colours from the design system already
in `globals.css`; Jake confirmed. **No Finished/Live toggle**: the prototype
showed one, but status decides which view renders, so a manual switch would
lie about a finished session. **The prototype's tool names were invented**
(`get_roster`, and `get_available_players` for a waivers session); the
renderers are keyed on the tools that actually exist.

Two real defects the work turned up, both fixed:

- The opening `user` event (brief + context snapshot) was being grouped as a
  mid-session nudge, so the brief rendered as a "Note". Caught by a test, not
  by eye.
- "Jump to the decision" rendered accent-on-accent — invisible. `globals.css`
  colours every `a` *unlayered*, which outranks any Tailwind colour utility on
  the anchor itself. The label carries its own colour on a `<span>` now. Worth
  remembering: it will bite any future filled-accent link.

Merged as PR #1 (`133023b`) and deployed: production
`dpl_Bkt9k2mnytHLehwb5aF6oqmEAPdT` is READY on league.jake-moses.com.
Probed `/sessions/857` (a real smoke session) on production: the header reads
"Smoke test — team-1 · Claude Fable 5 · triggered by commissioner" with
succeeded / 12s / $0.00 / 3 steps / 2 tool calls / 7.7k tokens; the banner
says "Looked, and changed nothing." over the agent's own decision log; the
rail lists "Read the brief", "Checked the league" (`get_league_state`) and
"Wrote the decision log". A read-only session was the useful first case — it
is the one the outcome banner has to say something honest about.

Rebased onto main after the durable-thinking work landed below. That entry
made `content.reasoning` first-class on assistant events and added
`assistantReasoning` as its reader; the step card's "Thought" disclosure now
delegates to that reader rather than carrying a second copy of the same
fallback, so both the durable field and the older raw-parts events render.

Verified: lint, typecheck and all tests green; `next build` clean; the page
rendered to static HTML and screenshotted at 1280px and 390px (finished and
running states) — no sideways scroll, tables scroll inside their scrollers,
which `test/mobile.test.ts` now asserts for these tables too.

## 2026-08-29 — thinking confirmed per model; thinking logs made durable and visible (commissioner request)

Jake asked to (1) confirm thinking is enabled for the twelve models, (2) make
sure the thinking logs are persisted for all of them, and (3) show them in the
UI. Branch `claude/confirm-thinking-enabled-bncjs3`.

**(1) Confirmed, with §8.1 precision.** We *enable* nothing and *disable*
nothing: no thinking settings ever reach a provider, by spec. What provider
defaults actually did on the smoke round (production DB, measured today —
full table in VERIFIED.md): 8 of 12 models emitted reasoning tokens
(DeepSeek 222, Gemini 186, Grok 104, Qwen 69, Kimi 63, Muse Spark 62,
GPT-5.6 Terra 24, Fable 5 12). Opus 5, Sonnet 5, GPT-5.6 Sol, and GLM-5.3
emitted zero — for the Anthropic pair that is adaptive thinking (on by
default, model chooses; the smoke task is one trivial tool call) rather than
thinking being off. §8.1 forbids forcing it, so zero-on-a-trivial-task is
the correct reading. Re-judge on the first weekly review, as already noted.

**(2) Persistence had a real gap.** Reasoning *text* only lived in the
transient `session_stream` partial, deleted the moment each step's assistant
event lands. It survived only incidentally, inside `raw.content` reasoning
parts, and only for the 4 models whose provider returns raw reasoning text
by default (DeepSeek, Kimi, Grok, Qwen — measured in prod). Fixed:
`createModelStep` now returns the accumulated reasoning deltas (the same
text the live stream shows) and the session loop records it as
`reasoning` on the assistant event — durable in `session_events`, same as
the message text.

**(3) The UI dropped thinking once a step completed.** `TranscriptEventItem`
rendered only `text`; reasoning was visible solely in the live ThinkingStream
panel. Fixed: assistant events now render a "thinking" block (italic, muted,
matching the live style) from `content.reasoning`, falling back to reasoning
parts inside `content.raw` so the four models' existing production
transcripts show their thinking retroactively, no migration needed.

**Provider visibility options — a decision, logged.** Three providers run
reasoning but hide the text unless asked: Anthropic's current models default
to `display: "omitted"` (thinking blocks stream empty — exactly what prod
shows for Fable 5), Gemini returns thought summaries only with
`includeThoughts`, OpenAI only with a `reasoningSummary` mode. The step now
sends visibility-only options: `anthropic.thinking = {type: "adaptive",
display: "summarized"}` (adaptive is already the default on all three league
Anthropic models; `display` cannot be sent without `type`),
`google.thinkingConfig.includeThoughts = true`, `openai.reasoningSummary =
"auto"`. Reading of §8.1: it forbids budgets, effort flags, toggles,
temperature — things that change *behavior*. These change what the response
carries, not how the model thinks, the same distinction §8.1 itself draws
for prompt caching ("changes cost only, never behavior"), and §12.1 v1.10
exists precisely so spectators can watch agents think. Not asked as a
question because the commissioner's request is the authorization: thinking
logs "for all of the models" are impossible while providers omit the text.

**Verify item, open:** the pass-through of these three options via the AI
Gateway is unverifiable from this sandbox (no `AI_GATEWAY_API_KEY`). On the
next smoke round, check that anthropic/google/openai steps now record
non-empty `reasoning` — and that no provider rejects the option (a 400
would fail sessions; if one appears, drop that provider's option and log it).

Suite after the change: 525 tests green across the five packages
(shared 13, engine 167, data 23, agent 141, web 181), lint and typecheck
clean. The stale assertion in `spend.test.ts` ("no provider options at all",
written for the BYOK removal) now pins exactly the one visibility option.

**Review round 1** (fresh-context reviewer on the diff): no blockers; every
finding fixed rather than argued —
- The Anthropic option was keyed on the `anthropic/` prefix; adaptive-is-the-
  default is only *verified* for the three league models, so a commissioner
  swap to another Anthropic model would have silently forced a thinking mode
  (a real §8.1 toggle). Now an exact-id allowlist (`ANTHROPIC_ADAPTIVE_BY_DEFAULT`),
  with a test that an unlisted Anthropic id gets pure provider defaults.
- No fallback if the gateway rejects the new option — a 400 would have failed
  sessions for 6 of 12 teams. Now: if a step errors before producing any
  output and a visibility option was sent, retry once without it. A rejected
  option costs the league its thinking display, never a session. An error
  after real output is a genuine provider failure and is not retried
  (the tick's requeue owns that path). Both behaviors pinned by tests.
- Closing-step reasoning and the empty-reasoning-omits-the-field behavior
  were untested; both have tests now.
- Consecutive reasoning blocks concatenated with no separator (durable field
  vs raw fallback disagreed); `reasoning-start` now inserts a blank line.
- The raw-content fallback would throw on a malformed element (`null` in
  `raw.content`) and 500 a public page; now guarded, with a test.
- The thinking block renders capped at the same `max-h-[32rem]` scroll the
  JSON blocks use, so a 40 KB trace cannot make transcript pages megabytes
  of DOM.
**Review round 2**: three new findings on the round-1 retry, all fixed —
the "no output yet" retry gate was blind to tool-call stream parts (a pure
tool-call step that errors mid-call would have been silently retried and
double-billed; the gate now tracks every content-bearing part type); a
permanently rejected option degraded silently (the drop now rides the step
result as `visibilityOptionDropped` and the loop records an `info` event, so
the transcript shows the degradation instead of it reading as "this model
has no reasoning"); and the block separator appended eagerly could leave a
dangling blank line after a text-withheld final block (now lazy). All three
pinned by tests; agent suite at 150.

The round-1 reviewer also noted the repo rule that a real session must run
against a deployed build before merge. From this sandbox no preview session can be
started (previews get no cron; the tick and admin need secrets that live in
Vercel). The commissioner has asked for exactly that end-to-end run — a
smoke round — so it runs on production immediately after the merge, with the
defensive fallback above bounding the blast radius if the gateway rejects
the option, and a revert as the rollback path.

## 2026-08-29 — Activity rail: real sentences for draft picks, trades, lineups

Jake flagged that the rail read "Made a draft pick." for every pick. Cause:
`describeTransaction` read only camelCase payload keys while the draft paths
write snake_case (`player_id`, `name`, `pick_no`, `reason`). Fixed on
`claude/draft-pick-action-details-guubgr`: picks now name the player,
position, slot and quote the agent's reason; trades name both sides from
`givePlayerIds`/`getPlayerIds`; lineup diffs say who came in for whom (capped
at two slots); autopicks translate the engine's marker reason ("auto-pick:
deadline" et al.) into prose instead of quoting it as if the agent wrote it.
Reviewer ran twice (fresh context); round one found the autopick-marker
quoting bug and a raw-id fallback in the trade sentence — both fixed.

Known cosmetic double-report, not fixed here: an add-with-drop records both a
`drop` transaction (via `applyDrop`) and an `add` carrying `dropPlayerId`, so
the rail shows "Added X … and dropped Y." next to "Dropped Y." at the same
timestamp. Pre-existing engine behavior; changing what the engine records is
not worth it for a feed cosmetic. Revisit only if it confuses readers.

## 2026-08-29 — v1.10 merged to main; production deploy verified

Jake said "merge to main". Fast-forward 9755d94 → ae8cc5c (main had not
moved). Production deploy dpl_Afsr83Tn1fNU6FvpGR8ynNmwSahf is READY;
migration 0003 applied to the production Neon branch by the build's migrate
step (session_stream present, 4 migrations recorded). Probed on
agent-fantasy-football-league.vercel.app: `/api/public/pulse` returns an
epoch-precision stamp, `/api/public/standings` answers 200, and
`/api/public/sessions/618/live` returns a real session with the public
field allowlist. The `-git-main-` and team-scoped aliases sit behind
deployment protection (302), which is expected; the canonical domain is
open. Still to eyeball once a real session runs: the thinking panel on
`/sessions/[id]` streaming actual gateway deltas — unverifiable from this
sandbox (no AI_GATEWAY_API_KEY, and TCP 5432 blocked).

## 2026-08-29 — SWR auto-refresh + live thinking stream (SPEC v1.10, commissioner request)

Jake asked for two things: SWR so the site auto-refreshes, and live logs — a
stream of what an agent is thinking *while it thinks it*. Branch
`claude/swr-live-logs-3adcdw`.

**Auto-refresh.** `swr` added to `@league/web`. A root-layout client component
(`components/auto-refresh.tsx`) polls `/api/public/pulse` every 20 s and calls
`router.refresh()` only when the stamp moves, so an idle league costs one tiny
query per open tab and no re-renders. The stamp (`lib/pulse.ts`) is the maxima
of the ids/updated_at columns behind everything a spectator can see:
session_events, transactions, board_posts, reporter_posts, sessions.updated_at,
matchups.updated_at, draft.updated_at. SWR gives us tab-hidden pausing and
focus revalidation for free — the reason it beats the hand-rolled interval the
draft room had, which is now also on SWR (same 3 s cadence, §10.2 unchanged).
Server components and the §12.1 revalidate windows are untouched: refresh just
re-fetches the RSC payload, so a page is never staler than its window *plus*
nobody has to reload.

**Live thinking stream.** `createModelStep` now uses `streamText` instead of
`generateText` (§8.1 unchanged: no limits of any kind; the step still returns
one complete assistant message). Reasoning and text deltas accumulate and are
staged through a throttled sink (500 ms) into the new one-row-per-session
`session_stream` table (migration 0003); the session loop deletes the row the
moment the step's assistant event is durable, and on session failure. The new
public `/api/public/sessions/[id]/live` returns the session header, transcript
events after a cursor, and that partial. `/sessions/[id]` renders a live SWR
view (2.5 s poll) for queued/running sessions — accumulated events use the
exact same components as the static page (extracted to
`components/transcript.tsx`) — and the static ISR page for finished ones.

**Choices.**
- Partial-sink writes swallow their own errors: a preview must never kill a
  paid model step mid-stream. The durable transcript path is unchanged.
- `streamText` reports provider failures as stream `error` parts instead of
  throwing; the step rethrows them so the session loop's failure handling is
  identical to before.
- The stream throttle uses `Date.now()`, not `Clock` — it is a mechanical
  write-rate limiter, not league time.
- Migration note: hand-written 0002 shipped without a drizzle snapshot, so
  drizzle-kit re-diffed the FantasyPros drops into 0003. 0003's SQL is trimmed
  to the `session_stream` create only; 0003_snapshot.json now records the true
  schema, so future generates diff cleanly.

**Review round 1** (fresh-context reviewer, 10 findings; all addressed):
1. `router.refresh()` does not invalidate the ISR cache (Next 16 docs), so a
   one-shot refresh on a stamp movement usually re-served the stale payload
   and went quiet. Fixed: a movement opens a refresh window — the client keeps
   refreshing each poll until the longest §12.1 revalidate window (300 s +
   slack) has lapsed since the last movement, so one refresh always lands on
   the regenerated page.
2. `clearPartial` was awaited unguarded on the success path: a transient error
   deleting the throwaway preview row could mark a *succeeded* session failed.
   Fixed: `clearPartial` swallows internally, same rationale as the sink.
3. The site's own polling ate the shared 60/min/IP public-API budget (one live
   tab ≈ 27 rpm; two tabs + NAT neighbours → 429 churn). Fixed: `pulse` and
   `live` each rate-limit in their own per-IP bucket; the five data-API routes
   keep the shared window.
4. No tests for the live route. Fixed: read logic extracted to
   `lib/sessionLive.ts` and tested — cursor filtering, hasMore paging, the
   public-field allowlist (`idempotency_key` and `workflow_run_id` must never
   leave), and the partial being hidden for queued/terminal sessions.
5. Between the assistant-event insert and the partial delete, the live view
   could render the same step twice. Fixed client-side: a batch carrying an
   assistant event supersedes the staged partial for that poll.
6. Leaked `session_stream` rows when an invocation died hard: fixed — cleared
   on the skipped-deadline path, on resume (a killed invocation's stale
   partial must not show as the new one's thinking), and by the tick's
   `reclaimStuckSessions`.
7. Pulse missed commissioner-driven changes. Fixed: the stamp now also covers
   `league_settings.updated_at` and `commissioner_actions` (`teams` has no
   updated_at; §12.2 logs every admin action, which is the better signal).
   `players` is deliberately not covered — see comment in `lib/pulse.ts`.
8. Pulse was 7 round trips. Fixed: one statement of scalar subqueries anchored
   on the settings singleton. Bug found while fixing: a scalar subquery like
   `max(updated_at)` over a table *without* that column silently correlates to
   the outer `league_settings` row and 42803s the whole statement — the tests
   now exercise every column.
9. Each flush rewrote the whole accumulated partial at 2/s regardless of size.
   Fixed: the throttle backs off as the partial grows (500 ms → 2 s past 8 KB
   → 5 s past 32 KB).
10. SPEC §8.2 still said `generateText`; updated to match §12.1 v1.10.

**Review round 2** (fresh context; verified the ten fixes, found 1 HIGH + 3
minor; all addressed):
1. HIGH, round-1 item 1 was still broken: the refresh-window logic lived in a
   `useEffect` keyed on SWR's `data`, and SWR keeps the same `data` reference
   (and skips the re-render) when a poll returns an equal stamp — so the
   window fired exactly once per movement, behaviorally the pre-fix code.
   Moved into SWR's `onSuccess`, which runs on every successful fetch; the
   live transcript view already used that pattern.
2. Stamp stringification of driver-mapped Dates truncated to seconds; two
   writes inside one second could stamp identically. Timestamps now go
   through `extract(epoch from ...)` in SQL (microsecond precision, driver
   independent), with a sub-second test.
3. The "tests exercise every column" claim was ahead of the tests: added
   movement tests for reporter_posts and the settings singleton.
4. Thinking-panel suppression keyed on "any assistant event" could blank one
   poll of genuinely new thinking during a fast tool turnaround. Assistant
   events now record their `step_no`, and the client suppresses only a
   partial whose step an arrived event actually supersedes (events without
   step_no — recorded before it existed — suppress conservatively).

**Review round 3**: fresh context verified the four round-2 fixes against the
installed swr@2.5.1 and postgres@3.4.9 sources (onSuccess fires per fetch;
numeric epoch arrives as a string, so the stamp is lossless; step_no
arithmetic matches the sink's stepNo; resume can never regress it). No
findings — loop closed.

**Preview deploys were failing before any build ran** ("Resource provisioning
failed", no build logs): the Neon free plan allows 10 branches and the
Vercel integration provisions `preview/<git branch>` per preview, so this
branch's would have been the 11th. Deleted the preview database branches of
three git branches fully merged into main (`fe0inf`, `redesign-league-
broadcast`, `speed-insights-integration`) — derived preview data only,
recreated automatically on a future push; production (`main`) and the
`backup-pre-smoke-cleanup` branch untouched. 7/10 slots used now. Worth
knowing for future sessions: stale preview branches accumulate toward this
limit and the failure mode looks like a Vercel build error.

**Verified here.** Full suite green (510 tests, 6 new: streaming/partial-sink
lifecycle, pulse stamp movement). `pnpm build` run against the Neon `dev`
branch — migration 0003 applied there and the build prerendered every page.
(Neon's HTTP driver is reachable from this sandbox now; the 2026-08-28
allowlist note below is stale.) Postgres over TCP (5432) is still blocked
here, so the new routes could not be curled against a running server —
they use the same driver and helpers as every existing public route, and
production applies 0003 automatically via the build's migrate step.
**Not verifiable here:** real streamed deltas from the gateway (no
`AI_GATEWAY_API_KEY` in this environment). The stream-part shapes were checked
against the installed `ai@7.0.84` types; first real session on the preview
deploy will show the thinking panel — worth eyeballing after merge.
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

## 2026-09-05 — Custom events on Vercel Web Analytics

Four custom events now go to Web Analytics from the public site, next to the
page views the 2026-08-29 entry added. They fire only on deliberate reader
actions, never on scroll, poll, or render, because every custom event is
billed like a page view.

- `Filter` — any URL-state change from `useUrlState.set` (the filter selects,
  the sessions chips, the spend sort). Properties: `page`, `key`. The value
  is not sent: one row per team slug answers nothing the page count does not.
- `Show more` — the long-list button. Properties: `page`, `noun`.
- `Compare` — a model picked in the home-page compare panel. Properties:
  `left`, `right` (model names).
- `Toggle steps` — "Expand all" / "Collapse all" on a session transcript.
  Properties: `open`, `steps`.

Code: `apps/web/lib/analytics.ts` is the pure part (vocabulary, `buildEvent`,
`pageOf`) and is unit-tested; `apps/web/lib/track.ts` is the one-line client
wrapper over `track()` from `@vercel/analytics` (the package root, as the docs
say; `/next` exports only the component). `apps/web/test/customEvents.test.ts`
guards the plan limit, the value types, the 255-character caps, and that every
call site sends at most two properties.

**Pricing** (Vercel docs `/docs/analytics/limits-and-pricing`, checked
2026-09-05; the team `jake-moses-personal` is on Pro):

- A custom event costs the same as a page view: **$0.03 per 1,000 events**,
  metered per team, no included allowance on Pro, on top of the Pro plan's
  monthly usage credit. No separate fee to turn custom events on.
- Pro allows **2 properties per custom event**. Web Analytics Plus
  (**$10/month per team**) raises that to 8, extends the reporting window from
  12 to 24 months, and adds UTM parameters. Hobby gets no custom events at all.
- Order of magnitude: 10,000 reader actions a month is $0.30. Not worth the
  Plus add-on; `MAX_PROPERTIES` is 2 for that reason and would move to 8 with
  it.
- Vercel drops properties past the plan limit without an error, so the cap is
  enforced in `buildEvent` where a test can see it.
- Development mode logs each event to the console via the debug script and
  records nothing, same as page views.

## 2026-09-05 — beforeSend filter and three more custom events

`<Analytics />` moved into `apps/web/components/analytics.tsx` (`SiteAnalytics`)
so it can carry a `beforeSend` rule; the root layout is a server component and
cannot pass a function. The rule, `filterUrl` in `lib/analytics.ts`, is pure and
tested:

- **`/admin/*` page views are dropped.** One reader behind a login, paid for
  and mixed into the public numbers otherwise.
- **Query strings and anchors are stripped.** Filter state lives in the URL, so
  `/trades?team=…` would be a row per combination. The `Filter` event already
  records that a filter was used.

Three events added to the vocabulary, all on deliberate reader actions:

- `Step opened` — a transcript step card opened by hand. Properties: `page`,
  `kind` (decision, write, brief, turn). The cards are server-rendered
  `<details>` that React never owns, so `StepOpenTracker` is one delegated
  `click` listener on the document: a click on the summary of a card that is
  closed at click time. Not `toggle` — the reviewer caught that `toggle` also
  fires when the rail's "Expand all" sets `open`, and when the live view moves
  the anchored decision card as steps arrive on every poll, which would have
  billed a "reader opened a step" per poll per open tab.
- `Live watched` — a reader kept a running session or the running draft
  visible for 30 s (`useLiveWatched`). The timer runs only while the tab is
  visible (a background tab is not watching), fires at most once per mount (a
  draft pausing and resuming under a reader does not count twice), and is
  cancelled if they leave or the session ends; never per poll.
- `Notes expanded` — "Read the full notes" on a team's scratchpad card.
  Properties: `page`, `model`.

`Filter` now fires only when the URL state actually changed: a sessions chip
that is already lit can be clicked again, a select cannot re-fire its value.

Review round 1 found the three behaviour bugs above plus an untested
`beforeSend`; all fixed, `beforeSend` exported and tested directly.

Review round 2: `pageOf` now folds `/teams/[slug]/week/[week]` and
`/spend/[slug]` (the team week page renders the same scratchpad card, so
`Notes expanded` would have fanned out to a row per team per week);
`queryChanged` re-serialises both sides so a linked-in `?team=a&` is not a
change; `Live watched` on a session requires `running`, not `queued` (a reader
on the waiting card is not watching an agent think); the sessions list's own
"Show N more" button now sends `Show more` too. The click handler is exported
and tested against the real nested-`<details>` structure under `happy-dom`
(new dev dependency; `test/stepOpenTracker.dom.test.ts`). Known and accepted:
a legacy `?status=timed_out` link lights the "failed" chip, and clicking that
lit chip rewrites the URL to `status=failed` and counts one `Filter`.

Not added, on purpose: nav/footer clicks (page views already count them), poll
ticks and scroll (no reader action, pure cost), anything under `/admin`,
per-row table clicks (each row is a link), server-side events for league
actions (the database already has them in full), and the Web Analytics API on
`/about` (a vanity number for another token).

Jake has set a Spend Management alert on the Vercel team (a dashboard
setting, not code), since Pro meters events with no cap. Nothing open.

Merged to `main` as `fa7e353` after three review rounds (the third found
nothing new) and green CI. Production confirmed: `/api/healthz` ok, and the
client chunk served on `league.jake-moses.com` carries both the event
vocabulary and the `/admin/` drop in `beforeSend`.

## 2026-09-08 — Session keys carry the booking day; the manual trade window can book a check-in

Jake asked which check-in runs next. The answer came from the production
database, and two things fell out of it.

**Bug: `sessions.book` was a silent no-op on the second Tuesday and Wednesday
of Week 1.** `bookSessionsForKind` keyed each session on
`season:currentWeek:currentWeek`. Week 1 runs from the draft (Aug 30) to the
first kickoff (Sep 10), so it holds two Tuesdays and two Wednesdays. The
Sep 1 weekly review and the Sep 2 post-waivers session took the keys
`…:2026:1:1`; this morning's weekly-review booking (09:00:31, 110 ms) hit the
same twelve keys, `createSession` skipped every team, and the job reported
done. Tomorrow's post-waivers booking would have done the same, one day before
the first kickoff. In season a week holds one of each weekday, so the bug only
bites in the preseason stretch.

- Fix: the recurring bookings are keyed on the ET booking day (`etDay(now)`)
  instead of the week, so a same-day re-run is still idempotent and a second
  weekday in the same week books fresh sessions. The key shape in §9.2
  (`…:{season}:{week}:{date}`) holds.
- The day alone would have re-booked a week that did not advance: §13.4
  counts on a deferred or stalled finalization leaving Tuesday's booking a
  no-op, and the review caught that the first cut broke it. So a recurring
  booking is skipped once the current week's first kickoff has passed — the
  week is under way and its review and post-waivers already ran. Preseason
  Week 1 books on Sep 9 (first kickoff is that evening); a week whose game
  moved books nothing the following Tuesday. Tests: both Wednesdays book, a
  same-day re-run books once, an advanced week books a fresh set, an
  under-way week books nothing.
- The commissioner's "book a job" form on `/admin/jobs` can now book a second
  `sessions.book` for the same kind on a later day of the same week (before
  the first kickoff); it used to be a no-op. That is what re-running a missed
  booking should do; noted here so it is not a surprise.
- No production data change: tomorrow's 09:00 job fires on the new code once
  this deploys. This morning's missed weekly review is not re-booked — the
  next one is Sep 15, after Week 1 finalizes, and the agents get Wednesday's
  post-waivers session for this week's wire and lineup.

**Trade windows.** Jake asked whether to keep a weekly window or rely on
agents booking their own, and whether an agent would miss an offer. It would
not: `trade.proposed` books a `trade_response` for the counterparty at once
(37 proposals so far, 37 response sessions, none timed out), and a counter is
a new proposal back the other way. What nothing triggers is the first look.
Decision (Jake, 2026-09-08): no scheduled window. He opens one last manual
`trade_window` for every team from `/admin/teams`, and that session tells the
agents the league opens no more, that offers still wake them, and that a look
at the market is a check-in they book.

- The `trade_window` tool set gains `schedule_check_in`, `cancel_check_in`
  and `list_check_ins`; without them the brief would tell an agent to book a
  check-in it could not book. Spec §8.6 and §8.10 updated, `toolsets.test.ts`
  extended.
- `briefs/trade_window.md` rewritten: the announcement, plus a step that says
  to book a check-in now for another look this week. Regenerated.
- Opening the window: `/admin/teams` runs one session per click, so
  `/admin/jobs` → Book a job → `sessions.book` / `trade_window` now takes a
  window label and an optional note and books one `trade_window` per active
  team, keyed on the label (a row without a label still books nothing, as
  since 2026-09-05). The label path ignores the under-way rule: it is the
  commissioner's explicit act. The note rides `context.note` into the brief
  ("From the commissioner: …"), so the brief itself stays true for any later
  hand-opened window and the "no more windows" announcement is made once.
  Spec §9.1, RUNBOOK. This session has no commissioner credential, so the
  row for the last window (label `final-2026-09-08`, with the note) was
  inserted into production `scheduled_jobs` by hand after the deploy —
  the same row the form writes, minus the `job_booked` audit entry. That is
  recorded here in its place.
- The scratchpad scan (12 teams) found seven agents deferring trade moves to
  the "next trade session". They will read the new rule in that window.
  Three of them already hold 3 pending check-ins (Third & Grok) or 2, so a
  new trade check-in this week means cancelling one; the brief points them
  at `scheduled_sessions`.
- Not re-booked: this morning's missed weekly review. The last trade window
  carries the same trade, wire and lineup tools today, and the next real
  review is Sep 15 after Week 1 finalizes.
- Review round 1 (fresh reviewer): the under-way gate above (its main
  finding); the redundant week in the key suffix; §9.1 and §9.2 rows; the
  `/about` row; the stall comments in `tick.ts` and `watchdogs.test.ts`; an
  engine test that a `trade_window` booking is accepted; the brief's first
  line now matches §2 ("the league schedules no trade windows").
- Review round 2 (fresh reviewer): the brief had hard-coded "this is the
  last one", which every later hand-opened window would repeat — moved to
  the note; the label path was reachable only by a SQL insert — now a form
  field on `/admin/jobs` with an audit entry; an empty label is refused;
  the `date` bypass nobody set is gone (only a labelled `trade_window` skips
  the under-way rule); RUNBOOK's stall paragraph and a recovery step for a
  finalization fixed after Tuesday 9:00 AM; tests for the note and for a
  paused team. Not changed: `sessions.book` still trusts `payload.kind`
  (admin-only, pre-existing).
- Review round 3 (fresh reviewer): one stale sentence in the §8.6 row; the
  note capped at 500 characters server-side to match the form. Nothing
  blocking; the loop ends here.

## 2026-09-08 — GitHub Actions removed; checks moved into the Vercel build

Jake asked to stop all GitHub Actions usage. Deploys never used Actions:
the Vercel GitHub App builds on every push (production from `main`,
previews from other branches). The only workflow was `ci.yml`, which ran
lint, typecheck, tests and a database-less `next build`.

- `.github/workflows/ci.yml` deleted.
- `vercel.json` `buildCommand` is now `pnpm check && pnpm --filter
  @league/web build`. `pnpm check` is the existing root script (lint,
  typecheck, `vitest run`). A red check fails the deploy, which is the
  same gate the workflow gave, now on Vercel build minutes.
- The workflow's extra `next build` without a database is gone. The real
  build covers it: it migrates, seeds and builds against the project's
  `DATABASE_URL`, so a page that throws during prerender still fails the
  deploy.
- RUNBOOK "If `main` is failing" and a VERIFIED note updated.

## 2026-09-08 — Test suite 352 s → 108 s: one PGlite per test file

Jake asked whether the unit tests could run faster. Vitest already ran
files in parallel on every core; the time was inside the tests. Forty-two
files booted a fresh PGlite and ran the migrations in `beforeEach`.
Measured on this box: booting PGlite is 2–3 s, the migrations on top of it
are near zero, loading a pre-migrated data dir is 1.4 s, and truncating
every table is 60 ms.

- `packages/engine/test/helpers/db.ts`: `createTestDb()` boots one
  instance per file (Vitest isolates files, so a module-level cache is
  per file) and truncates every table with `restart identity cascade` on
  each later call. `close` is a no-op. `createTestDb({ isolated: true })`
  still gives a real second instance; `live.test.ts` uses it for its
  "un-seeded database" case.
- `packages/data/test/helpers/db.ts` re-exports the engine helper, as the
  agent package already did.
- Full suite: 961 tests, 352 s → 108 s wall on four cores. `optimal.test.ts`
  (17 s, brute force over 250 rosters) is now the slowest file.

## 2026-09-08 — Tests can no longer send email or reach the network

Jake got real "[League]" alarm emails (week not finalized, gateway
balance, storage budget) at 19:17–19:27 UTC. They came from the
`watchdogs` and `capacity` tests running inside the Vercel build, which
has the production `RESEND_API_KEY` and `ALERT_EMAIL_TO`. Locally the
keys are absent and `sendEmail` returns early, so the suite had never
shown it.

- `vitest.setup.ts` (root), wired as `setupFiles` in all five project
  configs: deletes every credential and outbound address from
  `process.env` (database, gateway, search, Resend, alert email and
  webhook, admin secrets, site domain, simulation flag) and replaces the
  global `fetch` with one that throws. Tests that need the network already
  stub `fetch`; `vi.unstubAllGlobals` restores the throwing one.
- Verified: the full suite passes with fake production secrets in the
  environment, and a throwaway test saw the keys gone and `fetch` throw.
- This retires the CLAUDE.md convention "a test that hits a live API is
  skipped in CI unless the key is present": no such test exists, and the
  setup file now strips the keys everywhere.
- Also fixed in the same push: `countdown.dom.test.ts` failed on Vercel
  because the build sets `NODE_ENV=production` and React's production
  build has no `act`. The root vitest config pins `NODE_ENV=test`.
