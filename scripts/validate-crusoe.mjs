import { readFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'Crusoe';
const PROVIDER = 'ashby';
const OFFICIAL_HOST = 'jobs.ashbyhq.com';
const OFFICIAL_PATH_PREFIX = '/crusoe/';
const MAX_VERIFICATION_AGE_HOURS = 30;
const MAX_FALLBACK_AGE_HOURS = 96;
const MAX_FUTURE_SKEW_MINUTES = 10;
const MIN_RETENTION_RATIO = 0.35;

const allowedTypes = new Set(['entry-level', 'internship', 'apprenticeship', 'trainee']);
const allowedExperience = new Set(['no-experience', '0-2-years', '2-5-years']);
const excludedTitleTerms = [
  'senior', 'sr.', 'sr ', 'lead ', 'principal', 'manager', 'director',
  'vice president', 'vp ', 'head of', 'staff engineer', 'supervisor'
];

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const lower = value => clean(value).toLowerCase();

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function parseTimestamp(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

function isOfficialCrusoeUrl(value) {
  try {
    const parsed = new URL(clean(value));
    return parsed.protocol === 'https:' &&
      parsed.hostname.toLowerCase() === OFFICIAL_HOST &&
      parsed.pathname.toLowerCase().startsWith(OFFICIAL_PATH_PREFIX);
  } catch {
    return false;
  }
}

const [jobs, status] = await Promise.all([readJson(JOBS_PATH), readJson(STATUS_PATH)]);
if (!Array.isArray(jobs)) throw new Error(`${JOBS_PATH} must contain an array.`);
if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error(`${STATUS_PATH} must contain an object.`);

const violations = [];
const publicRoles = jobs.filter(job => clean(job?.company) === COMPANY);
const diagnostics = [
  ...(Array.isArray(status?.genericDirectSources?.sourceDiagnostics) ? status.genericDirectSources.sourceDiagnostics : []),
  ...(Array.isArray(status?.sourceDiagnostics) ? status.sourceDiagnostics : [])
];
const diagnostic = diagnostics.find(item => clean(item?.company) === COMPANY);

if (!diagnostic) {
  violations.push('missing Crusoe generic employer-direct source diagnostic');
} else {
  if (lower(diagnostic.provider) !== PROVIDER) {
    violations.push(`expected Crusoe provider ${PROVIDER}, found ${clean(diagnostic.provider) || '(missing)'}`);
  }
  const expected = Number(diagnostic.qualifyingRoles || 0);
  if (Number.isFinite(expected) && expected > 0 && publicRoles.length === 0) {
    violations.push(`Crusoe source reported ${expected} qualifying role(s) but the public feed retained none`);
  }
  if (Number.isFinite(expected) && expected >= 8) {
    const minimum = Math.ceil(expected * MIN_RETENTION_RATIO);
    if (publicRoles.length < minimum) {
      violations.push(`Crusoe public feed retained only ${publicRoles.length}/${expected} qualifying employer-direct role(s); minimum protected retention is ${minimum}`);
    }
  }
}

for (const job of publicRoles) {
  if (!isOfficialCrusoeUrl(job?.sourceUrl)) {
    violations.push(`${clean(job?.id) || '(missing id)'} does not point to the official Crusoe Ashby job board`);
  }
  if (!allowedTypes.has(clean(job?.type))) {
    violations.push(`${clean(job?.id) || '(missing id)'} has unsupported role type ${clean(job?.type) || '(missing)'}`);
  }
  if (!allowedExperience.has(clean(job?.experience))) {
    violations.push(`${clean(job?.id) || '(missing id)'} has unsupported experience band ${clean(job?.experience) || '(missing)'}`);
  }
  const title = lower(job?.title);
  if (excludedTitleTerms.some(term => title.includes(term))) {
    violations.push(`${clean(job?.id) || '(missing id)'} contains senior/managerial title noise: ${clean(job?.title)}`);
  }
}

const freshness = status?.genericFallbackFreshness?.sources?.[COMPANY];
if (publicRoles.length > 0 && (!freshness || typeof freshness !== 'object')) {
  violations.push('published Crusoe roles are missing generic fallback freshness evidence');
} else if (freshness && typeof freshness === 'object') {
  const now = Date.now();
  const futureSkewMs = MAX_FUTURE_SKEW_MINUTES * 60e3;
  const latestScanMs = parseTimestamp(freshness.latestScanAt || status?.genericDirectSources?.updatedAt);
  if (publicRoles.length > 0) {
    if (latestScanMs === null) {
      violations.push('published Crusoe roles are missing a valid latest source scan timestamp');
    } else if (latestScanMs > now + futureSkewMs) {
      violations.push(`Crusoe latest source scan is more than ${MAX_FUTURE_SKEW_MINUTES} minutes in the future`);
    } else {
      const ageHours = Math.max(0, (now - latestScanMs) / 36e5);
      if (ageHours >= MAX_VERIFICATION_AGE_HOURS) {
        violations.push(`Crusoe source verification is ${ageHours.toFixed(1)} hours old; maximum deployable age is ${MAX_VERIFICATION_AGE_HOURS} hours`);
      }
    }
  }

  if (diagnostic?.sourceHealthy === true) {
    if (freshness.sourceHealthyAtLatestScan !== true || freshness.fallbackActive === true || freshness.expired === true) {
      violations.push('healthy Crusoe source is inconsistently marked as fallback-active, expired, or unhealthy');
    }
  } else if (publicRoles.length > 0) {
    if (freshness.fallbackActive !== true || freshness.expired === true) {
      violations.push('unhealthy Crusoe source retains public roles without an active, unexpired verified fallback');
    }
    const lastHealthyMs = parseTimestamp(freshness.lastHealthyAt);
    if (lastHealthyMs === null) {
      violations.push('Crusoe fallback roles are missing a valid lastHealthyAt timestamp');
    } else {
      const ageHours = Math.max(0, (now - lastHealthyMs) / 36e5);
      if (ageHours >= MAX_FALLBACK_AGE_HOURS) {
        violations.push(`Crusoe fallback verification is ${ageHours.toFixed(1)} hours old; maximum is ${MAX_FALLBACK_AGE_HOURS} hours`);
      }
    }
  }
}

if (violations.length) {
  for (const violation of violations) console.error(`Crusoe source guard: ${violation}`);
  throw new Error(`Blocked ${violations.length} Crusoe source-integrity regression(s).`);
}

console.log(`Crusoe source guard passed: ${publicRoles.length} public employer-direct role(s), official Ashby provenance, 0-5 year mission fit, and fresh source evidence.`);
