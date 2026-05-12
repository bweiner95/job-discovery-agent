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

**Description enrichment (important for accurate scoring):** Right after extracting cards on each city's search page, harvest the descriptions for the cards still visible there — the JD lazy-loads in the right pane when you click into a card.

**IMPORTANT — what actually works:**
- LinkedIn's `/jobs/view/{id}/` standalone URL **does NOT render** the description for direct visits. Don't navigate there.
- The description only loads in the right-side detail pane on the `/jobs/search/?...&currentJobId={id}` URL, AND only after a real click on the card.
- Programmatic JS clicks (`.click()`) **do not** trigger LinkedIn's React handler. You must use `mcp__Claude_in_Chrome__computer` with `action: "left_click"` (real click).
- After click, wait **5 seconds** before extracting — LinkedIn lazy-loads the body.

**Loop, per city — do this RIGHT AFTER step's card extraction (still on the same search page, before navigating away):**

For each card you just extracted:
1. Set the URL via JS to `currentJobId={id}` so LinkedIn highlights that card:
   ```javascript
   const newUrl = new URL(location.href);
   newUrl.searchParams.set('currentJobId', '<JOB_ID>');
   history.replaceState(null, '', newUrl.toString());
   ```
2. Find the card on the page via `mcp__Claude_in_Chrome__javascript_tool`:
   ```javascript
   const card = document.querySelector('[data-job-id="<JOB_ID>"]');
   if (card) card.scrollIntoView({ block: 'center' });
   const r = card?.getBoundingClientRect();
   JSON.stringify({ x: r ? Math.round(r.x + r.width/2) : null, y: r ? Math.round(r.y + r.height/2) : null });
   ```
3. Real-click via `mcp__Claude_in_Chrome__computer` `left_click` at `{x, y}` from step 2.
4. Wait 5 seconds (extract via JS that begins with `await new Promise(r => setTimeout(r, 5000));`).
5. Extract:
   ```javascript
   const el = document.querySelector('.jobs-description__content');
   JSON.stringify({ job_id: '<JOB_ID>', description: (el?.innerText ?? '').slice(0, 8000) });
   ```

After collecting all descriptions across the 3 cities, store them in one batch:
```bash
cd "<YOUR_PROJECT_PATH>"
node scripts/enrich-linkedin-descriptions.js << 'EOF'
[{"job_id":"...","description":"..."}, ...]
EOF
```

**Limit:** only enrich jobs currently visible on the search page (~7 per city = ~21/run). Older jobs that fell out of the past-week filter cannot be re-enriched — accept this as a known limitation. Score them based on title/company alone.

**After all 3 cities are scraped, descriptions enriched, and stored**, close the LinkedIn tab to keep the user's browser tidy. Call `mcp__Claude_in_Chrome__tabs_close_mcp` with the `tabId` from the earlier `tabs_context_mcp` call. If the close fails (tab already closed by user, etc.), continue silently.

### Step 2.5 — Ali Rohde Jobs Substack (weekly, Fridays)

Ali Rohde sends a weekly Substack newsletter ("Edition N: Ali Rohde Jobs") with curated Chief of Staff / BizOps / VC roles. Search for the most recent edition not yet processed; parse and store.

```
mcp__gmail__search_emails: from:alirohdejobs@substack.com after:YYYY/MM/DD
```

For each unprocessed edition (compare subject "Edition NNN" against most recent `e{NNN}-...` job_id in DB), fetch the full body via `mcp__gmail__read_email` and pipe the JSON to the processor:

```bash
cd "<YOUR_PROJECT_PATH>"
python3 -c "
import json
print(json.dumps({
  'subject': '<EMAIL SUBJECT>',
  'messageId': '<MSG_ID>',
  'date': 'YYYY-MM-DD',
  'body': '''<FULL PLAIN-TEXT BODY HERE>'''
}))
" | node scripts/process-alirohde-email.js
```

The processor parses the listings, resolves each Substack redirect to the real ATS URL, and inserts new jobs with `source='alirohde'`. Output reports `{ edition, totalParsed, new, dupes, crossSourceDupes, resolved }`.

If the search returns nothing newer than the most recent edition already in the DB, skip this step silently.

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

**After scoring, run two auto-archive passes** so Open Roles stays signal-dense:

1. **Low scores (≤ 3)** — wrong geography, wrong industry, wrong function. Captures the score reason as the not_fit_reason so the user can verify in the Not a Fit tab.
2. **Stale LinkedIn listings (>14 days old)** — LinkedIn's `f_TPR=r604800` filter only surfaces past-week postings, so any LinkedIn job still in the DB after 14 days is very likely closed/filled. Marking it as not_fit with a clear reason prevents the user from clicking through to "no longer accepting applications" pages.

```bash
cd "/Users/benweiner/Documents/Claude Code/job-discovery-agent"
node --input-type=module << 'EOF'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('jobs.db');
const lowScore = db.prepare(`
  UPDATE jobs SET status = 'not_fit',
    not_fit_reason = COALESCE(score_reason, 'Auto-archived: score ' || score || ' below fit threshold')
  WHERE score <= 3 AND (status IS NULL OR status = 'active') AND duplicate_of IS NULL
`).run();
const stale = db.prepare(`
  UPDATE jobs SET status = 'not_fit',
    not_fit_reason = 'Auto-archived: LinkedIn listing >14 days old, likely no longer accepting applications'
  WHERE source = 'linkedin' AND (status IS NULL OR status = 'active') AND duplicate_of IS NULL
    AND created_at < datetime('now', '-14 days')
`).run();
console.log('Auto-archived ' + lowScore.changes + ' low-scored + ' + stale.changes + ' stale LinkedIn');
db.close();
EOF
```

Surface both counts in the final briefing so the user knows how many were filtered.

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
