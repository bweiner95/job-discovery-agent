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
  db.js                     SQLite (node:sqlite built-in, no native deps)
  scorer.js                 Claude scoring (imports from candidate-profile.js)
  candidate-profile.js      YOUR profile — git-ignored, never committed
  candidate-profile.example.js  template for new users
  email.js                  SendGrid HTML digest
  scrapers/
    serpapi.js              Google Jobs
    linkedin.js             LinkedIn guest API + cheerio
    greenhouse.js           ~40 consumer/tech companies
    lever.js                ~35 consumer/tech companies
.claude/
  skill/SKILL.md            source for /job-hunt slash command
  skill/SETUP.md            source for /job-hunt-setup (first-time setup wizard)
  scheduled-task/SKILL.md   source for daily-job-hunt scheduled task
scripts/
  setup.js                  terminal fallback for setup (non-Claude Code users)
  serve-dashboard.js        local HTTP dashboard server (port 3033)
  store-linkedin-jobs.js    stores LinkedIn scrape results to DB
jobs.db                     SQLite database (git-ignored, auto-created on first run)
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

## Adding companies to scrape

- **Greenhouse**: append slugs to `COMPANIES` in `src/scrapers/greenhouse.js`
  - Find slugs at: `https://boards.greenhouse.io/{slug}`
- **Lever**: append slugs to `COMPANIES` in `src/scrapers/lever.js`
  - Find slugs at: `https://jobs.lever.co/{slug}`
