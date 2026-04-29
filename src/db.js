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
