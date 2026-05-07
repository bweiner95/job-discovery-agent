/**
 * scripts/enrich-linkedin-descriptions.js
 *
 * Reads a JSON array of { job_id, description } objects from stdin and
 * updates the corresponding LinkedIn rows in jobs.db. Used after the agent
 * navigates into each LinkedIn job page and extracts the description text.
 *
 * Input shape:
 * [
 *   { "job_id": "4404502134", "description": "About the role: ..." },
 *   ...
 * ]
 *
 * Output: { "updated": N, "skipped": M }
 */

import { DatabaseSync } from 'node:sqlite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, '..', 'jobs.db');

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();

  let items;
  try {
    items = JSON.parse(raw);
  } catch {
    process.stderr.write('ERROR: Could not parse JSON array from stdin\n');
    process.exit(1);
  }

  if (!Array.isArray(items)) {
    process.stderr.write('ERROR: Input must be a JSON array\n');
    process.exit(1);
  }

  const db = new DatabaseSync(DB_PATH);
  let updated = 0;
  let skipped = 0;

  for (const item of items) {
    if (!item.job_id || !item.description) { skipped++; continue; }
    const desc = String(item.description).slice(0, 8000);
    // Update both the linkedin row AND any cross-source canonical row that
    // references it (so a Whatnot Director duplicate still gets the JD).
    const r = db.prepare(`
      UPDATE jobs SET description = ?
      WHERE source = 'linkedin' AND job_id = ?
        AND (description IS NULL OR length(description) < ?)
    `).run(desc, String(item.job_id), desc.length);

    // Also propagate to canonical row if this LinkedIn row is a duplicate
    const linkedinRow = db.prepare(`SELECT id, duplicate_of FROM jobs WHERE source = 'linkedin' AND job_id = ?`).get(String(item.job_id));
    if (linkedinRow?.duplicate_of) {
      db.prepare(`
        UPDATE jobs SET description = ?
        WHERE id = ? AND (description IS NULL OR length(description) < ?)
      `).run(desc, linkedinRow.duplicate_of, desc.length);
    }

    if (r.changes > 0) updated++; else skipped++;
  }

  db.close();
  process.stdout.write(JSON.stringify({ updated, skipped, total: items.length }));
}

main().catch(err => { process.stderr.write(`ERROR: ${err.message}\n`); process.exit(1); });
