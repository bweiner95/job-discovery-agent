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
      SELECT * FROM jobs WHERE (status IS NULL OR status IN ('active', 'applied'))
      ORDER BY score DESC NULLS LAST, created_at DESC
    `).all();
    db.close();
    return rows;
  } catch { return []; }
}

function getNotFitJobs() {
  const db = openJobsDb();
  if (!db) return [];
  try {
    const rows = db.prepare(`SELECT * FROM jobs WHERE status = 'not_fit' ORDER BY created_at DESC`).all();
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

function updateJobStatus(id, status) {
  const db = openJobsDb();
  if (!db) return false;
  try {
    db.prepare(`UPDATE jobs SET status = ? WHERE id = ?`).run(status, id);
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
  const map = { greenhouse: 'Greenhouse', lever: 'Lever', linkedin: 'LinkedIn', serpapi: 'Google' };
  return map[source] || source;
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function applyUrl(job) {
  return job.external_url || job.url || '#';
}

function viewButtonLabel(source) {
  const map = { linkedin: 'View on LinkedIn', greenhouse: 'View on Greenhouse', lever: 'View on Lever', serpapi: 'View Job' };
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

function renderPage(jobs, notFitJobs, applications) {
  const total    = jobs.length;
  const scores   = jobs.map(j => j.score).filter(s => s != null);
  const avgScore = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : '—';
  const count9   = jobs.filter(j => j.score >= 9).length;
  const count7   = jobs.filter(j => j.score >= 7 && j.score <= 8).length;
  const countLever      = jobs.filter(j => j.source === 'lever').length;
  const countLinkedIn   = jobs.filter(j => j.source === 'linkedin').length;
  const countGreenhouse = jobs.filter(j => j.source === 'greenhouse').length;

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

    return `
<div class="job-card${isApplied ? ' is-applied' : ''}" data-score="${score ?? 0}" data-source="${esc(src)}" data-id="${job.id}" data-date="${esc(job.created_at || '')}">
  <button class="dismiss-btn" title="Not a fit" onclick="markNotFit(${job.id})">×</button>
  ${score != null ? `<div class="score-badge" style="background:${scoreBg(score)};color:${scoreColor(score)}">${score}<span>/10</span></div>` : `<div class="score-badge" style="background:#EFEAE4;color:#9E9289">—</div>`}
  <div class="card-body">
    <div class="card-title">${esc(job.title || '')}</div>
    <div class="card-company">${esc(job.company || '')}</div>
    <div class="card-chips">
      ${job.location ? `<span class="chip chip-loc">${esc(job.location)}</span>` : ''}
      <span class="chip chip-src chip-${esc(src)}">${sourceLabel(src)}</span>
      ${job.salary ? `<span class="chip chip-salary">${esc(job.salary)}</span>` : ''}
    </div>
    ${rationale ? `<div class="card-snippet">${esc(rationale)}</div>` : ''}
    <div class="card-footer">
      <span class="card-date">${dateStr}</span>
      <div class="card-actions">
        <button class="btn-applied${isApplied ? ' active' : ''}" onclick="toggleApplied(this, ${job.id})">${isApplied ? '✓ Applied' : '+ Applied'}</button>
        ${hasUrl ? `<a class="btn-view" href="${esc(url)}" target="_blank">${viewButtonLabel(src)} ↗</a>` : ''}
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
    <div class="card-footer">
      <span class="card-date">${fmtDate(job.created_at)}</span>
      <div class="card-actions">
        <button class="btn-applied" onclick="restoreJob(${job.id})">↩ Restore</button>
      </div>
    </div>
  </div>
</div>`).join('');

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
.job-card.dimmed{opacity:.5}
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
</style>
</head>
<body>

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
    </div>
  </div>
</div>

<!-- Tabs -->
<div class="tabs">
  <div class="tab active" onclick="showTab('roles',this)">Open Roles <span class="tab-count">${total}</span></div>
  <div class="tab" onclick="showTab('pipeline',this)">Pipeline <span class="tab-count">${applications.length}</span></div>
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
function markNotFit(id) {
  fetch('/api/jobs/' + id + '/notfit', { method: 'POST' }).then(() => {
    const card = document.querySelector('[data-id="' + id + '"]');
    if (card) { card.style.transition = 'opacity 200ms'; card.style.opacity = '0'; setTimeout(() => { card.remove(); applyFilters(); }, 200); }
  });
}

function restoreJob(id) {
  fetch('/api/jobs/' + id + '/restore', { method: 'POST' }).then(() => location.reload());
}

function toggleApplied(btn, id) {
  const wasApplied = btn.classList.contains('active');
  const action = wasApplied ? 'unapplied' : 'applied';
  fetch('/api/jobs/' + id + '/' + action, { method: 'POST' }).then(r => {
    if (!r.ok) return;
    btn.classList.toggle('active', !wasApplied);
    btn.textContent = wasApplied ? '+ Applied' : '✓ Applied';
    const card = btn.closest('.job-card');
    if (card) card.classList.toggle('is-applied', !wasApplied);
  });
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
    updateJobStatus(Number(id), statusMap[action]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
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
    const applications = getApplications();
    const html = renderPage(jobs, notFitJobs, applications);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
