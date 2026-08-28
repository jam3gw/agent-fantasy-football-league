# VERIFIED — facts confirmed against live sources

Each entry: date, the request made, what came back. Items marked **verify** in SPEC.md land here.

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
- Spec candidate `google/gemini-3.1-pro` does not exist on the gateway; the live ID is `google/gemini-3.1-pro-preview` (§8.9 already anticipated the `-preview` ID in `byok_routes`).
- Spec candidate `xai/grok-4.6` does not exist; xAI models are listed under the `spacexai/` prefix. `spacexai/grok-4.6` is live. BYOK credential/settings name stays `xai` (§8.9); only the gateway model ID differs.
- Sonnet 5 catalog price (2/10) is lower than Appendix F's estimate (3/15); GLM-5.3 (1.40/4.40) differs from F's GLM-5.2 figure. Appendix F is an estimate; the catalog is authoritative for `model_prices`.
- Some models have tiered long-context pricing (OpenAI >272k, Gemini/Grok >200k) and DeepSeek has peak/off-peak windows; `model_prices` stores the base tier, and the gateway-reported cost (when present, §8.7 verify pending) is preferred over the price table.
- Raw catalog extract for the 12 models: `fixtures/gateway-models-2026-08-28.json`.

## 2026-08-28 — Endpoint reachability

- `https://api.sleeper.app/v1/state/nfl` → 200.
- `https://api.sleeper.com/stats/nfl/2025/1?season_type=regular&position[]=QB` → 200 (shape capture + fixtures in M2).
- `https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv` → 206 on ranged GET (URL current, §5.5).
- `https://api.fantasypros.com/public/v2/json/nfl/players` → 403 without key (base URL live; key required — §14 `FANTASYPROS_BASE_URL` consistent with the OpenAPI document).
- `https://api.tavily.com` / `https://api.resend.com` → reachable.
