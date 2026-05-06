import 'dotenv/config';
import cron from 'node-cron';

import { fetchSerpApiJobs }    from './scrapers/serpapi.js';
import { fetchLinkedInJobs }   from './scrapers/linkedin.js';
import { fetchGreenhouseJobs } from './scrapers/greenhouse.js';
import { fetchLeverJobs }      from './scrapers/lever.js';
import { fetchAshbyJobs }      from './scrapers/ashby.js';
import { scoreJobs }           from './scorer.js';
import { sendDigest }          from './email.js';
import {
  isFirstRun,
  hasJob,
  insertJob,
  updateJobScore,
  getEmailableJobs,
  markEmailed,
  recordRun,
} from './db.js';

async function runAgent() {
  const startedAt = new Date();
  console.log(`\n[${startedAt.toISOString()}] ── Job Discovery Agent starting ──`);

  const firstRun = isFirstRun();
  if (firstRun) {
    console.log('First run detected — fetching all available jobs (no 24 h filter)');
  }

  // ── 1. Fetch from all sources concurrently ─────────────────────────────────────────
  console.log('\nFetching jobs from all sources…');
  const [serpResult, linkedinResult, ghResult, leverResult, ashbyResult] = await Promise.allSettled([
    fetchSerpApiJobs(firstRun),
    fetchLinkedInJobs(firstRun),
    fetchGreenhouseJobs(firstRun),
    fetchLeverJobs(firstRun),
    fetchAshbyJobs(firstRun),
  ]);

  function unwrap(result, name) {
    if (result.status === 'fulfilled') return result.value;
    console.error(`${name} scraper threw an error:`, result.reason?.message);
    return [];
  }

  const allJobs = [
    ...unwrap(serpResult,    'SerpAPI'),
    ...unwrap(linkedinResult, 'LinkedIn'),
    ...unwrap(ghResult,      'Greenhouse'),
    ...unwrap(leverResult,   'Lever'),
    ...unwrap(ashbyResult,   'Ashby'),
  ];

  console.log(`\nTotal fetched: ${allJobs.length} jobs across all sources`);

  // ── 2. Deduplicate against the database ───────────────────────────────────────
  const newJobs = [];
  for (const job of allJobs) {
    if (!job.job_id) continue;
    if (!hasJob(job.source, job.job_id)) {
      insertJob(job);
      newJobs.push(job);
    }
  }

  const dupeCount = allJobs.length - newJobs.length;
  console.log(`New: ${newJobs.length}  |  Duplicates skipped: ${dupeCount}`);

  if (newJobs.length === 0) {
    console.log('No new jobs to score or email.\n');
    recordRun(0, 0);
    return;
  }

  // ── 3. Score new jobs (only if ANTHROPIC_API_KEY is set) ─────────────────────
  const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;

  if (hasAnthropicKey) {
    console.log(`\nScoring ${newJobs.length} new job(s) with Claude…`);
    const scoredJobs = await scoreJobs(newJobs);
    for (const job of scoredJobs) {
      updateJobScore(job.source, job.job_id, job.score, job.score_reason);
    }
    const dist = scoredJobs.reduce((acc, j) => {
      const bucket = j.score >= 9 ? '9-10' : j.score >= 7 ? '7-8' : j.score >= 5 ? '5-6' : '1-4';
      acc[bucket] = (acc[bucket] || 0) + 1;
      return acc;
    }, {});
    console.log('Score distribution:', dist);
  } else {
    console.log('\nNo ANTHROPIC_API_KEY — skipping scoring.');
    console.log('ℹ️  Run via the "daily-job-hunt" Claude scheduled task for native AI scoring.\n');
  }

  // ── 4. Email digest (only if SendGrid keys are set) ────────────────────────
  const hasSendGrid = !!(process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM_EMAIL && process.env.ALERT_EMAIL);

  if (hasSendGrid && hasAnthropicKey) {
    const emailJobs = getEmailableJobs(7);
    console.log(`\n${emailJobs.length} job(s) scored 7+ queued for email`);
    if (emailJobs.length > 0) {
      await sendDigest(emailJobs);
      markEmailed(emailJobs.map((j) => j.id));
    }
    recordRun(newJobs.length, emailJobs.length);
  } else {
    console.log(`\n${'─'.repeat(56)}`);
    console.log(`  ${newJobs.length} new job(s) found across all sources`);
    console.log(`${'─'.repeat(56)}`);
    const bySource = {};
    for (const job of newJobs) {
      (bySource[job.source] = bySource[job.source] || []).push(job);
    }
    for (const [source, jobs] of Object.entries(bySource)) {
      console.log(`\n  [${source.toUpperCase()}]`);
      for (const j of jobs) {
        console.log(`    • ${j.title} — ${j.company}`);
        console.log(`      ${j.location}${j.salary ? '  |  ' + j.salary : ''}`);
        if (j.url) console.log(`      ${j.url}`);
      }
    }
    if (!hasSendGrid) console.log('\n  ℹ️  Add SendGrid keys to .env to receive email digests.');
    recordRun(newJobs.length, 0);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n[${new Date().toISOString()}] ── Run complete in ${elapsed} s ──\n`);
}

// ── Entry point ────────────────────────────────────────────────────────────────────
const RUN_NOW = process.argv.includes('--run-now');

if (RUN_NOW) {
  // One-shot mode: run immediately and exit
  runAgent()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Agent failed:', err);
      process.exit(1);
    });
} else {
  // Daemon mode: run once on start, then daily at 8:00 AM local time
  console.log('Job Discovery Agent started in daemon mode.');
  console.log('Scheduled to run daily at 08:00. Running now for the initial fetch…');

  runAgent().catch((err) => console.error('Initial run failed:', err));

  cron.schedule('0 8 * * *', () => {
    runAgent().catch((err) => console.error('Scheduled run failed:', err));
  });
}
