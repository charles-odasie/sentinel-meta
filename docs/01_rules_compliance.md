# 01 — Rules compliance

**Verification status.** The public event page (`cerebralvalley.ai/e/meta-ai-developer-hackathon`) was read in
a headless browser. The **Details** and **Submit** pages redirect to login, so the Official Rules,
judging weights, bonus prizes and submission form fields could **not** be verified from this session.
Items marked `UNVERIFIED` come from Charles's brief and must be confirmed against the logged-in pages
before submission (see §4).

## 1. Facts verified from the public page

- Virtual, worldwide; window **Oct 26 17:00 UTC → Nov 5 02:00 UTC**. "Nov 4: Project submissions due by 9:00 PM ET" (= **Thu Nov 5 09:00 Bangkok**).
- Judging Nov 4–8; closing ceremony Nov 9. "Dates may be subject to change at Meta's sole discretion."
- Two tracks: Indie developer ("creativity, technical ambition, and whether it works") and Startup.
- Two themes: *Build for Your World*, *Push the Frontier* (software is explicitly listed under Push the Frontier).
- Partners: Baseten ($100 + 2M TPM), Modal ($100), Fireworks ($100) — "to select participants", for Meta open-weight models.
- Eligibility: not sanctioned countries/persons; no Meta/Cerebral Valley employees or household.
- "Official Rules will be published before the Hackathon begins on October 26, 2026 and must be accepted by the selected participants."

## 2. Rules that shape the build (`UNVERIFIED` = from the brief)

| Rule | How Sentinel complies |
|---|---|
| Public repo | `github.com/charles-odasie/sentinel-meta`, MIT at root |
| New work only; judges must identify hackathon work (`UNVERIFIED`: failure = DQ) | Repo had only a LICENSE before Nov 3. README has a "Built during the hackathon" section listing every component with its first commit date. Commit timestamps are real, never rewritten. |
| 3-minute demo video, public, no login (`UNVERIFIED`) | Storyboard in PRD §3; YouTube unlisted/public; link in submission |
| Up to 4 people; list everyone (`UNVERIFIED`) | Solo: Charles Gourlaouen. AI coding assistance is disclosed in the README (it is tooling, not a team member). |
| Demo shows only hackathon work (`UNVERIFIED`) | The sample app is also new and in-repo; nothing pre-existing is shown |
| No employer/customer code or data | Sample app is a generic IoT telemetry hub. CI greps the repo for forbidden names (`odasie`, `graphtravel`, `safarine`) and fails if found. |
| Meta tooling must be central (rubric 25%, `UNVERIFIED`) | All reasoning on **Muse Spark Open (open weights, via Baseten)**; fast steps on **Muse Glimmer 30B (via Fireworks)**; model names printed on screen in every run and in the Privacy Receipt |
| Open-weight bonus (`UNVERIFIED`) | Primary path is open-weight only. The hosted `muse-spark-1.3` is a **fallback only** and is logged as such in the receipt when used. |
| Most Viral: post on X, submit link (`UNVERIFIED`) | Draft text in `docs/private/04_submission_meta.md`; Charles posts |

## 3. Ambiguities

1. **Does a hackathon-built sample app count as "the demo shows only what was built"?** We treat yes; it is in the same repo with the same timestamps.
2. **AI-assisted coding.** Rules (as summarised) don't forbid it; we disclose it in the README rather than hide it.
3. **"Select participants" for partner credits** — unclear whether Charles's acceptance includes credits. If Baseten credits are not granted, pay-as-you-go on Baseten still works with a card; budget ≈ $20–40 for the whole benchmark (PRD §5).
4. **Privacy claim scope.** A hosted endpoint still receives the code sent to it. We claim only what the egress ledger proves (PRD §4.6). Baseten documents ZDR by default for this model; we cite it, we don't rely on it.

## 4. Draft questions for organizers (do not send without Charles)

1. "Is a benchmark sample application written during the hackathon acceptable as the demo target, provided it is in the same public repo with hackathon-dated commits?"
2. "Is AI-assisted coding (coding agents) permitted, and should it be disclosed?"
3. "For the Open-Weight bonus, must *all* inference be on open-weight models, or the primary path?"
4. "Were partner credits (Baseten/Fireworks/Modal) granted automatically to accepted Indie participants, or by separate application?"

## 5. Blockers

None that stop the build. One **gate** before submission: confirm §2 `UNVERIFIED` rows against the logged-in Details/Rules page (5 minutes, Charles).
