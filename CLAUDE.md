# Job Discovery Agent — Claude Instructions

## First-time setup

Run `/job-hunt-setup` in Claude Code. It handles everything interactively:
reads your resume, asks about target titles/cities/salary/industries, writes
`src/candidate-profile.js`, updates location filters, patches skill files. No API key needed.

## Candidate profile

Your personal profile lives in `src/candidate-profile.js` (git-ignored).
Edit that file to update your background, target roles, salary, or scoring rubric.
The example template is at `src/candidate-profile.example.js`.

## Skill / scheduled-task sync

This project ships two Claude integration files that need to be kept in sync
with their live system copies after any edit:

| File in this repo | Live system copy |
|---|---|
| `.claude/scheduled-task/SKILL.md` | `~/.claude/scheduled-tasks/daily-job-hunt/SKILL.md` |
| `.claude/skill/SKILL.md` | Skills live dir (repackage after edits — see below) |

**After any change to `.claude/scheduled-task/SKILL.md`**, run:
```bash
cp ".claude/scheduled-task/SKILL.md" ~/.claude/scheduled-tasks/daily-job-hunt/SKILL.md
```

**After any change to `.claude/skill/SKILL.md`**, repackage the skill.
The skill creator path is specific to your Claude installation — find it at:
`~/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/`

Then double-click the `.skill` file to reinstall in Claude.

> **Note:** The `.skill` file is git-ignored. Reinstall it locally after cloning.

## Project layout

```
src/
  index.js                  orchestrator + cron scheduler
  db.js                     jobs.db SQLite helpers (uses node:sqlite)
  scorer.js                 Claude scoring (imports from candidate-profile.js)
  candidate-profile.js      YOUR profile — git-ignored, never committed
  candidate-profile.example.js  template for new users
  email.js                  SendGrid HTML digest
  scrapers/
    serpapi.js              Google Jobs (optional, requires SERPAPI_KEY)
    linkedin.js             LinkedIn guest API + cheerio
    greenhouse.js           ~70 companies across target industries
    lever.js                ~35 companies across target industries
    ashby.js                ~30 companies (returns full descriptions inline)
  pipeline/
    db.js                   pipeline.db SQLite helpers (applications + events)
    classifier.js           heuristic email classifier (inbound + outbound)
.claude/
  skill/SKILL.md            source for /job-hunt slash command
  skill/SETUP.md            source for /job-hunt-setup (first-time setup wizard)
  scheduled-task/SKILL.md   source for daily-job-hunt scheduled task
scripts/
  setup.js                  terminal fallback for setup (non-Claude Code users)
  serve-dashboard.js        local HTTP dashboard server (port 3033)
  store-linkedin-jobs.js    stores LinkedIn scrape results to jobs.db
  process-emails.js         classifies fetched emails → upserts pipeline.db
  get-pipeline.js           prints pipeline summary JSON for the briefing
jobs.db                     job listings (git-ignored, auto-created)
pipeline.db                 application pipeline (git-ignored, auto-created)
```

## Key facts

- Node.js ≥ 22.15.0 required (uses built-in `node:sqlite`)
- No native compiled dependencies
- First run fetches all available jobs (no 24 h filter); subsequent runs filter to last 24 h
- Only jobs scored 7+ are emailed; all jobs stored in `jobs.db` regardless of score
- Dashboard runs on port 3033 via `node scripts/serve-dashboard.js`
- Scoring is done natively by the Claude session when using the `/job-hunt` skill; the
  `ANTHROPIC_API_KEY` in `.env` is used only in standalone daemon mode (`npm start`)

## Updating your profile

Edit `src/candidate-profile.js` — change `CANDIDATE_PROFILE` (your background) and/or
`SCORING_RUBRIC` (how Claude should evaluate fit). Changes take effect on the next run.

## Upstream update check

Every agent run quietly checks GitHub for newer commits to the upstream repo
(`bweiner95/job-discovery-agent`). The check is throttled to once per 7 days
and stores its state in `.update-check` (git-ignored). If updates exist, the
agent prints a one-time banner with the recent commits and a `git pull` hint
— it never auto-pulls. Manual re-check: `npm run check-updates -- --force`.

The check is implemented in `scripts/check-updates.js` and called as the
first step of `runAgent()` in `src/index.js`. Failures (offline, GitHub
rate-limit, etc.) are tolerated silently.

## Adding companies to scrape

Company slugs live in `src/candidate-profile.js` (git-ignored), NOT in the
scraper files. Edit the `GREENHOUSE_COMPANIES`, `LEVER_COMPANIES`, and
`ASHBY_COMPANIES` arrays there. The scrapers import them at runtime; the
slug lists hardcoded in `src/scrapers/*.js` are tiny generic fallbacks only.

- Greenhouse slugs: `https://boards.greenhouse.io/{slug}`
- Lever slugs: `https://jobs.lever.co/{slug}`
- Ashby slugs: `https://jobs.ashbyhq.com/{slug}` (Ashby returns full
  descriptions inline → more accurate scoring than GH/Lever)

**Slug rot is real.** Companies migrate between ATS providers and change
slugs. A dead slug isn't fatal (the scraper skips it) but wastes a request
+ 250ms per run. Run `node scripts/verify-slugs.js` periodically (monthly)
to see which slugs are live vs dead, and `node scripts/verify-slugs.js --dead`
to get a prune list. As of 2026-05-15, Lever has rotted heavily for consumer
companies — most have moved to Greenhouse/Ashby.

## Application pipeline tracking

Beyond job discovery, the agent tracks the user's application pipeline by
scanning Gmail for both **inbound** recruiter emails and **outbound** thank-you
notes the user sends after interviews. Classification is heuristic (no LLM)
and lives in `src/pipeline/classifier.js`.

When a sent thank-you note doesn't match an existing Gmail thread, the
classifier merges into the most-recent active application for the same company
via `findActiveApplicationByCompany()` so a fresh thread doesn't create
a duplicate row.

Pass `USER_EMAIL=<your-email>` to `process-emails.js` so it can identify
outbound emails reliably.

## Years-of-Experience gate

The `SCORING_RUBRIC` in `src/candidate-profile.js` opens with a YOE gate
that caps the final score when a job description's stated minimum
experience exceeds the candidate's actual years. The thresholds (no
penalty within ±2, cap at 7 / 5 / 3 / 2 for progressively larger gaps)
are anchored to **the user's actual YOE** — `/job-hunt-setup` collects
this in Step 2g and writes the gate parameterized to that number.

If a user hand-edits `candidate-profile.js` from the example without
running the wizard, the example template includes a working version
defaulted to ~8 years with a comment to re-anchor.

## Auto-archive of low-scored jobs

After scoring, both skill files run an auto-archive query that moves any
job scoring ≤ 3 to `status = 'not_fit'` with the `score_reason` captured
as `not_fit_reason`. Threshold rationale: the ≤ 3 band reliably contains
hard non-fits (wrong geography, wrong industry, wrong function), while
4–6 still includes borderline-legitimate options worth surfacing.

The user can still find these in the Not a Fit tab and click ↩ Restore
to bring them back to Open Roles. The feature lives in the skill files
(both `scheduled-task/SKILL.md` and `skill/SKILL.md`) so any agent run
applies it consistently.

## Dashboard tabs

The dashboard at `http://localhost:3033` has four tabs:

- **Open Roles** — active jobs awaiting triage (excludes applied + not_fit)
- **Pipeline** — applications grouped by stage (offer / interview / applied / etc.)
- **Applied** — jobs the user marked applied; can be unapplied to restore
- **Not a Fit** — dismissed jobs with the optional feedback reason shown

The Not a Fit tab's captured `not_fit_reason` text is fed back into Claude
on the next scoring run so similar future roles score lower.
