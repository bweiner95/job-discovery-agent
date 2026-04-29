# Job Discovery Agent

A self-hosted job-hunting agent that searches multiple sources daily for roles matching your background, scores each one with Claude AI, and surfaces them in an interactive dashboard — so you only review jobs worth applying to.

Built to run inside [Claude Code](https://claude.ai/code) with the Chrome extension for LinkedIn scraping.

---

## What It Does

1. **Scrapes four sources** every day:
   - **Greenhouse** boards for ~70 consumer/tech companies (no API key needed)
   - **Lever** boards for ~35 consumer/tech companies (no API key needed)
   - **LinkedIn** via Chrome extension — searches your target cities and titles
   - **Google Jobs** via SerpAPI (optional — broader coverage, includes salary data)

2. **Deduplicates** against a local SQLite database — you never see the same posting twice.

3. **Scores each job 1–10** with Claude, based on your personal candidate profile, target roles, and preferences.

4. **Serves a dashboard** at `http://localhost:3033` — filter by score, mark applied, archive irrelevant roles.

5. **Optionally emails** a digest of top-scoring jobs via SendGrid.

---

## Quick Start

### 1. Prerequisites

Before setting up, make sure you have:

| Requirement | How to check / get it |
|---|---|
| **Node.js 22.15+** | `node --version` — download at [nodejs.org](https://nodejs.org) |
| **Claude Code** | [claude.ai/download](https://claude.ai/download) |
| **Claude in Chrome extension** | [claude.ai/download](https://claude.ai/download) → scroll to "Chrome Extension" |
| **LinkedIn account** | Sign in to LinkedIn in Chrome before your first run |

### 2. Clone and install

```bash
git clone https://github.com/bweiner95/job-discovery-agent.git
cd job-discovery-agent
npm install
```

### 3. Run the setup wizard in Claude Code

Open Claude Code in this project directory and type:

```
/job-hunt-setup
```

The setup wizard handles everything in the chat — no terminal commands needed:

- 📋 **Prerequisites check** — confirms Node.js version and Chrome extension
- 📄 **Resume** — attach your `.pdf`, `.txt`, or `.md` resume file, or paste the text directly. Claude reads it and generates a detailed, specific profile.
- 🎯 **Target titles** — every variant you'd consider (titles vary a lot across companies)
- 📍 **Cities** — up to 3 cities for LinkedIn searches; location filters updated in all scrapers
- 💰 **Salary floor** — jobs listed below this get scored down
- 🏢 **Industries** — what kinds of companies you're targeting
- 🚫 **What to avoid** — industries, roles, or company types to filter out

Claude writes `src/candidate-profile.js`, updates all location and keyword configs, sets the project path in the skill files, and gives you a clear checklist at the end. No API key required.

### 4. Install the /job-hunt skill

After setup, repackage `.claude/skill/SKILL.md` and double-click the `.skill` file to install it in Claude. See `CLAUDE.md` for the exact repackage command.

### 5. Run your first job search

Open Claude Code and type:

```
/job-hunt
```

Claude scrapes Greenhouse, Lever, and LinkedIn, scores every new job against your profile, and opens the dashboard at **http://localhost:3033**.

To run Greenhouse + Lever only (no LinkedIn, no Claude session needed):
```bash
npm run run-now
```

---

## How It Works

### Your candidate profile

The `setup` wizard creates `src/candidate-profile.js` — a git-ignored file that contains two things:

**`CANDIDATE_PROFILE`** — your work history, key achievements, target roles, ideal company types, and what you want to avoid. Claude reads this when scoring every job.

**`SCORING_RUBRIC`** — how Claude should weight different signals: title seniority, company type, location, salary. You define what a 9/10 looks like vs. a 5/10.

The richer and more specific your profile, the more accurate the scoring. See `src/candidate-profile.example.js` for a fully worked example.

To update your profile at any time — you change jobs, raise your salary floor, add new target titles — just edit `src/candidate-profile.js`. No git involvement, changes take effect on the next run.

### The dashboard

The dashboard at `http://localhost:3033` shows all discovered jobs sorted by score.

| Feature | Description |
|---|---|
| Score filter | Show only 8+, 7+, or all jobs |
| Score badges | Green (9–10) · Amber (7–8) · Red (<7) |
| Apply button | Direct link to the ATS page or company careers site |
| Mark applied | Moves job to "Applied" tab; auto-hides on next run |
| Archive | Hides irrelevant jobs without deleting them |

---

## Customization

### Add companies to scrape

**Greenhouse** — add slugs to `src/scrapers/greenhouse.js`:
```js
const COMPANIES = [
  'discord', 'airbnb', 'your-company-here',  // ← add any company on Greenhouse
];
```
Find a company's slug at `https://boards.greenhouse.io/{slug}`.

**Lever** — add slugs to `src/scrapers/lever.js`:
```js
const COMPANIES = [
  'spotify', 'duolingo', 'your-company-here',  // ← add any company on Lever
];
```
Find a company's slug at `https://jobs.lever.co/{slug}`.

### Change LinkedIn search titles or cities

Re-run `npm run setup` — it regenerates the LinkedIn search URLs and location filters from your answers.

Or edit `.claude/skill/SKILL.md` directly and update the `keywords=` parameter in the three LinkedIn search URLs.

### Change the scoring model

In `src/scorer.js`, update the `model` field:
```js
model: 'claude-opus-4-5',   // most nuanced, slower
model: 'claude-haiku-4-5',  // fastest, cheapest
```

### Change the email score threshold

In `src/index.js`, change `getEmailableJobs(7)` to your preferred minimum.

### Change the cron schedule

In `src/index.js`:
```js
cron.schedule('0 8 * * *', ...)    // 8 AM daily (default)
cron.schedule('0 7,17 * * *', ...) // 7 AM and 5 PM
```

---

## API Keys

All API keys go in `.env` (created automatically by the setup wizard from `.env.example`).

| Key | Required? | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Optional* | Standalone scoring (`npm start`, `npm run run-now`) |
| `SERPAPI_KEY` | Optional | Google Jobs as a 4th source — 100 free searches/month |
| `SENDGRID_API_KEY` | Optional | Email digest of top-scoring jobs |
| `SENDGRID_FROM_EMAIL` | Optional | Verified sender for SendGrid |
| `ALERT_EMAIL` | Optional | Where email digests are delivered |

*Not needed when running via the `/job-hunt` Claude skill — scoring runs natively in your Claude session.

---

## Project Structure

```
job-discovery-agent/
├── src/
│   ├── index.js                     # Orchestrator + cron scheduler
│   ├── db.js                        # SQLite helpers
│   ├── scorer.js                    # Claude scoring logic
│   ├── candidate-profile.js         # YOUR profile (git-ignored, created by setup)
│   ├── candidate-profile.example.js # Filled-in example showing expected detail level
│   ├── email.js                     # SendGrid digest builder
│   └── scrapers/
│       ├── greenhouse.js            # Greenhouse public boards (~70 companies)
│       ├── lever.js                 # Lever public postings (~35 companies)
│       ├── linkedin.js              # LinkedIn guest API
│       └── serpapi.js               # Google Jobs via SerpAPI
├── scripts/
│   ├── setup.js                     # ← Setup wizard (start here)
│   ├── serve-dashboard.js           # Local HTTP dashboard on port 3033
│   └── store-linkedin-jobs.js       # Stores Chrome MCP LinkedIn results
├── .claude/
│   ├── skill/SKILL.md               # /job-hunt slash command definition
│   └── scheduled-task/SKILL.md      # daily-job-hunt scheduled task definition
├── .env                             # Your secrets (git-ignored)
├── .env.example                     # Template showing required keys
├── jobs.db                          # SQLite database (git-ignored, auto-created)
├── CLAUDE.md                        # Instructions for Claude Code
└── package.json
```

---

## Privacy

- `candidate-profile.js` — git-ignored, your personal data stays on your machine
- `jobs.db` — git-ignored, your job search history stays local
- `.env` — git-ignored, your API keys stay local
- No data is sent anywhere except the APIs you explicitly configure

---

## Data Sources

### Greenhouse & Lever
Both expose public JSON APIs — no authentication needed. The agent queries curated lists of ~70 companies tuned for consumer tech, DTC, fintech, health/wellness, and marketplace roles. Easily extensible to any company using either ATS.

### LinkedIn
Uses the Chrome extension to scrape LinkedIn job search results. Claude controls the browser you're already logged into — no API key or scraper workarounds needed. LinkedIn job IDs expire quickly, so the agent captures direct ATS apply URLs immediately at scrape time.

### Google Jobs (SerpAPI)
Optional. Returns the broadest results and often includes salary data. Uses ~9 API calls per run (4 queries × 3 cities). SerpAPI's free tier includes 100 searches/month — roughly 11 daily runs.

---

## License

MIT
