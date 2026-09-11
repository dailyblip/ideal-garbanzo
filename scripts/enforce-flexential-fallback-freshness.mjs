import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/flexential-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'Flexential';
const MAX_FALLBACK_AGE_HOURS = 96;
const MAX_FALLBACK_AGE_MS = MAX_FALLBACK_AGE_HOURS * 60 * 60 * 1000;

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

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
  const now = Date.parse('2026-09-10T12:00:00Z');
  const fresh = freshnessDecision({
    verifiedAt: '2026-09-06T12:00:01Z',
    nowMs: now,
    hasPublishedRoles: true
  });
  if (fresh.expired) throw new Error('Flexential fallback expired before 96 hours');

  const boundary = freshnessDecision({
    verifiedAt: '2026-09-06T12:00:00Z',
    nowMs: now,
    hasPublishedRoles: true
  });
  if (!boundary.expired) throw new Error('Flexential fallback did not expire at 96 hours');

  const unknown = freshnessDecision({
    verifiedAt: null,
    nowMs: now,
    hasPublishedRoles: true
  });
  if (!unknown.expired) throw new Error('Flexential roles without verification evidence did not fail closed');

  const empty = freshnessDecision({
    verifiedAt: null,
    nowMs: now,
    hasPublishedRoles: false
  });
  if (empty.expired) throw new Error('Empty Flexential feed incorrectly entered fallback expiry');

  console.log('Flexential fallback freshness regression tests passed.');
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
if (!status || typeof status !== 'object' || Array.isArray(status)) {
  throw new Error(`${STATUS_PATH} must contain an object.`);
}

const publicFlexential = jobs.filter(job => clean(job?.company) === COMPANY);
const snapshotFlexential = snapshot.filter(job => clean(job?.company) === COMPANY);
const hasPublishedRoles = publicFlexential.length > 0 || snapshotFlexential.length > 0;
const source = status.flexential || {};
const recordedHealthy = source.sourceHealthy === true &&
  source.listingComplete === true &&
  source.authoritativeSnapshot === true;
const verifiedAt = recordedHealthy
  ? clean(source.checkedAt)
  : clean(source.fallbackFreshness?.lastHealthyAt);
const nowMs = Date.now();
const decision = freshnessDecision({ verifiedAt, nowMs, hasPublishedRoles });

if (!decision.expired) {
  const roundedAgeHours = Math.round(decision.ageHours * 10) / 10;
  if (hasPublishedRoles) {
    console.log(`Flexential snapshot is ${roundedAgeHours} hours old and inside the ${MAX_FALLBACK_AGE_HOURS}-hour maximum.`);
  } else {
    console.log('No Flexential roles are currently published; stale-fallback enforcement is not active.');
  }
  process.exit(0);
}

const prunedJobs = jobs.filter(job => clean(job?.company) !== COMPANY);
const removedPublic = jobs.length - prunedJobs.length;
const removedSnapshot = snapshotFlexential.length;
const checkedAt = new Date(nowMs).toISOString();
const roundedAgeHours = decision.ageHours === null ? null : Math.round(decision.ageHours * 10) / 10;
const expiresAt = decision.expiresAt ? new Date(decision.expiresAt).toISOString() : null;

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
status.flexential = {
  ...source,
  sourceHealthy: false,
  listingComplete: false,
  authoritativeSnapshot: false,
  qualifyingRoles: 0,
  fallbackFreshness: {
    active: false,
    expired: true,
    lastHealthyAt: verifiedAt || null,
    checkedAt,
    expiresAt,
    maxAgeHours: MAX_FALLBACK_AGE_HOURS,
    expiredAgeHours: roundedAgeHours,
    rolesRemoved: Math.max(removedPublic, removedSnapshot),
    policy: 'Flexential employer-direct roles may remain published for at most 96 hours after the last successful official Greenhouse verification.'
  }
};

await writeFile(JOBS_PATH, JSON.stringify(prunedJobs, null, 2) + '\n');
await writeFile(SNAPSHOT_PATH, '[]\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

console.warn(
  `Expired Flexential snapshot after ${roundedAgeHours ?? 'unknown'} hours without successful official-source verification; ` +
  `removed ${removedPublic} public role(s) and ${removedSnapshot} snapshot role(s).`
);
