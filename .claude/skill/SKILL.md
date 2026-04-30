---
name: job-hunt
description: >
  Runs the job discovery agent to search for new growth and strategy leadership roles.
  Use this skill whenever the user says anything like "run job hunt", "check for new jobs",
  "find jobs", "job search", "job agent", "any new jobs today", or asks to trigger the
  job discovery pipeline. Also trigger it if the user asks to check, view, or inspect the
  jobs database, or wants to know the status of recent job search runs.
---

# Job Hunt Skill

Runs the job discovery agent at `<YOUR_PROJECT_PATH>` (set this to the absolute path where
you cloned the repo, e.g. `/Users/yourname/projects/job-discovery-agent`).

Scrapes Greenhouse + Lever via Node.js, LinkedIn via Chrome extension, then serves an
interactive HTML dashboard.

## Step 1 — Run Greenhouse + Lever scrapers

```bash
cd "<YOUR_PROJECT_PATH>" && node src/index.js --run-now
```

Note the output: total fetched, new vs. duplicates, and any scoring info.

## Step 2 — Scrape LinkedIn via Chrome (3 searches)

Customize the `keywords` parameter in each URL to match your target titles. The defaults
below target growth and strategy leadership roles — edit to fit your search.

For each search below, navigate to the URL in the connected Chrome browser, wait for cards
to load, scroll to get more results, extract jobs, and store them.

### 2a. New York
Navigate to:
```
https://www.linkedin.com/jobs/search/?keywords=Head+of+Growth+OR+Director+of+Growth+OR+VP+Growth+OR+Director+of+Strategy+OR+Strategy+Operations&location=New+York%2C+United+States&f_TPR=r604800
```

### 2b. San Francisco
Navigate to:
```
https://www.linkedin.com/jobs/search/?keywords=Head+of+Growth+OR+Director+of+Growth+OR+VP+Growth+OR+Director+of+Strategy+OR+Strategy+Operations&location=San+Francisco+Bay+Area&f_TPR=r604800
```

### 2c. Los Angeles
Navigate to:
```
https://www.linkedin.com/jobs/search/?keywords=Head+of+Growth+OR+Director+of+Growth+OR+VP+Growth+OR+Director+of+Strategy+OR+Strategy+Operations&location=Los+Angeles+Metropolitan+Area&f_TPR=r604800
```

**For each page**, after navigating, run this extraction script via `mcp__Claude_in_Chrome__javascript_tool`.
It scrolls the list to load more cards, then extracts job data.

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

Store the list, then **immediately enrich each job with its real apply URL** by clicking into each card.

**For each job in the results list**, click its LinkedIn job URL, wait for it to load, then run:

```javascript
// Extract the external apply URL from the job detail page
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
  external_url: applyBtn?.href || jsonLdUrl || null,
  title: document.title
})
```

If an `external_url` is found, update it in the DB:
```bash
cd "<YOUR_PROJECT_PATH>"
node --input-type=module << 'EOF'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('jobs.db');
// Run one UPDATE per job where external_url was found:
// db.prepare("UPDATE jobs SET external_url=? WHERE source='linkedin' AND job_id=?").run('URL', 'JOB_ID');
db.close();
EOF
```

Then store the full extracted JSON:
```bash
cd "<YOUR_PROJECT_PATH>"
node scripts/store-linkedin-jobs.js << 'JOBSEOF'
[PASTE JSON ARRAY HERE]
JOBSEOF
```

Repeat for all three locations. After all three, deduplicate (the store script handles this automatically).

## Step 3 — Score new jobs natively in Claude

After storing, score any unscored jobs using the candidate profile from `src/candidate-profile.js`.
Read each job's title, company, description/snippet, and output a score 1–10 + brief reason
based on the CANDIDATE_PROFILE and SCORING_RUBRIC defined in that file.

Update scores in DB:
```bash
cd "<YOUR_PROJECT_PATH>"
node --input-type=module << 'EOF'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('jobs.db');
// Run one UPDATE per job scored:
// db.prepare("UPDATE jobs SET score=?, score_reason=? WHERE id=?").run(SCORE, 'REASON', ID);
db.close();
EOF
```

## Step 4 — Serve the interactive dashboard

Kill any old server and start a fresh one:
```bash
lsof -ti:3033 | xargs kill -9 2>/dev/null; sleep 1
cd "<YOUR_PROJECT_PATH>" && node scripts/serve-dashboard.js &
sleep 2 && echo "Dashboard ready"
```

Dashboard URL: **http://localhost:3033**

## Step 5 — Report summary

Present a concise summary:

```
Run complete ✓  (timestamp)
  Greenhouse/Lever:  X new · Y duplicates skipped
  LinkedIn (NY/SF/LA): X new jobs added
  Total in database:  N jobs

  Dashboard → http://localhost:3033
```

Highlight any standout roles and note top-scored new additions (score 8+).
