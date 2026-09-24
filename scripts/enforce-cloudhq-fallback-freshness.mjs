import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/cloudhq-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'CloudHQ';
const STATUS_KEY = 'cloudHqCareers';
const MAX_FALLBACK_AGE_HOURS = 96;
const MAX_FALLBACK_AGE_MS = MAX_FALLBACK_AGE_HOURS * 60 * 60 * 1000;

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

function isCloudHqJob(job = {}) {
  if (clean(job?.company) === COMPANY) return true;
  try {
    const url = new URL(clean(job?.sourceUrl));
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'recruiting.paylocity.com'
      && /\/CloudHQ-LLC(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

function freshnessDecision({ verifiedAt, nowMs, hasPublishedRoles }) {
  if (!hasPublishedRoles) return { expired: false, ageHours: 0, expiresAt: null };
  const verifiedMs = Date.parse(String(verifiedAt || ''));
  if (!Number.isFinite(verifiedMs)) return { expired: true, ageHours: null, expiresAt: null };
  const expiresAt = verifiedMs + MAX_FALLBACK_AGE_MS;
  return {
    expired: nowMs >= expiresAt,
    ageHours: Math.max(0, (nowMs - verifiedMs) / 36e5),
    expiresAt
  };
}

function pruneCloudHqJobs(jobs = []) {
  return jobs.filter(job => !isCloudHqJob(job));
}

function runSelfTest() {
  const now = Date.parse('2026-09-24T12:00:00Z');
  const fresh = freshnessDecision({ verifiedAt: '2026-09-20T12:00:01Z', nowMs: now, hasPublishedRoles: true });
  if (fresh.expired) throw new Error('CloudHQ fallback expired before 96 hours');

  const boundary = freshnessDecision({ verifiedAt: '2026-09-20T12:00:00Z', nowMs: now, hasPublishedRoles: true });
  if (!boundary.expired) throw new Error('CloudHQ fallback did not expire at 96 hours');

  const missing = freshnessDecision({ verifiedAt: null, nowMs: now, hasPublishedRoles: true });
  if (!missing.expired) throw new Error('CloudHQ roles without verification evidence did not fail closed');

  const empty = freshnessDecision({ verifiedAt: null, nowMs: now, hasPublishedRoles: false });
  if (empty.expired) throw new Error('Empty CloudHQ feed incorrectly entered expiry');

  const sentinel = {
    id: 'sentinel-other-employer',
    company: 'Other Employer',
    title: 'Data Center Technician',
    sourceUrl: 'https://example.com/jobs/1',
    postedHours: 12
  };
  const sourceRows = [
    { id: 'cloudhq-1', company: COMPANY, sourceUrl: 'https://recruiting.paylocity.com/recruiting/jobs/Details/1/CloudHQ-LLC/Test' },
    { id: 'legacy-cloudhq', company: 'Legacy Label', sourceUrl: 'https://recruiting.paylocity.com/recruiting/jobs/Details/2/CloudHQ-LLC/Test' }
  ];
  const pruned = pruneCloudHqJobs([sentinel, ...sourceRows]);
  if (pruned.length !== 1 || JSON.stringify(pruned[0]) !== JSON.stringify(sentinel)) {
    throw new Error('CloudHQ expiry changed or retained rows outside its source boundary');
  }

  console.log('CloudHQ fallback freshness and source-boundary regression tests passed.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

const jobs = await readJson(JOBS_PATH, []);
const snapshot = await readJson(SNAPSHOT_PATH, []);
const status = await readJson(STATUS_PATH, {});
if (!Array.isArray(jobs)) throw new Error(`${JOBS_PATH} must contain an array.`);
if (!Array.isArray(snapshot)) throw new Error(`${SNAPSHOT_PATH} must contain an array.`);
if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error(`${STATUS_PATH} must contain an object.`);

const publicJobs = jobs.filter(isCloudHqJob);
const snapshotJobs = snapshot.filter(isCloudHqJob);
const hasPublishedRoles = publicJobs.length > 0 || snapshotJobs.length > 0;
const source = status?.[STATUS_KEY] || {};
const legacyHealthyAnchor = source?.sourceHealthy === true ? source?.checkedAt : null;
const verifiedAt = clean(source?.lastHealthyAt || legacyHealthyAnchor);
const nowMs = Date.now();
const decision = freshnessDecision({ verifiedAt, nowMs, hasPublishedRoles });

if (!decision.expired) {
  const age = Math.round((decision.ageHours || 0) * 10) / 10;
  if (hasPublishedRoles) console.log(`CloudHQ verification is ${age} hours old and inside the ${MAX_FALLBACK_AGE_HOURS}-hour maximum.`);
  else console.log('No CloudHQ roles are currently published; stale-fallback enforcement is not active.');
  process.exit(0);
}

const prunedJobs = pruneCloudHqJobs(jobs);
const removedPublic = jobs.length - prunedJobs.length;
const removedSnapshot = snapshotJobs.length;
const enforcedAt = new Date(nowMs).toISOString();
const roundedAgeHours = decision.ageHours === null ? null : Math.round(decision.ageHours * 10) / 10;

status.updatedAt = enforcedAt;
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
status[STATUS_KEY] = {
  ...source,
  lastHealthyAt: verifiedAt || null,
  sourceHealthy: false,
  mode: 'fail-closed',
  qualifyingRoles: 0,
  publishedRoles: 0,
  fallbackMaxAgeHours: MAX_FALLBACK_AGE_HOURS,
  fallbackAgeHours: roundedAgeHours,
  fallbackExpired: true,
  usedPreviousSnapshot: false,
  preservedPrevious: 0,
  removedExpiredFallback: Math.max(removedPublic, removedSnapshot),
  fallbackEnforcedAt: enforcedAt,
  fallbackPolicy: `Retain the last fully verified CloudHQ snapshot for at most ${MAX_FALLBACK_AGE_HOURS} hours after official-source failure; then remove CloudHQ roles until fresh verification succeeds.`
};

await writeFile(JOBS_PATH, JSON.stringify(prunedJobs, null, 2) + '\n');
await writeFile(SNAPSHOT_PATH, '[]\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

console.warn(`Expired CloudHQ snapshot after ${roundedAgeHours ?? 'unknown'} hours without official-source verification; removed ${removedPublic} public role(s) and ${removedSnapshot} snapshot role(s).`);
