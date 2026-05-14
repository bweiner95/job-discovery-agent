# Job Discovery Agent

A self-hosted job-hunting agent that searches multiple sources daily for roles matching your background, scores each one with Claude AI, and surfaces them in an interactive dashboard — so you only review jobs worth applying to.

Built to run inside [Claude Code](https://claude.ai/code) with the Chrome extension for LinkedIn scraping.

---

## What It Does

1. **Scrapes six sources** every day:
   - **Greenhouse** boards for ~70 companies across your target industries (no API key needed)
   - **Lever** boards for ~35 companies across your target industries (no API key needed)
   - **Ashby** boards for ~30 companies — returns full job descriptions inline for richer scoring (no API key needed)
   - **LinkedIn** via Chrome extension — searches your target cities and titles
   - **Curated newsletters** like Ali Rohde Jobs (Substack) — parses weekly emails, resolves redirect links to real ATS apply pages
   - **Google Jobs** via SerpAPI (optional — broader coverage, includes salary data)

2. **Deduplicates** against a local SQLite database — same role surfacing from multiple sources gets merged into a single canonical card (e.g. one Whatnot Director, not three). You never see the same posting twice.

3. **Scores each job 1–10** with Claude, based on your personal candidate profile, target roles, and preferences. Three layers of intelligence:
   - **YOE gate**: jobs requiring significantly more years of experience than you have get auto-capped (no more "12+ years" listings cluttering your triage)
   - **Feedback loop**: when you dismiss a role and explain why, that reason informs future scoring runs
   - **Auto-archive**: jobs scoring ≤ 3 and stale LinkedIn listings (> 14 days) get auto-archived to the **Not a Fit** tab so they don't clutter Open Roles

4. **Tracks your application pipeline** by scanning Gmail — both inbound recruiter emails and the thank-you notes you send after interviews. Status advances automatically (Applied → Interview → Follow-up → Offer / Rejection). Cold applications (14+ days no activity) get flagged.

5. **Serves a dashboard** at `http://localhost:3033` with five tabs: Open Roles, Pipeline, **Analytics**, Applied, Not a Fit. Click any card to open a side panel with the full description, score rationale, and apply link.

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

**`SCORING_RUBRIC`** — how Claude should weight signals: years-of-experience requirement, salary, company type, location, function, scope. Title is treated as descriptive (not a score input) — what matters is whether the JD's YOE requirement, salary, and scope align with where you actually are. You define what a 9/10 looks like vs. a 5/10.

The richer and more specific your profile, the more accurate the scoring. See `src/candidate-profile.example.js` for a fully worked example.

To update your profile — new job, new salary floor, new target titles — just edit `src/candidate-profile.js`. Changes take effect on the next run.

### The dashboard

The dashboard at `http://localhost:3033` shows discovered jobs sorted by score across five tabs:

| Tab | What it shows |
|---|---|
| **Open Roles** | Active jobs awaiting triage. Filter by score, source, or location. |
| **Pipeline** | Applications grouped by stage: Offer · Interview · Take-home · Follow-up · Applied · Rejection. Scanned automatically from Gmail. |
| **Analytics** | Conversion funnel, response rate, median time-to-response, weekly application velocity, top companies. Derived from your pipeline data. |
| **Applied** | Jobs you've marked as applied. Click "Unapply" to restore them to Open Roles. |
| **Not a Fit** | Dismissed jobs. Your reason (if you provide one) is shown on the card. |

| Action | Behavior |
|---|---|
| Click a card | Opens a side panel with the full job description, score reason, source links, and Apply / Mark Applied / Not a Fit actions |
| `+ Applied` | Marks the job applied and moves it to the Applied tab |
| `×` (Not a Fit) | Opens a modal asking why; reason is fed back into Claude on the next scoring run so similar roles score lower |
| `View on …` | Direct link to the ATS or company careers page |

**Demo mode**: visit `http://localhost:3033/?demo=true` to see the dashboard populated with sanitized sample data (well-known companies like Notion / Linear / Discord) — useful for screenshots or sharing without exposing your real pipeline. Reload without the flag to return to your data.

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
│   ├── setup.js                          # Terminal fallback for setup
│   ├── serve-dashboard.js                # Local HTTP dashboard on port 3033
│   ├── store-linkedin-jobs.js            # Stores Chrome MCP LinkedIn results to jobs.db
│   ├── enrich-linkedin-descriptions.js   # Backfills LinkedIn JD text after scraping
│   ├── process-emails.js                 # Classifies fetched emails → upserts pipeline.db
│   ├── process-alirohde-email.js         # Parses Ali Rohde newsletter, resolves redirects
│   ├── get-pipeline.js                   # Prints pipeline summary JSON for the briefing
│   └── check-updates.js                  # Weekly upstream-update check
├── .claude/
│   ├── skill/SKILL.md               # /job-hunt slash command definition
│   ├── skill/SETUP.md               # /job-hunt-setup wizard definition
│   └── scheduled-task/SKILL.md      # daily-job-hunt scheduled task definition
├── .env.example                     # Optional integrations (SerpAPI, SendGrid)
├── CLAUDE.md                        # Instructions for Claude Code
└── package.json
```

---

## Staying up to date

The agent quietly checks GitHub for new commits on every run, throttled to once per week. If updates are available, you'll see a notice like this in the run log:

```
━━━ 📦 Update Available ━━━
Your local copy is behind bweiner95/job-discovery-agent by 3 commit(s).

Recent changes upstream:
  • c3f5d0f  Bring CLAUDE.md and README in sync with current feature set
  • 18c7669  Close LinkedIn tab after Step 2 finishes
  • 279345e  Detect post-interview thank-you notes from user's sent emails

To update:  cd into the repo and run `git pull`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Updates are **never** pulled automatically — review and run `git pull` yourself. To check immediately, run `npm run check-updates -- --force`.

The check stores its state in `.update-check` (git-ignored) and silently skips on offline / rate-limit failures.

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
Uses the Chrome extension to scrape LinkedIn job search results. Claude controls the browser you're already logged into — no API key needed. After scraping, the agent navigates into each job card to capture the full description (so YOE and other description-based scoring rules apply equally to LinkedIn jobs). LinkedIn listings older than 14 days are auto-archived as likely closed.

### Curated newsletters (Substack)
Some of the best curated job lists live in weekly newsletters — Ali Rohde Jobs is the supported example. The agent scans your Gmail for new editions, parses each listing, resolves the Substack tracking redirects to the real ATS apply URLs, and stores them with `source='alirohde'`. To add other newsletters, model on `scripts/process-alirohde-email.js`.

### Google Jobs (SerpAPI)
Optional source. Returns broad results and often includes salary data. Sign up at [serpapi.com](https://serpapi.com) — free tier includes 100 searches/month. Add `SERPAPI_KEY` to `.env` to enable.

---

## Security

The dashboard binds to `127.0.0.1` only (never exposed to your LAN). State-changing endpoints and the privileged "run agent" endpoint require same-origin Origin/Referer headers, so a malicious webpage you visit can't trigger them in the background. No data leaves your machine except via the APIs you explicitly configure.

---

## License

MIT
