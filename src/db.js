// Uses Node.js built-in sqlite (stable since v22.15.0 — no native compilation needed)
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'jobs.db');

let _db;

function getDb() {
  if (!_db) {
    _db = new DatabaseSync(DB_PATH);
    _db.exec('PRAGMA journal_mode = WAL');
    initSchema(_db);
  }
  return _db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      source       TEXT    NOT NULL,
      job_id       TEXT    NOT NULL,
      title        TEXT,
      company      TEXT,
      location     TEXT,
      url          TEXT,
      external_url TEXT,
      salary       TEXT,
      description  TEXT,
      posted_at    TEXT,
      score        INTEGER,
      score_reason TEXT,
      status       TEXT    DEFAULT 'active',
      not_fit_reason TEXT,
      duplicate_of INTEGER,
      emailed      INTEGER DEFAULT 0,
      created_at   TEXT    DEFAULT (datetime('now')),
      UNIQUE(source, job_id)
    );

    CREATE TABLE IF NOT EXISTS runs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ran_at       TEXT    DEFAULT (datetime('now')),
      jobs_found   INTEGER DEFAULT 0,
      jobs_emailed INTEGER DEFAULT 0
    );
  `);

  // Idempotent migrations for older DBs
  try { db.exec(`ALTER TABLE jobs ADD COLUMN duplicate_of INTEGER`); } catch {}
  try { db.exec(`ALTER TABLE jobs ADD COLUMN status TEXT DEFAULT 'active'`); } catch {}
  try { db.exec(`ALTER TABLE jobs ADD COLUMN not_fit_reason TEXT`); } catch {}
}

// ─── Cross-source duplicate detection ────────────────────────────────────────

function normalizeText(s) {
  return (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(inc|llc|corp|corporation|the|a|an|and)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find an existing canonical job that matches this one across sources.
 * Match keys: normalized company AND title share at least 70% of tokens.
 * Returns the canonical (non-duplicate) row, or null.
 */
export function findCrossSourceDuplicate({ company, title, sourceToSkip }) {
  const db = getDb();
  const normCompany = normalizeText(company);
  const normTitle = normalizeText(title);
  if (!normCompany || !normTitle) return null;
  const titleTokens = new Set(normTitle.split(' ').filter(t => t.length >= 3));
  if (titleTokens.size === 0) return null;

  // Pull all jobs with the same normalized company. Cheap because we filter
  // by company name first; cross-source dupes within a company are rare so
  // this is bounded.
  const candidates = db.prepare(`
    SELECT id, source, title, company, duplicate_of
    FROM jobs
    WHERE LOWER(company) LIKE ?
      AND duplicate_of IS NULL
      ${sourceToSkip ? 'AND source != ?' : ''}
  `).all(`%${normCompany.split(' ')[0]}%`, ...(sourceToSkip ? [sourceToSkip] : []));

  for (const c of candidates) {
    if (normalizeText(c.company) !== normCompany) continue;
    const cTokens = new Set(normalizeText(c.title).split(' ').filter(t => t.length >= 3));
    if (cTokens.size === 0) continue;
    // Jaccard similarity
    let intersection = 0;
    for (const t of titleTokens) if (cTokens.has(t)) intersection++;
    const union = titleTokens.size + cTokens.size - intersection;
    const sim = intersection / union;
    if (sim >= 0.7) return c;
  }
  return null;
}

/**
 * Mark `jobId` as a duplicate of `canonicalId`. Also backfill richer fields
 * (description, salary, external_url) from whichever row has them onto the
 * canonical row, so the user's view never loses information.
 */
export function markAsDuplicate(jobId, canonicalId) {
  const db = getDb();
  const dup = db.prepare(`SELECT description, salary, external_url FROM jobs WHERE id = ?`).get(jobId);
  const canon = db.prepare(`SELECT description, salary, external_url FROM jobs WHERE id = ?`).get(canonicalId);
  if (dup && canon) {
    const mergedDesc = (canon.description && canon.description.length >= (dup.description?.length ?? 0))
      ? canon.description : (dup.description ?? canon.description);
    const mergedSalary = canon.salary || dup.salary;
    const mergedExternalUrl = canon.external_url || dup.external_url;
    db.prepare(`
      UPDATE jobs SET description = ?, salary = ?, external_url = ?
      WHERE id = ?
    `).run(mergedDesc, mergedSalary, mergedExternalUrl, canonicalId);
  }
  db.prepare(`UPDATE jobs SET duplicate_of = ? WHERE id = ?`).run(canonicalId, jobId);
}

export function isFirstRun() {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM runs').get();
  return Number(row.cnt) === 0;
}

export function hasJob(source, jobId) {
  const db = getDb();
  return !!db.prepare('SELECT id FROM jobs WHERE source = ? AND job_id = ?').get(source, jobId);
}

export function findJobBySourceAndJobId(source, jobId) {
  const db = getDb();
  return db.prepare('SELECT id FROM jobs WHERE source = ? AND job_id = ?').get(source, jobId) ?? null;
}

export function insertJob(job) {
  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO jobs (source, job_id, title, company, location, url, external_url, salary, description, posted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.source,
      job.job_id,
      job.title        || null,
      job.company      || null,
      job.location     || null,
      job.url          || null,
      job.external_url || null,
      job.salary       || null,
      (job.description || '').slice(0, 4000),
      job.posted_at    || null,
    );
    return true;
  } catch (err) {
    // UNIQUE constraint — already in DB
    if (String(err.message).includes('UNIQUE')) return false;
    throw err;
  }
}

export function updateJobScore(source, jobId, score, scoreReason) {
  getDb()
    .prepare('UPDATE jobs SET score = ?, score_reason = ? WHERE source = ? AND job_id = ?')
    .run(score, scoreReason, source, jobId);
}

export function getEmailableJobs(minScore) {
  return getDb()
    .prepare('SELECT * FROM jobs WHERE score >= ? AND emailed = 0 ORDER BY score DESC, created_at DESC')
    .all(minScore);
}

export function markEmailed(ids) {
  const db = getDb();
  const stmt = db.prepare('UPDATE jobs SET emailed = 1 WHERE id = ?');
  for (const id of ids) stmt.run(id);
}

export function recordRun(jobsFound, jobsEmailed) {
  getDb()
    .prepare('INSERT INTO runs (jobs_found, jobs_emailed) VALUES (?, ?)')
    .run(jobsFound, jobsEmailed);
}
