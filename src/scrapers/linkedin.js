// LinkedIn guest jobs API — scrapes the public search endpoint (no auth required)
// NOTE: LinkedIn occasionally blocks automated requests. Failures are handled
// gracefully and the scraper will return empty results rather than crashing.

import { load } from 'cheerio';

const ROLE_QUERIES = [
  'Head of Growth',
  'VP Growth',
  'Director of Growth',
  'Director of Strategy',
  'Strategy Operations',
  'Head of Product Growth',
  'GTM Strategy',
  'Product Strategy',
];

const LOCATIONS = [
  'New York City Metropolitan Area',
  'Los Angeles Metropolitan Area',
  'San Francisco Bay Area',
];

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.linkedin.com/jobs/',
};

function extractJobId(url) {
  const match = url.match(/view\/(\d+)/);
  return match ? match[1] : null;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchSearchPage(keywords, location, isFirstRun) {
  const params = new URLSearchParams({
    keywords,
    location,
    start: '0',
    count: '25',
    f_E: '4,5,6',
  });
  if (!isFirstRun) {
    params.set('f_TPR', 'r86400');
  }

  const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function parseJobs(html) {
  const $ = load(html);
  const jobs = [];

  $('li').each((_, el) => {
    const $el = $(el);

    const link =
      $el.find('a.base-card__full-link').attr('href') ||
      $el.find('a[href*="/jobs/view/"]').first().attr('href') ||
      '';

    const cleanUrl = link.split('?')[0];
    if (!cleanUrl) return;

    const jobId = extractJobId(cleanUrl);
    if (!jobId) return;

    const title =
      $el.find('.base-search-card__title').text().trim() ||
      $el.find('[class*="job-card-list__title"]').text().trim() ||
      $el.find('h3').first().text().trim();

    if (!title) return;

    const company =
      $el.find('.base-search-card__subtitle').text().trim() ||
      $el.find('[class*="company"]').first().text().trim();

    const location =
      $el.find('.job-search-card__location').text().trim() ||
      $el.find('[class*="location"]').first().text().trim();

    const postedAtRaw =
      $el.find('time').attr('datetime') ||
      $el.find('[class*="date"]').first().text().trim();

    jobs.push({
      source:      'linkedin',
      job_id:      jobId,
      title,
      company,
      location,
      url:         cleanUrl,
      salary:      null,
      description: '',
      posted_at:   postedAtRaw || null,
    });
  });

  return jobs;
}

export async function fetchLinkedInJobs(isFirstRun) {
  const jobs = [];

  for (const keywords of ROLE_QUERIES) {
    for (const location of LOCATIONS) {
      try {
        const html = await fetchSearchPage(keywords, location, isFirstRun);
        const parsed = parseJobs(html);
        jobs.push(...parsed);
        console.log(`  LinkedIn: ${parsed.length} jobs for "${keywords}" in ${location}`);
      } catch (err) {
        console.warn(`LinkedIn scrape failed for "${keywords}" in ${location}: ${err.message}`);
      }
      await sleep(2_000 + Math.random() * 2_000);
    }
  }

  return jobs;
}
