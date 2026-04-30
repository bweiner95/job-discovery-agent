---
name: daily-job-hunt
description: >
  Runs the daily job discovery pipeline. Scrapes Greenhouse + Lever via Node,
  LinkedIn via Chrome MCP, scores new jobs natively, and serves the dashboard.
  Trigger on schedule or when user says "run job hunt", "check for new jobs", etc.
---

# Daily Job Hunt — Scheduled Task

Runs the full job discovery pipeline at `<YOUR_PROJECT_PATH>`.

## Step 1 — Greenhouse + Lever

```bash
cd "<YOUR_PROJECT_PATH>" && node src/index.js --run-now
```

## Step 2 — LinkedIn (Chrome MCP)

Scrape each search URL, extract job cards, enrich with external apply URLs, store results.

### 2a. New York
```
https://www.linkedin.com/jobs/search/?keywords=Head+of+Growth+OR+Director+of+Growth+OR+VP+Growth+OR+Director+of+Strategy+OR+Strategy+Operations&location=New+York%2C+United+States&f_TPR=r604800
```

### 2b. San Francisco
```
https://www.linkedin.com/jobs/search/?keywords=Head+of+Growth+OR+Director+of+Growth+OR+VP+Growth+OR+Director+of+Strategy+OR+Strategy+Operations&location=San+Francisco+Bay+Area&f_TPR=r604800
```

### 2c. Los Angeles
```
https://www.linkedin.com/jobs/search/?keywords=Head+of+Growth+OR+Director+of+Growth+OR+VP+Growth+OR+Director+of+Strategy+OR+Strategy+Operations&location=Los+Angeles+Metropolitan+Area&f_TPR=r604800
```

For each page, run the extraction script, enrich external URLs, then store:
```bash
cd "<YOUR_PROJECT_PATH>"
node scripts/store-linkedin-jobs.js << 'JOBSEOF'
[PASTE JSON ARRAY HERE]
JOBSEOF
```

## Step 3 — Score new jobs

Read `src/candidate-profile.js`, score unscored jobs natively, update DB.

```bash
cd "<YOUR_PROJECT_PATH>"
node --input-type=module << 'EOF'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('jobs.db');
const jobs = db.prepare("SELECT id, title, company, location FROM jobs WHERE score IS NULL").all();
console.log(JSON.stringify(jobs));
db.close();
EOF
```

## Step 4 — Dashboard

```bash
lsof -ti:3033 | xargs kill -9 2>/dev/null; sleep 1
cd "<YOUR_PROJECT_PATH>" && node scripts/serve-dashboard.js &
sleep 2 && echo "Dashboard ready at http://localhost:3033"
```
