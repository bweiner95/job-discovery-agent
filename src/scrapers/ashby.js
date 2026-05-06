// Ashby public job board API
// Endpoint: https://api.ashbyhq.com/posting-api/job-board/{slug}
// Find a company's Ashby slug at: https://jobs.ashbyhq.com/{slug}
//
// To add or remove companies, edit the COMPANIES array below.

const COMPANIES = [
  // Consumer marketplace / commerce
  'whatnot', 'faire', 'gopuff',

  // Consumer AI / creative / entertainment
  'suno', 'cursor', 'openai', 'anthropic', 'replit',
  'huggingface', 'perplexity',

  // Consumer fintech / payments
  'mercury', 'cash-app', 'ramp', 'gigs', 'kikoff',

  // Consumer social / content
  'substack', 'discord-corp',

  // Health / wellness consumer
  'ouraring', 'wholeproject', 'whoop',

  // Travel / mobility consumer
  'rippling',

  // Developer tools with consumer brand recognition
  'linear', 'posthog', 'vercel', 'browserbase',

  // High-growth consumer
  'decagon', 'nscale', 'sentilink', 'stepful',
  'crusoe', 'physicalintelligence',
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
  'business operations',
  'biz ops',
];

const ROLE_EXCLUSIONS = [
  'engineer', 'developer', 'designer', 'accountant', 'counsel',
  'recruiter', 'talent', 'data engineer', 'analyst i', 'analyst ii',
  'junior', 'associate analyst', 'engineering', 'sales development',
  'sdr ', 'bdr ', 'account executive', 'customer success',
];

const LOCATION_KEYWORDS = [
  'new york', 'los angeles', 'san francisco', 'bay area', 'remote',
  'nyc', 'sf ', 'ny,', 'ca,', 'oakland', 'mountain view', 'palo alto',
  'menlo park', 'san jose', 'culver city', 'santa monica',
];

function matchesRole(title = '') {
  const t = title.toLowerCase();
  if (ROLE_EXCLUSIONS.some((ex) => t.includes(ex))) return false;
  return ROLE_KEYWORDS.some((k) => t.includes(k));
}

function matchesLocation(location = '', secondaryLocations = [], isRemote = false) {
  if (isRemote) return true;
  const all = [location, ...(secondaryLocations || []).map(l => l.location || l)]
    .filter(Boolean)
    .map(s => String(s).toLowerCase());
  if (all.length === 0) return true; // no location info — include
  return all.some(l => LOCATION_KEYWORDS.some((k) => l.includes(k)));
}

function stripHtml(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchAshbyJobs(isFirstRun) {
  const jobs = [];
  const cutoff = isFirstRun ? null : new Date(Date.now() - 24 * 60 * 60 * 1_000);

  for (const slug of COMPANIES) {
    try {
      const res = await fetch(
        `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
        { headers: { Accept: 'application/json' } },
      );
      if (!res.ok) continue;

      const data = await res.json();
      const companyName = slug
        .split('-')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');

      for (const job of data.jobs || []) {
        if (job.isListed === false) continue;
        if (!matchesRole(job.title)) continue;
        if (!matchesLocation(job.location, job.secondaryLocations, job.isRemote)) continue;

        if (cutoff) {
          const publishedAt = new Date(job.publishedAt);
          if (publishedAt < cutoff) continue;
        }

        // Build location string: primary + secondary
        const locParts = [job.location].filter(Boolean);
        if (job.secondaryLocations?.length) {
          for (const sl of job.secondaryLocations) {
            const lstr = sl.location || sl;
            if (lstr) locParts.push(lstr);
          }
        }
        if (job.isRemote) locParts.push('Remote');

        jobs.push({
          source:      'ashby',
          job_id:      String(job.id),
          title:       job.title         || '',
          company:     companyName,
          location:    locParts.join(' · ') || '',
          url:         job.jobUrl         || '',
          external_url: job.applyUrl     || null,
          salary:      null,
          description: (job.descriptionPlain || stripHtml(job.descriptionHtml) || '').slice(0, 4000),
          posted_at:   job.publishedAt   || null,
        });
      }
    } catch {
      // Network errors or unexpected API shapes — skip silently
    }

    await sleep(250);
  }

  console.log(`  Ashby: ${jobs.length} matching jobs across ${COMPANIES.length} companies`);
  return jobs;
}
