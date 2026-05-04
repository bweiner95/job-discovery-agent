/**
 * scripts/process-emails.js
 *
 * Reads a JSON array of email objects from stdin, classifies each one,
 * upserts applications + email events into the SQLite pipeline database,
 * flags cold applications, and prints a summary JSON to stdout.
 *
 * Called by the job-hunt Claude skill after Gmail MCP fetches emails.
 *
 * Input JSON shape (array):
 * [
 *   {
 *     "threadId": "string",        // Gmail thread ID (used as application key)
 *     "messageId": "string",       // Gmail message ID (unique per email)
 *     "subject": "string",
 *     "from": "string",            // sender email address
 *     "to": "string",
 *     "body": "string",            // plain text body
 *     "snippet": "string",
 *     "date": "string"             // ISO date string or RFC 2822
 *   }
 * ]
 *
 * Output JSON (stdout):
 * {
 *   "emailsProcessed": 12,
 *   "newApplications": 5,
 *   "updatedApplications": 4,
 *   "skipped": 3,
 *   "coldApplications": 2,
 *   "events": [
 *     { "company": "Snap", "role": "Head of Growth", "eventType": "interview_scheduled", "isNew": true }
 *   ]
 * }
 */

import { classifyEmail, eventTypeToStatus } from '../src/pipeline/classifier.js';
import {
  isFirstRun,
  upsertApplication,
  addEmailEvent,
  markColdApplications,
  recordRun,
} from '../src/pipeline/db.js';

function toIsoDate(dateStr) {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split('T')[0];
  } catch {
    return null;
  }
}

async function main() {
  // Read stdin
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();

  let emails;
  try {
    emails = JSON.parse(raw);
  } catch {
    process.stderr.write('ERROR: Could not parse JSON array from stdin\n');
    process.exit(1);
  }

  if (!Array.isArray(emails)) {
    process.stderr.write('ERROR: Input must be a JSON array of email objects\n');
    process.exit(1);
  }

  const stats = {
    emailsProcessed: emails.length,
    newApplications: 0,
    updatedApplications: 0,
    skipped: 0,
    coldApplications: 0,
    events: [],
  };

  const CUTOFF = '2026-04-01';

  // Filter out any emails with a date before April 1, 2026
  const filtered = emails.filter(email => {
    if (!email.date) return true; // no date = include (can't determine)
    const d = email.date.slice(0, 10);
    return d >= CUTOFF;
  });

  const skippedOld = emails.length - filtered.length;
  if (skippedOld > 0) {
    process.stderr.write(`Skipped ${skippedOld} email(s) dated before ${CUTOFF}\n`);
    stats.emailsProcessed = filtered.length;
    stats.skipped += skippedOld;
  }

  for (const email of filtered) {
    const classification = classifyEmail({
      subject: email.subject ?? '',
      from: email.from ?? '',
      body: email.body ?? '',
      snippet: email.snippet ?? '',
      to: email.to ?? '',
    });

    // Skip very low-confidence unknowns
    if (classification.eventType === 'unknown' && classification.confidence < 0.4) {
      stats.skipped++;
      continue;
    }

    const status = eventTypeToStatus(classification.eventType);
    const eventDate = toIsoDate(email.date) ?? new Date().toISOString().split('T')[0];
    const dateApplied =
      classification.eventType === 'application_submitted' ? eventDate : null;

    const threadId = email.threadId || email.thread_id || email.messageId || email.id;
    if (!threadId) {
      stats.skipped++;
      continue;
    }

    const result = upsertApplication({
      gmail_thread_id: threadId,
      company: classification.company,
      role: classification.role ?? null,
      date_applied: dateApplied,
      current_status: status,
      last_activity_date: eventDate,
      next_step: null,
      notes: null,
    });

    if (result.isNew) {
      stats.newApplications++;
    } else {
      stats.updatedApplications++;
    }

    const msgId = email.messageId || email.id || threadId;
    addEmailEvent({
      application_id: result.id,
      gmail_message_id: msgId,
      event_type: classification.eventType,
      event_date: eventDate,
      subject: email.subject ?? null,
      snippet: (email.snippet ?? '').slice(0, 200) || null,
    });

    stats.events.push({
      company: classification.company,
      role: classification.role ?? null,
      eventType: classification.eventType,
      status,
      isNew: result.isNew,
    });
  }

  // Flag stale applications as cold (7+ days no activity)
  markColdApplications(7);

  // Count cold apps
  const { DatabaseSync } = await import('node:sqlite');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const db = new DatabaseSync(path.join(__dirname, '..', 'pipeline.db'));
  const coldRow = db.prepare(`SELECT COUNT(*) as n FROM applications WHERE is_cold = 1`).get();
  stats.coldApplications = coldRow?.n ?? 0;
  db.close();

  // Record this run
  recordRun({
    emailsScanned: stats.emailsProcessed,
    newApplications: stats.newApplications,
    updatedApplications: stats.updatedApplications,
  });

  process.stdout.write(JSON.stringify(stats, null, 2));
}

main().catch(err => {
  process.stderr.write(`ERROR: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
