/**
 * scripts/process-alirohde-email.js
 *
 * Parses an Ali Rohde Jobs weekly newsletter email body, extracts each
 * listing, resolves the Substack redirect links to real application
 * URLs, and inserts them into jobs.db with source='alirohde'.
 *
 * Input JSON (stdin):
 * {
 *   "subject": "Edition 255: Ali Rohde Jobs",
 *   "messageId": "19e090e017fcdbdf",
 *   "date": "2026-05-08",
 *   "body": "...plain text body of the email..."
 * }
 *
 * Output JSON (stdout):
 * { "edition": 255, "totalParsed": 47, "new": 32, "dupes": 15, "resolved": 47 }
 *
 * Listing line format (after a section header like "Chief of Staff roles:"):
 *   Title [substack-redirect-url], Company (industry, stage), Location
 * Some lines pack multiple titles at one company:
 *   Title A [url1], Title B [url2], Company (industry, stage), Location
 *
 * Notes:
 * - Listings are deduped across editions by (company, normalized-title).
 * - We follow each Substack redirect to capture the real apply URL as
 *   external_url. Fetched in parallel with a small concurrency cap.
 * - Cross-source dedup is applied at the end so a Notion BizOps role
 *   already found via Ashby/Greenhouse won't show up as a separate
 *   alirohde card.
 */

import { hasJob, insertJob, findCrossSourceDuplicate, markAsDuplicate, findJobBySourceAndJobId } from '../src/db.js';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function parseEdition(subject) {
  const m = (subject || '').match(/edition\s+(\d+)/i);
  return m ? Number(m[1]) : null;
}

function normalize(s) {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/**
 * Parse a single listing line.
 * Returns one or more { title, substackUrl, company, industryStage, location } records.
 */
function parseListingLine(line) {
  // Find all "Title [url]" pairs first
  const tokenRe = /(.+?)\s*\[(https?:\/\/[^\]]+)\]/g;
  const titlesAndUrls = [];
  let lastIdx = 0;
  let m;
  while ((m = tokenRe.exec(line)) !== null) {
    // m[1] is the title (may start with a stray ", " from a prior pair)
    const title = m[1].replace(/^,\s*/, '').trim();
    if (title) titlesAndUrls.push({ title, substackUrl: m[2] });
    lastIdx = tokenRe.lastIndex;
  }
  if (titlesAndUrls.length === 0) return [];

  // Everything after the last "]" is "Company (industry, stage), Location"
  const rest = line.slice(lastIdx).replace(/^,?\s*/, '').trim();
  // Match "Company (parens content), Location"
  const compMatch = rest.match(/^(.+?)\s*\(([^)]+)\)\s*(?:,\s*(.*))?$/);
  let company = '', industryStage = '', location = '';
  if (compMatch) {
    company = compMatch[1].trim();
    industryStage = compMatch[2].trim();
    location = (compMatch[3] || '').trim();
  } else {
    // Fall back: no parentheses
    const fallback = rest.split(',').map(s => s.trim());
    company = fallback[0] || '';
    location = fallback.slice(1).join(', ');
  }

  return titlesAndUrls.map(({ title, substackUrl }) => ({
    title,
    substackUrl,
    company,
    industryStage,
    location,
  }));
}

function parseBody(body) {
  // Split into non-empty lines, skip header, unsubscribe footer, etc.
  const lines = body.split(/\r?\n/).map(l => l.trim());
  const results = [];
  let inSection = false;
  for (const line of lines) {
    if (!line) continue;
    // Section headers end with ":" and have no link
    if (/^[A-Z][\w &/'-]+roles?:$/i.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    // Skip lines without a substack redirect link
    if (!/\[https?:\/\/substack\.com\/redirect/.test(line)) continue;
    results.push(...parseListingLine(line));
  }
  return results;
}

async function resolveRedirect(url, timeoutMs = 6000) {
  // Substack redirects respond 302 to the real URL when we don't follow.
  // Using redirect:'follow' + .url is simpler but slower (full GET).
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: ctl.signal,
      headers: { 'User-Agent': 'job-discovery-agent' },
    });
    clearTimeout(t);
    const loc = res.headers.get('location');
    if (loc) return loc;
    // No location header: try GET (some redirects don't expose Location on HEAD)
    const r2 = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctl.signal,
      headers: { 'User-Agent': 'job-discovery-agent' },
    });
    return r2.url || url;
  } catch {
    return url;
  }
}

async function resolveAll(items, concurrency = 8) {
  const out = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await resolveRedirect(items[i].substackUrl);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

async function main() {
  const raw = await readStdin();
  let input;
  try { input = JSON.parse(raw); }
  catch { process.stderr.write('ERROR: Could not parse JSON input\n'); process.exit(1); }

  const { subject = '', body = '', messageId = '', date = '' } = input;
  const edition = parseEdition(subject);
  if (!edition) {
    process.stderr.write('ERROR: Could not detect edition number in subject\n');
    process.exit(1);
  }

  const listings = parseBody(body);
  if (listings.length === 0) {
    process.stdout.write(JSON.stringify({ edition, totalParsed: 0, new: 0, dupes: 0, resolved: 0 }));
    return;
  }

  // Resolve substack redirects to actual application URLs
  const realUrls = await resolveAll(listings);

  let newCount = 0;
  let dupeCount = 0;
  let crossSourceDupes = 0;

  for (let i = 0; i < listings.length; i++) {
    const l = listings[i];
    const realUrl = realUrls[i];
    // Stable per-edition job id so dupes across runs collapse
    const job_id = `e${edition}-${normalize(l.company)}-${normalize(l.title)}`;

    if (hasJob('alirohde', job_id)) { dupeCount++; continue; }

    insertJob({
      source: 'alirohde',
      job_id,
      title: l.title,
      company: l.company,
      location: l.location || null,
      url: realUrl || l.substackUrl,
      external_url: realUrl || null,
      salary: null,
      description: l.industryStage ? `Industry/stage: ${l.industryStage}` : null,
      posted_at: date || null,
    });
    newCount++;

    // Cross-source dedup against existing canonical roles from other sources
    const canonical = findCrossSourceDuplicate({
      company: l.company,
      title: l.title,
      sourceToSkip: 'alirohde',
    });
    if (canonical) {
      const inserted = findJobBySourceAndJobId('alirohde', job_id);
      if (inserted) {
        markAsDuplicate(inserted.id, canonical.id);
        crossSourceDupes++;
      }
    }
  }

  process.stdout.write(JSON.stringify({
    edition,
    totalParsed: listings.length,
    new: newCount,
    dupes: dupeCount,
    crossSourceDupes,
    resolved: realUrls.filter(u => u && !u.includes('substack.com/redirect')).length,
  }));
}

main().catch(err => {
  process.stderr.write(`ERROR: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
