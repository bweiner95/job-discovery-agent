/**
 * scripts/verify-slugs.js
 *
 * Verifies the company slugs in src/candidate-profile.js against each ATS's
 * public API and reports which are live (valid board) vs dead (404 / moved).
 *
 * ATS company lists rot over time — companies migrate between Greenhouse,
 * Lever, and Ashby, or change their slug. A dead slug isn't fatal (the
 * scraper skips it) but it wastes a request + 250ms per run. Run this
 * periodically (e.g. monthly) and prune dead slugs from candidate-profile.js.
 *
 * Usage:
 *   node scripts/verify-slugs.js          # check slugs in candidate-profile.js
 *   node scripts/verify-slugs.js --dead   # only print dead slugs (for pruning)
 *
 * Exit code is always 0 — this is an informational maintenance tool.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEAD_ONLY = process.argv.includes('--dead');

async function checkGreenhouse(slug) {
  try {
    const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { slug, ok: false };
    const d = await r.json();
    return { slug, ok: true, jobs: d.jobs?.length ?? 0 };
  } catch { return { slug, ok: false }; }
}
async function checkLever(slug) {
  try {
    const r = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { slug, ok: false };
    const d = await r.json();
    return { slug, ok: true, jobs: Array.isArray(d) ? d.length : 0 };
  } catch { return { slug, ok: false }; }
}
async function checkAshby(slug) {
  try {
    const r = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${slug}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { slug, ok: false };
    const d = await r.json();
    return { slug, ok: true, jobs: d.jobs?.length ?? 0 };
  } catch { return { slug, ok: false }; }
}

async function run(name, slugs, checkFn, concurrency = 12) {
  const uniq = [...new Set(slugs ?? [])];
  if (uniq.length === 0) { console.log(`\n=== ${name}: (none configured) ===`); return; }
  const results = [];
  let i = 0;
  async function worker() {
    while (i < uniq.length) {
      const slug = uniq[i++];
      results.push(await checkFn(slug));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const dead = results.filter(r => !r.ok).map(r => r.slug).sort();
  const live = results.filter(r => r.ok).sort((a, b) => a.slug.localeCompare(b.slug));
  console.log(`\n=== ${name}: ${live.length} live / ${dead.length} dead (of ${uniq.length}) ===`);
  if (DEAD_ONLY) {
    if (dead.length) console.log('DEAD (prune these): ' + dead.join(','));
  } else {
    if (dead.length) console.log('DEAD: ' + dead.join(','));
    const zero = live.filter(r => r.jobs === 0).map(r => r.slug);
    if (zero.length) console.log('LIVE but 0 jobs right now (keep): ' + zero.join(','));
  }
}

async function main() {
  let profile;
  try {
    profile = await import('../src/candidate-profile.js');
  } catch {
    console.error('Could not load src/candidate-profile.js — run setup first.');
    process.exit(0);
  }
  await run('GREENHOUSE', profile.GREENHOUSE_COMPANIES, checkGreenhouse);
  await run('LEVER',      profile.LEVER_COMPANIES,      checkLever);
  await run('ASHBY',      profile.ASHBY_COMPANIES,      checkAshby);
}

main().catch(() => process.exit(0));
