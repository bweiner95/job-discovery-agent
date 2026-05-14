// Greenhouse public job boards API
// Queries a curated list of consumer-focused tech, DTC, retail, and travel companies.
// Each company's board is at: https://boards-api.greenhouse.io/v1/boards/{slug}/jobs
//
// To add or remove companies, edit the COMPANIES array below.
// Find a company's Greenhouse slug at: https://boards.greenhouse.io/{slug}

// Small generic fallback used only when src/candidate-profile.js doesn't
// export GREENHOUSE_COMPANIES (e.g., before setup runs). Edit your own
// list in src/candidate-profile.js, not here.
const FALLBACK_COMPANIES = [
  'airbnb', 'discord', 'stripe', 'doordash', 'pinterest',
];

let _companies = null;
async function getCompanies() {
  if (_companies) return _companies;
  try {
    const profile = await import('../candidate-profile.js');
    _companies = Array.isArray(profile.GREENHOUSE_COMPANIES) && profile.GREENHOUSE_COMPANIES.length
      ? profile.GREENHOUSE_COMPANIES
      : FALLBACK_COMPANIES;
  } catch {
    _companies = FALLBACK_COMPANIES;
  }
  return _companies;
}

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

export async function fetchGreenhouseJobs(cutoffOrFirstRun) {
  // Back-compat: callers may pass a boolean (legacy first-run flag) or a
  // Date/null (new style, computed via db.getScraperCutoff()). null/true
  // means "no cutoff, fetch all".
  const jobs = [];
  const cutoff = (cutoffOrFirstRun === true || cutoffOrFirstRun == null)
    ? null
    : (cutoffOrFirstRun instanceof Date ? cutoffOrFirstRun : new Date(cutoffOrFirstRun));

  const COMPANIES = await getCompanies();
  for (const slug of COMPANIES) {
    try {
      const res = await fetch(
        `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
        { headers: { Accept: 'application/json' } },
      );
      if (!res.ok) continue;

      const data = await res.json();
      const companyName = data.company?.name || slug;

      for (const job of data.jobs || []) {
        if (!matchesRole(job.title)) continue;
        if (!matchesLocation(job.location?.name)) continue;

        if (cutoff) {
          const updatedAt = new Date(job.updated_at);
          if (updatedAt < cutoff) continue;
        }

        jobs.push({
          source:      'greenhouse',
          job_id:      String(job.id),
          title:       job.title          || '',
          company:     companyName,
          location:    job.location?.name || '',
          url:         job.absolute_url   || '',
          salary:      null,
          description: job.content        || '',
          posted_at:   job.updated_at     || null,
        });
      }
    } catch {
      // Network errors or unexpected API shapes — skip silently
    }

    await sleep(250);
  }

  console.log(`  Greenhouse: ${jobs.length} matching jobs across ${COMPANIES.length} companies`);
  return jobs;
}
