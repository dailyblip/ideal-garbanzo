import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/sabey-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'Sabey Data Centers';
const MAX_FALLBACK_AGE_HOURS = 168;
const MAX_FALLBACK_AGE_MS = MAX_FALLBACK_AGE_HOURS * 60 * 60 * 1000;

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function normalizeSnapshot(value) {
  if (Array.isArray(value)) return { verifiedAt: null, jobs: value };
  if (value && typeof value === 'object' && Array.isArray(value.jobs)) {
    return { verifiedAt: clean(value.verifiedAt) || null, jobs: value.jobs };
  }
  throw new Error(`${SNAPSHOT_PATH} must contain a job array or an object with a jobs array.`);
}

function freshnessDecision({ verifiedAt, nowMs, hasPublishedRoles }) {
  if (!hasPublishedRoles) {
    return { expired: false, ageHours: 0, expiresAt: null };
  }

  const verifiedMs = Date.parse(String(verifiedAt || ''));
  if (!Number.isFinite(verifiedMs)) {
    return { expired: true, ageHours: null, expiresAt: null };
  }

  const expiresAt = verifiedMs + MAX_FALLBACK_AGE_MS;
  const ageHours = Math.max(0, (nowMs - verifiedMs) / 36e5);
  return {
    expired: nowMs >= expiresAt,
    ageHours,
    expiresAt
  };
}

function runSelfTest() {
  const now = Date.parse('2026-09-15T12:00:00Z');
  const fresh = freshnessDecision({
    verifiedAt: '2026-09-08T12:00:01Z',
    nowMs: now,
    hasPublishedRoles: true
  });
  if (fresh.expired) throw new Error('Sabey fallback expired before 168 hours');

  const boundary = freshnessDecision({
    verifiedAt: '2026-09-08T12:00:00Z',
    nowMs: now,
    hasPublishedRoles: true
  });
  if (!boundary.expired) throw new Error('Sabey fallback did not expire at 168 hours');

  const unknown = freshnessDecision({
    verifiedAt: null,
    nowMs: now,
    hasPublishedRoles: true
  });
  if (!unknown.expired) throw new Error('Sabey roles without verification evidence did not fail closed');

  const empty = freshnessDecision({
    verifiedAt: null,
    nowMs: now,
    hasPublishedRoles: false
  });
  if (empty.expired) throw new Error('Empty Sabey feed incorrectly entered fallback expiry');

  console.log('Sabey fallback freshness regression tests passed.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

const jobs = await readJson(JOBS_PATH, []);
const snapshotRaw = await readJson(SNAPSHOT_PATH, { verifiedAt: null, jobs: [] });
const status = await readJson(STATUS_PATH, {});

if (!Array.isArray(jobs)) throw new Error(`${JOBS_PATH} must contain an array.`);
if (!status || typeof status !== 'object' || Array.isArray(status)) {
  throw new Error(`${STATUS_PATH} must contain an object.`);
}

const snapshot = normalizeSnapshot(snapshotRaw);
const publicSabey = jobs.filter(job => clean(job?.company) === COMPANY);
const snapshotSabey = snapshot.jobs.filter(job => clean(job?.company) === COMPANY);
const hasPublishedRoles = publicSabey.length > 0 || snapshotSabey.length > 0;
const verifiedAt = snapshot.verifiedAt || clean(status?.sabeyCareers?.snapshotVerifiedAt) || null;
const nowMs = Date.now();
const decision = freshnessDecision({ verifiedAt, nowMs, hasPublishedRoles });

if (!decision.expired) {
  const roundedAgeHours = Math.round(decision.ageHours * 10) / 10;
  if (hasPublishedRoles) {
    console.log(`Sabey snapshot is ${roundedAgeHours} hours old and inside the ${MAX_FALLBACK_AGE_HOURS}-hour maximum.`);
  } else {
    console.log('No Sabey roles are currently published; stale-fallback enforcement is not active.');
  }
  process.exit(0);
}

const prunedJobs = jobs.filter(job => clean(job?.company) !== COMPANY);
const removedPublic = jobs.length - prunedJobs.length;
const removedSnapshot = snapshotSabey.length;
const checkedAt = new Date(nowMs).toISOString();
const roundedAgeHours = decision.ageHours === null ? null : Math.round(decision.ageHours * 10) / 10;
const expiresAt = decision.expiresAt ? new Date(decision.expiresAt).toISOString() : null;
const source = status.sabeyCareers && typeof status.sabeyCareers === 'object'
  ? status.sabeyCareers
  : {};

status.updatedAt = checkedAt;
status.jobs = prunedJobs.length;
if (status.countsByType && typeof status.countsByType === 'object') {
  status.countsByType = prunedJobs.reduce((acc, job) => {
    const key = clean(job?.type) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}
if (status.countsByExperience && typeof status.countsByExperience === 'object') {
  status.countsByExperience = prunedJobs.reduce((acc, job) => {
    const key = clean(job?.experience) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}
status.sabeyCareers = {
  ...source,
  sourceHealthy: false,
  qualifyingRoles: 0,
  snapshotRoles: 0,
  snapshotRestored: 0,
  snapshotFresh: false,
  snapshotVerifiedAt: verifiedAt,
  snapshotMaxAgeHours: MAX_FALLBACK_AGE_HOURS,
  removedExpiredFallback: Math.max(removedPublic, removedSnapshot),
  fallbackFreshness: {
    active: false,
    expired: true,
    lastHealthyAt: verifiedAt,
    checkedAt,
    expiresAt,
    maxAgeHours: MAX_FALLBACK_AGE_HOURS,
    expiredAgeHours: roundedAgeHours,
    rolesRemoved: Math.max(removedPublic, removedSnapshot),
    policy: 'Sabey employer-direct roles may remain published for at most 168 hours after the last successful official-source verification.'
  }
};

await writeFile(JOBS_PATH, JSON.stringify(prunedJobs, null, 2) + '\n');
await writeFile(SNAPSHOT_PATH, JSON.stringify({ verifiedAt, jobs: [] }, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

console.warn(
  `Expired Sabey snapshot after ${roundedAgeHours ?? 'unknown'} hours without successful official-source verification; ` +
  `removed ${removedPublic} public role(s) and ${removedSnapshot} snapshot role(s).`
);
