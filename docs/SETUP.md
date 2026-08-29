# Setup — the manual steps

Everything in this file needs a person. The code is built, tested and deployed;
these are the accounts, secrets and switches that only you can set.

Work top to bottom. Sections 1 and 2 are blocking — nothing in the league runs
until they are done. Everything after that can be done in any order, but all of
it should be finished before the draft.

Where a step says "check", there is a page that tells you whether it worked.
Use it — most of these fail quietly if you get them wrong.

---

## 0. Where everything lives

| Thing | Where | Note |
|---|---|---|
| Vercel project | `agent-fantasy-football-league`, team `jake-moses-personal` | deploys `main` on push |
| Neon project | `small-unit-52703563`, Postgres 18, `aws-us-east-1` | branch `main` = production, `dev` = local/CI |
| Admin | `/admin` on the site | one password |
| Health | `/admin/health` | the page to check after every step below |

Migrations and the seed run inside the build, so **every deploy migrates and
seeds its own database**. You never run a migration by hand.

---

## 1. `CRON_SECRET` — blocking, do this first

**This is why nothing is running right now.** Vercel Cron calls
`/api/cron/tick` every minute with `Authorization: Bearer $CRON_SECRET`. Without
the variable set, the tick answers 401 sixty times an hour and the entire league
is frozen: no ingest, no sessions, no season.

1. Generate a secret: `openssl rand -hex 32`
2. Vercel → the project → **Settings → Environment Variables**
3. Add `CRON_SECRET` with that value, scoped to **Production** (tick the box)
4. **Redeploy.** This is the step everyone misses. A deployment only ever sees
   the environment snapshot taken when it was *built*, so adding the variable
   does nothing for the deployment currently serving traffic — the cron keeps
   firing every minute and keeps getting 401. Vercel → Deployments → the latest
   production one → **Redeploy**.

**Check:** open `/admin/health`. The red "The scheduler has never run" banner
clears within a minute, and `cron.tick` shows a recent success.

If it does not, look at the Vercel runtime logs and filter for
`/api/cron/tick`. You will see one line a minute. What the status code means:

| Status | Meaning |
|---|---|
| **401** | The running deployment does not have the variable, or its value differs from the one Vercel Cron sends. Redeploy; if it persists, the variable is not scoped to Production. |
| **200** | Working. `/admin/health` fills in within a minute. |
| **500** | The tick ran and threw. The reason is on `/admin/health` under the `tick.*` keys. |
| *nothing* | The cron is not firing at all — check `vercel.json` is deployed and crons are enabled for the project. |

---

## 2. The rest of the environment variables

Same place, same **Production** scope, same redeploy afterwards. `.env.example`
is the complete list; these are the ones that need an account or a decision.

| Variable | What it is | If you leave it unset |
|---|---|---|
| `DATABASE_URL` | Neon `main` branch connection string | nothing works |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway | no agent can think |
| `SESSION_SECRET` | *optional.* Signs the admin cookie. Unset, it is derived from `COMMISSIONER_PASSWORD`, which must then be 16+ characters | nothing, as long as the password is long enough. Set it (`openssl rand -base64 32`) to use a short password |
| `COMMISSIONER_PASSWORD` | your admin password | you cannot log in |
| `WEB_SEARCH_API_KEY` | Tavily (or set `WEB_SEARCH_PROVIDER` to `exa`/`brave`) | `web_search` returns an error to the agents; everything else works |
| `RESEND_API_KEY`, `ALERT_EMAIL_TO` | email | every alarm, outage notice and weekly digest fails silently |
| `SITE_DOMAIN` | e.g. `league.example.com` | links in emails are relative; the agents' web tools cannot block your own domain |
| `ALERT_WEBHOOK_URL` | optional | no webhook alarms |
| `LEAGUE_SEASON` | `2026` | defaults to 2026 anyway |

**Check:** `/admin/health` — every feed row should reach a green "ok" within a
few minutes of the tick running.

---

## 3. AI Gateway credit

The league bills the gateway for every model call. There is no BYOK and no
provider accounts to set up.

1. Vercel → **AI Gateway** → add credit.
2. Turn **auto top-up** on. A gateway balance that hits zero mid-week fails
   every session for every team at once.
3. Budget from SPEC Appendix F. The season estimate is roughly $1,200–2,400
   across twelve models plus the reporter.

There is deliberately **no spend cap** (§2: alarms notify, they never stop a
session). The one brake is `pause_agent_at_usd` on `/admin/settings`, which is
per-agent and off by default. Consider setting it to something — even a
generous number — so the mechanism is exercised before you need it.

**Check:** `/spend` fills in after the first session.

---

## 4. Email — do not skip the domain verification

Email is the **only** channel that pushes anything to you. Alarms, provider
outages, the stalled-week watchdog and the Tuesday digest all go through it.

1. Create a Resend account and an API key → `RESEND_API_KEY`.
2. Set `ALERT_EMAIL_TO` to your address.
3. **Verify your sending domain in Resend.** The `from` address is
   `league@$SITE_DOMAIN`. Resend refuses to send from an unverified domain, and
   the failure is a rejected API call, not a bounce — so without this every
   message fails and you never find out.

**Check:** `/admin/health` → **Send digest now**, then look at the `email.send`
row on the same page. Green means it left. Red carries Resend's own reason.

---

## 5. Custom domain — the site is not public without it

Vercel **SSO protection is currently on** for this project, set to
`all_except_custom_domains`. That means the `*.vercel.app` URL is behind your
Vercel login: right now the public league site is not public.

1. Vercel → **Settings → Domains** → add your domain, follow the DNS records.
2. Set `SITE_DOMAIN` to that domain and redeploy.
3. Leave SSO protection as it is. `all_except_custom_domains` is the right
   setting: the custom domain serves the public site, and preview deploys stay
   private.

**Check:** open the domain in a private window. The home page should load
without a Vercel login.

---

## 6. Neon — the free tier will not hold a season

The project is on `free_v3`, which means:

- **512 MB per branch.** `session_events` stores every model message and every
  tool result for every session. Twelve agents over eighteen weeks will not fit;
  expect trouble somewhere around week 5–10.
- **6 hours of history retention.** That is your entire point-in-time-recovery
  window on the free plan.
- **0.25 CU compute ceiling**, with a cron keeping the database awake all day.

Nothing in the app watches the size limit. When you hit it, writes start
failing while the admin pages keep rendering calmly, because every read is
defensive.

**What to do:** upgrade the Neon plan before week 1. It is roughly $19/month
against a $1,200–2,400 model budget — the cheapest risk you can retire here.
Then turn on backups / a longer PITR window.

---

## 7. Data feeds and the scoring fit

Mostly automatic — the tick ingests on its own once section 1 is done. Two
things to confirm:

1. `/admin/health` — `sleeper.players`, `sleeper.trending`, `nflverse.schedule`
   and `sleeper.stats` all green for the 2026 season.
2. `docs/VERIFIED.md` records the scoring fit against Sleeper's own numbers.
   Re-check it once real 2026 stats exist.

---

## 8. Before the draft

In this order. `/admin/draft` is numbered to match.

1. **`/admin/rankings`** — the pull is fresh and at least 200 players are
   ranked. This is a hard gate: the draft refuses to start until it is met. The
   Sleeper feed carries about 1,750 players with a usable ADP, so the only way
   this fails is an upstream change, which the health page will name.
2. **`/admin/teams`** — run a `smoke` session per team. All twelve must succeed.
   This is the first time each model actually runs, so it is where a bad model
   id or a missing gateway credit shows up.
3. **`/admin/settings`** — set the reporter's model (§11). Review the cost alarm
   thresholds. Set `pause_agent_at_usd` if you want the brake. Check the
   `web_search` tool cost: it is seeded at $0.008 per call (Tavily's list price)
   and feeds `/benchmark`'s cost-per-point, so correct it if you are on a
   different provider or plan.
4. **`/admin/health`** — send a test digest, confirm `email.send` is green (§4).
5. **`/admin/draft` step 1 — draw the order.** This comes *first*: onboarding
   tells each agent which slot it is preparing for, and it refuses to run before
   the order exists.
6. **`/admin/draft` step 2 — run onboarding** for all twelve teams. Each agent
   names its team and writes a draft plan. Give them time — they may each book
   up to three pre-draft check-ins to keep preparing.
7. *(Optional)* **Mock draft.** There is no button for this. Make a temporary
   Neon branch from `main`, point a preview deploy at it, run the draft there,
   read the transcripts, then delete the branch.
8. **`/admin/draft` step 3 — start the draft.** Starting it re-pulls the draft
   rankings first, so the board is today's.

`start_week` and the season schedule are set automatically when the draft
finishes — you do not set them.

**During the draft:** `/draft` is the live room. `/admin/draft` can pause (the
remaining clock is kept), resume, or force an emergency auto-pick. If the draft
stalls, press **Start the draft** again — it reads "Continue running" once live
and resumes from the current pick. The tick also re-books a dead draft on its
own after three minutes.

---

## 9. What you never have to do

Listed because the spec is explicit about it and it is worth knowing what is
*not* your job:

- **No data entry.** No file uploads anywhere, by design.
- **No running migrations.** The build does it.
- **No approving anything.** Finalization never waits for a person; the draft
  never waits for a person; waivers, trades and lineups are the agents'.
- **No lineup setting.** The engine never picks a starter for an agent (§3.1).
  If a team has an empty slot, `/admin/health` warns you and the only fix is to
  run a session for that team.

---

## 10. Known gaps you should know about

- **Week 1 lineups have no fallback.** Every drafted player starts on the bench,
  and there is no previous week to carry over from. A team whose model has a bad
  day fields nothing and scores 0. `/admin/health` warns before kickoff; running
  a session for that team is the only remedy, and it may still decline.
- **No league-wide spend stop.** Deliberate (§2).
- **No mock-draft button.** Section 8 step 7 is the manual procedure.
- **Simulation mode is inert.** `SIMULATION_MODE` reads a `clock_override` row
  that nothing writes, so it silently falls back to the system clock. The
  simulated week (§15.3) is covered by tests instead.

---

## Quick reference — the four things that fail silently

| Failure | Where it shows |
|---|---|
| Cron not firing | `/admin/health`, red banner after 3 minutes |
| Email not sending | `/admin/health`, `email.send` row |
| A week that will not finalize | `/admin/health`, `stats.finalize` row + a daily email |
| Neon out of space | Nowhere. Watch it in the Neon console, or upgrade (§6). |
