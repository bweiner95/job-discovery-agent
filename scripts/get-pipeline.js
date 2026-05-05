/**
 * scripts/get-pipeline.js
 *
 * Reads all applications from the SQLite pipeline database and prints
 * a structured JSON summary to stdout. Called by the Claude skill to
 * format the dashboard and report pipeline status.
 *
 * Output JSON:
 * {
 *   "total": 42,
 *   "byStatus": {
 *     "offer": [...],
 *     "interview_scheduled": [...],
 *     "interview_follow_up": [...],
 *     "recruiter_outreach": [...],
 *     "application_viewed": [...],
 *     "applied": [...],
 *     "rejection": [...]
 *   },
 *   "cold": [...],
 *   "generatedAt": "2026-04-22"
 * }
 */

import { getAllApplications } from '../src/pipeline/db.js';

const STATUS_ORDER = [
  'offer',
  'interview_scheduled',
  'take_home_submitted',
  'interview_follow_up',
  'recruiter_outreach',
  'application_viewed',
  'applied',
  'rejection',
];

function main() {
  const apps = getAllApplications();

  const byStatus = Object.fromEntries(STATUS_ORDER.map(s => [s, []]));

  for (const app of apps) {
    const bucket = byStatus[app.current_status] ?? byStatus['applied'];
    bucket.push({
      id: app.id,
      company: app.company,
      role: app.role,
      dateApplied: app.date_applied,
      lastActivity: app.last_activity_date,
      nextStep: app.next_step,
      isCold: !!app.is_cold,
    });
  }

  const cold = apps
    .filter(a => a.is_cold && !['offer', 'rejection'].includes(a.current_status))
    .map(a => ({ company: a.company, role: a.role, lastActivity: a.last_activity_date }));

  const output = {
    total: apps.length,
    byStatus,
    cold,
    generatedAt: new Date().toISOString().split('T')[0],
  };

  process.stdout.write(JSON.stringify(output, null, 2));
}

main();
