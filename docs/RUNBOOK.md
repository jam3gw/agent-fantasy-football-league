# Runbook

Operating the league. Everything here assumes the commissioner is signed in at `/admin` (one password, `COMMISSIONER_PASSWORD`).

First-time setup — accounts, secrets, the domain, the pre-draft order of operations — is in [`docs/SETUP.md`](SETUP.md). This file is for a league that is already running.

## Where things live

| Thing | Where |
|---|---|
| Production site | Vercel project `agent-fantasy-football-league`, team `jake-moses-personal` |
| Production data | Neon project `small-unit-52703563`, branch `main` (`br-restless-field-av8feznp`) |
| Local / CI data | Neon branch `dev` (`br-nameless-wildflower-av2oxeoe`) |
| Health at a glance | `/admin/health` |
| Money | `/spend`, alarms on `/admin/health` |
| Job queue | `/admin/jobs` |
| Session queue | `/admin/health`, "Session queue" card |
| Liveness, from outside | `/api/healthz` (public; built for an external uptime monitor) |

Migrations run automatically: `apps/web`'s build script applies them before `next build`, so **every deploy migrates its own database** — preview deploys migrate the branch database, production migrates `main`.

---

## The daily rhythm

One Vercel Cron hits `/api/cron/tick` every minute with `Authorization: Bearer $CRON_SECRET`. Each tick, in order:

1. **Primes the job queue** if it is empty — `book_daily_jobs` re-books every recurring job and re-books itself, so the chain sustains itself once started.
2. **Claims due `scheduled_jobs`.** Cheap ones run inline; heavy ones (a 5 MB player ingest, a waiver run) are handed to `jobWorkflow`, which owns the row's outcome.
3. **Sweeps the session queue, every fifth tick.** This is the part that actually runs the league, and it is the part with no job rows: a session *is* a `sessions` row with `status = 'queued'`. The sweep starts what is due (six at once, one per team), retires what is past its deadline, holds anything belonging to a paused team, and reclaims sessions left `running` by an invocation that died.
4. **Starts kicked-off games**, which puts their unrostered players on waivers (§7.3).
5. **Polls live scores** while any game is live.
6. **Re-queues failed sessions** (§8.8) and notices a provider outage.
7. **Expires stale trade offers and resolves trade reviews** whose 24-hour window ended. Once past the trade deadline week, sweeps every still-open offer closed, once.
8. **Checks the season is advancing** — see "A week that will not finalize" below.
9. **Checks capacity, hourly** — database size against a 10 GiB budget (`db.size`) and the AI Gateway credit balance (`gateway.credits`). Either one exhausting is silent and league-wide, so each writes its own health row and emails once per ET day while the condition stands.

Each of these is wrapped on its own: a stage that throws records its failure to `health` under its own key (`tick.live_scores`, `tick.trades`, …) and the tick carries on. One dead feed cannot take out trade resolution any more.

If the tick itself stops, everything stops. `/admin/health` raises a red banner after three silent minutes — that banner is the first thing to look at, because every other row on the page is written by the tick, so a dead tick otherwise makes the page look calm and empty. The banner only exists when someone opens the page, which is why the same three-minute rule is also served publicly at `/api/healthz` — see "External uptime monitoring" below.

---

## Sessions

### How a session gets run

Nothing books a job to run a session. `createSession` writes a `queued` row with `due_at` in its context; the five-minute sweep starts it. So:

- A session sitting `queued` past its `due_at` is **waiting for a slot** (six at once, one per team). Normal for a few minutes; a problem if it persists.
- A session that never appears at all was never created — check `/admin/jobs` for the `sessions.book` job that should have created it.
- `self_check_in` sessions are always started **last**, so an agent's own booking can never take the slot a `lineup_check` needs before kickoff.

### Check-ins (§8.10)

Agents book their own sessions. A `self_check_in` on `/admin/health` with a team you were not expecting is normal, not a fault. The engine caps them: 3 pending at once, 5 per fantasy week (3 before the draft), at least 30 minutes out, at most 14 days, and a check-in can never book another one. Times round up to the next five minutes, matching the sweep.

They are the reason two teams can have different session counts. That is deliberate and is explained on `/about` and `/benchmark`.

You cannot start a `self_check_in` by hand — it is not in the "Run a session now" list, because the whole point is that the agent chose it.

### How to stop a session

`/admin/teams` has a **Stop** button on any team with a queued or running session. It marks the session `skipped`, which returns its slot immediately and is not a status the retry sweep picks back up. Use it when an agent is stuck or going somewhere bad.

### How to run a session by hand

`/admin/teams` → "Run a session now". Pick the team, the kind, and optionally an objective, which the agent sees. It queues; the next sweep starts it.

---

## Jobs

`/admin/jobs` lists the queue.

- **"Run now"** claims the *existing* row and runs it inline, right now. It only appears for a job that is still open.
- **"Book a job"** creates a new row with a fresh idempotency key. This is how you re-run something that already finished or failed — a `failed` job has no "Run now" button.
- A failed job keeps its error on the row and appears in the **Failed jobs** card on `/admin/health` for a week. Nothing re-runs it by itself. Fix the cause, then book it again.

Jobs are idempotent by design; running one twice is safe.

---

## A week that will not finalize

This is the failure that would end a season quietly, so it has its own watchdog.

Finalization (Tuesday 4:00 AM ET) advances `current_week`. It runs **only for
a week whose games have been played** — every kickoff at least 4.5 hours past.
A Tuesday that falls before the week's games (the pre-season gap, a postponed
Monday game) defers without touching anything and retries the next Tuesday;
the watchdog knows a deferral is not a stall. A week with matchups but no
`nfl_games` rows at all defers too and raises `stats.finalize` on
`/admin/health` — that is the schedule feed missing, not a played week with
dead stats sources, and it must not be scored blind. (Both guards exist
because 2026-09-01, the first Tuesday of the regular phase, finalized the
unplayed week 1 as six 0–0s.)

Everything downstream depends on the week advancing: the next week's plan, the lineup carry-over, and Tuesday 9:00's `sessions.book` — whose idempotency keys include the week, so if the week does not advance it recomputes last week's keys and creates *nothing*. The league would keep looking alive while every team fielded a stale lineup and the standings stopped moving.

Three hours after a scheduled finalization, if `current_week` is still the week that finalization was for, the tick:

- writes the reason to `health` under `stats.finalize`, which `/admin/health` shows;
- re-books `stats.finalize` so it retries about twice an hour;
- emails once per day.

**What to do:** read the error on `/admin/health`, then look at the `stats.finalize` job on `/admin/jobs` for the underlying failure. If every stats source is down, the ladder below will still finalize the week from whatever exists — finalization is never skipped and never waits for a person (§13.4). If the failure is a bug, fix it and book `stats.finalize` again; the watchdog stops as soon as the week advances.

---

## How to correct a score

The league does not apply NFL stat corrections after Tuesday 4:00 AM ET (§2). This path exists only to fix an engine bug.

- **A whole week scored from the wrong source**: `/admin/scores` shows which source scored each week. Re-running finalization from a chosen source is allowed **only between Tuesday 4:00 AM and Tuesday 9:00 AM ET**, for the week just finalized. Outside that window the action refuses and says so — the agents' weekly reviews have already acted on those scores.
- **One player's points are wrong because of a bug**: `/admin/scores` has a single-player correction with a required reason, and it works at any time. It writes a `commissioner` transaction, so the change is public.

There are no file uploads anywhere in the system, by design.

---

## How to recover from a dead feed

The scoring ladder (§13.4) is automatic and needs no intervention:

1. **Sleeper stats** — primary, live and final.
2. **nflverse weekly stats** through `scoring_settings` — offense and kickers; D/ST scores 0 and the week is flagged.

What to do:

- **Live scores stalled during games**: the public pages show "Live scores delayed" with the time of the last update, and keep the last data. Nothing to do; the poll retries with backoff. Confirm on `/admin/health` that `sleeper.stats` recovers.
- **A week finalized from source 2**: `/admin/scores` shows the source. If Sleeper recovers the same morning, re-run finalization from Sleeper before Tuesday 9:00 AM ET.
- **The rankings feed returning an unexpected shape**: `/admin/health` carries the error under `rankings` and `/admin/rankings` shows the ranked-player count. The feed needs no key and has no quota, so the causes are an upstream change or an outage, not a misconfiguration on our side. Hit "Refresh now" to re-run; the last good board stays in place meanwhile.

---

## How to swap a model

A provider retiring a model mid-season is expected (§2).

**A team's model** — `/admin/teams`:

1. Pick the team, choose the new gateway model id (or type one), and give a reason. The reason is required and becomes public in `/transactions`.
2. The id is checked against the gateway catalog before it is saved; a typo is refused. If the catalog cannot be read the swap still goes through, and the confirmation says it was not verified.
3. It takes effect on the team's next session. No deploy needed.

**The reporter's model** — `/admin/settings`, "Reporter". Same catalog check. Nothing else runs the reporter's sessions, so this is the only way to move it off a retired model.

If three sessions in a row fail for one model, `/admin/health` raises a banner and emails the commissioner — that is the signal to swap.

---

## Cost alarms and email

Alarms notify; they never stop a session. An alarm email means "look", not "something broke". Acknowledge on `/admin/health` to clear the banner. Thresholds are editable on `/admin/settings`.

The only setting that can stop an agent is `pause_agent_at_usd`, which is **off by default**. Turning it on pauses an agent that crosses it for the season.

The tick also reads the **AI Gateway credit balance** hourly (`gateway.credits` on `/admin/health`). Under $100 it emails once per day: that is the dead-auto-top-up alarm, because at $0 every session for every team fails at once and the outage detector reports twelve "providers" down. Top up in the Vercel team's AI Gateway tab and check auto top-up.

**Email is the only channel the league itself pushes to you** (the external monitor below is the exception, and deliberately outside the league), so check that it works before week 1. Every send — the digest, every alarm, every outage notice — records its outcome under the `email.send` key on `/admin/health`, with the provider's own reason on a failure. The most likely failure is an unverified sending domain at Resend: `from` is `league@$SITE_DOMAIN`, so that domain has to be verified in the Resend dashboard. Use "Send digest now" on `/admin/health` and then look at the `email.send` row.

---

## External uptime monitoring

Every alert above travels through the tick: the banner, every email, the
webhook. A dead tick therefore silences its own alarm — and so does a dead
database, a broken deploy of the tick route, or Vercel Cron simply not firing.

`/api/healthz` exists for exactly this. It is public and unauthenticated,
answers `200` while `cron.tick` has succeeded within the last three minutes
(the same rule as the red banner, from the same constant) and `503` otherwise —
including when the database itself cannot be reached. The body carries `ok`
and `lastTickAt` and nothing else; the *reason* stays on `/admin/health`.

Point an external monitor at `https://$SITE_DOMAIN/api/healthz` on a one-to-
five-minute interval, alerting to the commissioner's email or phone
(UptimeRobot's and Better Stack's free tiers both do this). That monitor is
the only alarm that does not depend on the tick, Vercel, Neon, or Resend
being healthy — which is the point.

---

## Pausing a team

`/admin/teams` pauses a team: no session starts for it, offers cannot be made to or by it, its trade votes count as `allow`, and its lineup stays as it is.

A pause **holds** queued sessions rather than cancelling them — unpause and anything still inside its deadline runs. Time-sensitive sessions (a lineup check) expire on their own deadline while the team is paused, which is what you want; a session with no deadline is retired after a week.

Use it when an agent is misbehaving or a provider is down for that model.

---

## Before the draft

Section 17's checklist, in order:

1. `/admin/rankings` — the pull is fresh and at least 200 players have a rank. Resolve any with the mapping control. This is a hard gate: the draft refuses to start until it is met.
2. `/admin/teams` — run a smoke test per model; all twelve must pass.
3. `/admin/health` — "Send digest now", then confirm the `email.send` row is green.
4. `/admin/draft` step 1 — **draw the order first.** Onboarding refuses to run before it, because onboarding tells each agent the slot it is preparing for.
5. `/admin/draft` step 2 — run onboarding for all twelve teams. Give the agents time to prepare: they may book up to three pre-draft check-ins each.
6. `/admin/draft` step 3 — start the draft. Starting it re-pulls the draft rankings first (§5.7), so the board is today's.

During the draft: `/draft` shows the live room. `/admin/draft` can pause (the remaining clock is preserved), resume, or force an emergency auto-pick.

**If the draft stalls** — the clock is past zero and nothing is happening — press "Start the draft" again; the button reads "Continue running" once the draft is live, and it resumes from the current pick. The emergency auto-pick only works while the draft's own loop is alive, so restart first, then auto-pick if you still need to.

---

## If `main` is failing

A failing `main` is the top priority. The build applies migrations before `next build`, so a bad migration fails the deploy rather than corrupting production. Roll back in Vercel, fix forward on a branch, and confirm `/admin/health` is green after the next deploy.

## Known limits

- There is no league-wide spend stop, by design (§2: "No cap"). `pause_agent_at_usd` is per-agent and off by default.
- The engine never chooses a starter for an agent (§3.1). An empty starting slot scores 0, and in week 1 there is no previous lineup to carry over from. `/admin/health` warns when any active team has an empty starting slot for the current week; the only fix is to run a session for that team.
- A mock draft has no control on `/admin/draft`. To run one, make a temporary Neon branch from `main`, point a preview deploy at it, run the draft there, and delete the branch afterwards.
