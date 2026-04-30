/**
 * scripts/store-linkedin-jobs.js
 *
 * Reads a JSON array of LinkedIn job objects from stdin,
 * deduplicates against the SQLite database, inserts new ones,
 * and prints a summary JSON to stdout.
 *
 * Called by the /job-hunt Claude skill after Chrome MCP scrapes LinkedIn.
 *
 * Input JSON shape (array):
 * [
 *   {
 *     "job_id": "4404502134",
 *     "title": "Head of Growth",
 *     "company": "Acme Corp",
 *     "location": "New York, NY (Hybrid)",
 *     "salary": null,
 *     "url": "https://www.linkedin.com/jobs/view/4404502134/",
 *     "external_url": "https://company.com/jobs/apply/123",
 *     "source": "linkedin",
 *     "posted_at": "2026-04-20",
 *     "description": null
 *   }
 * ]
 *
 * Output JSON (stdout):
 * { "total": 25, "new": 18, "dupes": 7 }
 */

import { hasJob, insertJob } from '../src/db.js';

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();

  let jobs;
  try {
    jobs = JSON.parse(raw);
  } catch {
    process.stderr.write('ERROR: Could not parse JSON array from stdin\n');
    process.exit(1);
  }

  if (!Array.isArray(jobs)) {
    process.stderr.write('ERROR: Input must be a JSON array\n');
    process.exit(1);
  }

  let newCount = 0;
  let dupeCount = 0;

  for (const job of jobs) {
    if (!job.job_id) { dupeCount++; continue; }
    job.source = job.source || 'linkedin';
    if (hasJob(job.source, String(job.job_id))) {
      dupeCount++;
    } else {
      insertJob({ ...job, job_id: String(job.job_id) });
      newCount++;
    }
  }

  process.stdout.write(JSON.stringify({ total: jobs.length, new: newCount, dupes: dupeCount }));
}

main().catch(err => { process.stderr.write(`ERROR: ${err.message}\n`); process.exit(1); });
