// Google Jobs via SerpAPI
// 4 query buckets × 3 locations = 12 API calls per run (~360/month on free tier)
//
// Customize SEARCH_QUERIES below to match your target titles.
// Customize LOCATIONS to match your preferred cities.

const SEARCH_QUERIES = [
  '"Head of Growth" OR "VP of Growth" OR "VP Growth" OR "Director of Growth" OR "Senior Director of Growth"',
  '"Director of Strategy" OR "Head of Strategy" OR "Strategy and Operations" OR "Strategy & Operations" OR "Head of Strategic Initiatives"',
  '"Head of User Growth" OR "Director of User Growth" OR "Head of Product Growth" OR "Product Strategy" OR "Product Growth"',
  '"GTM Strategy" OR "Growth Strategy" OR "Growth Strategy Manager" OR "Product Operations" OR "Chief of Staff"',
];

const LOCATIONS = [
  'New York, NY',
  'Los Angeles, CA',
  'San Francisco Bay Area, CA',
];

function buildUrl(query, location, isFirstRun) {
  const params = new URLSearchParams({
    engine:  'google_jobs',
    q:       query,
    location,
    api_key: process.env.SERPAPI_KEY,
    num:     '20',
  });
  if (!isFirstRun) {
    params.set('chips', 'date_posted:today');
  }
  return `https://serpapi.com/search.json?${params}`;
}

function normalizeJob(raw, locationFallback) {
  const ext = raw.detected_extensions || {};
  const applyUrl =
    raw.apply_options?.[0]?.link ||
    raw.related_links?.[0]?.link ||
    raw.apply_link ||
    '';

  return {
    source:      'serpapi',
    job_id:      raw.job_id || `${raw.company_name}_${raw.title}`.replace(/\s+/g, '_'),
    title:       raw.title        || '',
    company:     raw.company_name || '',
    location:    raw.location     || locationFallback,
    url:         applyUrl,
    salary:      ext.salary       || null,
    description: raw.description  || '',
    posted_at:   ext.posted_at    || null,
  };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchSerpApiJobs(isFirstRun) {
  if (!process.env.SERPAPI_KEY) {
    console.warn('SERPAPI_KEY not set — skipping Google Jobs source');
    return [];
  }

  const jobs = [];

  for (const query of SEARCH_QUERIES) {
    for (const location of LOCATIONS) {
      try {
        const url = buildUrl(query, location, isFirstRun);
        const res = await fetch(url);

        if (res.status === 429) {
          console.warn('SerpAPI rate limit hit — pausing 30 s');
          await sleep(30_000);
          continue;
        }
        if (!res.ok) {
          console.warn(`SerpAPI HTTP ${res.status} for "${query.slice(0, 50)}" in ${location}`);
          continue;
        }

        const data = await res.json();
        if (data.error) {
          console.warn(`SerpAPI error: ${data.error}`);
          continue;
        }

        const results = data.jobs_results || [];
        for (const raw of results) {
          jobs.push(normalizeJob(raw, location));
        }

        console.log(`  SerpAPI: ${results.length} jobs — "${query.slice(0, 50)}…" in ${location}`);
      } catch (err) {
        console.error(`SerpAPI fetch failed for "${query.slice(0, 50)}" in ${location}:`, err.message);
      }

      await sleep(1_200);
    }
  }

  return jobs;
}
