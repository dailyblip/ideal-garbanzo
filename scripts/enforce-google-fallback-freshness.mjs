import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/google-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'Google';
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

const isGoogleJob = job => clean(job?.company) === COMPANY
  || /^https:\/\/www\.google\.com\/about\/careers\/applications\/jobs\/results\//i.test(clean(job?.sourceUrl));

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

function countsBy(records, field) {
  return records.reduce((counts, record) => {
    const value = clean(record?.[field]) || 'unknown';
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function runSelfTest() {
  const now = Date.parse('2026-09-10T12:00:00Z');
  const fresh = freshnessDecision({
    verifiedAt: '2026-09-06T12:00:01Z',
    nowMs: now,
    hasPublishedRoles: true
  });
  if (fresh.expired) throw new Error('Google fallback expired before 96 hours');

  const boundary = freshnessDecision({
    verifiedAt: '2026-09-06T12:00:00Z',
    nowMs: now,
    hasPublishedRoles: true
  });
  if (!boundary.expired) throw new Error('Google fallback did not expire at 96 hours');

  const unknown = freshnessDecision({
    verifiedAt: null,
    nowMs: now,
    hasPublishedRoles: true
  });
  if (!unknown.expired) throw new Error('Google roles without verification evidence did not fail closed');

  const empty = freshnessDecision({
    verifiedAt: null,
    nowMs: now,
    hasPublishedRoles: false
  });
  if (empty.expired) throw new Error('Empty Google feed incorrectly entered fallback expiry');

  console.log('Google fallback freshness regression tests passed.');
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

const publicGoogle = jobs.filter(isGoogleJob);
const snapshotGoogle = snapshot.filter(isGoogleJob);
const hasPublishedRoles = publicGoogle.length > 0 || snapshotGoogle.length > 0;
const source = status.googleCareers || {};
const verifiedAt = clean(source.lastHealthyAt);
const nowMs = Date.now();
const decision = freshnessDecision({ verifiedAt, nowMs, hasPublishedRoles });

if (!decision.expired) {
  const roundedAgeHours = Math.round(decision.ageHours * 10) / 10;
  if (hasPublishedRoles) {
    console.log(`Google Careers snapshot is ${roundedAgeHours} hours old and inside the ${MAX_FALLBACK_AGE_HOURS}-hour maximum.`);
  } else {
    console.log('No Google Careers roles are currently published; stale-fallback enforcement is not active.');
  }
  process.exit(0);
}

const prunedJobs = jobs.filter(job => !isGoogleJob(job));
const removedPublic = jobs.length - prunedJobs.length;
const removedSnapshot = snapshotGoogle.length;
const checkedAt = new Date(nowMs).toISOString();
const roundedAgeHours = decision.ageHours === null ? null : Math.round(decision.ageHours * 10) / 10;
const expiresAt = decision.expiresAt ? new Date(decision.expiresAt).toISOString() : null;
const priorErrors = Array.isArray(status.errors)
  ? status.errors.filter(error => !String(error).includes('Google Careers fallback freshness:'))
  : [];
const ageLabel = roundedAgeHours === null ? 'unknown age' : `${roundedAgeHours}h old`;
priorErrors.push(`Google Careers fallback freshness: removed ${Math.max(removedPublic, removedSnapshot)} stale role(s); last healthy verification is ${ageLabel}.`);

status.updatedAt = checkedAt;
status.jobs = prunedJobs.length;
status.countsByType = countsBy(prunedJobs, 'type');
status.countsByExperience = countsBy(prunedJobs, 'experience');
status.googleCareers = {
  ...source,
  sourceHealthy: false,
  listingComplete: false,
  qualifyingRoles: 0,
  lastHealthyAt: verifiedAt || null,
  freshnessCheckedAt: checkedAt,
  fallbackMaxAgeHours: MAX_FALLBACK_AGE_HOURS,
  fallbackAgeHours: roundedAgeHours,
  fallbackExpiresAt: expiresAt,
  fallbackExpired: true,
  usedPreviousSnapshot: false,
  staleRolesRemoved: Math.max(removedPublic, removedSnapshot),
  freshnessPolicy: 'Google employer-direct roles may remain published for at most 96 hours after the last successful official Google Careers verification.'
};
status.errors = priorErrors;

await writeFile(JOBS_PATH, JSON.stringify(prunedJobs, null, 2) + '\n');
await writeFile(SNAPSHOT_PATH, '[]\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

console.warn(
  `Expired Google Careers snapshot after ${roundedAgeHours ?? 'unknown'} hours without successful official-source verification; ` +
  `removed ${removedPublic} public role(s) and ${removedSnapshot} snapshot role(s).`
);
