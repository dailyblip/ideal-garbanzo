import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'Equinix';
const BROAD_SOURCE = 'Equinix official careers';
const MAX_FALLBACK_AGE_HOURS = Number(process.env.EQUINIX_FALLBACK_MAX_HOURS || 96);

if (!Number.isFinite(MAX_FALLBACK_AGE_HOURS) || MAX_FALLBACK_AGE_HOURS <= 0) {
  throw new Error('EQUINIX_FALLBACK_MAX_HOURS must be a positive number.');
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const isBroadEquinix = job => clean(job?.company) === COMPANY && clean(job?.source) === BROAD_SOURCE;

function sourceIsAuthoritative(diagnostic) {
  if (!diagnostic || typeof diagnostic !== 'object') return false;
  const attempted = Number(diagnostic.listingPagesAttempted || 0);
  const succeeded = Number(diagnostic.listingPagesSucceeded || 0);
  return diagnostic.authoritative === true && diagnostic.listingComplete === true && attempted > 0 && succeeded === attempted;
}

function fallbackIsActive(diagnostic) {
  if (!diagnostic || sourceIsAuthoritative(diagnostic)) return false;
  return Number(diagnostic.fallbackRetained || 0) > 0 || Number(diagnostic.preservedOnFailure || 0) > 0;
}

function freshnessDecision({ verifiedAt, nowMs, sourceHealthy }) {
  if (sourceHealthy) return { expired: false, active: false, expiresAt: null, ageHours: 0 };
  const verifiedMs = Date.parse(String(verifiedAt || ''));
  if (!Number.isFinite(verifiedMs)) return { expired: true, active: false, expiresAt: null, ageHours: null };
  const expiresAt = verifiedMs + MAX_FALLBACK_AGE_HOURS * 60 * 60 * 1000;
  const ageHours = Math.max(0, (nowMs - verifiedMs) / 36e5);
  return { expired: nowMs >= expiresAt, active: nowMs < expiresAt, expiresAt, ageHours };
}

async function historicalCollectorStatuses(limit = 80) {
  let commits = [];
  try {
    const { stdout } = await exec('git', ['log', '--format=%H%x09%cI', `-${limit}`, '--', STATUS_PATH], { maxBuffer: 1024 * 1024 });
    commits = stdout.split(/\r?\n/).map(line => {
      const [sha, committedAt] = line.trim().split('\t');
      return { sha, committedAt };
    }).filter(entry => entry.sha);
  } catch {
    return [];
  }

  const statuses = [];
  for (const { sha, committedAt } of commits) {
    try {
      const { stdout } = await exec('git', ['show', `${sha}:${STATUS_PATH}`], { maxBuffer: 8 * 1024 * 1024 });
      statuses.push({ sha, committedAt, status: JSON.parse(stdout) });
    } catch {
      // Keep walking history if an individual status file cannot be read.
    }
  }
  return statuses;
}

async function lastAuthoritativeVerification(history) {
  for (const entry of history) {
    const diagnostic = entry.status?.priorityEmployerExpansion?.Equinix;
    if (!sourceIsAuthoritative(diagnostic)) continue;
    // Prefer an explicit source check time. Otherwise use the commit that recorded
    // the authoritative result before falling back to the status file's global time.
    const timestamp = diagnostic?.checkedAt || entry.committedAt || entry.status?.updatedAt;
    const parsed = Date.parse(String(timestamp || ''));
    if (Number.isFinite(parsed)) return { at: parsed, sha: entry.sha };
  }
  return null;
}

function runSelfTest() {
  const now = Date.parse('2026-09-10T12:00:00Z');
  const healthy = freshnessDecision({ sourceHealthy: true, verifiedAt: '2026-09-01T00:00:00Z', nowMs: now });
  if (healthy.active || healthy.expired) throw new Error('healthy Equinix source incorrectly entered fallback mode');
  const fresh = freshnessDecision({ sourceHealthy: false, verifiedAt: '2026-09-06T13:00:00Z', nowMs: now });
  if (!fresh.active || fresh.expired) throw new Error('Equinix fallback expired before 96 hours');
  const boundary = freshnessDecision({ sourceHealthy: false, verifiedAt: '2026-09-06T12:00:00Z', nowMs: now });
  if (!boundary.expired) throw new Error('Equinix fallback did not expire at 96 hours');
  const unknown = freshnessDecision({ sourceHealthy: false, verifiedAt: null, nowMs: now });
  if (!unknown.expired) throw new Error('Equinix fallback without verification evidence did not fail closed');
  console.log('Equinix broad-source fallback freshness regression tests passed.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

const jobs = await readJson(JOBS_PATH, []);
const status = await readJson(STATUS_PATH, {});
if (!Array.isArray(jobs)) throw new Error(`${JOBS_PATH} must contain an array.`);
if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error(`${STATUS_PATH} must contain an object.`);

const diagnostic = status?.priorityEmployerExpansion?.Equinix;
if (!diagnostic || typeof diagnostic !== 'object') {
  console.log('Equinix broad-source diagnostics are not present yet; freshness enforcement is deferred.');
  process.exit(0);
}

if (sourceIsAuthoritative(diagnostic)) {
  console.log('Equinix broad employer source is authoritative; stale-fallback enforcement is not active.');
  process.exit(0);
}

if (!fallbackIsActive(diagnostic)) {
  console.log('Equinix source is not authoritative, but no retained broad-source fallback is active.');
  process.exit(0);
}

const history = await historicalCollectorStatuses();
const lastVerified = await lastAuthoritativeVerification(history);
const nowMs = Date.now();
const decision = freshnessDecision({
  verifiedAt: lastVerified ? new Date(lastVerified.at).toISOString() : null,
  nowMs,
  sourceHealthy: false
});
const roundedAgeHours = decision.ageHours === null ? null : Math.round(decision.ageHours * 10) / 10;
const expiresIso = decision.expiresAt ? new Date(decision.expiresAt).toISOString() : null;

if (!decision.expired) {
  console.log(`Equinix broad-source fallback age is ${roundedAgeHours} hours and remains inside the ${MAX_FALLBACK_AGE_HOURS}-hour window.`);
  process.exit(0);
}

const broadBefore = jobs.filter(isBroadEquinix).length;
const prunedJobs = jobs.filter(job => !isBroadEquinix(job));
const removed = jobs.length - prunedJobs.length;
const nextDiagnostic = {
  ...diagnostic,
  fallbackRetained: 0,
  preservedOnFailure: 0,
  qualifyingRoles: Math.max(0, Number(diagnostic.qualifyingRoles || 0) - removed),
  fallbackFreshness: {
    active: false,
    expired: true,
    lastAuthoritativeAt: lastVerified ? new Date(lastVerified.at).toISOString() : null,
    lastAuthoritativeCommit: lastVerified?.sha || null,
    expiresAt: expiresIso,
    maxAgeHours: MAX_FALLBACK_AGE_HOURS,
    broadRolesBefore: broadBefore,
    broadRolesRemoved: removed,
    reason: `Equinix broad employer-direct source has not completed an authoritative verification within ${MAX_FALLBACK_AGE_HOURS} hours, so retained broad-source roles were removed until the source recovers.`
  }
};

status.updatedAt = new Date(nowMs).toISOString();
status.jobs = prunedJobs.length;
status.countsByType = prunedJobs.reduce((acc, job) => {
  const key = clean(job?.type) || 'unknown';
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {});
status.countsByExperience = prunedJobs.reduce((acc, job) => {
  const key = clean(job?.experience) || 'unknown';
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {});
status.priorityEmployerExpansion = {
  ...(status.priorityEmployerExpansion || {}),
  Equinix: nextDiagnostic
};

await writeFile(JOBS_PATH, JSON.stringify(prunedJobs, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
console.warn(`Expired Equinix broad-source fallback after ${roundedAgeHours ?? 'unknown'} hours without an authoritative employer-direct verification; removed ${removed} broad-source role(s).`);
