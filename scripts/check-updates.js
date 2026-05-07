/**
 * scripts/check-updates.js
 *
 * Checks the upstream GitHub repo for new commits since the user last pulled,
 * and prints a friendly notice if updates are available. Throttled to once
 * per CHECK_INTERVAL_DAYS (default 7) so it doesn't burn time on every run.
 *
 * State file (.update-check) records:
 *   - lastCheck:   ISO timestamp of the most recent successful check
 *   - lastSeenSha: the SHA the user is locally on at that time
 *
 * Behaviour:
 *   - Silent if checked within CHECK_INTERVAL_DAYS and nothing new
 *   - Silent if offline / GitHub unreachable
 *   - Prints a list of new commits + `git pull` hint when updates exist
 *   - Pass --force to ignore the throttle (e.g. for manual checks)
 *
 * Used by `src/index.js` on every run, but most invocations are no-ops
 * because of the throttle. Exit code is always 0 — this script never
 * blocks the agent flow.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const STATE_FILE = resolve(REPO_ROOT, '.update-check');
const CHECK_INTERVAL_DAYS = 7;

// ─── Helpers ───────────────────────────────────────────────────────────────

function readState() {
  if (!existsSync(STATE_FILE)) return null;
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

function writeState(state) {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n'); } catch {}
}

function daysSince(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 86_400_000;
}

function readPackageRepo() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
    const url = pkg.repository?.url ?? '';
    // Match owner/repo from common URL forms (https / ssh / git+https)
    const m = url.match(/github\.com[/:]([\w-]+)\/([\w.-]+?)(?:\.git)?(?:\/|$)/);
    if (m) return { owner: m[1], repo: m[2] };
  } catch {}
  return null;
}

function readCurrentSha() {
  try {
    return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch { return null; }
}

async function fetchRecentCommits(owner, repo) {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits?per_page=20`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'job-discovery-agent-update-check',
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  return res.json();
}

// ─── Main ──────────────────────────────────────────────────────────────────

const FORCE = process.argv.includes('--force');
const QUIET = process.argv.includes('--quiet'); // skip "no updates" message

async function main() {
  const repoInfo = readPackageRepo();
  if (!repoInfo) return; // No repository configured — silent

  const state = readState();

  if (!FORCE && state?.lastCheck && daysSince(state.lastCheck) < CHECK_INTERVAL_DAYS) {
    return; // Recent check — silent
  }

  let commits;
  try {
    commits = await fetchRecentCommits(repoInfo.owner, repoInfo.repo);
  } catch {
    // Network / API failure — write a soft "tried but failed" mark so we don't
    // keep retrying every run, but reset to a short cooldown.
    writeState({ ...(state ?? {}), lastCheck: new Date().toISOString(), error: 'fetch_failed' });
    return;
  }

  const localSha = readCurrentSha();
  const remoteSha = commits[0]?.sha;

  // If we can't read the local SHA (not a git checkout), still record the
  // remote SHA so we can detect changes between runs going forward.
  if (!localSha) {
    writeState({ lastCheck: new Date().toISOString(), lastSeenSha: remoteSha ?? null });
    return;
  }

  if (localSha === remoteSha) {
    writeState({ lastCheck: new Date().toISOString(), lastSeenSha: localSha });
    if (!QUIET) {
      // Print only if we just did a real check (not on every run)
      console.log(`📦 Update check: you're on the latest version (${localSha.slice(0, 7)}).`);
    }
    return;
  }

  // We're behind — find which of the remote commits are new
  const newCommits = [];
  for (const c of commits) {
    if (c.sha === localSha) break; // caught up
    newCommits.push(c);
  }

  console.log('');
  console.log('━━━ 📦 Update Available ━━━');
  console.log(`Your local copy is behind ${repoInfo.owner}/${repoInfo.repo} by ${newCommits.length}+ commit(s).`);
  console.log('');
  console.log('Recent changes upstream:');
  for (const c of newCommits.slice(0, 10)) {
    const sha = c.sha.slice(0, 7);
    const msg = (c.commit?.message ?? '').split('\n')[0].slice(0, 88);
    console.log(`  • ${sha}  ${msg}`);
  }
  if (newCommits.length > 10) {
    console.log(`  …and ${newCommits.length - 10} more`);
  }
  console.log('');
  console.log('To update:  cd into the repo and run `git pull`');
  console.log(`(Next auto-check in ~${CHECK_INTERVAL_DAYS} days. Run \`npm run check-updates -- --force\` to re-check now.)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  writeState({
    lastCheck: new Date().toISOString(),
    lastSeenSha: localSha,
    remoteSha,
    commitsBehind: newCommits.length,
  });
}

main().catch(() => { /* never block — silent on unexpected error */ });
