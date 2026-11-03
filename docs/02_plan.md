# 02 — Execution plan (Bangkok UTC+7 · Eastern UTC-5)

| Milestone | Bangkok | Eastern |
|---|---|---|
| Plan written | Tue 3 Nov 07:30 | Mon 2 Nov 19:30 |
| **Internal target (Charles: "end of day")** | **Tue 3 Nov 22:00** | Tue 3 Nov 10:00 |
| Fallback submission target | Wed 4 Nov 22:00 | Wed 4 Nov 10:00 |
| **Hard deadline** | **Thu 5 Nov 09:00** | **Wed 4 Nov 21:00** |

Execution is by this cloud session; Charles's items are marked 👤. Hours are wall-clock Bangkok.

## Tuesday 3 Nov

| Hour | Work | Go/No-Go checkpoint & fallback |
|---|---|---|
| 07:00–08:00 | Repo inspection, rules, model-fact verification, docs 00/01 ✅ · Sentinel core written, unit-tested, pushed ✅ · sample-app build started ✅ | — |
| 08:00–09:00 | PRD, this plan, credits runbook, submission draft · 👤 **add `BASETEN_API_KEY` (+ optional keys) as environment secrets** | **CP-0 (09:00): key visible?** If not → Charles opens a new session on `main` ("continue from docs/02_plan.md"); nothing else blocks |
| 09:00–10:00 | Sample app + 8 bugs land; `verify-bugs.sh` green; commit · `npm run smoke` (chat + tool call on Muse Spark Open) | **CP-1 (10:00): tool calling works on Spark Open.** Fallback: `SENTINEL_REASONER=meta` (`muse-spark-1.3`), receipt flags "not open-weight"; keep Glimmer for fast steps so open weights remain in the product |
| 10:00–11:30 | First end-to-end run on one bug (B01) with fix + bisect; fix prompts/tools from what the model actually does; commit | **CP-2 (11:30): one bug fully through** (validated test, verified fix, correct commit, receipt). Fallback: drop fix stage from the demo headline, keep repro + bisect + receipt; raise turn budget |
| 11:30–12:00 | Bench harness `bench/run.ts` (per-run work dirs, resumable JSON, md report) | — |
| 12:00–12:30 | Lunch 👤 · harness runs `full` on B01–B04 unattended | — |
| 12:30–14:00 | `full` on B05–B08; triage failures (prompt, not benchmark tampering); re-run only genuinely fixed pipeline bugs, record every re-run | **CP-3 (14:00): `full` results exist for 8/8 bugs.** Fallback: report N<8 honestly |
| 14:00–16:00 | Ablations: `no-validator` ×8, `no-oracle` ×8 (serial, ~5 min each) | **CP-4 (16:00): ablations done.** Fallback: run ablations on 4 bugs and say so |
| 16:00–17:00 | README with real numbers, CI workflow, `.env.example`, demo script finalised from a real run's transcript · clean-clone setup test | — |
| 17:00–18:00 | 👤 **Record demo** (2 takes, storyboard PRD §3, real terminal), trim, upload to YouTube (unlisted or public, no login) | **CP-5 (18:00): video uploaded.** Fallback: screen-record the benchmark replay from logs (still real output) |
| 18:00–19:00 | Dinner 👤 · session: final repo audit (secrets grep, forbidden names, MIT at top, links) | — |
| 19:00–20:00 | 👤 Submission form from `docs/private/04_submission_meta.md`; 👤 verify Official Rules items marked UNVERIFIED; 👤 X post | **CP-6 (20:00): submission saved (not necessarily final-submitted)** |
| 20:00–22:00 | Buffer: fix anything the form/video revealed; if ahead → Glimmer triage (SHOULD), second benchmark pass | **CP-7 (22:00): SUBMITTED.** If not: continue Wednesday per below |

## Wednesday 4 Nov (buffer — only if CP-7 slipped)

| Hour | Work |
|---|---|
| 08:00–12:00 | Finish whatever CP failed, in order: smoke → e2e → bench full → README → video |
| 12:00–16:00 | Ablations / second pass if missing; otherwise polish README and receipt wording |
| 16:00–20:00 | Record / re-record video; submission text final |
| **22:00** | **Submit — 11 h before the hard deadline.** Nothing new starts after this |
| Thu 5 Nov 09:00 | Hard deadline (Wed 21:00 ET) |

## Standing rules while executing
- Commit after every green step; push to `main`; real timestamps; never rewrite history.
- Every benchmark number in any text is copied from `bench/results/<run>/results.json`, never typed.
- Model/receipt wording never claims more than the code enforces.
- Any consent box, form submit, social post, or payment: list it, wait for Charles's "yes".
