# VERIFIED — facts confirmed against live sources

Each entry: date, the request made, what came back. Items marked **verify** in SPEC.md land here.

## FantasyPros free-tier truncation — measured 2026-08-29 (§5.7 verify)

**The §5.7 draft gate cannot be met on the free plan.** Measured against the
live API from production, not inferred: FantasyPros states its own limits in
every `consensus-rankings` response.

```
"tier": "free", "limit": 10, "count": 518   (position=ALL, Draft PPR, 2026)
"tier": "free", "limit": 10, "count": 105   (position=QB)
"tier": "free", "limit": 10, "count": 44    (position=K)
"tier": "free", "limit": 10, "count": 32    (position=DST)
```

Every request is capped at **10 rows**, whatever the position. The ingest
already makes eight calls (the id map, an overall call, and six per-position
calls) precisely to defeat truncation, and the ceiling is still the sum of the
caps: the full run produced **68 ranked players** — QB 10, RB 10, WR 10, TE 10,
K 10, DEF 18 — against a gate that requires **200**, and 518 available on the
overall list alone.

No code change can get past this; it is the plan. Recorded as a `fp.rankings`
health row with the measured numbers, so `/admin/rankings` explains the shortfall
rather than showing "68 ranked (need 200)" beside a working key and no errors.

## 2026-08-28 — §12.1 cache windows on the real CDN (Next 16 + Vercel)

Established by probing the deployed preview, not by reading docs.

- **A page's own `Cache-Control` beats everything else.** A page rendered per
  request (`export const dynamic = "force-dynamic"`, or any page that reads
  `searchParams`) answers
  `private, no-cache, no-store, max-age=0, must-revalidate`, and that value
  overrides both `proxy.ts` response headers and `next.config` `headers()`.
  Two attempts at setting the §12.1 windows in those places had no effect
  whatsoever on the live response.
- **`export const revalidate` is the only thing that works**, and what it
  produces is not an `s-maxage` header: Vercel holds the copy itself and sends
  the client `public, max-age=0, must-revalidate`. The evidence that the
  window is in force is `x-vercel-cache: HIT` / `PRERENDER`, which every ISR
  page now returns.
- **A dynamic segment with no `generateStaticParams` is a server-rendered
  route**, and `revalidate` does not apply to it. `/matchups/1`, `/sessions/1`
  and `/players/…` answered `no-store` with `x-vercel-cache: MISS` on every
  repeat request until each declared the export — even an empty list is
  enough to make Next treat the route as static-with-revalidation.
- **postgres-js retries connections with exponential backoff**
  (`(0.5 + rand/2) × min(3^retries/100, 20)` seconds) and keeps the retry
  count *shared across the pool*, never resetting it until a connection
  succeeds. With no database reachable, a page issuing a dozen reads therefore
  waited minutes: `/`, `/spend` and `/standings` each blew past Next's
  60-second per-page prerender budget and failed the build three times running.
  `backoff: () => 0` is the fix.

Live probe of the preview after the fix (`x-vercel-cache`): `/` HIT; `/about`,
`/standings`, `/draft`, `/board`, `/report`, `/waivers`, `/trades`,
`/benchmark`, `/spend`, `/matchups/1`, `/matchups/18` PRERENDER; `/sessions/…`,
`/players/…`, `/spend/…` MISS then cacheable (`public`, no longer `no-store`);
`/transactions` and `/teams/…` deliberately per-request (they read
`searchParams`).

## 2026-08-28 — Vercel deployment protection

`ssoProtection` is enabled for `all_except_custom_domains`. Preview URLs and
the `*.vercel.app` production URL therefore sit behind Vercel Authentication;
only the custom domain will serve the public site (§2, §12.1). Cron requests
from Vercel bypass it. Nothing to change before launch — the site simply
becomes public when the domain is attached (§17).

## 2026-08-28 — AI Gateway model catalog (§8.1)

Request: `GET https://ai-gateway.vercel.sh/v1/models` (no auth needed for the catalog). 359 models returned.

Final league model list (intent per §8.1 unchanged; two gateway IDs corrected):

| Team slot | Model | Verified gateway ID | Ctx | $/1M in | $/1M out | Cache read $/1M |
|---|---|---|---|---|---|---|
| 1 | Claude Fable 5 | `anthropic/claude-fable-5` | 1,000,000 | 10.00 | 50.00 | 1.00 |
| 2 | Claude Opus 5 | `anthropic/claude-opus-5` | 1,000,000 | 5.00 | 25.00 | 0.50 |
| 3 | Claude Sonnet 5 | `anthropic/claude-sonnet-5` | 1,000,000 | 2.00 | 10.00 | 0.20 |
| 4 | GPT-5.6 Sol | `openai/gpt-5.6-sol` | 1,050,000 | 2.00 | 10.00 | 0.20 |
| 5 | GPT-5.6 Terra | `openai/gpt-5.6-terra` | 1,050,000 | 2.00 | 12.00 | 0.20 |
| 6 | Gemini 3.1 Pro | `google/gemini-3.1-pro-preview` | 1,000,000 | 2.00 | 12.00 | 0.20 |
| 7 | Grok 4.6 | `spacexai/grok-4.6` | 500,000 | 2.00 | 6.00 | 0.50 |
| 8 | DeepSeek V4-Pro | `deepseek/deepseek-v4-pro` | 1,000,000 | 0.66 | 1.98 | 0.022 |
| 9 | Kimi K3 | `moonshotai/kimi-k3` | 1,000,000 | 3.00 | 15.00 | 0.30 |
| 10 | Qwen 3.8-Max | `alibaba/qwen3.8-max` | 1,000,000 | 2.00 | 6.00 | 0.25 |
| 11 | Muse Spark 1.2 | `meta/muse-spark-1.2` | 1,048,576 | 1.25 | 4.25 | 0.15 |
| 12 | GLM-5.3 | `zai/glm-5.3` | 1,000,000 | 1.40 | 4.40 | 0.14 |

Reporter: `anthropic/claude-sonnet-5` (same ID as slot 3).

Notes:
- Spec candidate `google/gemini-3.1-pro` does not exist on the gateway; the live ID is `google/gemini-3.1-pro-preview`.
- Spec candidate `xai/grok-4.6` does not exist; xAI models are listed under the `spacexai/` prefix. `spacexai/grok-4.6` is live.
- BYOK routing was removed on 2026-08-28 (§8.9): every call bills the AI Gateway, so `billed_to` always reads `gateway` and there is nothing per-provider left to verify.
- Sonnet 5 catalog price (2/10) is lower than Appendix F's estimate (3/15); GLM-5.3 (1.40/4.40) differs from F's GLM-5.2 figure. Appendix F is an estimate; the catalog is authoritative for `model_prices`.
- Some models have tiered long-context pricing (OpenAI >272k, Gemini/Grok >200k) and DeepSeek has peak/off-peak windows; `model_prices` stores the base tier, and the gateway-reported cost (when present, §8.7 verify pending) is preferred over the price table.
- Raw catalog extract for the 12 models: `fixtures/gateway-models-2026-08-28.json`.

## 2026-08-28 — Endpoint reachability

- `https://api.sleeper.app/v1/state/nfl` → 200.
- `https://api.sleeper.com/stats/nfl/2025/1?season_type=regular&position[]=QB` → 200 (shape capture + fixtures in M2).
- `https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv` → 206 on ranged GET (URL current, §5.5).
- `https://api.fantasypros.com/public/v2/json/nfl/players` → 403 without key (base URL live; key required — §14 `FANTASYPROS_BASE_URL` consistent with the OpenAPI document).
- `https://api.tavily.com` / `https://api.resend.com` → reachable.

## 2026-08-28 — Sleeper weekly stats shape (§5.3)

Request: `GET https://api.sleeper.com/stats/nfl/2025/{1..18}?season_type=regular&position[]=QB&...&position[]=DEF` — 200 for all 18 weeks; ~600–780 entries per week; team defenses included (`player_id` = team abbreviation). Entry keys: `player_id`, `week`, `season`, `team`, `opponent`, `game_id`, `updated_at`, `last_modified`, `stats`, plus `player` (embedded metadata object), `date`, `status` (null in final data), `category`, `company` ("sportradar"). Zero-valued keys omitted as documented. Cached at `fixtures/sleeper/stats_2025_w{1..18}.json`; season totals at `stats_2025_season.json`; projections shape confirmed (`projections_2025_w1.json`, same shape with projected `pts_ppr`). Re-verify against 2026 Week 1 in season.

## 2026-08-28 — scoring_settings fit (§3.2, Appendix A)

Method per Appendix A: dot product of candidate coefficients vs Sleeper `pts_ppr` over ALL 18 weeks of 2025 (6,057 scored entries — stronger than the required W1–3), residual analysis on mismatches. Result: **Appendix A is correct except two changes**:

1. `pts_allow_14_20` = **0**, not 1 (25 of 26 W1–3 mismatches were DEF rows off by exactly +1, all with 14–20 points allowed; JAX W16 corroborates).
2. Add `idp_blk_kick` = **2** (an individual player's blocked kick, e.g. FB 6202 W2 with `pts_ppr` 2.0 from `idp_blk_kick: 1` alone).

All Appendix A uncertains resolved: `pass_int` −1, `fgmiss` −1, `xpmiss` −1, `ff` 1, `def_st_*` {td 6, ff 1, fum_rec 1}, `st_*` {td 6, ff 1, fum_rec 1}, no plain `fum` penalty, `fum_rec_td` 6 (confirmed by W15 player 12474). `xp_blkd` scores 0.

Final fit: **6,053 / 6,057 exact (±0.01)**. The 4 exceptions are Sleeper-side inconsistencies where their own `pts_ppr` does not match their own stats object (e.g. W5 WR 2374: `pts_ppr` 1.6 ignores a recorded `fum_rec_td`; W5 TEN DEF: `pts_ppr` 15.0 includes a TD the stats object lacks — no `def_td` key, while W7 HOU / W12 PIT identical situations carry it). These are exactly the rows §3.2's `scoring_discrepancy` log handles at runtime (log, show on health page, use `pts_ppr`).

Engine default updated in `packages/engine/src/settings.ts`. The M2 TS test (15.1.1) replays this fit from the fixtures.

## 2026-08-28 — nflverse schedule (§5.5) and 2026 opener (§3.7)

`https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv` → 200. Columns confirmed: `game_id, season, game_type, week, gameday, weekday, gametime, away_team, away_score, home_team, home_score, ...`. 2026 season present (272 regular-season games). **2026 Week 1 earliest kickoff: 2026-09-09 20:20 ET, NE @ SEA — matches §3.7's "Wednesday, September 9, 2026, Seahawks host Patriots" exactly.** Fixture (2024+) at `fixtures/nflverse/games.csv`.

## 2026-08-28 — Sleeper player statuses (§3.6)

`GET https://api.sleeper.app/v1/players/nfl` (12,225 players; active fantasy subset cached at `fixtures/sleeper/players_active.json`). `injury_status` uses short forms (`IR`, `PUP`, `Sus`, `Doubtful`, `Questionable`, `NA`, `DNR`); `status` uses long forms (`Active`, `Injured Reserve`, `Inactive`, `Physically Unable to Perform`, `Practice Squad`, `Non Football Injury`). The IR-eligible default now includes the long forms so the §3.6 "injury_status or status" check works against real data.

## 2026-08-28 — Next.js 16.2.4 breaking changes (AGENTS.md requirement)

Read from the bundled docs at `node_modules/next/dist/docs/` before writing any `apps/web` code, per AGENTS.md. What actually differs from older Next.js and therefore governs this codebase:

- **Async request APIs (breaking).** `cookies()`, `headers()`, `draftMode()`, and `params`/`searchParams` in `layout`, `page`, `route`, `default` are Promises; synchronous access was removed in 16. Every dynamic route and the commissioner auth read must `await` them.
- **`middleware.ts` → `proxy.ts`.** The named export becomes `proxy`. The `edge` runtime is not supported in `proxy` (it is nodejs, not configurable). Config flags renamed (`skipMiddlewareUrlNormalize` → `skipProxyUrlNormalize`). Commissioner cookie checks therefore live in `proxy.ts` on the Node runtime — which suits us, since the engine needs Node.
- **`revalidateTag(tag)` now requires a `cacheLife` profile** as a second argument; the one-argument form is a TypeScript error. `updateTag(tag)` is the new Server-Actions-only read-your-writes API.
- **Turbopack is the default** for `next dev` and `next build`; a custom webpack config makes the build fail rather than silently fall back.
- **`next lint` was removed** and `next build` no longer lints — CI runs ESLint directly, which this repo already does.
- **Route handlers are not cached by default**, which is what the public JSON API and `/api/draft/state` need (§12.1 asks for `no-store` on draft state). Page-level `export const revalidate = N` still applies for the 30 s live / 5 min default rendering rule.
- Node 20.9+ and TypeScript 5.1+ minimums; the Vercel project is Node 24.x, so this is satisfied.
