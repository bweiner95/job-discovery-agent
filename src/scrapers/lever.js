// Lever public postings API
// Endpoint: https://api.lever.co/v0/postings/{company}?mode=json
//
// To add or remove companies, edit the COMPANIES array below.
// The slug is usually the company's lowercase name as it appears in their Lever URL:
// https://jobs.lever.co/{slug}

const COMPANIES = [
  // Entertainment / streaming
  'netflix', 'spotify', 'hulu', 'patreon',

  // Social / dating / community
  'hinge', 'bumble', 'discord',

  // Consumer fintech
  'square', 'coinbase', 'brex', 'ramp', 'robinhood',
  'wealthsimple', 'dave',

  // Health & wellness consumer apps
  'noom', 'hims', 'ro', 'calm', 'headspace', 'duolingo',
  'strava', 'whoop', 'oura', 'flo',

  // Consumer SaaS / productivity with large user bases
  'figma', 'notion', 'airtable', 'loom', 'canva',

  // Analytics / data tools
  'amplitude', 'mixpanel',

  // Marketplace / commerce
  'faire', 'depop', 'stockx', 'goat', 'grailed',
  'thumbtack', 'taskrabbit',

  // Food / delivery / consumer
  'instacart', 'gopuff',

  // Travel
  'turo', 'getaround', 'hippo',

  // HR / workforce tools with consumer-facing products
  'gusto', 'lattice', 'deel',
];

const ROLE_KEYWORDS = [
  'growth',
  'strategy',
  'gtm',
  'go-to-market',
  'product operations',
  'strategic operations',
  'strategic initiatives',
  'chief of staff',
  'user acquisition',
];

const ROLE_EXCLUSIONS = [
  'engineer', 'developer', 'designer', 'accountant', 'counsel',
  'recruiter', 'talent', 'finance', 'data engineer', 'analyst i',
  'analyst ii', 'junior', 'associate analyst',
];

const LOCATION_KEYWORDS = [
  'new york', 'los angeles', 'san francisco', 'bay area', 'remote',
];

function matchesRole(title = '') {
  const t = title.toLowerCase();
  if (ROLE_EXCLUSIONS.some((ex) => t.includes(ex))) return false;
  return ROLE_KEYWORDS.some((k) => t.includes(k));
}

function matchesLocation(location = '') {
  if (!location) return true;
  const l = location.toLowerCase();
  return LOCATION_KEYWORDS.some((k) => l.includes(k));
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchLeverJobs(cutoffOrFirstRun) {
  const jobs = [];
  const cutoff = (cutoffOrFirstRun === true || cutoffOrFirstRun == null)
    ? null
    : (cutoffOrFirstRun instanceof Date ? cutoffOrFirstRun : new Date(cutoffOrFirstRun));

  for (const slug of COMPANIES) {
    try {
      const res = await fetch(
        `https://api.lever.co/v0/postings/${slug}?mode=json`,
        { headers: { Accept: 'application/json' } },
      );
      if (!res.ok) continue;

      const data = await res.json();
      if (!Array.isArray(data)) continue;

      for (const job of data) {
        if (!matchesRole(job.text)) continue;
        if (!matchesLocation(job.categories?.location)) continue;

        if (cutoff) {
          const createdAt = new Date(job.createdAt);
          if (createdAt < cutoff) continue;
        }

        jobs.push({
          source:      'lever',
          job_id:      job.id,
          title:       job.text                  || '',
          company:     job.company               || slug,
          location:    job.categories?.location  || '',
          url:         job.hostedUrl || job.applyUrl || '',
          salary:      null,
          description: job.descriptionBody || job.description || '',
          posted_at:   job.createdAt
            ? new Date(job.createdAt).toISOString()
            : null,
        });
      }
    } catch {
      // Skip silently — company not on Lever or API shape changed
    }

    await sleep(200);
  }

  console.log(`  Lever: ${jobs.length} matching jobs across ${COMPANIES.length} companies`);
  return jobs;
}
