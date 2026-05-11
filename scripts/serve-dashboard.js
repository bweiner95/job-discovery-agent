/**
 * scripts/serve-dashboard.js
 *
 * Local HTTP dashboard — matches the original card-grid layout.
 * Three tabs: Open Roles · Pipeline · Not a Fit
 * Port: DASHBOARD_PORT env var, default 3033
 */

import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JOBS_DB_PATH     = resolve(__dirname, '..', 'jobs.db');
const PIPELINE_DB_PATH = process.env.PIPELINE_DB_PATH || resolve(__dirname, '..', 'pipeline.db');
const PORT             = Number(process.env.DASHBOARD_PORT) || 3033;
import { readFileSync, accessSync } from 'node:fs';

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
  return 'claude'; // rely on PATH
})();

let activeRun = null; // guard against concurrent runs

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
    // Attach the count of additional sources this job was seen on
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

// Group multiple pipeline rows that represent the same logical application
// (same company + role, often arriving via different Gmail threads — e.g., a
// recruiter email + a calendar invite + a follow-up reply all for the same
// interview process). Keeps the row with the most-advanced status; if all are
// terminal, prefers offer > rejection.
function dedupeApplications(applications) {
  const STAGE_PRIORITY = {
    offer: 8,
    interview_follow_up: 7,
    take_home_submitted: 6,
    interview_scheduled: 5,
    recruiter_outreach: 4,
    application_viewed: 3,
    applied: 2,
    rejection: 1, // terminal but lower than active stages so e.g. an interview-then-rejection still counts under interview
    unknown: 0,
  };
  function norm(s) {
    return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  // Generic "round name" patterns that aren't real role titles — these often
  // come from email subjects like "Builders interview" or "Phone screen with
  // Faire" and should NOT be treated as a separate role. Group these by
  // company alone so they merge with the actual application.
  const ROUND_NAME_PATTERN = /^(builders|phone\s*screen|recruiter\s*screen|technical\s*screen|onsite|on\s*site|virtual|in\s*person|final\s*round|hiring\s*manager|behavioral|culture\s*fit)?\s*(interview|screen|round|panel|chat|conversation|call)?$/i;
  function isRoundName(role) {
    if (!role) return true;
    if (role.length < 4) return true;
    return ROUND_NAME_PATTERN.test(role.trim());
  }

  // Two-pass dedupe so that round-name entries ("Builders interview",
  // "Phone screen") always collapse into the canonical role-named entry
  // for the same company, even if their group keys would otherwise differ.

  const groups = new Map(); // key → app
  const realRoleAppsByCompany = new Map(); // company → first app with a real role

  function pickWinner(a, b) {
    const ap = STAGE_PRIORITY[a.current_status] ?? 0;
    const bp = STAGE_PRIORITY[b.current_status] ?? 0;
    if (bp > ap) return b;
    if (bp < ap) return a;
    const ad = new Date(a.last_activity_date || 0);
    const bd = new Date(b.last_activity_date || 0);
    return bd > ad ? b : a;
  }

  for (const app of applications) {
    const company = norm(app.company);
    const role = norm(app.role);
    if (!company) continue;

    const isRound = isRoundName(app.role);

    if (isRound) {
      // Try to find an existing real-role entry for this company first.
      const target = realRoleAppsByCompany.get(company);
      if (target) {
        // Merge into that entry: pick the more advanced of the two.
        const existing = groups.get(target.key);
        if (existing) {
          groups.set(target.key, pickWinner(existing, app));
          continue;
        }
      }
      // No real-role entry exists yet for this company — fall back to
      // company-only key so any future real-role entry won't collide
      // with it. This will be retroactively rerouted if a real role
      // shows up later in the loop.
      const key = `${company}::`;
      const existing = groups.get(key);
      groups.set(key, existing ? pickWinner(existing, app) : app);
    } else {
      // Real role name — record it for future round-name lookups
      const key = `${company}::${role}`;
      const existing = groups.get(key);
      groups.set(key, existing ? pickWinner(existing, app) : app);
      realRoleAppsByCompany.set(company, { ...app, key });

      // Also: pull in any earlier company-only round entries for this company
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
  // Dedupe before computing so same-role multi-row noise doesn't inflate counts
  const applications = dedupeApplications(rawApplications);
  const total = applications.length;
  if (total === 0) return null;

  // Funnel counts
  const STAGES = ['applied', 'application_viewed', 'recruiter_outreach', 'interview_scheduled', 'take_home_submitted', 'interview_follow_up', 'offer'];
  const counts = Object.fromEntries(STAGES.map(s => [s, 0]));
  let rejections = 0;

  for (const a of applications) {
    if (a.current_status === 'rejection') rejections++;
    // Apps in current_status >= stage X count for stage X (cumulative funnel)
    const idx = STAGES.indexOf(a.current_status);
    if (idx >= 0) {
      for (let i = 0; i <= idx; i++) counts[STAGES[i]]++;
    } else if (a.current_status === 'rejection') {
      // Rejected apps still passed through "applied"
      counts['applied']++;
    }
  }

  // Response rate: any movement past 'applied'
  const responded = applications.filter(a =>
    !['applied'].includes(a.current_status) && a.current_status !== 'unknown'
  ).length;
  const responseRate = total > 0 ? Math.round((responded / total) * 100) : 0;

  // Time-to-first-response: median days from date_applied to last_activity_date
  // for apps that responded
  const responseTimes = [];
  for (const a of applications) {
    if (!a.date_applied || !a.last_activity_date) continue;
    if (['applied', 'unknown'].includes(a.current_status)) continue;
    const applied = new Date(a.date_applied);
    const activity = new Date(a.last_activity_date);
    const days = Math.floor((activity - applied) / 86400000);
    if (days >= 0 && days < 365) responseTimes.push(days);
  }
  const medianResponseDays = responseTimes.length
    ? Math.round(responseTimes.sort((a, b) => a - b)[Math.floor(responseTimes.length / 2)])
    : null;

  // Application velocity: apps per week, last 8 weeks
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

  // Top companies
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

  // Cold rate
  const coldCount = applications.filter(a =>
    a.is_cold && !['offer', 'rejection'].includes(a.current_status)
  ).length;
  const activeCount = applications.filter(a => !['offer', 'rejection'].includes(a.current_status)).length;
  const coldRate = activeCount > 0 ? Math.round((coldCount / activeCount) * 100) : 0;

  // Rejection rate
  const rejectionRate = total > 0 ? Math.round((rejections / total) * 100) : 0;

  return {
    total,
    funnel: counts,
    rejections,
    responseRate,
    rejectionRate,
    medianResponseDays,
    velocityWeeks,
    topCompanies,
    coldRate,
    coldCount,
    activeCount,
  };
}

function updateJobStatus(id, status, reason = null) {
  const db = openJobsDb();
  if (!db) return false;
  try {
    if (status === 'not_fit' && reason) {
      db.prepare(`UPDATE jobs SET status = ?, not_fit_reason = ? WHERE id = ?`).run(status, reason, id);
    } else if (status !== 'not_fit') {
      // Clear reason when restoring/applying
      db.prepare(`UPDATE jobs SET status = ?, not_fit_reason = NULL WHERE id = ?`).run(status, id);
    } else {
      db.prepare(`UPDATE jobs SET status = ? WHERE id = ?`).run(status, id);
    }
    db.close();
    return true;
  } catch { return false; }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esc(s) {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function scoreColor(score) {
  if (score == null) return '#9E9289';
  if (score >= 9)  return '#3F5F54';
  if (score >= 7)  return '#7a5c28';
  if (score >= 5)  return '#6B5B4E';
  return '#8a4a35';
}

function scoreBg(score) {
  if (score == null) return '#EFEAE4';
  if (score >= 9)  return '#E0EDE8';
  if (score >= 7)  return '#F5EDDA';
  if (score >= 5)  return '#EEE9E2';
  return '#F5E8E3';
}

function fmtDate(d) {
  if (!d) return '';
  try {
    const date = new Date(d);
    const now = new Date();
    const diffMs = now - date;
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffDays === 0) return 'today';
    if (diffDays === 1) return 'yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch { return ''; }
}

function sourceLabel(source) {
  const map = { greenhouse: 'Greenhouse', lever: 'Lever', linkedin: 'LinkedIn', serpapi: 'Google', ashby: 'Ashby', alirohde: 'Ali Rohde' };
  return map[source] || source;
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function applyUrl(job) {
  return job.external_url || job.url || '#';
}

function viewButtonLabel(source) {
  const map = { linkedin: 'View on LinkedIn', greenhouse: 'View on Greenhouse', lever: 'View on Lever', serpapi: 'View Job', ashby: 'View on Ashby', alirohde: 'Apply' };
  return map[source] || 'View Job';
}

const STATUS_META = {
  offer:               { icon: '🏆', color: '#7a5c28', bg: '#F5EDDA', label: 'Offer',       section: 'Offers' },
  interview_scheduled: { icon: '📅', color: '#3F5F54', bg: '#E0EDE8', label: 'Interview',   section: 'Interviews' },
  take_home_submitted: { icon: '📝', color: '#3F5F54', bg: '#E0EDE8', label: 'Assignment',  section: 'Case Study / Assignment' },
  interview_follow_up: { icon: '🔄', color: '#6B5B4E', bg: '#EEE9E2', label: 'Follow-up',   section: 'Interview Follow-ups' },
  recruiter_outreach:  { icon: '📣', color: '#8a4a35', bg: '#F5E8E3', label: 'Recruiter',   section: 'Recruiter Outreach' },
  application_viewed:  { icon: '👁',  color: '#4a6070', bg: '#E8EEF2', label: 'Viewed',      section: 'Application Viewed' },
  applied:             { icon: '📨', color: '#6B6B6B', bg: '#EFEAE4', label: 'Applied',     section: 'Applied' },
  rejection:           { icon: '❌', color: '#8a4a35', bg: '#F5E8E3', label: 'Rejected',    section: 'Rejected' },
};

function statusBadge(status, isCold) {
  const m = STATUS_META[status] ?? { icon: '❓', color: '#555', bg: '#f2f2f7', label: status };
  const coldFlag = isCold && !['offer', 'rejection'].includes(status) ? ' 🥶' : '';
  return `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:20px;font-size:12px;font-weight:500;background:${m.bg};color:${m.color}">${m.icon} ${m.label}${coldFlag}</span>`;
}

// ─── Page render ──────────────────────────────────────────────────────────────

// Read first name from candidate-profile.js for the dashboard title
function getCandidateFirstName() {
  try {
    const text = readFileSync(resolve(__dirname, '..', 'src', 'candidate-profile.js'), 'utf8');
    const m = text.match(/CANDIDATE:\s+([^\n,]+)/);
    if (m) return m[1].trim().split(/\s+/)[0]; // first word = first name
  } catch {}
  return 'My';
}
const CANDIDATE_FIRST_NAME = getCandidateFirstName();

function renderPage(jobs, notFitJobs, appliedJobs, applications, analytics) {
  const total    = jobs.length;
  const scores   = jobs.map(j => j.score).filter(s => s != null);
  const avgScore = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : '—';
  const count9   = jobs.filter(j => j.score >= 9).length;
  const count7   = jobs.filter(j => j.score >= 7 && j.score <= 8).length;
  const countLever      = jobs.filter(j => j.source === 'lever').length;
  const countLinkedIn   = jobs.filter(j => j.source === 'linkedin').length;
  const countGreenhouse = jobs.filter(j => j.source === 'greenhouse').length;
  const countAshby      = jobs.filter(j => j.source === 'ashby').length;
  const countAliRohde   = jobs.filter(j => j.source === 'alirohde').length;

  const lastUpdated = (() => {
    const dates = jobs.map(j => j.created_at).filter(Boolean).sort().reverse();
    if (!dates[0]) return '';
    try {
      return new Date(dates[0]).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch { return ''; }
  })();

  // Pipeline stats
  const pStats = {};
  for (const a of applications) pStats[a.current_status] = (pStats[a.current_status] || 0) + 1;

  const STATUS_ORDER = ['offer','interview_scheduled','take_home_submitted','interview_follow_up','recruiter_outreach','application_viewed','applied','rejection'];
  const grouped = {};
  for (const s of STATUS_ORDER) grouped[s] = [];
  for (const a of applications) {
    const key = STATUS_META[a.current_status] ? a.current_status : 'applied';
    grouped[key].push(a);
  }

  // Build job cards
  const jobCards = jobs.map(job => {
    const score      = job.score;
    const url        = applyUrl(job);
    const hasUrl     = url && url !== '#';
    const rationale  = (job.score_reason || '').trim();
    const dateStr    = fmtDate(job.created_at);
    const src        = job.source || '';
    const isApplied  = job.status === 'applied';

    const alsoOn = (job.also_on || []).filter(s => s);
    return `
<div class="job-card card-clickable${isApplied ? ' is-applied' : ''}" data-score="${score ?? 0}" data-source="${esc(src)}" data-id="${job.id}" data-date="${esc(job.created_at || '')}" onclick="openJdPanel(event, ${job.id})">
  <button class="dismiss-btn" title="Not a fit" onclick="event.stopPropagation();markNotFit(${job.id})">×</button>
  ${score != null ? `<div class="score-badge" style="background:${scoreBg(score)};color:${scoreColor(score)}">${score}<span>/10</span></div>` : `<div class="score-badge" style="background:#EFEAE4;color:#9E9289">—</div>`}
  <div class="card-body">
    <div class="card-title">${esc(job.title || '')}</div>
    <div class="card-company">${esc(job.company || '')}${alsoOn.length ? ` <span style="font-weight:400;color:#9E9289">· also on ${alsoOn.map(s => sourceLabel(s)).join(', ')}</span>` : ''}</div>
    <div class="card-chips">
      ${job.location ? `<span class="chip chip-loc">${esc(job.location)}</span>` : ''}
      <span class="chip chip-src chip-${esc(src)}">${sourceLabel(src)}</span>
      ${job.salary ? `<span class="chip chip-salary">${esc(job.salary)}</span>` : ''}
    </div>
    ${rationale ? `<div class="card-snippet">${esc(rationale)}</div>` : ''}
    <div class="card-footer">
      <span class="card-date">${dateStr}</span>
      <div class="card-actions">
        <button class="btn-applied${isApplied ? ' active' : ''}" onclick="event.stopPropagation();toggleApplied(this, ${job.id})">${isApplied ? '✓ Applied' : '+ Applied'}</button>
        ${hasUrl ? `<a class="btn-view" href="${esc(url)}" target="_blank" onclick="event.stopPropagation()">${viewButtonLabel(src)} ↗</a>` : ''}
      </div>
    </div>
  </div>
</div>`;
  }).join('');

  // Not a Fit cards
  const notFitCards = notFitJobs.length === 0
    ? '<div class="empty-state">No jobs marked as "Not a Fit" yet.</div>'
    : notFitJobs.map(job => `
<div class="job-card dimmed" data-id="${job.id}">
  ${job.score != null ? `<div class="score-badge" style="background:${scoreBg(job.score)};color:${scoreColor(job.score)}">${job.score}<span>/10</span></div>` : `<div class="score-badge" style="background:#f2f2f7;color:#aaa">—</div>`}
  <div class="card-body">
    <div class="card-title">${esc(job.title || '')}</div>
    <div class="card-company">${esc(job.company || '')}</div>
    <div class="card-chips">
      ${job.location ? `<span class="chip chip-loc">${esc(job.location)}</span>` : ''}
      <span class="chip chip-src chip-${esc(job.source || '')}">${sourceLabel(job.source || '')}</span>
    </div>
    ${job.not_fit_reason ? `<div class="card-snippet" style="font-style:italic">"${esc(job.not_fit_reason)}"</div>` : ''}
    <div class="card-footer">
      <span class="card-date">${fmtDate(job.created_at)}</span>
      <div class="card-actions">
        <button class="btn-applied" onclick="restoreJob(${job.id})">↩ Restore</button>
      </div>
    </div>
  </div>
</div>`).join('');

  // Applied cards
  const appliedCards = appliedJobs.length === 0
    ? '<div class="empty-state">No jobs marked as Applied yet.</div>'
    : appliedJobs.map(job => {
      const url = applyUrl(job);
      const hasUrl = url && url !== '#';
      return `
<div class="job-card is-applied" data-id="${job.id}">
  ${job.score != null ? `<div class="score-badge" style="background:${scoreBg(job.score)};color:${scoreColor(job.score)}">${job.score}<span>/10</span></div>` : `<div class="score-badge" style="background:#EFEAE4;color:#9E9289">—</div>`}
  <div class="card-body">
    <div class="card-title">${esc(job.title || '')}</div>
    <div class="card-company">${esc(job.company || '')}</div>
    <div class="card-chips">
      ${job.location ? `<span class="chip chip-loc">${esc(job.location)}</span>` : ''}
      <span class="chip chip-src chip-${esc(job.source || '')}">${sourceLabel(job.source || '')}</span>
      ${job.salary ? `<span class="chip chip-salary">${esc(job.salary)}</span>` : ''}
    </div>
    <div class="card-footer">
      <span class="card-date">${fmtDate(job.created_at)}</span>
      <div class="card-actions">
        <button class="btn-applied" onclick="restoreJob(${job.id})">↩ Unapply</button>
        ${hasUrl ? `<a class="btn-view" href="${esc(url)}" target="_blank">${viewButtonLabel(job.source || '')} ↗</a>` : ''}
      </div>
    </div>
  </div>`;
    }).join('');

  // Pipeline sections (grouped by status)
  const pipelineSections = STATUS_ORDER.flatMap(status => {
    const apps = grouped[status];
    if (!apps.length) return [];
    const m = STATUS_META[status];
    const rows = apps.map(app => {
      const isCold = app.is_cold && !['offer','rejection'].includes(status);
      return `
<tr class="${isCold ? 'cold-row' : ''}">
  <td><strong>${esc(app.company || '')}</strong></td>
  <td>${app.role ? esc(app.role) : '<em style="color:#B5ADA5;font-weight:400">Role not captured</em>'}</td>
  <td>${fmtDate(app.last_activity_date)}${isCold ? ' 🥶' : ''}</td>
</tr>`;
    }).join('');
    return [`
<div class="pipeline-section">
  <div class="pipeline-section-header" onclick="toggleSection(this)">
    <span class="ps-icon-label">
      <span style="background:${m.bg};color:${m.color}" class="ps-icon">${m.icon}</span>
      <span class="ps-name">${m.section}</span>
    </span>
    <span class="ps-count" style="background:${m.bg};color:${m.color}">${apps.length}</span>
    <span class="ps-chevron">▾</span>
  </div>
  <div class="pipeline-section-body">
    <table class="pipeline-table">
      <tbody>${rows}</tbody>
    </table>
  </div>
</div>`];
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(CANDIDATE_FIRST_NAME)}'s Job Search</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;1,400&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
/* ── Reset ── */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

/* ── Base ── */
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;background:#F7F5F2;color:#1C1C1C;font-size:14px;line-height:1.55}

/* ── Top bar ── */
.topbar{background:#fff;border-bottom:1px solid #E7E2DA;padding:16px 32px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:20;box-shadow:0 1px 0 #E7E2DA}
.topbar-left h1{font-family:'Playfair Display',Georgia,serif;font-size:26px;font-weight:500;letter-spacing:-0.2px;color:#1C1C1C;line-height:1.2}
.topbar-left h1 em{font-style:italic;color:#6F8F80;font-weight:400}
.topbar-left .updated{font-size:11px;color:#9E9289;margin-top:4px;letter-spacing:0.02em}
.source-pills{display:flex;gap:6px}
.source-pill{padding:6px 14px;border-radius:20px;border:1px solid #DDD8D1;background:#fff;font-size:12px;font-weight:500;cursor:pointer;transition:all 150ms ease;color:#4A4A4A}
.source-pill:hover{border-color:#6F8F80;color:#3F5F54;background:rgba(111,143,128,.08)}
.source-pill.active{background:#6F8F80;border-color:#6F8F80;color:#fff}

/* ── Tabs ── */
.tabs{background:#fff;border-bottom:1px solid #E7E2DA;padding:0 32px;display:flex}
.tab{padding:14px 20px;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;color:#9E9289;transition:all 150ms;user-select:none;font-weight:500;letter-spacing:0.01em}
.tab:hover{color:#1C1C1C}
.tab.active{color:#3F5F54;border-bottom-color:#6F8F80}
.tab-count{font-size:11px;margin-left:5px;background:#EFEAE4;padding:2px 7px;border-radius:10px;color:#6B6B6B}
.tab.active .tab-count{background:rgba(111,143,128,.15);color:#3F5F54}

/* ── Stats bar ── */
.stats-bar{display:flex;padding:24px 32px;background:#EFEAE4;border-bottom:1px solid #DDD8D1}
.stat{flex:1;text-align:center;border-right:1px solid #DDD8D1}
.stat:last-child{border-right:none}
.stat-value{font-family:'Playfair Display',Georgia,serif;font-size:28px;font-weight:500;color:#1C1C1C;line-height:1}
.stat-label{font-size:10px;font-weight:600;color:#6B6B6B;text-transform:uppercase;letter-spacing:0.08em;margin-top:6px}

/* ── Filters ── */
.filters{padding:14px 32px;display:flex;gap:8px;align-items:center;background:#EFEAE4;border-bottom:1px solid #DDD8D1;flex-wrap:wrap}
.search-input{padding:8px 14px;border:1.5px solid #C8C2BA;border-radius:10px;font-size:13px;width:260px;background:#fff;font-family:'Inter',sans-serif;outline:none;color:#1C1C1C}
.search-input::placeholder{color:#B5ADA5}
.search-input:focus{border-color:#6F8F80;box-shadow:0 0 0 3px rgba(111,143,128,.12)}
.filter-select{padding:8px 12px;border:1.5px solid #C8C2BA;border-radius:10px;font-size:13px;background:#fff;cursor:pointer;font-family:'Inter',sans-serif;color:#1C1C1C;outline:none}
.filter-select:focus{border-color:#6F8F80}
.showing{margin-left:auto;font-size:12px;color:#6B6B6B;font-style:italic}

/* ── Tab panels ── */
.tab-panel{display:none}
.tab-panel.active{display:block}

/* ── Job grid ── */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:16px;padding:32px 40px;max-width:1600px;margin:0 auto}

/* ── Job card ── */
.job-card{background:#fff;border-radius:12px;border:1px solid #E0DBD4;position:relative;transition:box-shadow 150ms ease,transform 150ms ease;overflow:hidden;box-shadow:0 2px 8px rgba(28,28,28,.05)}
.job-card:hover{box-shadow:0 6px 24px rgba(28,28,28,.09);transform:translateY(-1px)}
.job-card.dimmed{opacity:.7;background:#FAF6F2;border-color:#D8CFC4}
.job-card.is-applied{background:#F4F8F6;border-color:#B8D0C8}
.job-card.is-applied .card-title{color:#3F5F54}
.job-card.is-applied .score-badge{opacity:.6}
.dismiss-btn{position:absolute;top:10px;right:10px;width:22px;height:22px;border:none;background:none;font-size:15px;color:#C5BEB6;cursor:pointer;border-radius:50%;display:flex;align-items:center;justify-content:center;z-index:1;transition:all 150ms}
.dismiss-btn:hover{background:#EFEAE4;color:#4A4A4A}
.score-badge{position:absolute;top:12px;left:12px;padding:3px 8px;border-radius:8px;font-size:12px;font-weight:700;line-height:1.3}
.score-badge span{font-size:10px;font-weight:400;opacity:.65}
.card-body{padding:16px 16px 12px;margin-top:32px}
.card-title{font-size:14px;font-weight:600;line-height:1.35;margin-bottom:4px;color:#1C1C1C}
.card-company{font-size:12px;color:#4A4A4A;margin-bottom:8px;font-weight:600;letter-spacing:0.01em}
.card-chips{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px}
.chip{padding:3px 8px;border-radius:20px;font-size:11px;font-weight:500}
.chip-loc{background:#EFEAE4;color:#6B6B6B}
.chip-salary{background:rgba(111,143,128,.15);color:#3F5F54}
.chip-src{background:#EFEAE4;color:#6B6B6B}
.chip-linkedin{background:#EAF0F7;color:#1a5276}
.chip-greenhouse{background:#E8F2ED;color:#2e6b35}
.chip-lever{background:#FAF0E8;color:#8a4a1a}
.chip-ashby{background:#F0E8F5;color:#5a3a8a}
.chip-alirohde{background:#FDEEDF;color:#a06236}
.card-snippet{font-size:11.5px;color:#6B6B6B;line-height:1.55;margin-bottom:10px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.card-footer{display:flex;align-items:center;justify-content:space-between;margin-top:10px;padding-top:10px;border-top:1px solid #EFEAE4}
.card-date{font-size:11px;color:#B5ADA5;font-style:italic}
.card-actions{display:flex;gap:6px;align-items:center}
.btn-applied{padding:5px 10px;border-radius:8px;border:1.5px solid #DDD8D1;background:transparent;font-size:11px;cursor:pointer;font-family:'Inter',sans-serif;color:#6B6B6B;transition:all 150ms;font-weight:500}
.btn-applied:hover,.btn-applied.active{background:#6F8F80;color:#fff;border-color:#6F8F80}
.btn-view{padding:5px 10px;border-radius:8px;background:#6F8F80;color:#fff;font-size:11px;text-decoration:none;display:inline-flex;align-items:center;gap:3px;white-space:nowrap;font-family:'Inter',sans-serif;font-weight:500;transition:background 150ms}
.btn-view:hover{background:#5E7C6F}

/* ── Pipeline ── */
.pipeline-wrap{padding:32px;display:flex;flex-direction:column;gap:12px;max-width:1000px;margin:0 auto}
.pipeline-section{border:1px solid #E0DBD4;border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 2px 6px rgba(28,28,28,.04)}
.pipeline-section-header{display:flex;align-items:center;gap:10px;padding:14px 18px;cursor:pointer;user-select:none;transition:background 150ms}
.pipeline-section-header:hover{background:#F7F5F2}
.ps-icon-label{display:flex;align-items:center;gap:10px;flex:1}
.ps-icon{padding:3px 8px;border-radius:6px;font-size:13px}
.ps-name{font-size:14px;font-weight:600;color:#1C1C1C}
.ps-count{padding:2px 10px;border-radius:20px;font-size:11px;font-weight:600}
.ps-chevron{color:#B5ADA5;font-size:11px;transition:transform 200ms;margin-left:4px}
.pipeline-section.collapsed .ps-chevron{transform:rotate(-90deg)}
.pipeline-section.collapsed .pipeline-section-body{display:none}
.pipeline-section-body{border-top:1px solid #EFEAE4}
.pipeline-table{width:100%;border-collapse:collapse}
.pipeline-table td{padding:12px 18px;border-bottom:1px solid #F7F5F2;font-size:13px;color:#1C1C1C}
.pipeline-table td:first-child{font-weight:600;color:#1C1C1C}
.pipeline-table td:last-child{color:#6B6B6B;font-size:12px}
.pipeline-table tr:last-child td{border-bottom:none}
.cold-row td{color:#C5BEB6 !important}
.empty-state{text-align:center;padding:64px;color:#9E9289;font-size:14px;font-style:italic}
.stat-clickable{cursor:pointer;transition:background 150ms}
.stat-clickable:hover{background:#DDD8D1}
.stat-clickable .stat-label{color:#6F8F80}
.run-btn{padding:7px 14px;border-radius:20px;border:1.5px solid #DDD8D1;background:#fff;font-size:12px;font-weight:500;cursor:pointer;font-family:'Inter',sans-serif;color:#4A4A4A;transition:all 150ms;display:flex;align-items:center;gap:5px}
.run-btn:hover{border-color:#6F8F80;color:#3F5F54;background:rgba(111,143,128,.08)}
.run-btn.running{color:#6F8F80;border-color:#6F8F80;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* ── Log drawer ── */
#log-drawer{position:fixed;bottom:0;left:0;right:0;height:340px;background:#1C1A18;border-top:2px solid #6F8F80;transform:translateY(100%);transition:transform 280ms cubic-bezier(.4,0,.2,1);z-index:100;display:flex;flex-direction:column;box-shadow:0 -8px 32px rgba(0,0,0,.25)}
#log-drawer.open{transform:translateY(0)}
#log-drawer-header{display:flex;align-items:center;gap:10px;padding:10px 20px;border-bottom:1px solid #2E2C29;flex-shrink:0}
#log-drawer-title{font-size:13px;font-weight:600;color:#C8C2BA;font-family:'Inter',sans-serif;flex:1}
#log-drawer-status{font-size:11px;color:#6F8F80;font-style:italic}
#log-drawer-close{width:26px;height:26px;border:none;background:none;color:#6B6B6B;font-size:16px;cursor:pointer;border-radius:4px;display:flex;align-items:center;justify-content:center;line-height:1;transition:background 150ms}
#log-drawer-close:hover{background:#2E2C29;color:#C8C2BA}
#log-output{flex:1;overflow-y:auto;padding:12px 20px;font-family:'SF Mono','Fira Code','Menlo',monospace;font-size:11.5px;line-height:1.7;color:#C8C2BA;word-break:break-word;white-space:pre-wrap}
#log-output .log-line-tool{color:#8EBFB0}
#log-output .log-line-done{color:#A8D5A2;font-weight:600}
#log-output .log-line-err{color:#E8A090}
#log-progress{height:3px;background:#2E2C29;flex-shrink:0}
#log-progress-bar{height:100%;background:#6F8F80;width:0%;transition:width 600ms ease}
#log-progress-bar.indeterminate{animation:progress-slide 1.4s infinite linear;width:30%}
@keyframes progress-slide{0%{transform:translateX(-200%)}100%{transform:translateX(400%)}}

/* ── Analytics tab ── */
.analytics-wrap{padding:32px;display:flex;flex-direction:column;gap:24px;max-width:1100px;margin:0 auto}
.an-row{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.an-row.two{grid-template-columns:repeat(2,1fr)}
.an-card{background:#fff;border:1px solid #E0DBD4;border-radius:12px;padding:18px;box-shadow:0 2px 6px rgba(28,28,28,.04)}
.an-card-label{font-size:11px;font-weight:600;color:#6B6B6B;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px}
.an-card-value{font-family:'Playfair Display',Georgia,serif;font-size:32px;font-weight:500;color:#1C1C1C;line-height:1}
.an-card-sub{font-size:11px;color:#9E9289;margin-top:6px;font-style:italic}
.an-section{background:#fff;border:1px solid #E0DBD4;border-radius:12px;padding:20px;box-shadow:0 2px 6px rgba(28,28,28,.04)}
.an-section h3{font-family:'Playfair Display',Georgia,serif;font-size:18px;font-weight:500;color:#1C1C1C;margin-bottom:14px}
.funnel-bar{display:flex;align-items:center;gap:8px;margin:6px 0;font-size:13px}
.funnel-label{flex:0 0 220px;color:#4A4A4A}
.funnel-track{flex:1;background:#EFEAE4;border-radius:6px;height:18px;overflow:hidden;position:relative}
.funnel-fill{height:100%;background:linear-gradient(90deg,#6F8F80 0%,#7a5c28 100%);transition:width 400ms}
.funnel-count{flex:0 0 64px;text-align:right;color:#1C1C1C;font-weight:600;font-size:12px}
.velocity-grid{display:grid;grid-template-columns:repeat(8,1fr);gap:6px;align-items:end;height:140px;margin-top:8px}
.velocity-col{display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:4px}
.velocity-bar{background:#6F8F80;border-radius:4px 4px 0 0;width:100%;min-height:2px;transition:height 400ms}
.velocity-label{font-size:10px;color:#9E9289;margin-top:4px}
.velocity-value{font-size:11px;font-weight:600;color:#1C1C1C}
.companies-table{width:100%;border-collapse:collapse;font-size:13px}
.companies-table th{text-align:left;padding:8px 10px;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#6B6B6B;border-bottom:2px solid #E0DBD4}
.companies-table td{padding:10px;border-bottom:1px solid #F0EBE4}
.companies-table tr:last-child td{border-bottom:none}
.adv-pill{display:inline-block;padding:2px 8px;border-radius:10px;background:#E0EDE8;color:#3F5F54;font-size:11px;font-weight:600}
.rej-pill{display:inline-block;padding:2px 8px;border-radius:10px;background:#F5E8E3;color:#8a4a35;font-size:11px;font-weight:600}
.pen-pill{display:inline-block;padding:2px 8px;border-radius:10px;background:#EFEAE4;color:#6B6B6B;font-size:11px;font-weight:600}

/* ── JD preview side panel ── */
#jd-panel{position:fixed;top:0;right:0;height:100vh;width:560px;max-width:90vw;background:#fff;border-left:1px solid #DDD8D1;box-shadow:-12px 0 32px rgba(28,28,28,.08);transform:translateX(100%);transition:transform 280ms cubic-bezier(.4,0,.2,1);z-index:150;display:flex;flex-direction:column}
#jd-panel.open{transform:translateX(0)}
#jd-overlay{position:fixed;inset:0;background:rgba(28,26,24,.25);opacity:0;pointer-events:none;transition:opacity 200ms;z-index:140}
#jd-overlay.open{opacity:1;pointer-events:auto}
#jd-header{padding:18px 24px 14px;border-bottom:1px solid #EFEAE4;flex-shrink:0;display:flex;align-items:flex-start;gap:12px}
#jd-header h2{font-family:'Playfair Display',Georgia,serif;font-size:20px;font-weight:500;color:#1C1C1C;line-height:1.3;letter-spacing:-0.2px;margin-bottom:4px}
#jd-header .jd-company{font-size:13px;font-weight:600;color:#4A4A4A;margin-bottom:8px}
#jd-header .jd-meta{display:flex;flex-wrap:wrap;gap:6px}
#jd-close{position:absolute;top:14px;right:14px;width:30px;height:30px;border:none;background:#EFEAE4;color:#4A4A4A;border-radius:50%;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;transition:background 150ms}
#jd-close:hover{background:#DDD8D1;color:#1C1C1C}
#jd-score-row{padding:14px 24px;background:#FAF8F5;border-bottom:1px solid #EFEAE4;display:flex;align-items:center;gap:14px}
#jd-score-badge{padding:6px 12px;border-radius:8px;font-weight:700;font-size:14px}
#jd-score-reason{font-size:12px;color:#4A4A4A;line-height:1.5;font-style:italic}
#jd-body{flex:1;overflow-y:auto;padding:20px 24px}
#jd-body h4{font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6B6B6B;font-weight:600;margin-bottom:8px}
#jd-description{font-size:13px;line-height:1.65;color:#1C1C1C;white-space:pre-wrap;word-break:break-word}
#jd-description-empty{font-size:13px;color:#9E9289;font-style:italic;padding:20px;text-align:center;background:#FAF8F5;border-radius:8px}
#jd-footer{padding:14px 24px;border-top:1px solid #EFEAE4;display:flex;gap:8px;flex-shrink:0;background:#fff}
#jd-footer button,#jd-footer a{padding:9px 14px;border-radius:8px;font-family:'Inter',sans-serif;font-size:13px;font-weight:500;cursor:pointer;text-decoration:none;border:1.5px solid transparent;display:inline-flex;align-items:center;gap:6px}
.jd-btn-apply{background:#6F8F80;color:#fff;border-color:#6F8F80}
.jd-btn-apply:hover{background:#5E7C6F}
.jd-btn-view{background:#fff;border-color:#DDD8D1;color:#4A4A4A}
.jd-btn-view:hover{border-color:#6F8F80;color:#3F5F54}
.jd-btn-dismiss{background:#fff;border-color:#DDD8D1;color:#8a4a35;margin-left:auto}
.jd-btn-dismiss:hover{background:#F5E8E3;border-color:#8a4a35}
.jd-also-on{font-size:11px;color:#9E9289;font-style:italic;margin-top:4px}

.card-clickable{cursor:pointer}

/* ── Not-a-fit feedback modal ── */
#nf-overlay{position:fixed;inset:0;background:rgba(28,26,24,.5);display:none;align-items:center;justify-content:center;z-index:200;backdrop-filter:blur(2px)}
#nf-overlay.open{display:flex}
#nf-modal{background:#fff;border-radius:14px;padding:24px;max-width:480px;width:90%;box-shadow:0 12px 48px rgba(0,0,0,.25);animation:nf-pop 180ms cubic-bezier(.4,0,.2,1)}
@keyframes nf-pop{from{opacity:0;transform:scale(.95) translateY(8px)}to{opacity:1;transform:scale(1) translateY(0)}}
#nf-modal h3{font-family:'Playfair Display',Georgia,serif;font-size:20px;font-weight:500;color:#1C1C1C;margin-bottom:4px;letter-spacing:-0.2px}
#nf-modal .nf-job{font-size:12px;color:#9E9289;margin-bottom:14px;font-style:italic}
#nf-modal label{font-size:12px;font-weight:600;color:#4A4A4A;margin-bottom:6px;display:block;letter-spacing:0.02em}
#nf-modal textarea{width:100%;padding:10px 12px;border:1.5px solid #C8C2BA;border-radius:8px;font-family:'Inter',sans-serif;font-size:13px;line-height:1.5;resize:vertical;min-height:80px;outline:none;color:#1C1C1C;background:#FAF8F5}
#nf-modal textarea:focus{border-color:#6F8F80;box-shadow:0 0 0 3px rgba(111,143,128,.12);background:#fff}
#nf-modal textarea::placeholder{color:#B5ADA5}
#nf-modal .nf-hint{font-size:11px;color:#9E9289;margin-top:6px;font-style:italic}
#nf-modal .nf-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
#nf-modal button{padding:8px 16px;border-radius:8px;font-family:'Inter',sans-serif;font-size:13px;font-weight:500;cursor:pointer;transition:all 150ms;border:1.5px solid transparent}
#nf-modal .nf-cancel{background:transparent;border-color:#DDD8D1;color:#6B6B6B}
#nf-modal .nf-cancel:hover{background:#EFEAE4;color:#1C1C1C}
#nf-modal .nf-skip{background:transparent;border-color:#DDD8D1;color:#6B6B6B}
#nf-modal .nf-skip:hover{background:#EFEAE4;color:#1C1C1C}
#nf-modal .nf-save{background:#6F8F80;color:#fff;border-color:#6F8F80}
#nf-modal .nf-save:hover{background:#5E7C6F;border-color:#5E7C6F}
</style>
</head>
<body>

<!-- Not-a-fit feedback modal -->
<div id="nf-overlay" onclick="if(event.target===this)closeNfModal()">
  <div id="nf-modal">
    <h3>Why isn't this a fit?</h3>
    <div class="nf-job" id="nf-job-label"></div>
    <label for="nf-reason">Feedback (optional)</label>
    <textarea id="nf-reason" placeholder="e.g. wrong industry, too junior, too operational, location not viable…"></textarea>
    <div class="nf-hint">Your feedback is included in future scoring runs to refine which roles get suggested.</div>
    <div class="nf-actions">
      <button class="nf-cancel" onclick="closeNfModal()">Cancel</button>
      <button class="nf-skip" onclick="submitNfModal(true)">Skip & Dismiss</button>
      <button class="nf-save" onclick="submitNfModal(false)">Save & Dismiss</button>
    </div>
  </div>
</div>

<!-- Log drawer -->
<div id="log-drawer">
  <div id="log-progress"><div id="log-progress-bar" class="indeterminate" style="display:none"></div></div>
  <div id="log-drawer-header">
    <span id="log-drawer-title">↻ Running /job-hunt…</span>
    <span id="log-drawer-status"></span>
    <button id="log-drawer-close" onclick="closeLogDrawer()" title="Close">✕</button>
  </div>
  <div id="log-output"></div>
</div>

<!-- Top bar -->
<div class="topbar">
  <div class="topbar-left">
    <h1>${esc(CANDIDATE_FIRST_NAME)}'s Job <em>Search</em></h1>
    ${lastUpdated ? `<div class="updated">Updated ${lastUpdated}</div>` : ''}
  </div>
  <div style="display:flex;align-items:center;gap:12px">
    <button class="run-btn" onclick="runAgent(this)" title="Fetch new jobs now">↻ Refresh</button>
    <div class="source-pills">
      <button class="source-pill active" onclick="filterSource('all',this)">All ${total}</button>
      <button class="source-pill" onclick="filterSource('lever',this)">Lever ${countLever}</button>
      <button class="source-pill" onclick="filterSource('linkedin',this)">LinkedIn ${countLinkedIn}</button>
      <button class="source-pill" onclick="filterSource('greenhouse',this)">Greenhouse ${countGreenhouse}</button>
      <button class="source-pill" onclick="filterSource('ashby',this)">Ashby ${countAshby}</button>
      <button class="source-pill" onclick="filterSource('alirohde',this)">Ali Rohde ${countAliRohde}</button>
    </div>
  </div>
</div>

<!-- Tabs -->
<div class="tabs">
  <div class="tab active" onclick="showTab('roles',this)">Open Roles <span class="tab-count">${total}</span></div>
  <div class="tab" onclick="showTab('pipeline',this)">Pipeline <span class="tab-count">${applications.length}</span></div>
  <div class="tab" onclick="showTab('analytics',this)">Analytics</div>
  <div class="tab" onclick="showTab('applied',this)">Applied <span class="tab-count">${appliedJobs.length}</span></div>
  <div class="tab" onclick="showTab('notfit',this)">Not a Fit <span class="tab-count">${notFitJobs.length}</span></div>
</div>

<!-- Open Roles -->
<div id="tab-roles" class="tab-panel active">
  <!-- Stats -->
  <div class="stats-bar">
    <div class="stat"><div class="stat-value">${total}</div><div class="stat-label">Active</div></div>
    <div class="stat"><div class="stat-value">${avgScore}</div><div class="stat-label">Avg Score</div></div>
    <div class="stat stat-clickable" onclick="setScoreFilter('9')" title="Show 9–10 only"><div class="stat-value">${count9}</div><div class="stat-label">Score 9–10 ↗</div></div>
    <div class="stat stat-clickable" onclick="setScoreFilter('7')" title="Show 7–8 only"><div class="stat-value">${count7}</div><div class="stat-label">Score 7–8 ↗</div></div>
    <div class="stat stat-clickable" onclick="filterSource('lever',document.querySelector('.source-pill:nth-child(2)'))" title="Filter Lever"><div class="stat-value">${countLever}</div><div class="stat-label">Lever ↗</div></div>
    <div class="stat stat-clickable" onclick="filterSource('linkedin',document.querySelector('.source-pill:nth-child(3)'))" title="Filter LinkedIn"><div class="stat-value">${countLinkedIn}</div><div class="stat-label">LinkedIn ↗</div></div>
    <div class="stat stat-clickable" onclick="filterSource('greenhouse',document.querySelector('.source-pill:nth-child(4)'))" title="Filter Greenhouse"><div class="stat-value">${countGreenhouse}</div><div class="stat-label">Greenhouse ↗</div></div>
  </div>
  <!-- Filters -->
  <div class="filters">
    <input class="search-input" type="text" placeholder="Search title, company, location…" oninput="applyFilters()">
    <select class="filter-select" onchange="applyFilters()" id="sort-select">
      <option value="score">Highest Score</option>
      <option value="newest">Newest</option>
    </select>
    <select class="filter-select" onchange="applyFilters()" id="score-select">
      <option value="all" selected>All Scores</option>
      <option value="9">9–10</option>
      <option value="7">7–8</option>
      <option value="5">5–6</option>
      <option value="1">1–4</option>
    </select>
    <select class="filter-select" onchange="applyFilters()" id="loc-select">
      <option value="all">All Locations</option>
      <option value="new york">New York</option>
      <option value="los angeles">Los Angeles</option>
      <option value="san francisco">San Francisco</option>
      <option value="remote">Remote</option>
    </select>
    <span class="showing" id="showing-count">Showing ${total}</span>
  </div>
  <!-- Grid -->
  <div class="grid" id="jobs-grid">
    ${jobCards}
    <div id="empty-state" class="empty-state" style="display:none;grid-column:1/-1">No jobs match your filters. <a href="#" onclick="resetFilters();return false;" style="color:#6F8F80">Clear filters</a></div>
  </div>
</div>

<!-- Pipeline -->
<div id="tab-pipeline" class="tab-panel">
  <div class="pipeline-wrap">
    ${applications.length === 0
      ? '<div class="empty-state">No pipeline data. Run /job-hunt to scan Gmail for application emails.</div>'
      : pipelineSections}
  </div>
</div>

<!-- Analytics -->
<div id="tab-analytics" class="tab-panel">
  ${analytics ? `
  <div class="analytics-wrap">
    <div class="an-row">
      <div class="an-card">
        <div class="an-card-label">Total Applications</div>
        <div class="an-card-value">${analytics.total}</div>
        <div class="an-card-sub">${analytics.activeCount} active · ${analytics.rejections} rejected</div>
      </div>
      <div class="an-card">
        <div class="an-card-label">Response Rate</div>
        <div class="an-card-value">${analytics.responseRate}%</div>
        <div class="an-card-sub">apps that got past "applied"</div>
      </div>
      <div class="an-card">
        <div class="an-card-label">Median Response</div>
        <div class="an-card-value">${analytics.medianResponseDays !== null ? analytics.medianResponseDays + 'd' : '—'}</div>
        <div class="an-card-sub">days from apply to first reply</div>
      </div>
      <div class="an-card">
        <div class="an-card-label">Cold Rate</div>
        <div class="an-card-value">${analytics.coldRate}%</div>
        <div class="an-card-sub">${analytics.coldCount} of ${analytics.activeCount} active apps idle 14+ days</div>
      </div>
    </div>

    <div class="an-section">
      <h3>Conversion Funnel</h3>
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
          return `<div class="funnel-bar">
            <span class="funnel-label">${label}</span>
            <div class="funnel-track"><div class="funnel-fill" style="width:${pct}%"></div></div>
            <span class="funnel-count">${n} · ${conv}%</span>
          </div>`;
        }).join('');
      })()}
    </div>

    <div class="an-section">
      <h3>Application Velocity (last 8 weeks)</h3>
      <div class="velocity-grid">
        ${(() => {
          const max = Math.max(1, ...analytics.velocityWeeks.map(w => w.count));
          return analytics.velocityWeeks.map(w => {
            const h = (w.count / max) * 100;
            return `<div class="velocity-col">
              <span class="velocity-value">${w.count || ''}</span>
              <div class="velocity-bar" style="height:${h}%"></div>
              <span class="velocity-label">${w.label}</span>
            </div>`;
          }).join('');
        })()}
      </div>
    </div>

    <div class="an-section">
      <h3>Top Companies (by application count)</h3>
      <table class="companies-table">
        <thead><tr><th>Company</th><th>Total</th><th>Advanced</th><th>Pending</th><th>Rejected</th></tr></thead>
        <tbody>
          ${analytics.topCompanies.map(c => `<tr>
            <td><strong>${esc(c.company)}</strong></td>
            <td>${c.total}</td>
            <td>${c.advanced ? `<span class="adv-pill">${c.advanced}</span>` : '—'}</td>
            <td>${c.pending ? `<span class="pen-pill">${c.pending}</span>` : '—'}</td>
            <td>${c.rejected ? `<span class="rej-pill">${c.rejected}</span>` : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>
  ` : '<div class="empty-state">No application data yet. Run the agent to scan Gmail.</div>'}
</div>

<!-- JD preview side panel -->
<div id="jd-overlay" onclick="closeJdPanel()"></div>
<div id="jd-panel" role="dialog" aria-modal="true">
  <div id="jd-header" style="position:relative">
    <div style="flex:1">
      <h2 id="jd-title">—</h2>
      <div class="jd-company" id="jd-company">—</div>
      <div class="jd-meta" id="jd-meta"></div>
      <div class="jd-also-on" id="jd-also-on"></div>
    </div>
    <button id="jd-close" onclick="closeJdPanel()" aria-label="Close">✕</button>
  </div>
  <div id="jd-score-row" style="display:none">
    <div id="jd-score-badge"></div>
    <div id="jd-score-reason"></div>
  </div>
  <div id="jd-body">
    <h4>Description</h4>
    <div id="jd-description"></div>
  </div>
  <div id="jd-footer">
    <a id="jd-btn-apply" class="jd-btn-apply" href="#" target="_blank">Apply ↗</a>
    <button class="jd-btn-view" onclick="markAppliedFromPanel()">+ Mark Applied</button>
    <button class="jd-btn-dismiss" onclick="dismissFromPanel()">× Not a Fit</button>
  </div>
</div>

<!-- Applied -->
<div id="tab-applied" class="tab-panel">
  <div class="grid">${appliedCards}</div>
</div>

<!-- Not a Fit -->
<div id="tab-notfit" class="tab-panel">
  <div class="grid">${notFitCards}</div>
</div>

<script>
let activeSource = 'all';

// ── Init: run default filters on load ────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => applyFilters());

// ── Tabs ─────────────────────────────────────────────────────────────────────
function showTab(name, el) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  el.classList.add('active');
}

// ── Source filter ─────────────────────────────────────────────────────────────
function filterSource(src, btn) {
  activeSource = src;
  document.querySelectorAll('.source-pill').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  applyFilters();
}

// ── Score filter (from stat bar click) ───────────────────────────────────────
function setScoreFilter(val) {
  document.getElementById('score-select').value = val;
  applyFilters();
}

// ── Reset all filters ─────────────────────────────────────────────────────────
function resetFilters() {
  document.querySelector('.search-input').value = '';
  document.getElementById('score-select').value = 'all';
  document.getElementById('loc-select').value = 'all';
  document.getElementById('sort-select').value = 'score';
  activeSource = 'all';
  document.querySelectorAll('.source-pill').forEach((b, i) => b.classList.toggle('active', i === 0));
  applyFilters();
}

// ── Main filter + sort ────────────────────────────────────────────────────────
function applyFilters() {
  const q        = document.querySelector('.search-input').value.toLowerCase();
  const scoreMin = document.getElementById('score-select').value;
  const loc      = document.getElementById('loc-select').value;
  const sortBy   = document.getElementById('sort-select').value;

  const grid  = document.getElementById('jobs-grid');
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
      const max = min <= 1 ? 4 : min + 1;
      if (score < min || score > max) ok = false;
    }
    if (loc !== 'all' && !text.includes(loc)) ok = false;
    card.style.display = ok ? '' : 'none';
    if (ok) shown++;
  });

  // Sort visible cards
  const sorted = [...cards].sort((a, b) => {
    if (sortBy === 'newest') return (b.dataset.date || '').localeCompare(a.dataset.date || '');
    const diff = Number(b.dataset.score) - Number(a.dataset.score);
    return diff !== 0 ? diff : (b.dataset.date || '').localeCompare(a.dataset.date || '');
  });
  sorted.forEach(card => grid.appendChild(card));

  document.getElementById('showing-count').textContent = 'Showing ' + shown;
  if (empty) empty.style.display = shown === 0 ? '' : 'none';
}

// ── Job actions ───────────────────────────────────────────────────────────────
let _nfPendingId = null;

function markNotFit(id) {
  _nfPendingId = id;
  const card = document.querySelector('[data-id="' + id + '"]');
  const title = card?.querySelector('.card-title')?.textContent || '';
  const company = card?.querySelector('.card-company')?.textContent || '';
  document.getElementById('nf-job-label').textContent = (title && company) ? (title + ' — ' + company) : '';
  document.getElementById('nf-reason').value = '';
  document.getElementById('nf-overlay').classList.add('open');
  setTimeout(() => document.getElementById('nf-reason').focus(), 50);
}

function closeNfModal() {
  document.getElementById('nf-overlay').classList.remove('open');
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
    if (card) { card.style.transition = 'opacity 200ms'; card.style.opacity = '0'; setTimeout(() => { card.remove(); applyFilters(); }, 200); }
  });
}

// Escape key + Cmd/Ctrl-Enter to submit
document.addEventListener('keydown', e => {
  if (document.getElementById('nf-overlay').classList.contains('open')) {
    if (e.key === 'Escape') closeNfModal();
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submitNfModal(false);
    return;
  }
  if (document.getElementById('jd-panel').classList.contains('open')) {
    if (e.key === 'Escape') closeJdPanel();
  }
});

// ── JD preview panel ─────────────────────────────────────────────────────────
let _jdCurrentId = null;

const SOURCE_LABELS = { greenhouse: 'Greenhouse', lever: 'Lever', linkedin: 'LinkedIn', serpapi: 'Google', ashby: 'Ashby' };

async function openJdPanel(ev, id) {
  if (ev?.target?.closest('button, a')) return; // ignore clicks on buttons/links inside card
  _jdCurrentId = id;
  document.getElementById('jd-overlay').classList.add('open');
  document.getElementById('jd-panel').classList.add('open');
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
    if (job.location) meta.push('<span class="chip chip-loc">' + escapeHtml(job.location) + '</span>');
    if (job.source)   meta.push('<span class="chip chip-src chip-' + job.source + '">' + (SOURCE_LABELS[job.source] || job.source) + '</span>');
    if (job.salary)   meta.push('<span class="chip chip-salary">' + escapeHtml(job.salary) + '</span>');
    document.getElementById('jd-meta').innerHTML = meta.join('');

    if (job.aliases && job.aliases.length) {
      document.getElementById('jd-also-on').textContent = 'Also seen on: ' + job.aliases.map(a => SOURCE_LABELS[a.source] || a.source).join(', ');
    }

    if (job.score != null) {
      const badge = document.getElementById('jd-score-badge');
      badge.textContent = job.score + '/10';
      badge.style.background = scoreBg(job.score);
      badge.style.color = scoreColor(job.score);
      document.getElementById('jd-score-reason').textContent = job.score_reason || '';
      document.getElementById('jd-score-row').style.display = 'flex';
    }

    const desc = (job.description || '').trim();
    if (desc) {
      document.getElementById('jd-description').textContent = desc;
    } else {
      document.getElementById('jd-description').innerHTML = '<div id="jd-description-empty">No description stored for this job. (LinkedIn jobs without enrichment, or older entries.) Click "Apply" to read on the source site.</div>';
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
  document.getElementById('jd-overlay').classList.remove('open');
  document.getElementById('jd-panel').classList.remove('open');
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
  // Reuse the existing not-a-fit modal flow
  markNotFit(id);
}

function escapeHtml(s) {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function scoreColor(s) {
  if (s == null) return '#9E9289';
  if (s >= 9) return '#3F5F54';
  if (s >= 7) return '#7a5c28';
  if (s >= 5) return '#6B5B4E';
  return '#8a4a35';
}
function scoreBg(s) {
  if (s == null) return '#EFEAE4';
  if (s >= 9) return '#E0EDE8';
  if (s >= 7) return '#F5EDDA';
  if (s >= 5) return '#EEE9E2';
  return '#F5E8E3';
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
      setTimeout(() => { card.remove(); applyFilters(); updateTabCounts(); }, 220);
    }
  });
}

function updateTabCounts() {
  // Decrement Open Roles count, increment Applied count
  const tabs = document.querySelectorAll('.tabs .tab');
  if (tabs[0]) {
    const c = tabs[0].querySelector('.tab-count');
    if (c) c.textContent = Math.max(0, Number(c.textContent) - 1);
  }
  if (tabs[2]) {
    const c = tabs[2].querySelector('.tab-count');
    if (c) c.textContent = Number(c.textContent) + 1;
  }
}

// ── Log drawer ────────────────────────────────────────────────────────────────
let _runEs = null;

function openLogDrawer() {
  document.getElementById('log-drawer').classList.add('open');
  document.getElementById('log-output').innerHTML = '';
  document.getElementById('log-drawer-status').textContent = '';
  document.getElementById('log-drawer-title').textContent = '↻ Running /job-hunt…';
  const bar = document.getElementById('log-progress-bar');
  bar.style.display = 'block';
  bar.style.width = '0%';
  bar.classList.add('indeterminate');
}

function closeLogDrawer() {
  document.getElementById('log-drawer').classList.remove('open');
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

// ── Run agent ─────────────────────────────────────────────────────────────────
function runAgent(btn) {
  if (btn.classList.contains('running')) return;
  btn.classList.add('running');
  btn.textContent = '↻ Running…';
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
        appendLog('⚠  Claude CLI is not authenticated.', 'log-line-err');
        appendLog('', null);
        appendLog('The dashboard runs claude in the background, but it needs', null);
        appendLog('to be logged in separately from the Claude Desktop app.', null);
        appendLog('', null);
        appendLog('One-time fix — open Terminal and run:', null);
        appendLog('', null);
        appendLog('    claude login', 'log-line-tool');
        appendLog('', null);
        appendLog('Follow the browser prompt, then click Refresh again.', null);
      } else if (msg.type === 'done') {
        const bar = document.getElementById('log-progress-bar');
        bar.classList.remove('indeterminate');
        bar.style.width = '100%';
        const ok = msg.code === 0;
        document.getElementById('log-drawer-title').textContent = ok ? '✓ Run complete' : '⚠ Run finished with errors';
        const status = document.getElementById('log-drawer-status');
        if (ok) {
          appendLog('─── Done. Reloading dashboard in 4s… ───', 'log-line-done');
          status.textContent = 'Reloading…';
          setTimeout(() => location.reload(), 4000);
        } else {
          status.textContent = 'Check log for errors';
        }
        btn.textContent = ok ? '✓ Done' : '⚠ Error';
        btn.classList.remove('running');
        setTimeout(() => { btn.textContent = '↻ Refresh'; }, 5000);
        _runEs.close(); _runEs = null;
      } else if (msg.type === 'busy') {
        appendLog('A run is already in progress.', 'log-line-err');
        btn.classList.remove('running'); btn.textContent = '↻ Refresh';
        _runEs.close(); _runEs = null;
      }
    } catch {}
  };

  _runEs.onerror = () => {
    appendLog('Connection lost.', 'log-line-err');
    btn.classList.remove('running'); btn.textContent = '↻ Refresh';
    if (_runEs) { _runEs.close(); _runEs = null; }
  };
}

// ── Pipeline collapse ─────────────────────────────────────────────────────────
function toggleSection(header) {
  header.closest('.pipeline-section').classList.toggle('collapsed');
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

    // Read optional JSON body for not_fit reason
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
      // Read the scheduled-task SKILL.md as the prompt so skills don't need to be packaged
      let prompt = 'Run the full job hunt pipeline: scrape Greenhouse and Lever for new jobs, check LinkedIn for new roles, score any unscored jobs, and scan Gmail for application updates. Then provide a summary.';
      try {
        let raw = readFileSync(resolve(__dirname, '..', '.claude', 'scheduled-task', 'SKILL.md'), 'utf8');
        // Strip YAML front matter (--- ... ---)
        if (raw.startsWith('---')) {
          const end = raw.indexOf('\n---', 3);
          if (end !== -1) raw = raw.slice(end + 4).trim();
        }
        if (raw.length > 50) prompt = raw;
      } catch {}

      const proc = spawn(CLAUDE_BIN, [
        '-p', prompt,
        '--permission-mode', 'bypassPermissions',
        '--chrome',
      ], {
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
        // Detect auth error and send a friendly message
        if (/not logged in|please run \/login/i.test(fullOutput)) {
          send('auth_error', {});
        }
        send('done', { code: code ?? 0 });
        try { res.end(); } catch {}
      });

      req.on('close', () => {
        if (activeRun === proc) { proc.kill(); activeRun = null; }
      });
    });
    return;
  }

  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    const jobs        = getJobs();
    const notFitJobs  = getNotFitJobs();
    const appliedJobs = getAppliedJobs();
    const rawApplications = getApplications();
    // Dedupe by (company, role) — keep the most-advanced status. Same logic
    // used for analytics so the Pipeline tab counts/sections match the
    // Analytics tab numbers.
    const applications = dedupeApplications(rawApplications);
    const analytics  = computeAnalytics(rawApplications);
    const html = renderPage(jobs, notFitJobs, appliedJobs, applications, analytics);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // API endpoint for the JD preview pane
  if (req.method === 'GET' && /^\/api\/jobs\/(\d+)$/.test(path)) {
    const id = Number(path.match(/^\/api\/jobs\/(\d+)$/)[1]);
    const db = openJobsDb();
    if (!db) { res.writeHead(500); res.end(); return; }
    try {
      const row = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
      // Include any cross-source aliases
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
