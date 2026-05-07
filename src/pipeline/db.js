import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// pipeline.db lives at the project root (same level as jobs.db)
const DB_PATH = path.join(__dirname, '..', '..', 'pipeline.db');

let _db = null;

function getDb() {
  if (!_db) {
    _db = new DatabaseSync(DB_PATH);
    initSchema(_db);
  }
  return _db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gmail_thread_id TEXT UNIQUE,
      company TEXT NOT NULL,
      role TEXT,
      date_applied TEXT,
      current_status TEXT DEFAULT 'applied',
      last_activity_date TEXT,
      next_step TEXT,
      notes TEXT,
      is_cold INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS email_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER REFERENCES applications(id),
      gmail_message_id TEXT UNIQUE,
      event_type TEXT,
      event_date TEXT,
      subject TEXT,
      snippet TEXT,
      processed_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ran_at TEXT DEFAULT (datetime('now')),
      emails_scanned INTEGER DEFAULT 0,
      new_applications INTEGER DEFAULT 0,
      updated_applications INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

// ─── Run tracking ────────────────────────────────────────────────────────────

export function isFirstRun() {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'last_run_at'`).get();
  return !row || !row.value;
}

export function recordRun(stats = {}) {
  const db = getDb();
  db.prepare(`
    INSERT INTO runs (emails_scanned, new_applications, updated_applications)
    VALUES (?, ?, ?)
  `).run(
    stats.emailsScanned ?? 0,
    stats.newApplications ?? 0,
    stats.updatedApplications ?? 0
  );
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('last_run_at', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = datetime('now')
  `).run();
}

// ─── Application CRUD ────────────────────────────────────────────────────────

export function getApplication(threadId) {
  const db = getDb();
  return db.prepare(`SELECT * FROM applications WHERE gmail_thread_id = ?`).get(threadId) ?? null;
}

/**
 * Find the most recent active application for a company. Used when a sent
 * thank-you note creates a new Gmail thread that doesn't match the existing
 * recruiter thread — we still want to advance the existing application's status
 * rather than create a duplicate row.
 */
export function findActiveApplicationByCompany(company) {
  if (!company) return null;
  const db = getDb();
  return db.prepare(`
    SELECT * FROM applications
    WHERE LOWER(company) = LOWER(?)
      AND current_status NOT IN ('rejection', 'offer')
    ORDER BY last_activity_date DESC, id DESC
    LIMIT 1
  `).get(company) ?? null;
}

/**
 * Insert or update an application record.
 */
export function upsertApplication(data) {
  const db = getDb();
  const existing = getApplication(data.gmail_thread_id);

  if (!existing) {
    const result = db.prepare(`
      INSERT INTO applications
        (gmail_thread_id, company, role, date_applied, current_status,
         last_activity_date, next_step, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.gmail_thread_id,
      data.company,
      data.role ?? null,
      data.date_applied ?? null,
      data.current_status ?? 'applied',
      data.last_activity_date ?? null,
      data.next_step ?? null,
      data.notes ?? null
    );
    return { id: result.lastInsertRowid, isNew: true };
  }

  // Merge: only update fields that represent progression or new info
  const statusPriority = {
    applied: 0,
    application_submitted: 0,
    application_viewed: 1,
    recruiter_outreach: 2,
    interview_follow_up: 3,
    interview_scheduled: 4,
    take_home_submitted: 5,
    offer: 6,
    rejection: 6,
    unknown: -1,
  };

  const existingPriority = statusPriority[existing.current_status] ?? 0;
  const newPriority = statusPriority[data.current_status] ?? 0;
  const updatedStatus = newPriority > existingPriority
    ? data.current_status
    : existing.current_status;

  db.prepare(`
    UPDATE applications SET
      company = COALESCE(?, company),
      role = COALESCE(?, role),
      date_applied = COALESCE(date_applied, ?),
      current_status = ?,
      last_activity_date = COALESCE(?, last_activity_date),
      next_step = COALESCE(?, next_step),
      notes = COALESCE(?, notes),
      updated_at = datetime('now')
    WHERE gmail_thread_id = ?
  `).run(
    data.company ?? null,
    data.role ?? null,
    data.date_applied ?? null,
    updatedStatus,
    data.last_activity_date ?? null,
    data.next_step ?? null,
    data.notes ?? null,
    data.gmail_thread_id
  );

  return { id: existing.id, isNew: false };
}

// ─── Email events ─────────────────────────────────────────────────────────────

export function addEmailEvent(data) {
  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO email_events
        (application_id, gmail_message_id, event_type, event_date, subject, snippet)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      data.application_id,
      data.gmail_message_id,
      data.event_type ?? null,
      data.event_date ?? null,
      data.subject ?? null,
      data.snippet ?? null
    );
    return true;
  } catch (err) {
    // UNIQUE constraint on gmail_message_id — already processed
    if (err.message?.includes('UNIQUE')) return false;
    throw err;
  }
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function getAllApplications() {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM applications ORDER BY last_activity_date DESC, created_at DESC
  `).all();
}

export function getApplicationsByStatus(status) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM applications WHERE current_status = ?
    ORDER BY last_activity_date DESC
  `).all(status);
}

/**
 * Flag applications with no activity in `dayThreshold` days as cold.
 * Uses company-level recency: if ANY thread for a company has recent activity,
 * none of that company's applications are marked cold.
 */
export function markColdApplications(dayThreshold = 14) {
  const db = getDb();
  // Reset all
  db.prepare(`UPDATE applications SET is_cold = 0`).run();
  // Mark cold: non-terminal statuses AND company has no recent activity across any thread
  db.prepare(`
    UPDATE applications SET is_cold = 1
    WHERE current_status NOT IN ('offer', 'rejection', 'take_home_submitted')
      AND company NOT IN (
        SELECT DISTINCT company FROM applications
        WHERE last_activity_date IS NOT NULL
          AND julianday('now') - julianday(last_activity_date) < ?
      )
  `).run(dayThreshold);
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export function getSetting(key) {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  return row?.value ?? null;
}

export function setSetting(key, value) {
  const db = getDb();
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = ?
  `).run(key, value, value);
}
