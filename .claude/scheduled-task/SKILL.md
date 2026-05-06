---
name: daily-job-hunt
description: Daily job search and pipeline tracker — scrapes new roles, scores them, scans Gmail for application emails, and delivers a unified daily briefing.
---

# Daily Job Hunt + Pipeline Tracker

Runs the full daily job search and application tracking pipeline.

- **Candidate:** <CANDIDATE_NAME> — <TARGET_ROLES_AND_INDUSTRIES>
- **Jobs DB:** `<YOUR_PROJECT_PATH>/jobs.db`
- **Pipeline DB:** `<YOUR_PROJECT_PATH>/pipeline.db`
- **Dashboard:** `http://localhost:3033` (always running via pm2)

---

## Part 1 — Job Discovery

### Step 1 — Greenhouse + Lever

```bash
cd "<YOUR_PROJECT_PATH>" && node src/index.js --run-now
```

### Step 2 — LinkedIn (Chrome MCP)

**IMPORTANT: Chrome MCP may not be available in unattended/routine runs. Before attempting, call `mcp__Claude_in_Chrome__list_connected_browsers` to check if Chrome is connected.**

- If Chrome **is connected**: proceed with scraping all 3 cities below.
- If Chrome **is not connected**: skip this step, set LinkedIn new jobs = 0 in the briefing, continue to Step 3.
- If Chrome **is connected but errors occur** (disconnect, batch failure, JS timeout): do NOT skip — fall back to the simple text extraction method below.

**Primary method**: Use `mcp__Claude_in_Chrome__javascript_tool` with the full JS extraction script after navigating to each URL.

**Fallback (if JS/batch fails)**: Use `mcp__Claude_in_Chrome__navigate` then `mcp__Claude_in_Chrome__get_page_text` to get the raw page text, then extract job titles/companies/locations from the text using pattern matching. This won't capture job IDs or external URLs but will capture the job listings. Store with `source: 'linkedin'` and `job_id` set to a hash or sequential placeholder.

Scrape each search URL, extract job cards, enrich with external apply URLs where possible, store results.

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
- If it **fails with any auth error** (`invalid_grant`, `No access, refresh token`, `unauthorized`, etc.):

  **Auto-reauth sequence** (run these commands):

  ```bash
  # 1. Delete the stale token
  rm -f ~/.gmail-mcp/credentials.json

  # 2. Run the auth script — opens a browser OAuth window for the user to authorize
  GMAIL_MCP_JS=$(find ~/.npm/_npx -path "*server-gmail-autoauth-mcp/dist/index.js" 2>/dev/null | head -1)
  node "$GMAIL_MCP_JS" auth &
  AUTH_PID=$!
  sleep 30

  # 3. Check if credentials were written
  ls ~/.gmail-mcp/credentials.json 2>/dev/null && echo "AUTH_OK" || echo "AUTH_PENDING"
  ```

  - If `AUTH_OK`: kill the background process (`kill $AUTH_PID 2>/dev/null`), then **retry the Gmail health check** (`from:me`). If it passes, proceed with the full search below.
  - If `AUTH_PENDING` (unattended run — no one clicked authorize in the browser):
    1. Run: `open "https://claude.ai/settings/connections"` to alert the user
    2. Run: `open -a "Claude"` to bring Claude to focus
    3. Skip the Gmail steps and note the auth failure in the final briefing
    4. Continue with Step 7 (dashboard refresh) and Step 8 (briefing without pipeline data)

  **Note:** `mcp__Claude_in_Chrome__navigate` cannot open `claude.ai` or `mail.google.com` — those domains are blocked. Use `open` (Bash) instead.

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

**After running process-emails.js, review the output `events` array for misidentified company names.** The classifier sometimes extracts the company name from the sender's email domain instead of the email content — e.g., `myworkday.com` → `"Myworkday"` instead of the actual company (Dyson, PwC, etc.), or `makenotion.com` → `"Makenotion"` instead of `"Notion"`.

For any misidentified entries, fix them directly in the DB:
```bash
cd "<YOUR_PROJECT_PATH>"
node --input-type=module << 'EOF'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('pipeline.db');
// Example fixes — adjust based on actual output:
// db.prepare("UPDATE applications SET company='Dyson', role='Chief of Staff' WHERE gmail_thread_id=?").run('THREAD_ID');
// db.prepare("UPDATE applications SET company='Notion', current_status='applied' WHERE company='Makenotion'").run();
db.close();
EOF
```

Also check for **skipped calendar invites and Google Calendar interview notifications** — the classifier may skip these with `unknown` confidence. Add them manually if needed:
```bash
node --input-type=module << 'EOF'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('<YOUR_PROJECT_PATH>/pipeline.db');
// db.prepare("INSERT INTO applications (gmail_thread_id, company, role, current_status, last_activity_date) VALUES (?,?,?,?,?)").run('THREAD_ID', 'Company', 'Role', 'interview_scheduled', 'YYYY-MM-DD');
db.close();
EOF
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

If Gmail auth failed and the auto-reauth did not complete, include at the top of the briefing:
⚠️ Gmail auth expired — pipeline data not updated. Open Claude → Settings → Connections to reconnect, or run `claude login` in Terminal.

Call out any new interviews, offers, take-home assignments, or top-scored roles (8+).
