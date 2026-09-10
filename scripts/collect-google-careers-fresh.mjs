import { readFile, writeFile } from 'node:fs/promises';

const COMPANY = 'Google';
const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/google-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const MAX_FALLBACK_AGE_HOURS = 96;

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

const isGoogleJob = job => String(job?.company || '').trim() === COMPANY
  || /^https:\/\/www\.google\.com\/about\/careers\/applications\/jobs\/results\//i.test(String(job?.sourceUrl || ''));

function countsBy(records, field) {
  return records.reduce((counts, record) => {
    const value = String(record?.[field] || '').trim() || 'unknown';
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function validIso(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function priorHealthyAnchor(status) {
  const explicit = validIso(status?.googleCareers?.lastHealthyAt);
  if (explicit) return explicit;
  if (status?.googleCareers?.sourceHealthy === true) {
    return validIso(status?.googleCareers?.freshnessCheckedAt)
      || validIso(status?.googleCareers?.checkedAt)
      || validIso(status?.updatedAt);
  }
  return null;
}

function fallbackState({ sourceHealthy, lastHealthyAt, now = Date.now() }) {
  if (sourceHealthy) return { ageHours: 0, expired: false };
  const timestamp = Date.parse(String(lastHealthyAt || ''));
  if (!Number.isFinite(timestamp)) return { ageHours: null, expired: true };
  const ageHours = Math.max(0, (now - timestamp) / 36e5);
  return { ageHours: Number(ageHours.toFixed(1)), expired: ageHours > MAX_FALLBACK_AGE_HOURS };
}

function runSelfTest() {
  const healthy = fallbackState({ sourceHealthy: true, lastHealthyAt: '2026-09-01T00:00:00.000Z', now: Date.parse('2026-09-10T00:00:00.000Z') });
  if (healthy.expired || healthy.ageHours !== 0) throw new Error('healthy source must reset fallback age');

  const withinWindow = fallbackState({ sourceHealthy: false, lastHealthyAt: '2026-09-06T01:00:00.000Z', now: Date.parse('2026-09-10T00:00:00.000Z') });
  if (withinWindow.expired || withinWindow.ageHours !== 95) throw new Error('95-hour fallback should remain publishable');

  const expired = fallbackState({ sourceHealthy: false, lastHealthyAt: '2026-09-05T23:00:00.000Z', now: Date.parse('2026-09-10T00:00:00.000Z') });
  if (!expired.expired || expired.ageHours !== 97) throw new Error('97-hour fallback should expire');

  const missingAnchor = fallbackState({ sourceHealthy: false, lastHealthyAt: null, now: Date.now() });
  if (!missingAnchor.expired || missingAnchor.ageHours !== null) throw new Error('unanchored fallback must fail closed');

  console.log('Google Careers fallback freshness self-test passed.');
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
  process.exit(0);
}

const priorStatus = await readJson(STATUS_PATH, {});
const previousHealthyAt = priorHealthyAnchor(priorStatus);
let collectorError = null;

try {
  await import('./collect-google-careers.mjs');
} catch (error) {
  const message = String(error?.message || error);
  const expectedAfterExpiry = priorStatus?.googleCareers?.fallbackExpired === true
    && message.includes('Google Careers collector failed and no verified snapshot exists');
  if (!expectedAfterExpiry) throw error;
  collectorError = error;
}

let status = await readJson(STATUS_PATH, priorStatus);
let jobs = await readJson(JOBS_PATH, []);
let snapshot = await readJson(SNAPSHOT_PATH, []);
if (!Array.isArray(jobs)) throw new Error(`${JOBS_PATH} is not an array`);
if (!Array.isArray(snapshot)) snapshot = [];

const checkedAt = new Date().toISOString();
const sourceHealthy = collectorError ? false : status?.googleCareers?.sourceHealthy === true;
const lastHealthyAt = sourceHealthy ? checkedAt : previousHealthyAt;
const freshness = fallbackState({ sourceHealthy, lastHealthyAt, now: Date.parse(checkedAt) });
const snapshotRolesBeforeExpiry = snapshot.length;
let staleRolesRemoved = 0;

if (freshness.expired) {
  const retained = jobs.filter(job => !isGoogleJob(job));
  staleRolesRemoved = jobs.length - retained.length;
  jobs = retained;
  snapshot = [];
  await writeFile(JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n');
  await writeFile(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n');
}

const priorGoogle = status?.googleCareers || priorStatus?.googleCareers || {};
const collectorErrors = Array.isArray(priorGoogle.errors) ? priorGoogle.errors : [];
const currentErrors = collectorError
  ? [...collectorErrors, `collector retry after fallback expiry: ${String(collectorError?.message || collectorError)}`]
  : collectorErrors;
const globalErrors = Array.isArray(status?.errors) ? status.errors.filter(error => !String(error).includes('Google Careers fallback freshness:')) : [];
if (freshness.expired) {
  const ageLabel = freshness.ageHours === null ? 'unknown age' : `${freshness.ageHours}h old`;
  globalErrors.push(`Google Careers fallback freshness: disabled ${snapshotRolesBeforeExpiry} stale snapshot role(s); last healthy verification is ${ageLabel}.`);
}

status = {
  ...status,
  jobs: jobs.length,
  countsByType: countsBy(jobs, 'type'),
  countsByExperience: countsBy(jobs, 'experience'),
  googleCareers: {
    ...priorGoogle,
    sourceHealthy,
    lastHealthyAt,
    freshnessCheckedAt: checkedAt,
    fallbackMaxAgeHours: MAX_FALLBACK_AGE_HOURS,
    fallbackAgeHours: freshness.ageHours,
    fallbackExpired: freshness.expired,
    usedPreviousSnapshot: !sourceHealthy && !freshness.expired && snapshotRolesBeforeExpiry > 0,
    staleRolesRemoved,
    errors: currentErrors
  },
  errors: globalErrors
};

await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

if (freshness.expired) {
  console.warn(`Google Careers fallback expired after ${freshness.ageHours ?? 'unknown'} hours; removed ${staleRolesRemoved} public role(s) and cleared ${snapshotRolesBeforeExpiry} stale snapshot role(s).`);
} else if (sourceHealthy) {
  console.log(`Google Careers freshness anchored at ${lastHealthyAt}; ${snapshot.length} verified role(s) remain publishable.`);
} else {
  console.warn(`Google Careers is using a verified fallback ${freshness.ageHours} hours after the last healthy scan; maximum is ${MAX_FALLBACK_AGE_HOURS} hours.`);
}
