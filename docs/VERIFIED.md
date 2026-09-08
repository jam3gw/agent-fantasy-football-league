# VERIFIED — facts confirmed against live sources

Each entry: date, the request made, what came back. Items marked **verify** in SPEC.md land here.

## 2026-09-08 — Gateway cost field and the ledger, checked on session 2598 (§8.7 verify)

Jake asked whether cost tracking works for `/sessions/2598` (Five Alarm
Spark, `meta/muse-spark-1.2-contributor`, week 1 trade window, succeeded,
12 model steps, 15 tool calls). Checked production (Neon `main`) end to end:

| Check | Result |
|---|---|
| `spend_ledger` rows for the session | 12, one per model step, `step_no` 1–12, all `source = gateway` |
| `assistant` events in `session_events` | 12, each carrying the same `usage` and `cost_usd` as its ledger row |
| `sessions.cost_usd` vs `sum(spend_ledger.cost_usd)` | $0.013368 = $0.013368 |
| `sessions` token columns vs ledger sums | 371,741 in / 25,829 out / 22,903 reasoning on both sides |
| Gateway cost vs `model_prices` recompute (0.10 in, 0.20 out, 0.002 cache read, reasoning at the output rate) | equal to the cent-of-a-cent on all 12 steps |
| `spend_rollups` for team 11 (day 2026-09-08, week W1, season 2026) | $0.013368 / $2.925117 / $3.897208, each equal to the ledger |
| `spend_rollups` for the league | equal to the ledger once the one running session (2599) had written its step; a rollup lags the ledger only for the seconds between one step's `recordSpend` and its `updateRollups` |
| `/sessions/2598` | "Cost $0.01", 398k tokens, 23k reasoning |
| `/spend/team-11` | session 2598 listed, 2026-09-08 day row $0.01, season (list) = season (paid) = $3.90 |

So the **verify** on the gateway cost field (§8.7) is resolved for this
model: `providerMetadata.gateway.cost` is present and `computeStepCost`
prefers it, and it agrees with the catalog price table exactly. The same
check across every ledger row since 2026-09-05 shows `gateway` for Alibaba,
DeepSeek, Meta, Mistral and Z.ai steps and `price_table` for every Anthropic
step (Fable 5, Sonnet 5): the gateway reports no cost (or 0) on those, and
the fallback the spec prescribes is what the ledger records. Not a fault —
the fallback is priced from the same catalog — but it is why an Anthropic
step can never read `gateway` on `/spend` today.

One display finding, fixed the same day: `money()` rounds to the cent, so
every one of the twelve steps on `/sessions/2598` read "$0.00" beside a
banner saying "Cost accrues per step, shown inline". Step costs on the
transcript now show four places under a cent, or "<$0.0001" below that
(`stepMoney`); totals, including the live thinking card's running total,
keep two.

## 2026-09-05 — AI Gateway catalog check for the GLM-5.3 promo entry (§8.1)

Request: `GET https://ai-gateway.vercel.sh/v1/models` (no auth). Slot 12 moves
to the 50%-off entry; the id is live:

| Gateway ID | Ctx | $/1M in | $/1M out | Cache read $/1M | ZDR | No training |
|---|---|---|---|---|---|---|
| `zai/glm-5.3` (old; US regional price, which the ledger matched) | 1,000,000 | 1.40 | 4.40 | 0.14 | some | some |
| `zai/glm-5.3-promo-50` (new) | 1,048,576 | 0.70 | 2.20 | 0.13 | all | all |

Same description ("uses the same base model as GLM-5.2"), same tags
(`reasoning`, `tool-use`, `implicit-caching`), same `supported_parameters`
and specifications. The promo entry lists no `regions` and no
`reasoning_options` block (the league sets none, §8.1). Checked against the
ledger first: GLM's 2026-09-01→04 tokens at 1.40/4.40/0.14 come to $2.76
against $2.88 recorded, so the current seat pays the regional rate and the
promo is a real halving.

## 2026-09-03 — AI Gateway catalog re-check for the Contributor tier (§8.1)

Request: `GET https://ai-gateway.vercel.sh/v1/models` (no auth). 369 models
returned. Slot 11 moves to Meta's Contributor pricing tier; the id is live:

| Gateway ID | Ctx | $/1M in | $/1M out | Cache read $/1M | Training on data |
|---|---|---|---|---|---|
| `meta/muse-spark-1.2` (old) | 1,048,576 | 1.25 | 4.25 | 0.15 | no |
| `meta/muse-spark-1.2-contributor` (new) | 1,048,576 | 0.10 | 0.20 | 0.002 | yes |

Same `supported_parameters`, same tags (`reasoning`, `tool-use`,
`implicit-caching`, `file-input`, `vision`) and the same description of the
model on both entries; only the price and the training term differ. The
catalog shows `max_tokens` equal to the context window for both, so nothing
about output limits changes (§8.1 sets none).

## 2026-09-03 — Prompt caching as the ledger actually recorded it (§8.1, §8.7)

Request: every `spend_ledger` row for the two Anthropic models on production
(233 model steps across 63 sessions, 2026-08-30 to 2026-09-03), read per step.

What came back. Within a session `cached_input_tokens` was the same number on
every step after the first — the size of the system prompt plus the first user
message — and never grew. Session 1104 (Fable, weekly_review): step 1 read
14,459 input tokens with 0 cached; steps 2–8 read 21,595 → 29,342 input tokens
with 14,457 cached on each. Session 1902 (Sonnet, trade_window, 15 steps) went
from 21,444 to 84,054 input tokens with 21,442 cached throughout. So every tool
result after the snapshot was billed at the full input rate on every later
step. Across all Anthropic steps after the first, the cached share averaged 34%;
Fable's input side cost $12.05 of its $20.01 total, of which $11.30 was uncached.

Why: `withCaching` put `cache_control` only on the system prompt and the first
user message, exactly as §8.1 v1.5 said. A breakpoint caches the prefix that
ends at it; nothing after the snapshot ever had one.

Simulated with the same rows, a breakpoint on the newest turn (the previous
step's whole prompt read from cache at the cached rate, the new content
written at 1.25× the input rate): Fable $7.36 instead of $12.05 on the input
side, Sonnet $2.64 instead of $4.98 — 41% of the Anthropic input spend, 26% of
Anthropic spend overall, about 10% of league spend to date. The 5-minute cache
holds: the longest gap between two consecutive Anthropic steps was 156 seconds
(average 16–21 s). Other providers' automatic caching sat at 29–43% on later
steps and is not ours to set.

Inferred, not measured, from the same rows: the AI SDK appears to fold
cache-write tokens into `inputTokens` (step 1 of session 1104 reported 14,459
input, and step 2 read 14,457 from the cache, so the write must have been in
step 1's count). The ledger never recorded writes, so it had priced them at the
plain input rate; `cache_write_tokens` is now recorded and priced at 1.25×.

**Verified on production 2026-09-05** (session 2117, Sonnet, trade_response,
2026-09-04): input 15,558 / 19,998 / 27,742 / 29,235 / 30,533; cached 0 /
15,556 / 19,996 / 27,740 / 29,233; cache writes 15,556 / 4,440 / 7,744 /
1,493 / 1,298. All three conditions below hold on every step, and the same
pattern shows on every Anthropic session since the deploy (2099–2150). The
daily trade-window bill went from $10.09 to $5.18 the next day. The
conditions, as they were written before the check:

- `cached_input_tokens` rises step by step (step N ≈ step N−1's input);
- `cache_write_tokens` is above 0 on step 1 and on later steps, which
  confirms the gateway reports the field at all;
- `input_tokens ≥ cached_input_tokens + cache_write_tokens` on every step,
  which confirms the "folded into input" reading; if it does not hold, the
  price-table formula in `computeStepCost` under-bills the write.

The simulated savings above assume all three hold and that every step after
the first is a full-prefix hit.

## 2026-09-03 — Where the tokens go (§8.7)

Request: `session_events` and `spend_ledger` on production, all sessions.

- 3,153 tool results, 20.5M characters. Largest: `player_research` 2.94M,
  `get_available_players` 2.65M (draft only), `get_team_roster` 2.31M,
  `get_transactions` 1.48M (13.5k characters per call; a `lineup` row carried
  the full lineup before and after next to its diff).
- A `weekly_review` step averaged 125k input tokens (first step 11k, largest
  562k); a `trade_window` step 82k. Session 1109 (Gemini, weekly_review) made
  121 tool calls, 56 of them `get_transactions` paging the same list, and cost
  $8.84 — 12% of all spend to date.
- Identical repeated calls in one session: `get_transactions` 28,
  `set_lineup` 23, `get_free_agents` 19.
- Check-ins: 15 queued; 8 were booked for 11:00–11:30 AM ET Sunday, the same
  moment as the `lineup_check` the week plan runs 90 minutes before the 1 PM
  window. The snapshot did not list either; `list_check_ins` was called
  before booking by 9 of the 12 agents.

## What provider-default reasoning actually returns, per model — measured 2026-08-29 (§8.1/§12.1)

Queried the production `session_events` (assistant rows joined to `sessions`),
which hold every model step from the smoke rounds. Two separate facts per
model: did the provider *spend* reasoning tokens, and did it *return* the
reasoning text (a non-empty `reasoning` part in the raw assistant message)?

| Model | reasoning tokens | reasoning text in `raw` |
|---|---|---|
| deepseek/deepseek-v4-pro | 222 | yes |
| google/gemini-3.1-pro-preview | 186 | **no** — no reasoning part at all |
| spacexai/grok-4.6 | 104 | yes |
| alibaba/qwen3.8-max | 69 | yes |
| moonshotai/kimi-k3 | 63 | yes |
| meta/muse-spark-1.2 | 62 | **no** — reasoning part present, text empty |
| openai/gpt-5.6-terra | 24 | **no** — reasoning part present, text empty |
| anthropic/claude-fable-5 | 12 | **no** — reasoning part present, text empty |
| anthropic/claude-opus-5 | 0 | — |
| anthropic/claude-sonnet-5 | 0 | — |
| openai/gpt-5.6-sol | 0 | — |
| zai/glm-5.3 | 0 | — |

So with pure provider defaults, thinking *happens* on 8 of 12 but its text is
recoverable for only 4. The zero rows are consistent with adaptive/dynamic
thinking skipping a trivial task (the smoke test is one tool call), not with
thinking being disabled — nothing in the codebase sends any thinking setting
(§8.1). Muse Spark's empty-text reasoning part appears to be the provider
withholding its raw chain of thought; no visibility flag is documented for it,
so it stays as-is.

**RESOLVED the same day, on a production smoke round (sessions 857–868) plus
one deliberative `manual` probe (881).** All twelve smoke sessions succeeded,
zero errors, zero `visibility_option_dropped` events — every provider accepts
the visibility options. Measured after the change:

| Model | round 2 reasoning tokens | durable `reasoning` text |
|---|---|---|
| google/gemini-3.1-pro-preview | 143 | **yes, new** (203 chars — `includeThoughts` works) |
| zai/glm-5.3 | 0 (!) | **yes, new** (931 chars; tokens unreported by provider) |
| spacexai/grok-4.6 | 111 | yes |
| moonshotai/kimi-k3 | 48 | yes |
| alibaba/qwen3.8-max | 83 | yes |
| deepseek/deepseek-v4-pro | 40 | yes |
| anthropic/claude-sonnet-5 (probe 881, hard task) | 874 | **yes, new** (1,449 chars over 3 of 5 steps — `display: "summarized"` works) |
| anthropic/claude-fable-5 / claude-opus-5→mistral swap / gpt-5.6-sol | 0 on the trivial task | nothing to show (adaptive skipped thinking; option accepted without error) |
| openai/gpt-5.6-terra | 20 | no — `reasoningSummary: "auto"` returned no summary for so small a burst |
| meta/muse-spark-1.2 | 126 | no — provider withholds the text; no visibility flag exists |

The smoke task (one tool call, one line) is too trivial to make the Anthropic
models think, which is why probe 881 exists: on a real deliberation Sonnet 5
thought on 3 of 5 steps and every thought is in the transcript and rendered
on `/sessions/881`. Fable 5 and the OpenAI pair should be re-eyeballed on
the first weekly review, but the mechanism is proven end to end.

## Rankings on Sleeper's projection feed — measured 2026-08-29 (§5.7 verify)

**The §5.7 draft gate is met with about nine times the headroom it needs.** One
unauthenticated call, run on production through `ingest.rankings`:

```
GET api.sleeper.com/projections/nfl/2026?season_type=regular&position[]=…&order_by=adp_ppr
→ 3,303 rows; 1,756 with a usable PPR ADP (Sleeper writes 999 where it has none)
stored: 1,756 ranked, 1,756 with an ADP, 413 with a tier, 0 errors
```

**Player identity, which is the number that matters:** all **1,756 of 1,756**
stored rows join to a row in `players`. Sleeper's `player_id` is our canonical id,
so the match rate is 100% by construction and `rankings_unmatched` no longer
exists.

For contrast, measured the same day against the same production `players` table:

| Source | Keyed by | Of the top 200 by ADP, how many join |
|---|---|---|
| Sleeper projections | `player_id` (ours) | **200 / 200** |
| ESPN `kona_player_info` | ESPN id | 56 / 200 |
| FantasyPros | yahoo id → espn id → name | 56 / 200 before the name fallback |

The reason the two external sources land in the same place: **Sleeper leaves
`espn_id` and `yahoo_id` null for players who entered the league from about 2021
on. 144 of the top 200 carry neither.** Chase, Gibbs, Bijan, Nacua, Jeanty, Love
are all null; McCaffrey (2017) has both. Any future external source inherits this
and must be measured the same way before it is trusted with the board.

Top of the live board: Gibbs 1.90, Bijan 2.60, Chase 3.60, Nacua 4.80,
McCaffrey 5.60.

### Tiers are not derived from ADP, and here is why

ADP has no cluster structure to find — the median consecutive gap is **1.00 at
every depth** (ranks 1–50, 50–100, 100–200; 0.30 beyond 200). So a gap-based tier
is an artifact of the threshold, not a property of the data:

```
gap > 1.2 → 67 tiers in the top 200      gap > 2.0 →  7 tiers
gap > 1.5 → 30 tiers                     gap > 2.5 →  2 tiers
```

Projected points do cluster. Within a position the median drop runs 1.5–2.8
points against real cliffs of 26–50 (RB 33.9, TE 35.8, QB 50.6, WR 26.6). Tiers
are therefore a drop larger than 3× the position's median drop, and a player with
no projection gets no tier rather than an invented one.

## FantasyPros free-tier truncation — measured 2026-08-29 (§5.7 verify, superseded)

**Superseded**: FantasyPros was removed on 2026-08-29. Kept because it is the
measurement that prompted the move.



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

### Re-measured 15:31 UTC the same day, after Jake reported upgrading the plan

The eight cached FantasyPros responses were deleted from `fp_cache` first, so the
run could not be served the earlier free-tier bodies out of the six-hour cache
(§5.8). All eight calls went to the live API and every one of them came back the
same:

```
"tier": "free", "limit": 10   on all 8 calls, 15:31:34–15:31:41 UTC
count: 512 (/nfl/players), 518 ALL, 105 QB, 196 RB, 256 WR, 178 TE, 44 K, 32 DST
```

Still 68 ranked players.

### The key itself is free-tier — measured directly, 15:41 UTC

Production was rebuilt (15:37:38 UTC) so no stale environment snapshot could be
blamed, and Jake reset the FantasyPros key. Calling the API by hand with the new
key — no deployment, no cache, no code of ours in the path:

```
GET /public/v2/json/nfl/2026/consensus-rankings?position=ALL&scoring=PPR&week=0
HTTP 200 → "tier": "free", "limit": 10, "count": 518, 10 rows returned
```

**Conclusive.** The key FantasyPros issued is on the free tier at the source. The
§5.7 gate stays blocked until the account carries a paid Hall of Fame subscription
(premium API is not granted by a HOF free trial, and production keys are activated
as a separate step after upgrading).

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
- Some models have tiered long-context pricing (OpenAI >272k, Gemini/Grok >200k) and DeepSeek has peak/off-peak windows; `model_prices` stores the base tier, and the gateway-reported cost (when present; §8.7 verify resolved 2026-09-08 above) is preferred over the price table.
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
- **`next lint` was removed** and `next build` no longer lints — the Vercel build runs ESLint directly through `pnpm check`, which this repo already does.
- **Route handlers are not cached by default**, which is what the public JSON API and `/api/draft/state` need (§12.1 asks for `no-store` on draft state). Page-level `export const revalidate = N` still applies for the 30 s live / 5 min default rendering rule.
- Node 20.9+ and TypeScript 5.1+ minimums; the Vercel project is Node 24.x, so this is satisfied.
