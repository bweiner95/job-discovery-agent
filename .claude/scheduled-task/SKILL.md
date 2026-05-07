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

### Step 1 — Greenhouse + Lever + Ashby

```bash
cd "<YOUR_PROJECT_PATH>" && node src/index.js --run-now
```

This single command runs all three ATS scrapers (Greenhouse, Lever, Ashby) in parallel along with the LinkedIn guest-API scraper and SerpAPI (if configured). The output reports per-source counts. Ashby returns full job descriptions inline, so jobs from Ashby will have richer context for scoring than Greenhouse/Lever ones.

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

**After all 3 cities are scraped and stored**, close the LinkedIn tab to keep the user's browser tidy. Call `mcp__Claude_in_Chrome__tabs_close_mcp` with the `tabId` from the earlier `tabs_context_mcp` call. If the close fails (tab already closed by user, etc.), continue silently.

### Step 3 — Score new jobs

Read `src/candidate-profile.js`. **Before scoring, query recent user feedback on jobs they marked "not a fit"** so you can incorporate it into your scoring decisions:

```bash
cd "/Users/benweiner/Documents/Claude Code/job-discovery-agent"
node --input-type=module << 'EOF'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('jobs.db');
const feedback = db.prepare("SELECT title, company, location, score, not_fit_reason FROM jobs WHERE status = 'not_fit' AND not_fit_reason IS NOT NULL AND not_fit_reason != '' ORDER BY id DESC LIMIT 30").all();
console.log(JSON.stringify(feedback, null, 2));
db.close();
EOF
```

Then query unscored jobs and score each 1–10 using CANDIDATE_PROFILE, SCORING_RUBRIC, **and the user feedback above**. Use the feedback as additional context — if the user repeatedly rejects similar roles, score similar new roles lower; if a pattern is strong enough that the rubric should be permanently updated, surface that suggestion in the briefing (don't auto-edit the profile). Update DB with scores.

```bash
cd "<YOUR_PROJECT_PATH>"
node --input-type=module << 'EOF'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('jobs.db');
const jobs = db.prepare("SELECT id, title, company, location, description, salary FROM jobs WHERE score IS NULL AND (status IS NULL OR status NOT IN ('not_fit', 'applied'))").all();
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

If auth is healthy, run **two** searches using `mcp__gmail__search_emails` with `sinceDate` from Step 4 (format `after:YYYY/MM/DD`):

**Search 1 — Inbound (recruiters / ATS):**
```
(subject:(application OR interview OR offer OR rejection OR "thank you for applying" OR "moving forward" OR "next steps" OR recruiter OR "your application" OR "phone screen" OR "we'd like to" OR "position has been filled" OR "take home" OR "assignment" OR "case study") OR from:(greenhouse.io OR lever.co OR workday.com OR ashbyhq.com OR taleo.net OR icims.com OR jobvite.com OR smartrecruiters.com OR bamboohr.com OR dover.com)) after:YYYY/MM/DD
```

**Search 2 — Outbound (user's sent thank-you notes after interviews):**
```
from:me (subject:(thank OR "great speaking" OR "great chatting" OR "great meeting" OR "following up" OR "looking forward" OR "appreciate") OR "thank you for taking the time" OR "really enjoyed our" OR "looking forward to next steps") after:YYYY/MM/DD
```

Combine results from both searches (dedup by messageId). Fetch full body for each via `mcp__gmail__read_email`. Up to 100 each.

### Step 6 — Classify and store

Pass `USER_EMAIL` so the classifier knows which emails are outbound (sent by the user) — outbound thank-you notes are mapped to `interview_follow_up` events:

```bash
cd "<YOUR_PROJECT_PATH>"
USER_EMAIL=bweiner95@gmail.com node scripts/process-emails.js << 'EMAILEOF'
[PASTE JSON ARRAY HERE — both inbound and outbound emails combined]
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

When querying new roles for the briefing, only include jobs with `status = 'active'` or `status IS NULL` — exclude `status = 'applied'` and `status = 'not_fit'`. Example:
```bash
cd "/Users/benweiner/Documents/Claude Code/job-discovery-agent"
node --input-type=module << 'EOF'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('jobs.db');
const newJobs = db.prepare("SELECT title, company, location, score FROM jobs WHERE score >= 7 AND (status IS NULL OR status = 'active') ORDER BY score DESC, created_at DESC LIMIT 15").all();
console.log(JSON.stringify(newJobs));
db.close();
EOF
```

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
  Greenhouse/Lever/Ashby: N new jobs (G:N · L:N · A:N)
  LinkedIn: N new jobs
  Emails scanned: N | New apps: N | Updates: N

🖥  Dashboard → http://localhost:3033
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

If Gmail auth failed and the auto-reauth did not complete, include at the top of the briefing:
⚠️ Gmail auth expired — pipeline data not updated. Open Claude → Settings → Connections to reconnect, or run `claude login` in Terminal.

Call out any new interviews, offers, take-home assignments, or top-scored roles (8+).
