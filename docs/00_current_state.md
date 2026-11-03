# 00 — Current state (inspected Tue 3 Nov 2026, ~07:20 Bangkok / Mon 2 Nov 19:20 ET)

## Repository `charles-odasie/sentinel-meta`

| Item | Finding |
|---|---|
| Commits | **1** — `6afbcfd` "Initial commit", 2026-10-29 10:15 +07 |
| Files | `LICENSE` (MIT) only |
| Code, tests, CI, README, model client | **None** |
| Default branch | `main` |

Conclusion: there is no prior work. Everything below the initial commit is built inside the
hackathon window (Oct 26 17:00 UTC → Nov 5 02:00 UTC). The initial commit itself (Oct 29) is
also inside the window. Judges can identify hackathon work trivially: it is the whole history.

## Build environment (this session — Claude cloud container)

| Capability | Status | Consequence |
|---|---|---|
| Node 22.23 / npm 10.9 / Python 3.13 / git 2.43 | available | TypeScript monorepo, no extra install |
| npm registry, GitHub | reachable | deps install fine |
| `inference.baseten.co`, `api.fireworks.ai`, `api.meta.ai` | reachable (401 without key) | all three inference routes are usable from here |
| Docker | client only, **no daemon** | sandbox is NOT Docker |
| `unshare -n` (Linux network namespace) | **works**: a `curl` inside it fails to connect | sandbox = netns with no interfaces → provable zero egress for test/git execution |
| `iptables` | present, OUTPUT policy ACCEPT | not needed; netns is stronger and simpler |
| Model API keys in env | **none** | smoke test and benchmark are blocked until `BASETEN_API_KEY` (and optionally `FIREWORKS_API_KEY`, `MODEL_API_KEY`) are added as environment secrets |
| 4 vCPU / 15 GB RAM / ~30 GB free disk | fine | benchmark runs serially, one bug at a time |

## Verified model facts (live docs, 3 Nov 2026)

| Claim in brief | Verified | Source |
|---|---|---|
| `meta-models/muse-spark-open-1026` on Baseten | **WRONG** — slug is **`meta-models/muse-spark-open`**, base `https://inference.baseten.co/v1`, OpenAI-compatible chat completions | baseten.co/library/muse-spark-open, Baseten changelog |
| Muse Spark Open: tool calling, reasoning, 1M ctx | yes | Baseten launch post; Meta research blog (816B total / 42B active, open weights) |
| Muse Spark Open structured outputs / JSON mode | **not supported** on Baseten; `n>1` → 400; `seed`/`temperature=0` **do not** guarantee reproducible output | docs.baseten.co model-apis overview |
| Muse Spark Open price | $1.25 in / $0.15 cached / $4.25 out per 1M | Baseten library page |
| Muse Glimmer on Baseten | **not listed**. Hosted on Fireworks as `accounts/fireworks/models/muse-glimmer-30b` (~131K ctx, ≈$0.35/$1.50 per 1M via resellers — `UNVERIFIED` on Fireworks' own page) | Fireworks model page, routers |
| Meta Model API | base `https://api.meta.ai/v1`, header `Authorization: Bearer $MODEL_API_KEY`, models `muse-spark-1.3` (hosted, **not open-weight**), `muse-wonder-1.0`; tool calling with `tool_choice` **only `"auto"`**; `reasoning_effort` minimal…xhigh; 3,000 RPM / 4M TPM per team; $1.25/$4.25 per 1M | dev.meta.ai/docs/{models,overview,tool-calling,pricing-rate-limits} |
| Muse Code | a terminal coding-agent product (`curl -fsSL https://dev.meta.ai/install.sh \| sh`), not a model ID | dev.meta.ai/docs/overview |
| Partner credits | Baseten **$100 + 2M TPM**, Modal **$100**, Fireworks **$100** (brief said $25) — "to select participants" | cerebralvalley.ai event page (public part) |
| Meta Model API $150 credits, claim by Nov 4 21:00 ET | `UNVERIFIED` (page is behind login) | — |

## What exists after this document

Nothing yet. The plan (`docs/02_plan.md`) starts from zero.
