import { readFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/flexential-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'Flexential';
const DEFAULT_MAX_AGE_HOURS = 96;
const MAX_FUTURE_SKEW_MINUTES = 10;

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

const [jobs, snapshot, status] = await Promise.all([
  readJson(JOBS_PATH),
  readJson(SNAPSHOT_PATH),
  readJson(STATUS_PATH)
]);

if (!Array.isArray(jobs)) throw new Error(`${JOBS_PATH} must contain an array.`);
if (!Array.isArray(snapshot)) throw new Error(`${SNAPSHOT_PATH} must contain an array.`);
if (!status || typeof status !== 'object' || Array.isArray(status)) {
  throw new Error(`${STATUS_PATH} must contain an object.`);
}

const publicRoles = jobs.filter(job => clean(job?.company) === COMPANY);
const snapshotRoles = snapshot.filter(job => clean(job?.company) === COMPANY);
const publishedCount = Math.max(publicRoles.length, snapshotRoles.length);
const source = status.flexential || {};
const freshness = source.fallbackFreshness || {};
const configuredMaxAge = Number(freshness.maxAgeHours);
const maxAgeHours = DEFAULT_MAX_AGE_HOURS;
if (Number.isFinite(configuredMaxAge) && configuredMaxAge > DEFAULT_MAX_AGE_HOURS) {
  throw new Error(`Flexential fallback policy cannot exceed ${DEFAULT_MAX_AGE_HOURS} hours (found ${configuredMaxAge}).`);
}

if (freshness.expired === true && publishedCount > 0) {
  throw new Error(
    `Flexential fallback is marked expired but ${publicRoles.length} public role(s) and ${snapshotRoles.length} snapshot role(s) remain published.`
  );
}

if (publishedCount === 0) {
  console.log('Flexential freshness guard passed: no Flexential roles are currently published.');
} else {
  const recordedHealthy = source.sourceHealthy === true &&
    source.listingComplete === true &&
    source.authoritativeSnapshot === true;
  const verifiedAt = recordedHealthy
    ? clean(source.checkedAt)
    : clean(freshness.lastHealthyAt);
  const verifiedMs = Date.parse(verifiedAt);
  if (!verifiedAt || !Number.isFinite(verifiedMs)) {
    throw new Error('Flexential roles are published without a valid official-source verification timestamp.');
  }

  const now = Date.now();
  const ageMs = now - verifiedMs;
  const futureSkewMs = MAX_FUTURE_SKEW_MINUTES * 60 * 1000;
  if (ageMs < -futureSkewMs) {
    throw new Error(`Flexential verification is unexpectedly future-dated: ${verifiedAt}.`);
  }

  const ageHours = Math.max(0, ageMs / 36e5);
  if (ageHours >= maxAgeHours) {
    throw new Error(
      `Flexential employer-direct snapshot is stale (${Math.floor(ageHours)}h since the last successful official Greenhouse verification; maximum ${maxAgeHours}h).`
    );
  }

  console.log(
    `Flexential freshness guard passed: ${publicRoles.length} public role(s), ${snapshotRoles.length} snapshot role(s), ` +
    `last official verification ${ageHours.toFixed(1)}h ago (limit ${maxAgeHours}h).`
  );
}
