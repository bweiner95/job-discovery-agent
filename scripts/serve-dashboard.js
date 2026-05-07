/**
 * scripts/serve-dashboard.js
 *
 * Local HTTP dashboard for the job-discovery agent. Single-page, server-rendered.
 *
 * Tabs: Open Roles · Pipeline · Analytics · Applied · Not a Fit
 * Port: DASHBOARD_PORT env var, default 3033
 *
 * Design system: editorial / journal — warm cream palette, sage accent,
 * Tabler outline icons, serif italic reserved for title accent + Analytics
 * hero numerals + small qualifier italics.
 */

import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, accessSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JOBS_DB_PATH     = resolve(__dirname, '..', 'jobs.db');
const PIPELINE_DB_PATH = process.env.PIPELINE_DB_PATH || resolve(__dirname, '..', 'pipeline.db');
const PORT             = Number(process.env.DASHBOARD_PORT) || 3033;

// Resolve claude binary: env override → common install locations → PATH fallback
const CLAUDE_BIN = process.env.CLAUDE_BIN || (() => {
  const candidates = [
    `${process.env.HOME}/.local/bin/claude`,
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const p of candidates) {
    try { accessSync(p); return p; } catch {}
  }
  return 'claude';
})();

let activeRun = null;

// ─── DB helpers ───────────────────────────────────────────────────────────────

function openJobsDb() {
  try {
    const db = new DatabaseSync(JOBS_DB_PATH);
    try { db.exec(`ALTER TABLE jobs ADD COLUMN status TEXT DEFAULT 'active'`); } catch {}
    try { db.exec(`ALTER TABLE jobs ADD COLUMN not_fit_reason TEXT`); } catch {}
    try { db.exec(`ALTER TABLE jobs ADD COLUMN duplicate_of INTEGER`); } catch {}
    return db;
  } catch { return null; }
}

function openPipelineDb() {
  try { return new DatabaseSync(PIPELINE_DB_PATH); } catch { return null; }
}

function getJobs() {
  const db = openJobsDb();
  if (!db) return [];
  try {
    const rows = db.prepare(`
      SELECT * FROM jobs
      WHERE (status IS NULL OR status = 'active')
        AND duplicate_of IS NULL
      ORDER BY score DESC NULLS LAST, created_at DESC
    `).all();
    const jobIds = rows.map(r => r.id);
    if (jobIds.length) {
      const placeholders = jobIds.map(() => '?').join(',');
      const dupes = db.prepare(`SELECT duplicate_of, source FROM jobs WHERE duplicate_of IN (${placeholders})`).all(...jobIds);
      const sourceMap = {};
      for (const d of dupes) {
        sourceMap[d.duplicate_of] = sourceMap[d.duplicate_of] || [];
        sourceMap[d.duplicate_of].push(d.source);
      }
      for (const r of rows) r.also_on = sourceMap[r.id] || [];
    }
    db.close();
    return rows;
  } catch { return []; }
}

function getNotFitJobs() {
  const db = openJobsDb();
  if (!db) return [];
  try {
    const rows = db.prepare(`SELECT * FROM jobs WHERE status = 'not_fit' AND duplicate_of IS NULL ORDER BY created_at DESC`).all();
    db.close();
    return rows;
  } catch { return []; }
}

function getAppliedJobs() {
  const db = openJobsDb();
  if (!db) return [];
  try {
    const rows = db.prepare(`SELECT * FROM jobs WHERE status = 'applied' AND duplicate_of IS NULL ORDER BY score DESC NULLS LAST, created_at DESC`).all();
    db.close();
    return rows;
  } catch { return []; }
}

function getApplications() {
  const db = openPipelineDb();
  if (!db) return [];
  try {
    const rows = db.prepare(`SELECT * FROM applications ORDER BY last_activity_date DESC, created_at DESC`).all();
    db.close();
    return rows;
  } catch { return []; }
}

// ─── Pipeline dedupe (collapse same-role multi-thread + round-name entries) ──
function dedupeApplications(applications) {
  const STAGE_PRIORITY = {
    offer: 8, interview_follow_up: 7, take_home_submitted: 6,
    interview_scheduled: 5, recruiter_outreach: 4, application_viewed: 3,
    applied: 2, rejection: 1, unknown: 0,
  };
  const norm = s => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const ROUND_NAME_PATTERN = /^(builders|phone\s*screen|recruiter\s*screen|technical\s*screen|onsite|on\s*site|virtual|in\s*person|final\s*round|hiring\s*manager|behavioral|culture\s*fit)?\s*(interview|screen|round|panel|chat|conversation|call)?$/i;
  const isRoundName = role => !role || role.length < 4 || ROUND_NAME_PATTERN.test(role.trim());

  const groups = new Map();
  const realRoleAppsByCompany = new Map();
  const pickWinner = (a, b) => {
    const ap = STAGE_PRIORITY[a.current_status] ?? 0;
    const bp = STAGE_PRIORITY[b.current_status] ?? 0;
    if (bp > ap) return b;
    if (bp < ap) return a;
    return new Date(b.last_activity_date || 0) > new Date(a.last_activity_date || 0) ? b : a;
  };

  for (const app of applications) {
    const company = norm(app.company);
    const role = norm(app.role);
    if (!company) continue;
    if (isRoundName(app.role)) {
      const target = realRoleAppsByCompany.get(company);
      if (target) {
        const existing = groups.get(target.key);
        if (existing) { groups.set(target.key, pickWinner(existing, app)); continue; }
      }
      const key = `${company}::`;
      const existing = groups.get(key);
      groups.set(key, existing ? pickWinner(existing, app) : app);
    } else {
      const key = `${company}::${role}`;
      const existing = groups.get(key);
      groups.set(key, existing ? pickWinner(existing, app) : app);
      realRoleAppsByCompany.set(company, { ...app, key });
      const companyOnlyKey = `${company}::`;
      const stray = groups.get(companyOnlyKey);
      if (stray) {
        groups.set(key, pickWinner(groups.get(key), stray));
        groups.delete(companyOnlyKey);
      }
    }
  }
  return Array.from(groups.values());
}

function computeAnalytics(rawApplications) {
  const applications = dedupeApplications(rawApplications);
  const total = applications.length;
  if (total === 0) return null;

  const STAGES = ['applied', 'application_viewed', 'recruiter_outreach', 'interview_scheduled', 'take_home_submitted', 'interview_follow_up', 'offer'];
  const counts = Object.fromEntries(STAGES.map(s => [s, 0]));
  let rejections = 0;

  for (const a of applications) {
    if (a.current_status === 'rejection') { rejections++; counts['applied']++; continue; }
    const idx = STAGES.indexOf(a.current_status);
    if (idx >= 0) for (let i = 0; i <= idx; i++) counts[STAGES[i]]++;
  }

  const responded = applications.filter(a => !['applied', 'unknown'].includes(a.current_status)).length;
  const responseRate = total > 0 ? Math.round((responded / total) * 100) : 0;

  const responseTimes = [];
  for (const a of applications) {
    if (!a.date_applied || !a.last_activity_date) continue;
    if (['applied', 'unknown'].includes(a.current_status)) continue;
    const days = Math.floor((new Date(a.last_activity_date) - new Date(a.date_applied)) / 86400000);
    if (days >= 0 && days < 365) responseTimes.push(days);
  }
  const medianResponseDays = responseTimes.length
    ? Math.round(responseTimes.sort((a, b) => a - b)[Math.floor(responseTimes.length / 2)])
    : null;

  const now = new Date();
  const velocityWeeks = [];
  for (let w = 7; w >= 0; w--) {
    const weekEnd = new Date(now.getTime() - w * 7 * 86400000);
    const weekStart = new Date(weekEnd.getTime() - 7 * 86400000);
    const count = applications.filter(a => {
      if (!a.date_applied) return false;
      const d = new Date(a.date_applied);
      return d >= weekStart && d < weekEnd;
    }).length;
    velocityWeeks.push({
      label: weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      count,
    });
  }

  const companyMap = {};
  for (const a of applications) {
    if (!a.company) continue;
    const stage = ['offer', 'interview_follow_up', 'take_home_submitted', 'interview_scheduled'].includes(a.current_status) ? 'advanced'
                : a.current_status === 'rejection' ? 'rejected' : 'pending';
    companyMap[a.company] = companyMap[a.company] || { company: a.company, total: 0, advanced: 0, rejected: 0, pending: 0 };
    companyMap[a.company].total++;
    companyMap[a.company][stage]++;
  }
  const topCompanies = Object.values(companyMap)
    .sort((a, b) => b.total - a.total || b.advanced - a.advanced)
    .slice(0, 12);

  const coldCount = applications.filter(a => a.is_cold && !['offer', 'rejection'].includes(a.current_status)).length;
  const activeCount = applications.filter(a => !['offer', 'rejection'].includes(a.current_status)).length;
  const coldRate = activeCount > 0 ? Math.round((coldCount / activeCount) * 100) : 0;

  return { total, funnel: counts, rejections, responseRate, medianResponseDays, velocityWeeks, topCompanies, coldRate, coldCount, activeCount };
}

function updateJobStatus(id, status, reason = null) {
  const db = openJobsDb();
  if (!db) return false;
  try {
    if (status === 'not_fit' && reason) {
      db.prepare(`UPDATE jobs SET status = ?, not_fit_reason = ? WHERE id = ?`).run(status, reason, id);
    } else if (status !== 'not_fit') {
      db.prepare(`UPDATE jobs SET status = ?, not_fit_reason = NULL WHERE id = ?`).run(status, id);
    } else {
      db.prepare(`UPDATE jobs SET status = ? WHERE id = ?`).run(status, id);
    }
    db.close();
    return true;
  } catch { return false; }
}

// ─── View helpers ─────────────────────────────────────────────────────────────

function esc(s) {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Score tier per design spec: 8–10 strong (green), 7 medium (amber), ≤6 weak (neutral)
function scoreTier(score) {
  if (score == null) return 'none';
  if (score >= 8) return 'strong';
  if (score === 7) return 'medium';
  return 'weak';
}

function fmtDate(d) {
  if (!d) return '';
  try {
    const date = new Date(d);
    const diffDays = Math.floor((new Date() - date) / 86400000);
    if (diffDays === 0) return 'today';
    if (diffDays === 1) return 'yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch { return ''; }
}

function fmtUpdatedAt(d) {
  if (!d) return '';
  try {
    const date = new Date(d);
    const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const diffDays = Math.floor((new Date() - date) / 86400000);
    if (diffDays === 0) return `${time} today`;
    if (diffDays === 1) return `${time} yesterday`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + `, ${time}`;
  } catch { return ''; }
}

function sourceLabel(source) {
  return ({ greenhouse: 'Greenhouse', lever: 'Lever', linkedin: 'LinkedIn', serpapi: 'Google', ashby: 'Ashby' })[source] || source;
}

function applyUrl(job) {
  return job.external_url || job.url || '#';
}

function viewButtonLabel(source) {
  return ({ linkedin: 'View on LinkedIn', greenhouse: 'View on Greenhouse', lever: 'View on Lever', serpapi: 'View Job', ashby: 'View on Ashby' })[source] || 'View';
}

// Pipeline status metadata: section title + Tabler icon + color tier (token name)
const STATUS_META = {
  offer:               { icon: 'trophy',             label: 'Offer',                section: 'Offers',                 tier: 'interview' },
  interview_scheduled: { icon: 'calendar-event',     label: 'Interview',            section: 'Interviews',             tier: 'interview' },
  take_home_submitted: { icon: 'clipboard-list',     label: 'Assignment',           section: 'Case Study / Assignment', tier: 'interview' },
  interview_follow_up: { icon: 'rotate-clockwise-2', label: 'Follow-up',            section: 'Interview Follow-ups',   tier: 'followup' },
  recruiter_outreach:  { icon: 'megaphone',          label: 'Recruiter',            section: 'Recruiter Outreach',     tier: 'outreach' },
  application_viewed:  { icon: 'eye',                label: 'Viewed',               section: 'Application Viewed',     tier: 'viewed' },
  applied:             { icon: 'mail',               label: 'Applied',              section: 'Applied',                tier: 'viewed' },
  rejection:           { icon: 'circle-x',           label: 'Rejected',             section: 'Rejected',               tier: 'viewed' },
};

// Read first name from candidate-profile.js for the dashboard title
function getCandidateFirstName() {
  try {
    const text = readFileSync(resolve(__dirname, '..', 'src', 'candidate-profile.js'), 'utf8');
    const m = text.match(/CANDIDATE:\s+([^\n,]+)/);
    if (m) return m[1].trim().split(/\s+/)[0];
  } catch {}
  return 'My';
}
const CANDIDATE_FIRST_NAME = getCandidateFirstName();

// ─── Page render ──────────────────────────────────────────────────────────────

function renderPage(jobs, notFitJobs, appliedJobs, applications, analytics) {
  const total    = jobs.length;
  const scores   = jobs.map(j => j.score).filter(s => s != null);
  const avgScore = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : '—';
  const count8plus = jobs.filter(j => j.score >= 8).length;
  const count7     = jobs.filter(j => j.score === 7).length;
  const countLever      = jobs.filter(j => j.source === 'lever').length;
  const countLinkedIn   = jobs.filter(j => j.source === 'linkedin').length;
  const countGreenhouse = jobs.filter(j => j.source === 'greenhouse').length;
  const countAshby      = jobs.filter(j => j.source === 'ashby').length;

  const lastUpdatedRaw = (() => {
    const dates = jobs.map(j => j.created_at).filter(Boolean).sort().reverse();
    return dates[0] || null;
  })();
  const lastUpdated = lastUpdatedRaw ? fmtUpdatedAt(lastUpdatedRaw) : '';

  const STATUS_ORDER = ['offer', 'interview_scheduled', 'take_home_submitted', 'interview_follow_up', 'recruiter_outreach', 'application_viewed', 'applied', 'rejection'];
  const grouped = {};
  for (const s of STATUS_ORDER) grouped[s] = [];
  for (const a of applications) {
    const key = STATUS_META[a.current_status] ? a.current_status : 'applied';
    grouped[key].push(a);
  }

  // ── Job card markup ──────────────────────────────────────────────────────
  function jobCardHtml(job, options = {}) {
    const { dimmed = false, applied = false, restoreLabel = null, hideDismiss = false, clickable = true } = options;
    const score    = job.score;
    const url      = applyUrl(job);
    const hasUrl   = url && url !== '#';
    const reason   = (job.score_reason || '').trim();
    const dateStr  = fmtDate(job.created_at);
    const src      = job.source || '';
    const tier     = scoreTier(score);
    const alsoOn   = (job.also_on || []).filter(s => s);
    const classes  = ['job-card'];
    if (dimmed) classes.push('is-dimmed');
    if (applied) classes.push('is-applied');
    if (clickable) classes.push('is-clickable');

    const scoreBadge = score != null
      ? `<span class="score-badge tier-${tier}">${score}<span class="score-badge-suffix">/10</span></span>`
      : `<span class="score-badge tier-none">—</span>`;

    return `
<article class="${classes.join(' ')}" data-id="${job.id}" data-score="${score ?? 0}" data-source="${esc(src)}" data-date="${esc(job.created_at || '')}"${clickable ? ` onclick="openJdPanel(event, ${job.id})"` : ''}>
  <header class="card-header">
    ${scoreBadge}
    ${!hideDismiss && !applied ? `<button class="dismiss-btn" aria-label="Not a fit" onclick="event.stopPropagation();markNotFit(${job.id})"><i class="ti ti-x"></i></button>` : ''}
  </header>
  <h3 class="card-title">${esc(job.title || '')}</h3>
  <p class="card-company">${esc(job.company || '')}${alsoOn.length ? `<span class="also-on"> · also on ${alsoOn.map(s => sourceLabel(s)).join(', ')}</span>` : ''}</p>
  ${job.location ? `<div class="location-chip">${esc(job.location)}${job.salary ? ` · ${esc(job.salary)}` : ''}</div>` : (job.salary ? `<div class="location-chip">${esc(job.salary)}</div>` : '')}
  ${reason ? `<p class="card-description">${esc(reason)}</p>` : ''}
  ${job.not_fit_reason ? `<p class="card-feedback">"${esc(job.not_fit_reason)}"</p>` : ''}
  <footer class="card-footer">
    <span class="card-timestamp">${dateStr}</span>
    <div class="card-actions">
      ${restoreLabel
        ? `<button class="btn-secondary" onclick="event.stopPropagation();restoreJob(${job.id})">${esc(restoreLabel)}</button>`
        : `<button class="btn-secondary" onclick="event.stopPropagation();toggleApplied(this, ${job.id})">+ Applied</button>`}
      ${hasUrl ? `<a class="btn-accent-outline" href="${esc(url)}" target="_blank" onclick="event.stopPropagation()">${viewButtonLabel(src)}<i class="ti ti-external-link"></i></a>` : ''}
    </div>
  </footer>
</article>`;
  }

  const jobCards = jobs.map(j => jobCardHtml(j)).join('');
  const notFitCards = notFitJobs.length === 0
    ? `<div class="empty-state"><em>No jobs marked "Not a Fit" yet.</em></div>`
    : notFitJobs.map(j => jobCardHtml(j, { dimmed: true, hideDismiss: true, restoreLabel: '↩ Restore', clickable: false })).join('');
  const appliedCards = appliedJobs.length === 0
    ? `<div class="empty-state"><em>No jobs marked Applied yet.</em></div>`
    : appliedJobs.map(j => jobCardHtml(j, { applied: true, hideDismiss: true, restoreLabel: '↩ Unapply', clickable: false })).join('');

  // ── Pipeline section markup ───────────────────────────────────────────────
  const pipelineSections = STATUS_ORDER.flatMap(status => {
    const apps = grouped[status];
    if (!apps.length) return [];
    const m = STATUS_META[status];
    const rows = apps.map(app => {
      const isCold = app.is_cold && !['offer', 'rejection'].includes(status);
      return `
<div class="pipeline-row${isCold ? ' is-cold' : ''}">
  <div class="pipeline-row-company">${esc(app.company || '')}</div>
  <div class="pipeline-row-role">${app.role ? esc(app.role) : '<em class="role-missing">Role not captured</em>'}</div>
  <div class="pipeline-row-meta">
    ${isCold ? `<i class="ti ti-moon" aria-label="cold"></i>` : ''}
    <span class="pipeline-row-date">${fmtDate(app.last_activity_date)}</span>
  </div>
</div>`;
    }).join('');

    return [`
<section class="pipeline-section" onclick="toggleSection(this)">
  <header class="pipeline-section-header">
    <div class="ps-icon-wrap tier-${m.tier}"><i class="ti ti-${m.icon}"></i></div>
    <h2 class="ps-title">${esc(m.section)}</h2>
    <span class="ps-count tier-${m.tier}">${apps.length}</span>
    <i class="ti ti-chevron-down ps-chevron"></i>
  </header>
  <div class="pipeline-section-body" onclick="event.stopPropagation()">${rows}</div>
</section>`];
  }).join('');

  // ── Header (shared across all views) ──────────────────────────────────────
  const header = `
<header class="topbar">
  <div class="topbar-title">
    <h1>${esc(CANDIDATE_FIRST_NAME)}'s Job <em>Search</em></h1>
    ${lastUpdated ? `<p class="topbar-updated"><em>updated ${esc(lastUpdated)}</em></p>` : ''}
  </div>
  <div class="topbar-actions">
    <button class="run-btn" onclick="runAgent(this)" title="Fetch new jobs now">
      <i class="ti ti-refresh"></i><span>Refresh</span>
    </button>
    <div class="source-pills" role="tablist">
      <button class="source-pill is-active" data-source="all" onclick="filterSource('all',this)">All <span class="pill-count">${total}</span></button>
      <button class="source-pill" data-source="lever" onclick="filterSource('lever',this)">Lever <span class="pill-count">${countLever}</span></button>
      <button class="source-pill" data-source="linkedin" onclick="filterSource('linkedin',this)">LinkedIn <span class="pill-count">${countLinkedIn}</span></button>
      <button class="source-pill" data-source="greenhouse" onclick="filterSource('greenhouse',this)">Greenhouse <span class="pill-count">${countGreenhouse}</span></button>
      <button class="source-pill" data-source="ashby" onclick="filterSource('ashby',this)">Ashby <span class="pill-count">${countAshby}</span></button>
    </div>
  </div>
</header>`;

  const tabs = `
<nav class="tabs" role="tablist">
  <button class="tab is-active" role="tab" onclick="showTab('roles',this)">Open Roles<span class="tab-count">${total}</span></button>
  <button class="tab" role="tab" onclick="showTab('pipeline',this)">Pipeline<span class="tab-count">${applications.length}</span></button>
  <button class="tab" role="tab" onclick="showTab('analytics',this)">Analytics</button>
  <button class="tab" role="tab" onclick="showTab('applied',this)">Applied<span class="tab-count">${appliedJobs.length}</span></button>
  <button class="tab" role="tab" onclick="showTab('notfit',this)">Not a Fit<span class="tab-count">${notFitJobs.length}</span></button>
</nav>`;

  // ── Open Roles view ───────────────────────────────────────────────────────
  const openRolesView = `
<div id="tab-roles" class="tab-panel is-active">
  <div class="open-roles-stats">
    <div class="stat-card stat-neutral">
      <span class="stat-label">Avg Score</span>
      <span class="stat-value-sans">${avgScore}</span>
    </div>
    <div class="stat-card stat-strong stat-clickable" onclick="setScoreFilter('8')" role="button" tabindex="0">
      <span class="stat-label">Score 8–10</span>
      <span class="stat-value-sans">${count8plus}</span>
      <span class="stat-qualifier"><em>strong fits</em></span>
    </div>
    <div class="stat-card stat-medium stat-clickable" onclick="setScoreFilter('7')" role="button" tabindex="0">
      <span class="stat-label">Score 7</span>
      <span class="stat-value-sans">${count7}</span>
      <span class="stat-qualifier"><em>worth a look</em></span>
    </div>
  </div>

  <div class="filters-bar">
    <input class="search-input" type="text" placeholder="Search title, company, location…" oninput="applyFilters()" aria-label="Search">
    <select class="filter-select" onchange="applyFilters()" id="sort-select" aria-label="Sort">
      <option value="score">Highest Score</option>
      <option value="newest">Newest</option>
    </select>
    <select class="filter-select" onchange="applyFilters()" id="score-select" aria-label="Score filter">
      <option value="all" selected>All Scores</option>
      <option value="8">8–10</option>
      <option value="7">7 only</option>
      <option value="5">5–6</option>
      <option value="1">1–4</option>
    </select>
    <select class="filter-select" onchange="applyFilters()" id="loc-select" aria-label="Location filter">
      <option value="all">All Locations</option>
      <option value="new york">New York</option>
      <option value="los angeles">Los Angeles</option>
      <option value="san francisco">San Francisco</option>
      <option value="remote">Remote</option>
    </select>
    <span class="showing-count" id="showing-count"><em>showing ${total}</em></span>
  </div>

  <div class="card-grid" id="jobs-grid">
    ${jobCards}
    <div id="empty-state" class="empty-state" style="display:none;grid-column:1/-1">
      <em>No jobs match your filters.</em> <a href="#" onclick="resetFilters();return false;">Clear filters</a>
    </div>
  </div>
</div>`;

  // ── Pipeline view ─────────────────────────────────────────────────────────
  const pipelineView = `
<div id="tab-pipeline" class="tab-panel">
  <div class="pipeline-wrap">
    ${applications.length === 0
      ? `<div class="empty-state"><em>No pipeline data. Run /job-hunt to scan Gmail for application emails.</em></div>`
      : pipelineSections}
  </div>
</div>`;

  // ── Analytics view ────────────────────────────────────────────────────────
  const analyticsView = `
<div id="tab-analytics" class="tab-panel">
  ${analytics ? `
  <div class="analytics-wrap">
    <div class="analytics-stat-row">
      <div class="analytics-stat-card">
        <span class="stat-label">Total Applications</span>
        <span class="stat-value-serif">${analytics.total}</span>
        <span class="stat-sub"><em>${analytics.activeCount} active · ${analytics.rejections} rejected</em></span>
      </div>
      <div class="analytics-stat-card">
        <span class="stat-label">Response Rate</span>
        <span class="stat-value-serif">${analytics.responseRate}%</span>
        <span class="stat-sub"><em>apps that got past "applied"</em></span>
      </div>
      <div class="analytics-stat-card">
        <span class="stat-label">Median Response</span>
        <span class="stat-value-serif">${analytics.medianResponseDays !== null ? analytics.medianResponseDays + 'd' : '—'}</span>
        <span class="stat-sub"><em>days from apply to first reply</em></span>
      </div>
      <div class="analytics-stat-card">
        <span class="stat-label">Cold Rate</span>
        <span class="stat-value-serif">${analytics.coldRate}%</span>
        <span class="stat-sub"><em>${analytics.coldCount} of ${analytics.activeCount} active idle 14+ days</em></span>
      </div>
    </div>

    <section class="analytics-section">
      <h2>Conversion funnel</h2>
      ${(() => {
        const order = [
          ['applied', 'Applied'],
          ['application_viewed', 'Viewed by recruiter'],
          ['recruiter_outreach', 'Recruiter outreach'],
          ['interview_scheduled', 'Interview scheduled'],
          ['take_home_submitted', 'Take-home submitted'],
          ['interview_follow_up', 'Interview follow-up'],
          ['offer', 'Offer'],
        ];
        const max = analytics.funnel['applied'] || 1;
        return order.map(([k, label]) => {
          const n = analytics.funnel[k] || 0;
          const pct = (n / max) * 100;
          const conv = max > 0 ? ((n / max) * 100).toFixed(0) : 0;
          return `<div class="funnel-row">
            <span class="funnel-label">${label}</span>
            <div class="funnel-track"><div class="funnel-fill" style="width:${pct}%"></div></div>
            <span class="funnel-count">${n} · ${conv}%</span>
          </div>`;
        }).join('');
      })()}
    </section>

    <section class="analytics-section">
      <h2>Application velocity (last 8 weeks)</h2>
      <div class="velocity-grid">
        ${(() => {
          const max = Math.max(1, ...analytics.velocityWeeks.map(w => w.count));
          return analytics.velocityWeeks.map(w => {
            const h = (w.count / max) * 100;
            return `<div class="velocity-col">
              <span class="velocity-value">${w.count || ''}</span>
              <div class="velocity-bar" style="height:${Math.max(2, h)}%"></div>
              <span class="velocity-label">${esc(w.label)}</span>
            </div>`;
          }).join('');
        })()}
      </div>
    </section>

    <section class="analytics-section">
      <h2>Top companies</h2>
      <table class="companies-table">
        <thead><tr><th>Company</th><th>Total</th><th>Advanced</th><th>Pending</th><th>Rejected</th></tr></thead>
        <tbody>
          ${analytics.topCompanies.map(c => `<tr>
            <td>${esc(c.company)}</td>
            <td>${c.total}</td>
            <td>${c.advanced ? `<span class="status-pill tier-interview">${c.advanced}</span>` : '<span class="muted">—</span>'}</td>
            <td>${c.pending ? `<span class="status-pill tier-viewed">${c.pending}</span>` : '<span class="muted">—</span>'}</td>
            <td>${c.rejected ? `<span class="status-pill tier-outreach">${c.rejected}</span>` : '<span class="muted">—</span>'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </section>
  </div>
  ` : `<div class="empty-state"><em>No application data yet. Run the agent to scan Gmail.</em></div>`}
</div>`;

  // ── Final HTML ────────────────────────────────────────────────────────────
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(CANDIDATE_FIRST_NAME)}'s Job Search</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500&family=Source+Serif+Pro:ital,wght@0,400;0,500;1,400;1,500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.5.0/dist/tabler-icons.min.css">
<style>
/* ─── Design Tokens ───────────────────────────────────────────────────────── */
:root {
  /* Surfaces */
  --bg-page: #F2EDE0;
  --bg-card: #FAF6EC;
  --bg-card-hover: #F5F0E2;
  --bg-subtle: rgba(255, 255, 255, 0.55);

  /* Borders */
  --border-default: #C9C2AE;
  --border-subtle: #E8E2D2;

  /* Text */
  --text-primary: #2C2C2A;
  --text-secondary: #5F5E5A;
  --text-muted: #8B8980;
  --text-faint: #B4B2A9;

  /* Accent — sage green */
  --accent: #4A6B47;
  --accent-hover: #3D5A3B;
  --accent-text-on-light: #2C3D2A;
  --accent-bg-light: rgba(74, 107, 71, 0.10);
  --accent-bg-lighter: rgba(74, 107, 71, 0.05);

  /* Score tiers */
  --score-strong-bg: rgba(74, 107, 71, 0.14);
  --score-strong-text: #2C3D2A;
  --score-medium-bg: rgba(186, 117, 23, 0.10);
  --score-medium-text: #633806;
  --score-weak-bg: rgba(180, 178, 169, 0.22);
  --score-weak-text: #5F5E5A;

  /* Pipeline stage tints */
  --stage-interview-bg: rgba(74, 107, 71, 0.10);
  --stage-interview-text: #4A6B47;
  --stage-followup-bg: rgba(43, 95, 145, 0.08);
  --stage-followup-text: #2B5F91;
  --stage-outreach-bg: rgba(186, 117, 23, 0.10);
  --stage-outreach-text: #8B5A11;
  --stage-viewed-bg: rgba(180, 178, 169, 0.20);
  --stage-viewed-text: #5F5E5A;

  /* Type */
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-serif: 'Source Serif Pro', 'Iowan Old Style', Georgia, serif;

  /* Radii */
  --radius-pill: 999px;
  --radius-md: 8px;
  --radius-lg: 12px;

  /* Spacing scale */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
}

/* ─── Reset ──────────────────────────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
button { font: inherit; cursor: pointer; border: none; background: none; }
a { text-decoration: none; color: inherit; }
table { border-collapse: collapse; }

/* ─── Base ───────────────────────────────────────────────────────────────── */
body {
  font-family: var(--font-sans);
  font-size: 13px;
  line-height: 1.55;
  background: var(--bg-page);
  color: var(--text-primary);
  font-weight: 400;
  -webkit-font-smoothing: antialiased;
}

:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 4px;
}

i.ti { font-size: 16px; line-height: 1; color: currentColor; }

/* ─── Top bar ────────────────────────────────────────────────────────────── */
.topbar {
  padding: var(--space-6) var(--space-8) var(--space-4);
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}
.topbar-title h1 {
  font-family: var(--font-sans);
  font-size: 26px;
  font-weight: 500;
  letter-spacing: -0.015em;
  color: var(--text-primary);
  line-height: 1.2;
}
.topbar-title h1 em {
  font-family: var(--font-serif);
  font-style: italic;
  font-weight: 400;
  color: var(--accent);
}
.topbar-updated {
  font-family: var(--font-serif);
  font-style: italic;
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
}
.topbar-actions { display: flex; align-items: center; gap: var(--space-3); }
.run-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 12px;
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-pill);
  background: transparent;
  font-size: 12px;
  color: var(--text-primary);
  transition: all 150ms ease;
}
.run-btn:hover { border-color: var(--accent); color: var(--accent); }
.run-btn.running i { animation: spin 1s linear infinite; }
.run-btn.running { color: var(--accent); border-color: var(--accent); }
@keyframes spin { to { transform: rotate(360deg); } }

.source-pills { display: flex; gap: 6px; flex-wrap: wrap; }
.source-pill {
  padding: 6px 12px;
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-pill);
  background: transparent;
  font-size: 12px;
  font-weight: 400;
  color: var(--text-primary);
  transition: all 150ms ease;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.source-pill .pill-count { color: var(--text-muted); font-weight: 400; }
.source-pill:hover { border-color: var(--accent); }
.source-pill.is-active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.source-pill.is-active .pill-count { color: rgba(255,255,255,0.65); }

/* ─── Tabs ───────────────────────────────────────────────────────────────── */
.tabs {
  display: flex;
  gap: 28px;
  padding: 0 var(--space-8);
  border-bottom: 0.5px solid var(--border-default);
  margin-bottom: var(--space-6);
}
.tab {
  padding: 0 0 12px 0;
  font-size: 14px;
  color: var(--text-muted);
  border-bottom: 2px solid transparent;
  margin-bottom: -0.5px;
  transition: color 150ms ease, border-color 150ms ease;
  font-weight: 400;
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
}
.tab:hover { color: var(--text-primary); }
.tab.is-active {
  color: var(--text-primary);
  font-weight: 500;
  border-bottom-color: var(--accent);
}
.tab-count { color: var(--text-muted); font-weight: 400; opacity: 0.75; font-size: 12px; }
.tab.is-active .tab-count { opacity: 1; }

/* ─── Tab panels ─────────────────────────────────────────────────────────── */
.tab-panel { display: none; padding: 0 var(--space-8) var(--space-8); }
.tab-panel.is-active { display: block; }

/* ─── Open Roles: stat strip ─────────────────────────────────────────────── */
.open-roles-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-3);
  margin-bottom: var(--space-5);
  max-width: 800px;
}
.stat-card {
  padding: var(--space-4) 18px;
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.stat-card.stat-neutral { background: var(--bg-subtle); }
.stat-card.stat-strong  { background: var(--accent-bg-light); }
.stat-card.stat-medium  { background: var(--accent-bg-lighter); }
.stat-card.stat-clickable { cursor: pointer; transition: transform 120ms ease, background-color 120ms ease; }
.stat-card.stat-clickable:hover { background: var(--accent-bg-light); }
.stat-label {
  font-size: 11px;
  font-weight: 400;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
}
.stat-value-sans {
  font-family: var(--font-sans);
  font-size: 26px;
  font-weight: 500;
  color: var(--text-primary);
  letter-spacing: -0.015em;
  line-height: 1.1;
}
.stat-qualifier {
  font-family: var(--font-serif);
  font-size: 12px;
  font-style: italic;
  color: var(--text-muted);
}

/* ─── Filters bar ────────────────────────────────────────────────────────── */
.filters-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-5);
  flex-wrap: wrap;
}
.search-input,
.filter-select {
  height: 36px;
  padding: 0 12px;
  background: var(--bg-card);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-md);
  font-family: var(--font-sans);
  font-size: 13px;
  color: var(--text-primary);
  outline: none;
  transition: border-color 120ms ease;
}
.search-input { flex: 1; min-width: 220px; max-width: 380px; }
.search-input::placeholder { color: var(--text-faint); }
.search-input:focus, .filter-select:focus { border-color: var(--accent); }
.filter-select { cursor: pointer; padding-right: 28px; }
.showing-count {
  margin-left: auto;
  font-family: var(--font-serif);
  font-style: italic;
  font-size: 12px;
  color: var(--text-muted);
}

/* ─── Card grid ──────────────────────────────────────────────────────────── */
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 14px;
}

/* ─── Job card ───────────────────────────────────────────────────────────── */
.job-card {
  background: var(--bg-card);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-lg);
  padding: var(--space-4) 18px;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  transition: background-color 120ms ease, transform 120ms ease;
}
.job-card.is-clickable { cursor: pointer; }
.job-card.is-clickable:hover { background: var(--bg-card-hover); }
.job-card.is-dimmed { opacity: 0.7; }
.job-card.is-applied { background: var(--accent-bg-lighter); border-color: rgba(74,107,71,0.25); }
.card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-2);
}
.dismiss-btn {
  width: 22px; height: 22px;
  border-radius: 50%;
  color: var(--text-faint);
  display: inline-flex; align-items: center; justify-content: center;
  transition: all 120ms ease;
  flex-shrink: 0;
}
.dismiss-btn i { font-size: 12px; }
.dismiss-btn:hover { background: var(--accent-bg-light); color: var(--text-secondary); }

.score-badge {
  display: inline-flex;
  align-items: baseline;
  gap: 1px;
  padding: 4px 11px;
  border-radius: var(--radius-pill);
  font-family: var(--font-sans);
  font-size: 14px;
  font-weight: 500;
  line-height: 1;
}
.score-badge.tier-strong { background: var(--score-strong-bg); color: var(--score-strong-text); }
.score-badge.tier-medium { background: var(--score-medium-bg); color: var(--score-medium-text); }
.score-badge.tier-weak   { background: var(--score-weak-bg);   color: var(--score-weak-text); }
.score-badge.tier-none   { background: var(--score-weak-bg);   color: var(--text-muted); }
.score-badge-suffix { font-size: 11px; opacity: 0.55; font-weight: 400; }

.card-title {
  font-family: var(--font-sans);
  font-size: 15px;
  font-weight: 500;
  line-height: 1.3;
  color: var(--text-primary);
}
.card-company {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
}
.card-company .also-on {
  font-weight: 400;
  color: var(--text-muted);
}
.location-chip {
  display: inline-flex;
  width: max-content;
  max-width: 100%;
  padding: 2px 8px;
  background: rgba(0, 0, 0, 0.035);
  color: var(--text-secondary);
  font-size: 11px;
  border-radius: var(--radius-pill);
}
.card-description {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.55;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-feedback {
  font-family: var(--font-serif);
  font-style: italic;
  font-size: 12px;
  color: var(--text-muted);
}
.card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding-top: 10px;
  border-top: 0.5px solid var(--border-subtle);
  margin-top: 2px;
}
.card-timestamp {
  font-family: var(--font-serif);
  font-style: italic;
  font-size: 11px;
  color: var(--text-muted);
}
.card-actions { display: inline-flex; gap: 6px; align-items: center; }

.btn-secondary,
.btn-accent-outline {
  padding: 5px 10px;
  border-radius: var(--radius-pill);
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  transition: all 120ms ease;
}
.btn-secondary {
  background: transparent;
  border: 0.5px solid var(--border-default);
  color: var(--text-secondary);
}
.btn-secondary:hover { border-color: var(--text-secondary); color: var(--text-primary); }
.btn-accent-outline {
  background: transparent;
  border: 0.5px solid var(--accent);
  color: var(--accent);
}
.btn-accent-outline:hover { background: var(--accent-bg-light); color: var(--accent-hover); border-color: var(--accent-hover); }
.btn-accent-outline i { font-size: 13px; margin-left: 1px; }

/* ─── Empty state ────────────────────────────────────────────────────────── */
.empty-state {
  text-align: center;
  padding: 64px var(--space-4);
  color: var(--text-muted);
  font-family: var(--font-serif);
  font-size: 14px;
}
.empty-state em { font-style: italic; }
.empty-state a { color: var(--accent); text-decoration: underline; }

/* ─── Pipeline ───────────────────────────────────────────────────────────── */
.pipeline-wrap {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-width: 1000px;
}
.pipeline-section {
  background: var(--bg-card);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-lg);
  overflow: hidden;
  cursor: pointer;
  transition: background-color 120ms ease;
}
.pipeline-section:hover { background: var(--bg-card-hover); }
.pipeline-section-header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5);
  height: 56px;
}
.ps-icon-wrap {
  width: 32px; height: 32px;
  border-radius: var(--radius-md);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.ps-icon-wrap i { font-size: 18px; }
.ps-icon-wrap.tier-interview { background: var(--stage-interview-bg); color: var(--stage-interview-text); }
.ps-icon-wrap.tier-followup  { background: var(--stage-followup-bg);  color: var(--stage-followup-text);  }
.ps-icon-wrap.tier-outreach  { background: var(--stage-outreach-bg);  color: var(--stage-outreach-text);  }
.ps-icon-wrap.tier-viewed    { background: var(--stage-viewed-bg);    color: var(--stage-viewed-text);    }

.ps-title {
  flex: 1;
  font-family: var(--font-sans);
  font-size: 16px;
  font-weight: 500;
  color: var(--text-primary);
}
.ps-count {
  display: inline-flex;
  align-items: center;
  padding: 2px 10px;
  border-radius: var(--radius-pill);
  font-size: 13px;
  font-weight: 500;
}
.ps-count.tier-interview { background: var(--stage-interview-bg); color: var(--stage-interview-text); }
.ps-count.tier-followup  { background: var(--stage-followup-bg);  color: var(--stage-followup-text);  }
.ps-count.tier-outreach  { background: var(--stage-outreach-bg);  color: var(--stage-outreach-text);  }
.ps-count.tier-viewed    { background: var(--stage-viewed-bg);    color: var(--stage-viewed-text);    }

.ps-chevron {
  color: var(--text-muted);
  transition: transform 200ms ease;
  font-size: 16px;
}
.pipeline-section.is-collapsed .ps-chevron { transform: rotate(-90deg); }
.pipeline-section.is-collapsed .pipeline-section-body { display: none; }
.pipeline-section-body {
  border-top: 0.5px solid var(--border-subtle);
  cursor: default;
}
.pipeline-row {
  display: grid;
  grid-template-columns: minmax(140px, 1.2fr) minmax(0, 2fr) auto;
  gap: var(--space-4);
  align-items: center;
  padding: 12px var(--space-5);
  border-top: 0.5px solid var(--border-subtle);
  font-size: 13px;
}
.pipeline-row:first-child { border-top: 0; }
.pipeline-row.is-cold { opacity: 0.55; }
.pipeline-row-company { font-weight: 500; color: var(--text-primary); }
.pipeline-row-role { color: var(--text-secondary); }
.pipeline-row-role .role-missing {
  font-family: var(--font-serif);
  font-style: italic;
  color: var(--text-faint);
  font-weight: 400;
}
.pipeline-row-meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
}
.pipeline-row-meta i { font-size: 14px; color: var(--text-muted); }
.pipeline-row-date {
  font-family: var(--font-serif);
  font-style: italic;
  font-size: 12px;
}

/* ─── Analytics ──────────────────────────────────────────────────────────── */
.analytics-wrap {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  max-width: 1100px;
}
.analytics-stat-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-3);
}
.analytics-stat-card {
  background: var(--bg-card);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-lg);
  padding: var(--space-5) var(--space-6);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.stat-value-serif {
  font-family: var(--font-serif);
  font-size: 36px;
  font-weight: 500;
  color: var(--text-primary);
  letter-spacing: -0.015em;
  line-height: 1;
}
.stat-sub {
  font-family: var(--font-serif);
  font-style: italic;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.4;
}

.analytics-section {
  background: var(--bg-card);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-lg);
  padding: var(--space-5) var(--space-6);
}
.analytics-section h2 {
  font-family: var(--font-sans);
  font-size: 16px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: var(--space-4);
}
.funnel-row {
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr) 88px;
  align-items: center;
  gap: var(--space-3);
  margin: var(--space-4) 0;
  font-size: 13px;
}
.funnel-row:first-of-type { margin-top: 0; }
.funnel-row:last-of-type { margin-bottom: 0; }
.funnel-label { color: var(--text-secondary); }
.funnel-track {
  height: 8px;
  background: var(--bg-page);
  border-radius: var(--radius-pill);
  overflow: hidden;
  max-width: 600px;
}
.funnel-fill {
  height: 100%;
  background: var(--accent);
  border-radius: var(--radius-pill);
  transition: width 400ms ease;
}
.funnel-count {
  text-align: right;
  color: var(--text-secondary);
  font-size: 13px;
}

.velocity-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: var(--space-2);
  align-items: end;
  height: 160px;
  padding-top: 12px;
  border-bottom: 0.5px solid var(--border-subtle);
}
.velocity-col {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: center;
  gap: 4px;
  height: 100%;
  padding-bottom: 4px;
}
.velocity-bar {
  background: var(--accent);
  border-radius: 4px 4px 0 0;
  width: 70%;
  min-height: 2px;
  transition: height 400ms ease;
}
.velocity-value {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-primary);
}
.velocity-label {
  font-family: var(--font-serif);
  font-style: italic;
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
}

.companies-table { width: 100%; font-size: 13px; }
.companies-table th {
  text-align: left;
  padding: 8px 10px;
  font-size: 11px;
  font-weight: 400;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
  border-bottom: 0.5px solid var(--border-default);
}
.companies-table td {
  padding: 10px;
  border-bottom: 0.5px solid var(--border-subtle);
  color: var(--text-primary);
}
.companies-table tr:last-child td { border-bottom: 0; }
.companies-table td:first-child { font-weight: 500; }
.companies-table .muted { color: var(--text-faint); }

.status-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 10px;
  border-radius: var(--radius-pill);
  font-size: 12px;
  font-weight: 500;
}
.status-pill.tier-interview { background: var(--stage-interview-bg); color: var(--stage-interview-text); }
.status-pill.tier-viewed    { background: var(--stage-viewed-bg);    color: var(--stage-viewed-text);    }
.status-pill.tier-outreach  { background: var(--stage-outreach-bg);  color: var(--stage-outreach-text);  }

/* ─── JD preview side panel ──────────────────────────────────────────────── */
#jd-overlay {
  position: fixed; inset: 0;
  background: rgba(44, 44, 42, 0.20);
  opacity: 0;
  pointer-events: none;
  transition: opacity 200ms ease;
  z-index: 140;
}
#jd-overlay.is-open { opacity: 1; pointer-events: auto; }
#jd-panel {
  position: fixed;
  top: 0; right: 0;
  height: 100vh;
  width: 560px;
  max-width: 92vw;
  background: var(--bg-card);
  border-left: 0.5px solid var(--border-default);
  transform: translateX(100%);
  transition: transform 280ms cubic-bezier(.4,0,.2,1);
  z-index: 150;
  display: flex;
  flex-direction: column;
}
#jd-panel.is-open { transform: translateX(0); }
#jd-header {
  padding: var(--space-5) var(--space-6) var(--space-3);
  border-bottom: 0.5px solid var(--border-subtle);
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
}
#jd-header h2 {
  font-family: var(--font-sans);
  font-size: 20px;
  font-weight: 500;
  color: var(--text-primary);
  letter-spacing: -0.015em;
  line-height: 1.3;
  margin-bottom: 4px;
}
.jd-company {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 8px;
}
.jd-meta { display: flex; flex-wrap: wrap; gap: 6px; }
.jd-also-on {
  font-family: var(--font-serif);
  font-style: italic;
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 6px;
}
#jd-close {
  width: 30px; height: 30px;
  border-radius: 50%;
  background: var(--accent-bg-lighter);
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all 120ms ease;
}
#jd-close:hover { background: var(--accent-bg-light); color: var(--text-primary); }
#jd-score-row {
  padding: var(--space-3) var(--space-6);
  background: var(--bg-card-hover);
  border-bottom: 0.5px solid var(--border-subtle);
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  font-size: 12px;
}
#jd-score-reason {
  font-family: var(--font-serif);
  font-style: italic;
  color: var(--text-secondary);
  line-height: 1.5;
}
#jd-body { flex: 1; overflow-y: auto; padding: var(--space-5) var(--space-6); }
#jd-body h4 {
  font-size: 11px;
  font-weight: 400;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
  margin-bottom: var(--space-2);
}
#jd-description {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}
.jd-description-empty {
  font-family: var(--font-serif);
  font-style: italic;
  font-size: 13px;
  color: var(--text-muted);
  padding: var(--space-4);
  text-align: center;
  background: var(--bg-page);
  border-radius: var(--radius-md);
}
#jd-footer {
  padding: var(--space-3) var(--space-6);
  border-top: 0.5px solid var(--border-subtle);
  display: flex;
  gap: 8px;
}
#jd-footer .btn-accent-outline,
#jd-footer .btn-secondary { padding: 8px 14px; font-size: 13px; }
.jd-btn-dismiss { margin-left: auto; }

/* Score chips inside JD panel meta row */
.jd-meta .source-pill { padding: 3px 10px; font-size: 11px; }
.jd-meta .score-badge { padding: 3px 10px; font-size: 12px; }
.jd-meta .location-chip { font-size: 11px; }

/* ─── Not-a-fit modal ────────────────────────────────────────────────────── */
#nf-overlay {
  position: fixed; inset: 0;
  background: rgba(44, 44, 42, 0.4);
  display: none;
  align-items: center;
  justify-content: center;
  z-index: 200;
  backdrop-filter: blur(2px);
}
#nf-overlay.is-open { display: flex; }
#nf-modal {
  background: var(--bg-card);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-lg);
  padding: var(--space-6);
  max-width: 480px;
  width: 90%;
  animation: nf-pop 180ms cubic-bezier(.4,0,.2,1);
}
@keyframes nf-pop {
  from { opacity: 0; transform: scale(.97) translateY(8px); }
  to   { opacity: 1; transform: scale(1) translateY(0); }
}
#nf-modal h3 {
  font-family: var(--font-sans);
  font-size: 18px;
  font-weight: 500;
  color: var(--text-primary);
  letter-spacing: -0.015em;
  margin-bottom: 4px;
}
.nf-job {
  font-family: var(--font-serif);
  font-style: italic;
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: var(--space-4);
}
#nf-modal label {
  font-size: 11px;
  font-weight: 400;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
  margin-bottom: 6px;
  display: block;
}
#nf-modal textarea {
  width: 100%;
  padding: 10px 12px;
  background: var(--bg-page);
  border: 0.5px solid var(--border-default);
  border-radius: var(--radius-md);
  font-family: var(--font-sans);
  font-size: 13px;
  line-height: 1.5;
  resize: vertical;
  min-height: 80px;
  color: var(--text-primary);
  outline: none;
  transition: border-color 120ms ease;
}
#nf-modal textarea:focus { border-color: var(--accent); background: var(--bg-card); }
#nf-modal textarea::placeholder { color: var(--text-faint); }
.nf-hint {
  font-family: var(--font-serif);
  font-style: italic;
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 6px;
}
.nf-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: var(--space-4);
}
#nf-modal .btn-secondary,
#nf-modal .btn-accent-outline { padding: 8px 14px; font-size: 13px; }
#nf-modal .nf-save { background: var(--accent); color: #fff; border: 0.5px solid var(--accent); }
#nf-modal .nf-save:hover { background: var(--accent-hover); border-color: var(--accent-hover); }

/* ─── Log drawer ─────────────────────────────────────────────────────────── */
#log-drawer {
  position: fixed; bottom: 0; left: 0; right: 0;
  height: 340px;
  background: #1F1E1B;
  border-top: 0.5px solid var(--accent);
  transform: translateY(100%);
  transition: transform 280ms cubic-bezier(.4,0,.2,1);
  z-index: 100;
  display: flex;
  flex-direction: column;
}
#log-drawer.is-open { transform: translateY(0); }
#log-drawer-header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-5);
  border-bottom: 0.5px solid #2E2C29;
  flex-shrink: 0;
}
#log-drawer-title {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  color: #C8C2BA;
  font-family: var(--font-sans);
}
#log-drawer-status {
  font-family: var(--font-serif);
  font-style: italic;
  font-size: 11px;
  color: var(--accent);
}
#log-drawer-close {
  width: 26px; height: 26px;
  color: var(--text-muted);
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
#log-drawer-close:hover { background: #2E2C29; color: #C8C2BA; }
#log-output {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-3) var(--space-5);
  font-family: 'SF Mono', 'Fira Code', 'Menlo', monospace;
  font-size: 11.5px;
  line-height: 1.7;
  color: #C8C2BA;
  word-break: break-word;
  white-space: pre-wrap;
}
#log-output .log-line-tool { color: #8EBFB0; }
#log-output .log-line-done { color: #A8D5A2; font-weight: 500; }
#log-output .log-line-err  { color: #E8A090; }
#log-progress { height: 3px; background: #2E2C29; flex-shrink: 0; }
#log-progress-bar {
  height: 100%;
  background: var(--accent);
  width: 0%;
  transition: width 600ms ease;
}
#log-progress-bar.indeterminate {
  animation: progress-slide 1.4s infinite linear;
  width: 30%;
}
@keyframes progress-slide {
  0%   { transform: translateX(-200%); }
  100% { transform: translateX(400%); }
}
</style>
</head>
<body>

${header}
${tabs}

${openRolesView}
${pipelineView}
${analyticsView}

<div id="tab-applied" class="tab-panel">
  <div class="card-grid">${appliedCards}</div>
</div>

<div id="tab-notfit" class="tab-panel">
  <div class="card-grid">${notFitCards}</div>
</div>

<!-- JD preview side panel -->
<div id="jd-overlay" onclick="closeJdPanel()"></div>
<aside id="jd-panel" role="dialog" aria-modal="true" aria-labelledby="jd-title">
  <header id="jd-header">
    <div style="flex:1;min-width:0">
      <h2 id="jd-title">—</h2>
      <div class="jd-company" id="jd-company"></div>
      <div class="jd-meta" id="jd-meta"></div>
      <div class="jd-also-on" id="jd-also-on"></div>
    </div>
    <button id="jd-close" onclick="closeJdPanel()" aria-label="Close"><i class="ti ti-x"></i></button>
  </header>
  <div id="jd-score-row" style="display:none">
    <span id="jd-score-badge" class="score-badge"></span>
    <div id="jd-score-reason"></div>
  </div>
  <div id="jd-body">
    <h4>Description</h4>
    <div id="jd-description"></div>
  </div>
  <footer id="jd-footer">
    <a id="jd-btn-apply" class="btn-accent-outline" href="#" target="_blank">Apply<i class="ti ti-external-link"></i></a>
    <button class="btn-secondary" onclick="markAppliedFromPanel()">+ Mark Applied</button>
    <button class="btn-secondary jd-btn-dismiss" onclick="dismissFromPanel()"><i class="ti ti-x"></i> Not a Fit</button>
  </footer>
</aside>

<!-- Not-a-fit feedback modal -->
<div id="nf-overlay" onclick="if(event.target===this)closeNfModal()">
  <div id="nf-modal" role="dialog" aria-modal="true">
    <h3>Why isn't this a fit?</h3>
    <div class="nf-job" id="nf-job-label"></div>
    <label for="nf-reason">Feedback (optional)</label>
    <textarea id="nf-reason" placeholder="e.g. wrong industry, too junior, location not viable…"></textarea>
    <div class="nf-hint">Your feedback is included in future scoring runs to refine which roles get suggested.</div>
    <div class="nf-actions">
      <button class="btn-secondary" onclick="closeNfModal()">Cancel</button>
      <button class="btn-secondary" onclick="submitNfModal(true)">Skip & Dismiss</button>
      <button class="btn-secondary nf-save" onclick="submitNfModal(false)">Save & Dismiss</button>
    </div>
  </div>
</div>

<!-- Log drawer -->
<div id="log-drawer">
  <div id="log-progress"><div id="log-progress-bar" class="indeterminate" style="display:none"></div></div>
  <div id="log-drawer-header">
    <span id="log-drawer-title">Running /job-hunt…</span>
    <span id="log-drawer-status"></span>
    <button id="log-drawer-close" onclick="closeLogDrawer()" title="Close"><i class="ti ti-x"></i></button>
  </div>
  <div id="log-output"></div>
</div>

<script>
let activeSource = 'all';
const SOURCE_LABELS = { greenhouse: 'Greenhouse', lever: 'Lever', linkedin: 'LinkedIn', serpapi: 'Google', ashby: 'Ashby' };
function escapeHtml(s) { return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function scoreTier(s) { if (s == null) return 'none'; if (s >= 8) return 'strong'; if (s === 7) return 'medium'; return 'weak'; }

document.addEventListener('DOMContentLoaded', () => applyFilters());

// ─── Tabs ──────────────────────────────────────────────────────────────────
function showTab(name, el) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('is-active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('is-active'));
  document.getElementById('tab-' + name).classList.add('is-active');
  if (el) el.classList.add('is-active');
}

// ─── Source filter ─────────────────────────────────────────────────────────
function filterSource(src, btn) {
  activeSource = src;
  document.querySelectorAll('.source-pill').forEach(b => b.classList.remove('is-active'));
  if (btn) btn.classList.add('is-active');
  applyFilters();
}

// ─── Score filter from stat-strip click ────────────────────────────────────
function setScoreFilter(val) {
  document.getElementById('score-select').value = val;
  applyFilters();
}

function resetFilters() {
  document.querySelector('.search-input').value = '';
  document.getElementById('score-select').value = 'all';
  document.getElementById('loc-select').value = 'all';
  document.getElementById('sort-select').value = 'score';
  activeSource = 'all';
  document.querySelectorAll('.source-pill').forEach((b, i) => b.classList.toggle('is-active', i === 0));
  applyFilters();
}

// ─── Open Roles filtering ──────────────────────────────────────────────────
function applyFilters() {
  const q        = document.querySelector('.search-input')?.value.toLowerCase() ?? '';
  const scoreMin = document.getElementById('score-select')?.value ?? 'all';
  const loc      = document.getElementById('loc-select')?.value ?? 'all';
  const sortBy   = document.getElementById('sort-select')?.value ?? 'score';

  const grid = document.getElementById('jobs-grid');
  if (!grid) return;
  const cards = Array.from(grid.querySelectorAll('.job-card'));
  const empty = document.getElementById('empty-state');

  let shown = 0;
  cards.forEach(card => {
    const score = Number(card.dataset.score);
    const src   = card.dataset.source;
    const text  = card.innerText.toLowerCase();
    let ok = true;
    if (activeSource !== 'all' && src !== activeSource) ok = false;
    if (q && !text.includes(q)) ok = false;
    if (scoreMin !== 'all') {
      const min = Number(scoreMin);
      if (min === 8) { if (score < 8) ok = false; }
      else if (min === 7) { if (score !== 7) ok = false; }
      else if (min === 5) { if (score < 5 || score > 6) ok = false; }
      else if (min === 1) { if (score < 1 || score > 4) ok = false; }
    }
    if (loc !== 'all' && !text.includes(loc)) ok = false;
    card.style.display = ok ? '' : 'none';
    if (ok) shown++;
  });

  const sorted = [...cards].sort((a, b) => {
    if (sortBy === 'newest') return (b.dataset.date || '').localeCompare(a.dataset.date || '');
    const diff = Number(b.dataset.score) - Number(a.dataset.score);
    return diff !== 0 ? diff : (b.dataset.date || '').localeCompare(a.dataset.date || '');
  });
  sorted.forEach(card => grid.appendChild(card));

  const sc = document.getElementById('showing-count');
  if (sc) sc.innerHTML = '<em>showing ' + shown + '</em>';
  if (empty) empty.style.display = shown === 0 ? '' : 'none';
}

// ─── Job actions ───────────────────────────────────────────────────────────
let _nfPendingId = null;

function markNotFit(id) {
  _nfPendingId = id;
  const card = document.querySelector('[data-id="' + id + '"]');
  const title = card?.querySelector('.card-title')?.textContent || '';
  const company = card?.querySelector('.card-company')?.textContent || '';
  document.getElementById('nf-job-label').textContent = (title && company) ? (title + ' — ' + company) : '';
  document.getElementById('nf-reason').value = '';
  document.getElementById('nf-overlay').classList.add('is-open');
  setTimeout(() => document.getElementById('nf-reason').focus(), 50);
}
function closeNfModal() {
  document.getElementById('nf-overlay').classList.remove('is-open');
  _nfPendingId = null;
}
function submitNfModal(skip) {
  const id = _nfPendingId;
  if (!id) return closeNfModal();
  const reason = skip ? '' : document.getElementById('nf-reason').value.trim();
  fetch('/api/jobs/' + id + '/notfit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  }).then(() => {
    closeNfModal();
    const card = document.querySelector('[data-id="' + id + '"]');
    if (card) {
      card.style.transition = 'opacity 200ms';
      card.style.opacity = '0';
      setTimeout(() => { card.remove(); applyFilters(); }, 200);
    }
  });
}

document.addEventListener('keydown', e => {
  if (document.getElementById('nf-overlay').classList.contains('is-open')) {
    if (e.key === 'Escape') closeNfModal();
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submitNfModal(false);
    return;
  }
  if (document.getElementById('jd-panel').classList.contains('is-open')) {
    if (e.key === 'Escape') closeJdPanel();
  }
});

// ─── JD panel ──────────────────────────────────────────────────────────────
let _jdCurrentId = null;

async function openJdPanel(ev, id) {
  if (ev?.target?.closest('button, a')) return;
  _jdCurrentId = id;
  document.getElementById('jd-overlay').classList.add('is-open');
  document.getElementById('jd-panel').classList.add('is-open');
  document.getElementById('jd-title').textContent = 'Loading…';
  document.getElementById('jd-company').textContent = '';
  document.getElementById('jd-meta').innerHTML = '';
  document.getElementById('jd-also-on').textContent = '';
  document.getElementById('jd-description').textContent = '';
  document.getElementById('jd-score-row').style.display = 'none';

  try {
    const res = await fetch('/api/jobs/' + id);
    if (!res.ok) throw new Error('fetch failed');
    const job = await res.json();
    document.getElementById('jd-title').textContent = job.title || '—';
    document.getElementById('jd-company').textContent = job.company || '—';

    const meta = [];
    if (job.location) meta.push('<span class="location-chip">' + escapeHtml(job.location) + '</span>');
    if (job.source)   meta.push('<span class="source-pill" style="cursor:default">' + (SOURCE_LABELS[job.source] || job.source) + '</span>');
    if (job.salary)   meta.push('<span class="location-chip">' + escapeHtml(job.salary) + '</span>');
    document.getElementById('jd-meta').innerHTML = meta.join('');

    if (job.aliases && job.aliases.length) {
      document.getElementById('jd-also-on').textContent = 'Also seen on: ' + job.aliases.map(a => SOURCE_LABELS[a.source] || a.source).join(', ');
    }

    if (job.score != null) {
      const badge = document.getElementById('jd-score-badge');
      badge.textContent = '';
      const tier = scoreTier(job.score);
      badge.className = 'score-badge tier-' + tier;
      badge.innerHTML = job.score + '<span class="score-badge-suffix">/10</span>';
      document.getElementById('jd-score-reason').textContent = job.score_reason || '';
      document.getElementById('jd-score-row').style.display = 'flex';
    }

    const desc = (job.description || '').trim();
    if (desc) {
      document.getElementById('jd-description').textContent = desc;
    } else {
      document.getElementById('jd-description').innerHTML = '<div class="jd-description-empty">No description stored. Click Apply to read on the source site.</div>';
    }

    const applyBtn = document.getElementById('jd-btn-apply');
    const url = job.external_url || job.url || '#';
    applyBtn.href = url;
    applyBtn.style.display = url === '#' ? 'none' : '';
  } catch {
    document.getElementById('jd-title').textContent = 'Error loading job';
  }
}

function closeJdPanel() {
  document.getElementById('jd-overlay').classList.remove('is-open');
  document.getElementById('jd-panel').classList.remove('is-open');
  _jdCurrentId = null;
}

function markAppliedFromPanel() {
  if (!_jdCurrentId) return;
  fetch('/api/jobs/' + _jdCurrentId + '/applied', { method: 'POST' }).then(r => {
    if (!r.ok) return;
    const card = document.querySelector('[data-id="' + _jdCurrentId + '"]');
    if (card) card.remove();
    closeJdPanel();
    applyFilters();
  });
}

function dismissFromPanel() {
  if (!_jdCurrentId) return;
  const id = _jdCurrentId;
  closeJdPanel();
  markNotFit(id);
}

function restoreJob(id) {
  fetch('/api/jobs/' + id + '/restore', { method: 'POST' }).then(() => location.reload());
}

function toggleApplied(btn, id) {
  fetch('/api/jobs/' + id + '/applied', { method: 'POST' }).then(r => {
    if (!r.ok) return;
    const card = btn.closest('.job-card');
    if (card) {
      card.style.transition = 'opacity 220ms, transform 220ms';
      card.style.opacity = '0';
      card.style.transform = 'translateY(-6px)';
      setTimeout(() => { card.remove(); applyFilters(); }, 220);
    }
  });
}

// ─── Pipeline collapse ─────────────────────────────────────────────────────
function toggleSection(section) {
  // Don't toggle if clicking inside the body (handled via stopPropagation in markup)
  section.classList.toggle('is-collapsed');
}

// ─── Run agent (log drawer) ────────────────────────────────────────────────
let _runEs = null;
function openLogDrawer() {
  document.getElementById('log-drawer').classList.add('is-open');
  document.getElementById('log-output').innerHTML = '';
  document.getElementById('log-drawer-status').textContent = '';
  document.getElementById('log-drawer-title').textContent = 'Running /job-hunt…';
  const bar = document.getElementById('log-progress-bar');
  bar.style.display = 'block';
  bar.style.width = '0%';
  bar.classList.add('indeterminate');
}
function closeLogDrawer() {
  document.getElementById('log-drawer').classList.remove('is-open');
  if (_runEs) { _runEs.close(); _runEs = null; }
}
function appendLog(text, cls) {
  const out = document.getElementById('log-output');
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = text;
  out.appendChild(div);
  out.scrollTop = out.scrollHeight;
}
function runAgent(btn) {
  if (btn.classList.contains('running')) return;
  btn.classList.add('running');
  btn.querySelector('span').textContent = 'Running…';
  openLogDrawer();
  if (_runEs) { _runEs.close(); }
  _runEs = new EventSource('/api/run-stream');
  _runEs.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'log') {
        const text = msg.text.trimEnd();
        if (!text) return;
        const cls = /tool_use|tool_result|bash|mcp/i.test(text) ? 'log-line-tool'
                  : /error|failed|exception/i.test(text) ? 'log-line-err'
                  : null;
        appendLog(text, cls);
      } else if (msg.type === 'auth_error') {
        document.getElementById('log-output').innerHTML = '';
        appendLog('Claude CLI is not authenticated.', 'log-line-err');
        appendLog('', null);
        appendLog('One-time fix — open Terminal and run:', null);
        appendLog('    claude login', 'log-line-tool');
      } else if (msg.type === 'done') {
        const bar = document.getElementById('log-progress-bar');
        bar.classList.remove('indeterminate');
        bar.style.width = '100%';
        const ok = msg.code === 0;
        document.getElementById('log-drawer-title').textContent = ok ? 'Run complete' : 'Run finished with errors';
        const status = document.getElementById('log-drawer-status');
        if (ok) {
          appendLog('─── Done. Reloading dashboard in 4s… ───', 'log-line-done');
          status.textContent = 'Reloading…';
          setTimeout(() => location.reload(), 4000);
        } else {
          status.textContent = 'Check log for errors';
        }
        btn.querySelector('span').textContent = ok ? 'Done' : 'Error';
        btn.classList.remove('running');
        setTimeout(() => { btn.querySelector('span').textContent = 'Refresh'; }, 5000);
        _runEs.close(); _runEs = null;
      } else if (msg.type === 'busy') {
        appendLog('A run is already in progress.', 'log-line-err');
        btn.classList.remove('running');
        btn.querySelector('span').textContent = 'Refresh';
        _runEs.close(); _runEs = null;
      }
    } catch {}
  };
  _runEs.onerror = () => {
    appendLog('Connection lost.', 'log-line-err');
    btn.classList.remove('running');
    btn.querySelector('span').textContent = 'Refresh';
    if (_runEs) { _runEs.close(); _runEs = null; }
  };
}
</script>
</body>
</html>`;
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url  = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === 'POST' && /^\/api\/jobs\/(\d+)\/(notfit|restore|applied|unapplied)$/.test(path)) {
    const [, id, action] = path.match(/^\/api\/jobs\/(\d+)\/(notfit|restore|applied|unapplied)$/);
    const statusMap = { notfit: 'not_fit', restore: 'active', applied: 'applied', unapplied: 'active' };
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 4000) req.destroy(); });
    req.on('end', () => {
      let reason = null;
      if (body) {
        try { reason = (JSON.parse(body).reason || '').toString().trim().slice(0, 1000) || null; } catch {}
      }
      updateJobStatus(Number(id), statusMap[action], reason);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (req.method === 'GET' && path === '/api/run-stream') {
    if (activeRun) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'busy' })}\n\n`);
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const stripAnsi = s => s.replace(/\x1B\[[0-9;]*[mGKHFJA-Z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '').replace(/\r/g, '');
    const send = (type, extra = {}) => {
      try { res.write(`data: ${JSON.stringify({ type, ...extra })}\n\n`); } catch {}
    };
    import('node:child_process').then(({ spawn }) => {
      let prompt = 'Run the full job hunt pipeline.';
      try {
        let raw = readFileSync(resolve(__dirname, '..', '.claude', 'scheduled-task', 'SKILL.md'), 'utf8');
        if (raw.startsWith('---')) {
          const end = raw.indexOf('\n---', 3);
          if (end !== -1) raw = raw.slice(end + 4).trim();
        }
        if (raw.length > 50) prompt = raw;
      } catch {}
      const proc = spawn(CLAUDE_BIN, ['-p', prompt, '--permission-mode', 'bypassPermissions', '--chrome'], {
        cwd: resolve(__dirname, '..'),
        env: { ...process.env, FORCE_COLOR: '0' },
      });
      activeRun = proc;
      send('log', { text: `[dashboard] Claude Code session started  (pid ${proc.pid})` });
      let buf = '';
      let fullOutput = '';
      const flush = (final = false) => {
        const lines = buf.split('\n');
        if (!final) buf = lines.pop();
        else buf = '';
        for (const line of lines) {
          const clean = stripAnsi(line);
          if (clean.trim()) send('log', { text: clean });
        }
      };
      const onData = chunk => { const s = chunk.toString(); buf += s; fullOutput += s; flush(); };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('close', code => {
        flush(true);
        activeRun = null;
        if (/not logged in|please run \/login/i.test(fullOutput)) send('auth_error', {});
        send('done', { code: code ?? 0 });
        try { res.end(); } catch {}
      });
      req.on('close', () => { if (activeRun === proc) { proc.kill(); activeRun = null; } });
    });
    return;
  }

  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    const jobs        = getJobs();
    const notFitJobs  = getNotFitJobs();
    const appliedJobs = getAppliedJobs();
    const rawApplications = getApplications();
    const applications = dedupeApplications(rawApplications);
    const analytics  = computeAnalytics(rawApplications);
    const html = renderPage(jobs, notFitJobs, appliedJobs, applications, analytics);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && /^\/api\/jobs\/(\d+)$/.test(path)) {
    const id = Number(path.match(/^\/api\/jobs\/(\d+)$/)[1]);
    const db = openJobsDb();
    if (!db) { res.writeHead(500); res.end(); return; }
    try {
      const row = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
      const aliases = db.prepare(`SELECT source, url, external_url FROM jobs WHERE duplicate_of = ?`).all(id);
      db.close();
      if (!row) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...row, aliases }));
    } catch {
      res.writeHead(500); res.end();
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
