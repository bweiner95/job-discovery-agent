# Job Discovery Agent

A self-hosted job-hunting agent that searches multiple sources daily for roles matching your background, scores each one with Claude AI, and surfaces them in an interactive dashboard — so you only review jobs worth applying to.

Built to run inside [Claude Code](https://claude.ai/code) with the Chrome extension for LinkedIn scraping.

---

## What It Does

1. **Scrapes five sources** every day:
   - **Greenhouse** boards for ~70 companies across your target industries (no API key needed)
   - **Lever** boards for ~35 companies across your target industries (no API key needed)
   - **Ashby** boards for ~30 companies — returns full job descriptions inline for richer scoring (no API key needed)
   - **LinkedIn** via Chrome extension — searches your target cities and titles
   - **Google Jobs** via SerpAPI (optional — broader coverage, includes salary data)

2. **Deduplicates** against a local SQLite database — you never see the same posting twice.

3. **Scores each job 1–10** with Claude, based on your personal candidate profile, target roles, and preferences. Past "not a fit" feedback is fed back into scoring so the model learns from your decisions.

4. **Tracks your application pipeline** by scanning Gmail — both inbound recruiter emails and the thank-you notes you send after interviews. Status advances automatically (Applied → Interview → Follow-up → Offer / Rejection).

5. **Serves a dashboard** at `http://localhost:3033` with four tabs: Open Roles, Pipeline, Applied, Not a Fit.

6. **Optionally emails** a digest of top-scoring jobs via SendGrid.

---

## Setup

### 1. Prerequisites

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

### 3. Open Claude Code in this directory, then paste this

```
/job-hunt-setup
```

That's it. Claude walks you through the rest — no terminal commands, no config files to edit, no API key needed.

The wizard will ask for:
- 📄 **Your resume** — attach a `.pdf`, `.txt`, or `.md` file, or paste the text. Claude reads it and builds your scoring profile.
- 🎯 **Target titles** — every variant you'd consider (titles vary a lot across companies)
- 📍 **Cities** — up to 3 cities; LinkedIn searches and location filters update automatically
- 💰 **Salary floor** — jobs listed below this get scored down
- 🏢 **Industries** — what kinds of companies you're targeting (e.g. consumer tech, fintech, healthcare, DTC). Claude uses this to suggest which companies to add to the Greenhouse and Lever scraper lists.
- 🚫 **What to avoid** — industries, roles, or company types to filter out

At the end, Claude writes `src/candidate-profile.js`, updates the Greenhouse and Lever company lists for your target industries, updates LinkedIn search URLs and location filters, and gives you a checklist of what's next.

### 4. Install the /job-hunt skill

After setup, repackage `.claude/skill/SKILL.md` and double-click the `.skill` file to install it in Claude. See `CLAUDE.md` for the exact command.

### 5. Run your first search

Open Claude Code and paste this:

```
/job-hunt
```

Claude scrapes Greenhouse, Lever, and LinkedIn, scores every new job against your profile, and opens the dashboard at **http://localhost:3033**.

To run Greenhouse + Lever only (no LinkedIn):
```bash
npm run run-now
```

---

## How It Works

### Your candidate profile

Setup creates `src/candidate-profile.js` — a git-ignored file with two things:

**`CANDIDATE_PROFILE`** — your work history, key achievements, target roles, ideal company types, and what you want to avoid. Claude reads this when scoring every job.

**`SCORING_RUBRIC`** — how Claude should weight signals: title seniority, company type, location, salary. You define what a 9/10 looks like vs. a 5/10.

The richer and more specific your profile, the more accurate the scoring. See `src/candidate-profile.example.js` for a fully worked example.

To update your profile — new job, new salary floor, new target titles — just edit `src/candidate-profile.js`. Changes take effect on the next run.

### The dashboard

The dashboard at `http://localhost:3033` shows discovered jobs sorted by score across four tabs:

| Tab | What it shows |
|---|---|
| **Open Roles** | Active jobs awaiting triage. Filter by score, source, or location. |
| **Pipeline** | Applications grouped by stage: Offer · Interview · Take-home · Follow-up · Applied · Rejection. Scanned automatically from Gmail. |
| **Applied** | Jobs you've marked as applied. Click "Unapply" to restore them to Open Roles. |
| **Not a Fit** | Dismissed jobs. Your reason (if you provide one) is shown on the card. |

| Action | Behavior |
|---|---|
| `+ Applied` | Marks the job applied and removes it from Open Roles → Applied tab |
| `×` (Not a Fit) | Opens a modal asking why; reason is fed back into Claude on the next scoring run so similar roles score lower |
| `View on …` | Direct link to the ATS or company careers page |

### Application pipeline tracking

The agent scans Gmail for both:
- **Inbound** recruiter and ATS emails (interviews scheduled, offers, rejections, take-home assignments)
- **Outbound** thank-you notes you send after interviews — automatically advances the application's status to `interview_follow_up`

Application status persists in `pipeline.db` and is rendered in the Pipeline tab. Cold applications (14+ days no activity) are flagged 🥶.

---

## Customization

### Add companies to scrape

**Greenhouse** — add slugs to `src/scrapers/greenhouse.js`:
```js
const COMPANIES = [
  'discord', 'airbnb', 'your-company-here',
];
```
Find a company's slug at `https://boards.greenhouse.io/{slug}`.

**Lever** — add slugs to `src/scrapers/lever.js`:
```js
const COMPANIES = [
  'spotify', 'duolingo', 'your-company-here',
];
```
Find a company's slug at `https://jobs.lever.co/{slug}`.

**Ashby** — add slugs to `src/scrapers/ashby.js`:
```js
const COMPANIES = [
  'whatnot', 'openai', 'replit', 'your-company-here',
];
```
Find a company's slug at `https://jobs.ashbyhq.com/{slug}`.

### Change your search titles or cities

Re-run the setup wizard in Claude Code:
```
/job-hunt-setup
```
It regenerates LinkedIn search URLs and location filters from your updated answers.

### Change the scoring model

In `src/scorer.js`:
```js
model: 'claude-opus-4-5',   // most nuanced, slower
model: 'claude-haiku-4-5',  // fastest, cheapest
```

### Change the cron schedule

In `src/index.js`:
```js
cron.schedule('0 8 * * *', ...)    // 8 AM daily (default)
cron.schedule('0 7,17 * * *', ...) // 7 AM and 5 PM
```

---

## Project Structure

```
job-discovery-agent/
├── src/
│   ├── index.js                     # Orchestrator + cron scheduler
│   ├── db.js                        # jobs.db SQLite helpers
│   ├── scorer.js                    # Claude scoring logic
│   ├── candidate-profile.js         # YOUR profile (git-ignored, created by setup)
│   ├── candidate-profile.example.js # Filled-in example showing expected detail level
│   ├── email.js                     # SendGrid digest builder
│   ├── scrapers/
│   │   ├── greenhouse.js            # Greenhouse public boards (~70 companies)
│   │   ├── lever.js                 # Lever public postings (~35 companies)
│   │   ├── ashby.js                 # Ashby public boards (~30 companies, full descriptions)
│   │   ├── linkedin.js              # LinkedIn guest API
│   │   └── serpapi.js               # Google Jobs via SerpAPI
│   └── pipeline/
│       ├── db.js                    # pipeline.db helpers (applications + events)
│       └── classifier.js            # Email classifier — inbound + outbound (sent thank-yous)
├── scripts/
│   ├── setup.js                     # Terminal fallback for setup
│   ├── serve-dashboard.js           # Local HTTP dashboard on port 3033
│   ├── store-linkedin-jobs.js       # Stores Chrome MCP LinkedIn results to jobs.db
│   ├── process-emails.js            # Classifies fetched emails → upserts pipeline.db
│   └── get-pipeline.js              # Prints pipeline summary JSON for the briefing
├── .claude/
│   ├── skill/SKILL.md               # /job-hunt slash command definition
│   ├── skill/SETUP.md               # /job-hunt-setup wizard definition
│   └── scheduled-task/SKILL.md      # daily-job-hunt scheduled task definition
├── .env.example                     # Optional integrations (SerpAPI, SendGrid)
├── CLAUDE.md                        # Instructions for Claude Code
└── package.json
```

---

## Privacy

- `candidate-profile.js` — git-ignored, your personal data stays on your machine
- `jobs.db` — git-ignored, your job search history stays local
- `pipeline.db` — git-ignored, your application pipeline (parsed from your Gmail) stays local
- `.env` — git-ignored, your API keys stay local
- No data is sent anywhere except the APIs you explicitly configure

---

## Data Sources

### Greenhouse, Lever & Ashby
All three ATS providers expose public JSON APIs — no authentication needed. The agent queries curated lists of companies across a range of industries — the defaults skew toward the industries in the example profile, but the lists are fully customizable. Add any company that uses one of these ATSs by appending their slug (see **Customization** above). The setup wizard also prompts you to specify your target industries, which Claude uses when suggesting companies to add.

Of the three, Ashby returns the richest data: full job descriptions come back inline, which gives Claude meaningfully better context when scoring. Greenhouse and Lever return titles, locations, and links; descriptions are fetched separately when needed.

### LinkedIn
Uses the Chrome extension to scrape LinkedIn job search results. Claude controls the browser you're already logged into — no API key needed. LinkedIn job IDs expire quickly, so the agent captures direct ATS apply URLs at scrape time.

### Google Jobs (SerpAPI)
Optional fourth source. Returns broad results and often includes salary data. Sign up at [serpapi.com](https://serpapi.com) — free tier includes 100 searches/month. Add `SERPAPI_KEY` to `.env` to enable.

---

## License

MIT
