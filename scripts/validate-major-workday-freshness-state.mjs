import { readFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/major-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const STATE_PATH = 'data/major-workday-freshness.json';
const MAX_FALLBACK_AGE_HOURS = 96;
const MAX_VERIFICATION_AGE_HOURS = 30;
const CLOCK_SKEW_MINUTES = 5;

const companies = [
  'Vantage Data Centers',
  'QTS Data Centers',
  'CyrusOne',
  'STACK Infrastructure',
  'NTT Global Data Centers',
  'Aligned Data Centers'
];

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const isCompany = (job, company) => clean(job?.company) === company;

async function readJson(path) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  return value;
}

function parseTimestamp(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

const jobs = await readJson(JOBS_PATH);
const snapshot = await readJson(SNAPSHOT_PATH);
const status = await readJson(STATUS_PATH);
const durable = await readJson(STATE_PATH);

if (!Array.isArray(jobs)) throw new Error(`${JOBS_PATH} must contain an array.`);
if (!Array.isArray(snapshot)) throw new Error(`${SNAPSHOT_PATH} must contain an array.`);
if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error(`${STATUS_PATH} must contain an object.`);
if (!durable || typeof durable !== 'object' || Array.isArray(durable)) throw new Error(`${STATE_PATH} must contain an object.`);

const diagnostics = status?.majorSources?.employerDiagnostics || {};
const durableEmployers = durable?.employers && typeof durable.employers === 'object' && !Array.isArray(durable.employers)
  ? durable.employers
  : {};
const detailAwareState = Number(durable?.version) >= 2;
const nowMs = Date.now();
const futureToleranceMs = CLOCK_SKEW_MINUTES * 60e3;
const maxVerificationAgeMs = MAX_VERIFICATION_AGE_HOURS * 36e5;
const violations = [];

for (const company of companies) {
  const watch = durableEmployers[company] || diagnostics?.[company]?.fallbackFreshness;
  const publicRoles = jobs.filter(job => isCompany(job, company)).length;
  const snapshotRoles = snapshot.filter(job => isCompany(job, company)).length;
  const retainedRoles = publicRoles > 0 || snapshotRoles > 0;

  if (!watch || typeof watch !== 'object' || Array.isArray(watch)) {
    violations.push(`${company}: missing durable fallback-freshness evidence`);
    continue;
  }

  const checkedAtMs = parseTimestamp(watch.checkedAt);
  if (checkedAtMs === null) {
    violations.push(`${company}: missing or invalid checkedAt verification timestamp`);
  } else if (checkedAtMs > nowMs + futureToleranceMs) {
    violations.push(`${company}: checkedAt is more than ${CLOCK_SKEW_MINUTES} minutes in the future`);
  } else {
    const verificationAgeMs = Math.max(0, nowMs - checkedAtMs);
    if (verificationAgeMs >= maxVerificationAgeMs) {
      const ageHours = Math.round((verificationAgeMs / 36e5) * 10) / 10;
      violations.push(`${company}: source verification evidence is ${ageHours} hours old; maximum deployable age is ${MAX_VERIFICATION_AGE_HOURS} hours`);
    }
  }

  if (Number(watch.maxAgeHours) !== MAX_FALLBACK_AGE_HOURS) {
    violations.push(`${company}: fallback maxAgeHours must remain ${MAX_FALLBACK_AGE_HOURS}`);
  }

  if (watch.active === true && watch.expired === true) {
    violations.push(`${company}: fallback cannot be active and expired at the same time`);
  }

  if (watch.sourceHealthy === true) {
    if (watch.listingComplete !== true) {
      violations.push(`${company}: healthy source is missing complete-listing evidence`);
    }
    if (detailAwareState) {
      const attempted = Number(watch.detailAttempted);
      const succeeded = Number(watch.detailSucceeded);
      if (watch.detailHealthy !== true) {
        violations.push(`${company}: healthy source is missing sampled job-detail verification`);
      }
      if (!Number.isFinite(attempted) || attempted < 1) {
        violations.push(`${company}: healthy source has no sampled job-detail evidence`);
      } else if (!Number.isFinite(succeeded) || succeeded !== attempted) {
        violations.push(`${company}: healthy source verified only ${Number.isFinite(succeeded) ? succeeded : 'an invalid count'}/${attempted} sampled job-detail endpoint(s)`);
      }
    }
    if (watch.active !== false || watch.expired !== false) {
      violations.push(`${company}: healthy source is incorrectly marked fallback-active or expired`);
    }
    const lastHealthyAtMs = parseTimestamp(watch.lastHealthyAt);
    if (lastHealthyAtMs === null) {
      violations.push(`${company}: healthy source is missing lastHealthyAt evidence`);
    }
    continue;
  }

  if (!retainedRoles) continue;

  if (watch.sourceHealthy !== false) {
    violations.push(`${company}: retained roles have no explicit sourceHealthy state`);
  }
  if (watch.active !== true) {
    violations.push(`${company}: unhealthy source retains ${publicRoles} public and ${snapshotRoles} snapshot role(s) without an active verified fallback`);
  }
  if (watch.expired === true) {
    violations.push(`${company}: expired fallback still retains ${publicRoles} public and ${snapshotRoles} snapshot role(s)`);
  }

  const lastHealthyAtMs = parseTimestamp(watch.lastHealthyAt);
  const expiresAtMs = parseTimestamp(watch.expiresAt);
  if (lastHealthyAtMs === null) {
    violations.push(`${company}: retained fallback roles are missing lastHealthyAt evidence`);
  }
  if (expiresAtMs === null) {
    violations.push(`${company}: retained fallback roles are missing a valid expiresAt timestamp`);
  } else if (expiresAtMs <= nowMs) {
    violations.push(`${company}: retained fallback roles are already beyond their verified expiry`);
  }
  if (lastHealthyAtMs !== null && expiresAtMs !== null) {
    const expectedExpiry = lastHealthyAtMs + MAX_FALLBACK_AGE_HOURS * 36e5;
    if (Math.abs(expiresAtMs - expectedExpiry) > 60e3) {
      violations.push(`${company}: fallback expiry no longer matches the ${MAX_FALLBACK_AGE_HOURS}-hour verified window`);
    }
  }
}

if (violations.length) {
  for (const violation of violations) console.error(`Priority Workday freshness violation: ${violation}`);
  throw new Error(`Blocked ${violations.length} priority Workday freshness regression(s).`);
}

console.log(`Priority Workday deployment freshness guard passed for ${companies.length} employers; verification evidence is under ${MAX_VERIFICATION_AGE_HOURS} hours old${detailAwareState ? ' and healthy sources include sampled job-detail verification' : ''}.`);
