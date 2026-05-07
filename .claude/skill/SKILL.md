---
name: job-hunt
description: >
  Runs the full job search pipeline: scrapes new roles, scores them, scans Gmail for
  application updates, and opens the unified dashboard.
  Trigger whenever the user says "run job hunt", "check for new jobs", "find jobs",
  "job search", "any new jobs today", "check my pipeline", "update pipeline",
  "application tracker", "job tracker", "any new emails about jobs", "pipeline status",
  "where are my applications", or asks about their job search status or active applications.
---

# Job Hunt Skill

Runs the complete job search and application tracking pipeline at
`<YOUR_PROJECT_PATH>`.

**Two pipelines run together:**
1. **Job Discovery** — scrapes Greenhouse, Lever, Ashby, LinkedIn, and optionally Google Jobs
2. **Application Pipeline** — scans Gmail for job emails and updates application status

---

## Part 1 — Job Discovery

### Step 1 — Run Greenhouse + Lever + Ashby scrapers

```bash
cd "<YOUR_PROJECT_PATH>" && node src/index.js --run-now
```

This runs all three ATS scrapers (Greenhouse, Lever, Ashby) plus the LinkedIn guest-API scraper and SerpAPI (if configured). Ashby returns full job descriptions inline, so its jobs come into the DB with richer context.

Note the output: per-source counts and total fetched, new vs. duplicates.

### Step 2 — Scrape LinkedIn via Chrome (3 cities)

**If Chrome MCP errors occur** (disconnect, batch failure, JS timeout): do NOT skip — fall back to `navigate` + `get_page_text` and extract job titles/companies/locations from the page text. Less precise but keeps LinkedIn in the run.

For each search below, navigate to the URL, scroll for more results, extract job cards, and store.

#### 2a. New York
```
https://www.linkedin.com/jobs/search/?keywords=Head+of+Growth+OR+Director+of+Growth+OR+VP+Growth+OR+Director+of+Strategy+OR+Strategy+Operations&location=New+York%2C+United+States&f_TPR=r604800
```

#### 2b. San Francisco
```
https://www.linkedin.com/jobs/search/?keywords=Head+of+Growth+OR+Director+of+Growth+OR+VP+Growth+OR+Director+of+Strategy+OR+Strategy+Operations&location=San+Francisco+Bay+Area&f_TPR=r604800
```

#### 2c. Los Angeles
```
https://www.linkedin.com/jobs/search/?keywords=Head+of+Growth+OR+Director+of+Growth+OR+VP+Growth+OR+Director+of+Strategy+OR+Strategy+Operations&location=Los+Angeles+Metropolitan+Area&f_TPR=r604800
```

**For each page**, run this extraction script via `mcp__Claude_in_Chrome__javascript_tool`:

```javascript
// Scroll the jobs list panel to load more cards
const panels = [...document.querySelectorAll('*')].filter(el => {
  const s = window.getComputedStyle(el);
  return (s.overflowY === 'auto' || s.overflowY === 'scroll')
    && el.scrollHeight > el.clientHeight + 50
    && !el.className.includes('job-details');
});
if (panels[0]) { panels[0].scrollTop = panels[0].scrollHeight; }

const results = [];
const seen = new Set();

document.querySelectorAll('[data-job-id], .job-card-container').forEach(card => {
  const linkEl = card.querySelector('a[href*="/jobs/view/"]');
  if (!linkEl) return;
  const url = linkEl.href.split('?')[0];
  if (seen.has(url)) return;
  seen.add(url);

  const jobId = url.match(/\/jobs\/view\/(\d+)/)?.[1] || url;

  const titleEl = card.querySelector('[class*="job-card-list__title"]') || card.querySelector('strong');
  const title = (titleEl?.innerText || linkEl?.innerText || '')
    .split('\n')[0].replace(/\s*with verification\s*$/i, '').trim();

  const companyEl = card.querySelector('[class*="subtitle"]') || card.querySelector('[class*="primary-description"]');
  const company = companyEl?.innerText?.trim() || '';

  const allSpans = [...card.querySelectorAll('span, li')];
  const locationEl = allSpans.find(el =>
    /\b(NY|CA|WA|TX|FL|IL|remote|New York|San Francisco|Los Angeles|Chicago|Austin|Seattle|Boston|hybrid|on-site|Mountain View|San Jose|Menlo Park|Culver City|Santa Monica)\b/i.test(el.innerText?.trim())
  );

  const cardText = card.innerText || '';
  const salaryMatch = cardText.match(/\$[\d,]+(?:K)?(?:\s*[-–]\s*\$[\d,]+(?:K)?)?(?:\s*(?:yr|\/yr|per year|annually|a year))?/i);

  results.push({
    job_id: jobId,
    title,
    company,
    location: locationEl?.innerText?.trim() || '',
    salary: salaryMatch?.[0] || null,
    url,
    external_url: null,
    source: 'linkedin',
    posted_at: null,
    description: null
  });
});

JSON.stringify(results)
```

Store the list, then **enrich each job with its real apply URL** by clicking into each card and running:

```javascript
const applyBtn = [...document.querySelectorAll('a[href]')]
  .find(a => a.href && !a.href.includes('linkedin.com') && a.href.startsWith('http') &&
    /apply|career|job|greenhouse|lever|workday|ashby|icims|taleo|myworkdayjobs|smartrecruiters/i.test(a.href));

const jsonLdUrl = (() => {
  try {
    const ld = [...document.querySelectorAll('script[type="application/ld+json"]')]
      .map(s => { try { return JSON.parse(s.innerText); } catch { return null; } })
      .filter(Boolean).find(d => d.url && !d.url.includes('linkedin.com'));
    return ld?.url || null;
  } catch { return null; }
})();

JSON.stringify({
  job_id: location.pathname.match(/\/jobs\/view\/(\d+)/)?.[1],
  external_url: applyBtn?.href || jsonLdUrl || null
})
```

If `external_url` found, update DB:
```bash
cd "<YOUR_PROJECT_PATH>"
node --input-type=module << 'EOF'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('jobs.db');
// db.prepare("UPDATE jobs SET external_url=? WHERE source='linkedin' AND job_id=?").run('URL', 'JOB_ID');
db.close();
EOF
```

Store results:
```bash
cd "<YOUR_PROJECT_PATH>"
node scripts/store-linkedin-jobs.js << 'JOBSEOF'
[PASTE JSON ARRAY HERE]
JOBSEOF
```

### Step 3 — Score new jobs natively

Read `src/candidate-profile.js`. **First, query recent user feedback on jobs they marked "not a fit"** so you can use it as context when scoring:

```bash
cd "<YOUR_PROJECT_PATH>"
node --input-type=module << 'EOF'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('jobs.db');
const feedback = db.prepare("SELECT title, company, location, score, not_fit_reason FROM jobs WHERE status = 'not_fit' AND not_fit_reason IS NOT NULL AND not_fit_reason != '' ORDER BY id DESC LIMIT 30").all();
console.log(JSON.stringify(feedback, null, 2));
db.close();
EOF
```

Use this feedback as additional context — if the user repeatedly rejects similar roles, score similar new roles lower. If a strong pattern emerges, surface a rubric-update suggestion in the final summary (do NOT auto-edit the profile).

Query unscored jobs:
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

Score each job 1–10 using CANDIDATE_PROFILE and SCORING_RUBRIC. Update DB:
```bash
cd "<YOUR_PROJECT_PATH>"
node --input-type=module << 'EOF'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('jobs.db');
// db.prepare("UPDATE jobs SET score=?, score_reason=? WHERE id=?").run(SCORE, 'REASON', ID);
db.close();
EOF
```

---

## Part 2 — Application Pipeline

### Step 4 — Determine Gmail scan window

```bash
cd "<YOUR_PROJECT_PATH>"
node --input-type=module <<'EOF'
import { isFirstRun } from './src/pipeline/db.js';
const first = isFirstRun();
const FLOOR = new Date('2026-04-01');
const incremental = new Date(Date.now() - 24 * 60 * 60 * 1000);
const since = first ? FLOOR : (incremental > FLOOR ? incremental : FLOOR);
console.log(JSON.stringify({ firstRun: first, since: since.toISOString().split('T')[0] }));
EOF
```

### Step 5 — Check Gmail auth, then search

**IMPORTANT: Before using Gmail, verify auth is working.**

Call `mcp__gmail__search_emails` with query `from:me` and maxResults 1 as a health check.

- If it **succeeds**: proceed to the full search below.
- If it **fails with any auth error** (invalid_grant, invalid_request, unauthorized, etc.):
  1. Use `mcp__Claude_in_Chrome__navigate` to open `https://claude.ai/settings/connections` in Chrome.
  2. Also run: `open -a "Claude"` to bring the Claude app to focus.
  3. Skip the Gmail steps and note the auth failure in the Step 10 summary.

If auth is healthy, run **two** searches via `mcp__gmail__search_emails` (replace DATE with `since` from Step 4, format `YYYY/MM/DD`):

**Search 1 — Inbound (recruiters / ATS):**
```
(subject:(application OR interview OR offer OR rejection OR "thank you for applying" OR "moving forward" OR "next steps" OR recruiter OR "your application" OR "phone screen" OR "we'd like to" OR "position has been filled" OR "take home" OR "assignment" OR "case study") OR from:(greenhouse.io OR lever.co OR workday.com OR ashbyhq.com OR taleo.net OR icims.com OR jobvite.com OR smartrecruiters.com OR bamboohr.com OR dover.com)) after:DATE
```

**Search 2 — Outbound (user-sent thank-you notes after interviews):**
```
from:me (subject:(thank OR "great speaking" OR "great chatting" OR "great meeting" OR "following up" OR "looking forward" OR "appreciate") OR "thank you for taking the time" OR "really enjoyed our" OR "looking forward to next steps") after:DATE
```

Retrieve up to 100 results from each. Dedup by messageId when combining.

### Step 6 — Fetch email bodies

For each email, call `mcp__gmail__read_email` to get the full message. Build a JSON array:
```json
[
  {
    "threadId": "...",
    "messageId": "...",
    "subject": "...",
    "from": "sender@company.com",
    "to": "...",
    "body": "plain text body...",
    "snippet": "...",
    "date": "2026-04-20"
  }
]
```

### Step 7 — Classify and store

Pass `USER_EMAIL` so the classifier can correctly identify outbound thank-you notes as `interview_follow_up` events:

```bash
cd "<YOUR_PROJECT_PATH>"
USER_EMAIL=your.email@gmail.com node scripts/process-emails.js << 'EMAILEOF'
[PASTE COMBINED JSON ARRAY HERE — inbound + outbound emails]
EMAILEOF
```

### Step 8 — Get pipeline summary

```bash
cd "<YOUR_PROJECT_PATH>"
node scripts/get-pipeline.js
```

---

## Step 9 — Refresh dashboard

The dashboard runs persistently via pm2:

```bash
pm2 restart job-dashboard
```

If pm2 is not running it:
```bash
cd "<YOUR_PROJECT_PATH>" && pm2 start scripts/serve-dashboard.js --name job-dashboard
```

Dashboard: **http://localhost:3033**

---

## Step 10 — Report summary

```
Run complete ✓  (timestamp)

  JOB DISCOVERY
  Greenhouse/Lever/Ashby:  X new · Y duplicates (G:n · L:n · A:n)
  LinkedIn (NY/SF/LA): X new jobs
  Total in database:  N jobs

  APPLICATION PIPELINE
  Emails scanned:  N
  New applications: N
  Status updates:  N
  📝 Case Study/Assignment: N
  Cold (🥶 14+ days): N

  Dashboard → http://localhost:3033
```

When listing standout new roles, only include jobs where `status = 'active'` or `status IS NULL` — exclude `status = 'applied'` and `status = 'not_fit'`. Query:
```sql
SELECT title, company, location, score FROM jobs
WHERE score >= 7 AND (status IS NULL OR status = 'active')
ORDER BY score DESC, created_at DESC LIMIT 15
```

Highlight any standout new roles (score 8+) and notable pipeline activity (new interviews, offers, take-home assignments).
