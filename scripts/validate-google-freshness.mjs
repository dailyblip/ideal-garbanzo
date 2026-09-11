import { readFile } from 'node:fs/promises';

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

function validateState({ publicCount, snapshotCount, source, nowMs }) {
  const violations = [];
  const hasRoles = publicCount > 0 || snapshotCount > 0;
  const maxAge = Number(source?.fallbackMaxAgeHours);
  if (Number.isFinite(maxAge) && maxAge > MAX_FALLBACK_AGE_HOURS) {
    violations.push(`fallbackMaxAgeHours is ${maxAge}, above the ${MAX_FALLBACK_AGE_HOURS}-hour policy`);
  }

  if (source?.fallbackExpired === true && hasRoles) {
    violations.push(`fallback is expired but ${publicCount} public / ${snapshotCount} snapshot role(s) remain`);
  }

  if (hasRoles) {
    const verifiedMs = Date.parse(String(source?.lastHealthyAt || ''));
    if (!Number.isFinite(verifiedMs)) {
      violations.push('published Google roles have no valid lastHealthyAt verification anchor');
    } else {
      const ageMs = Math.max(0, nowMs - verifiedMs);
      if (ageMs >= MAX_FALLBACK_AGE_MS) {
        violations.push(`published Google roles are ${(ageMs / 36e5).toFixed(1)} hours past the last healthy verification`);
      }
    }
  }

  return violations;
}

function runSelfTest() {
  const nowMs = Date.parse('2026-09-10T12:00:00Z');
  const fresh = validateState({
    publicCount: 2,
    snapshotCount: 2,
    source: { lastHealthyAt: '2026-09-06T12:00:01Z', fallbackMaxAgeHours: 96, fallbackExpired: false },
    nowMs
  });
  if (fresh.length) throw new Error(`Fresh Google state failed validation: ${fresh.join('; ')}`);

  const expired = validateState({
    publicCount: 1,
    snapshotCount: 1,
    source: { lastHealthyAt: '2026-09-06T12:00:00Z', fallbackMaxAgeHours: 96, fallbackExpired: false },
    nowMs
  });
  if (!expired.some(message => message.includes('past the last healthy verification'))) {
    throw new Error('Expired Google roles were not rejected');
  }

  const failClosed = validateState({
    publicCount: 1,
    snapshotCount: 0,
    source: { fallbackMaxAgeHours: 96, fallbackExpired: false },
    nowMs
  });
  if (!failClosed.some(message => message.includes('no valid lastHealthyAt'))) {
    throw new Error('Unanchored Google roles were not rejected');
  }

  const cleared = validateState({
    publicCount: 0,
    snapshotCount: 0,
    source: { fallbackMaxAgeHours: 96, fallbackExpired: true },
    nowMs
  });
  if (cleared.length) throw new Error(`Cleared expired Google state failed validation: ${cleared.join('; ')}`);

  console.log('Google freshness validation regression tests passed.');
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

const publicCount = jobs.filter(isGoogleJob).length;
const snapshotCount = snapshot.filter(isGoogleJob).length;
const source = status.googleCareers || {};
const violations = validateState({ publicCount, snapshotCount, source, nowMs: Date.now() });

if (violations.length) {
  throw new Error(`Google Careers freshness validation failed:\n- ${violations.join('\n- ')}`);
}

console.log(
  `Google Careers freshness valid: ${publicCount} public role(s), ${snapshotCount} snapshot role(s), ` +
  `lastHealthyAt=${source.lastHealthyAt || 'none'}, expired=${Boolean(source.fallbackExpired)}.`
);
