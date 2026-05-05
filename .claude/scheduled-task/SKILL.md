---
name: daily-job-hunt
description: Daily job search and pipeline tracker — scrapes new roles, scores them, scans Gmail for application emails, and delivers a unified daily briefing.
---

# Daily Job Hunt + Pipeline Tracker

Runs the full daily job search and application tracking pipeline.

- **Candidate:** <CANDIDATE_NAME> — <TARGET_ROLES_AND_INDUSTRIES>
- **Jobs DB:** `<YOUR_PROJECT_PATH>/jobs.db`
- **Pipeline DB:** `<YOUR_PROJECT_PATH>/pipeline.db`
- **Dashboard:** `http://localhost:3033`

---

## Part 1 — Job Discovery

### Step 1 — Greenhouse + Lever

```bash
cd "<YOUR_PROJECT_PATH>" && node src/index.js --run-now
```

### Step 2 — LinkedIn (Chrome MCP)

**IMPORTANT: Chrome MCP may not be available in unattended/routine runs. Before attempting, call `mcp__Claude_in_Chrome__list_connected_browsers` to check if Chrome is connected.**

- If Chrome **is connected**: proceed with scraping all 3 cities below.
- If Chrome **is not connected or returns any error**: skip this step entirely, set LinkedIn new jobs = 0 in the briefing, and continue to Step 3.

Scrape each search URL, extract job cards, enrich with external apply URLs, store results.

#### New York
```
https://www.linkedin.com/jobs/search/?keywords=Head+of+Growth+OR+Director+of+Growth+OR+VP+Growth+OR+Director+of+Strategy+OR+Strategy+Operations&location=New+York%2C+United+States&f_TPR=r604800
```

#### San Francisco
```
https://www.linkedin.com/jobs/search/?keywords=Head+of+Growth+OR+Director+of+Growth+OR+VP+Growth+OR+Director+of+Strategy+OR+Strategy+Operations&location=San+Francisco+Bay+Area&f_TPR=r604800
```

#### Los Angeles
```
https://www.linkedin.com/jobs/search/?keywords=Head+of+Growth+OR+Director+of+Growth+OR+VP+Growth+OR+Director+of+Strategy+OR+Strategy+Operations&location=Los+Angeles+Metropolitan+Area&f_TPR=r604800
```

For each page, extract job cards (scroll + extract JS), enrich external URLs, then store:
```bash
cd "<YOUR_PROJECT_PATH>"
node scripts/store-linkedin-jobs.js << 'JOBSEOF'
[PASTE JSON ARRAY HERE]
JOBSEOF
```

### Step 3 — Score new jobs

Read `src/candidate-profile.js`. Query unscored jobs and score each 1–10 using CANDIDATE_PROFILE and SCORING_RUBRIC. Update DB with scores.

```bash
cd "<YOUR_PROJECT_PATH>"
node --input-type=module << 'EOF'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('jobs.db');
const jobs = db.prepare("SELECT id, title, company, location, description, salary FROM jobs WHERE score IS NULL").all();
console.log(JSON.stringify(jobs));
db.close();
EOF
```

---

## Part 2 — Application Pipeline

### Step 4 — Scan window

```bash
cd "<YOUR_PROJECT_PATH>"
node --input-type=module <<'EOF'
import { isFirstRun } from './src/pipeline/db.js';
const first = isFirstRun();
const FLOOR = new Date('2026-04-01');
const incremental = new Date(Date.now() - 24 * 60 * 60 * 1000);
const since = first ? FLOOR : (incremental > FLOOR ? incremental : FLOOR);
console.log(JSON.stringify({ firstRun: first, sinceDate: since.toISOString().split('T')[0] }));
EOF
```

### Step 5 — Check Gmail auth, then search

**IMPORTANT: Before using Gmail, verify auth is working.**

Call `mcp__gmail__search_emails` with query `from:me` and maxResults 1 as a health check.

- If it **succeeds**: proceed to the full Gmail search below.
- If it **fails with any auth error** (invalid_grant, invalid_request, unauthorized, etc.):
  1. Use `mcp__Claude_in_Chrome__navigate` to open `https://claude.ai/settings/connections` in Chrome so the user can re-authenticate Google.
  2. Also run: `open -a "Claude"` to bring the Claude app to focus.
  3. Skip the Gmail steps and note the auth failure in the final briefing.
  4. Continue with Step 8 (dashboard refresh) and Step 9 (briefing without pipeline data).

If auth is healthy, run the full search using `mcp__gmail__search_emails` with `sinceDate` from Step 4 (format `after:YYYY/MM/DD`):

```
(subject:(application OR interview OR offer OR rejection OR "thank you for applying" OR "moving forward" OR "next steps" OR recruiter OR "your application" OR "phone screen" OR "we'd like to" OR "position has been filled" OR "take home" OR "assignment" OR "case study") OR from:(greenhouse.io OR lever.co OR workday.com OR ashbyhq.com OR taleo.net OR icims.com OR jobvite.com OR smartrecruiters.com OR bamboohr.com OR dover.com)) after:YYYY/MM/DD
```

Retrieve up to 100 results. Fetch full body for each via `mcp__gmail__read_email`.

### Step 6 — Classify and store

```bash
cd "<YOUR_PROJECT_PATH>"
node scripts/process-emails.js << 'EMAILEOF'
[PASTE JSON ARRAY HERE]
EMAILEOF
```

### Step 7 — Pipeline summary

```bash
cd "<YOUR_PROJECT_PATH>"
node scripts/get-pipeline.js
```

---

## Step 8 — Refresh dashboard

The dashboard runs persistently via pm2. Just restart it so it picks up any DB changes:

```bash
pm2 restart job-dashboard
```

If pm2 is not running the dashboard, start it:
```bash
cd "<YOUR_PROJECT_PATH>" && pm2 start scripts/serve-dashboard.js --name job-dashboard
```

## Step 9 — Daily briefing

Deliver a combined daily summary:

```
━━━ Daily Job Hunt Briefing — YYYY-MM-DD ━━━

📋 NEW ROLES (N new today)
  • [Title] — [Company], [Location]  Score: N/10
  • [Title] — [Company], [Location]  Score: N/10

📊 APPLICATION PIPELINE
  🏆 Offers: N
  📅 Interviews scheduled: N
  📝 Case Study / Assignment: N
  🔄 Interview follow-ups: N
  📣 Recruiter outreach: N
  👁 Application viewed: N
  📨 Applied: N
  ❌ Rejections: N
  🥶 Cold (14+ days no activity): N

📈 RUN STATS
  Greenhouse/Lever: N new jobs
  LinkedIn: N new jobs
  Emails scanned: N | New apps: N | Updates: N

🖥  Dashboard → http://localhost:3033
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

If Gmail auth failed, include a clear warning at the top of the briefing:
⚠️ Gmail auth expired — pipeline data not updated. Reconnect Google at: claude.ai/settings/connections

Call out any new interviews, offers, take-home assignments, or top-scored roles (8+).
