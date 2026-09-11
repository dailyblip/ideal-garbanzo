import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const FALLBACK_PATH = 'data/coresite-verified-fallback.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'CoreSite';
const MAX_FALLBACK_AGE_HOURS = 96;
const MAX_FALLBACK_AGE_MS = MAX_FALLBACK_AGE_HOURS * 60 * 60 * 1000;

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const isCoreSite = job => clean(job?.company) === COMPANY || /(^|\.)jobs\.coresite\.com\//i.test(clean(job?.sourceUrl));

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function freshnessDecision({ verifiedAt, declaredExpiresAt, nowMs, sourceHealthy }) {
  const verifiedMs = Date.parse(String(verifiedAt || ''));
  if (!Number.isFinite(verifiedMs)) {
    return { expired: !sourceHealthy, hardExpiresMs: null, effectiveExpiresMs: null, shouldTrimExpiry: false, ageHours: null };
  }

  const hardExpiresMs = verifiedMs + MAX_FALLBACK_AGE_MS;
  const declaredMs = Date.parse(String(declaredExpiresAt || ''));
  const validDeclared = Number.isFinite(declaredMs) && declaredMs > verifiedMs;
  const effectiveExpiresMs = validDeclared ? Math.min(declaredMs, hardExpiresMs) : hardExpiresMs;
  return {
    expired: !sourceHealthy && nowMs >= effectiveExpiresMs,
    hardExpiresMs,
    effectiveExpiresMs,
    shouldTrimExpiry: !validDeclared || declaredMs > hardExpiresMs,
    ageHours: Math.max(0, (nowMs - verifiedMs) / 36e5)
  };
}

function runSelfTest() {
  const now = Date.parse('2026-09-10T12:00:00Z');
  const fresh = freshnessDecision({
    verifiedAt: '2026-09-06T12:00:01Z',
    declaredExpiresAt: '2026-09-13T12:00:01Z',
    nowMs: now,
    sourceHealthy: false
  });
  if (fresh.expired) throw new Error('CoreSite fallback expired before 96 hours.');
  if (!fresh.shouldTrimExpiry) throw new Error('CoreSite fallback longer than 96 hours was not marked for trimming.');

  const boundary = freshnessDecision({
    verifiedAt: '2026-09-06T12:00:00Z',
    declaredExpiresAt: '2026-09-13T12:00:00Z',
    nowMs: now,
    sourceHealthy: false
  });
  if (!boundary.expired) throw new Error('CoreSite fallback did not expire at 96 hours.');

  const healthy = freshnessDecision({
    verifiedAt: '2026-09-01T12:00:00Z',
    declaredExpiresAt: '2026-09-08T12:00:00Z',
    nowMs: now,
    sourceHealthy: true
  });
  if (healthy.expired) throw new Error('Healthy direct CoreSite source was incorrectly pruned by fallback policy.');

  const missing = freshnessDecision({
    verifiedAt: null,
    declaredExpiresAt: null,
    nowMs: now,
    sourceHealthy: false
  });
  if (!missing.expired) throw new Error('CoreSite fallback without verification evidence did not fail closed.');

  console.log('CoreSite fallback freshness regression tests passed.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

const [jobs, fallback, status] = await Promise.all([
  readJson(JOBS_PATH),
  readJson(FALLBACK_PATH),
  readJson(STATUS_PATH)
]);
if (!Array.isArray(jobs)) throw new Error(`${JOBS_PATH} must contain an array.`);
if (!fallback || typeof fallback !== 'object' || Array.isArray(fallback) || !Array.isArray(fallback.jobs)) {
  throw new Error(`${FALLBACK_PATH} must contain a fallback object with a jobs array.`);
}
if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error(`${STATUS_PATH} must contain an object.`);

const sourceHealthy = status?.coreSite?.sourceHealthy === true;
const nowMs = Date.now();
const decision = freshnessDecision({
  verifiedAt: fallback.verifiedAt,
  declaredExpiresAt: fallback.expiresAt,
  nowMs,
  sourceHealthy
});

let fallbackChanged = false;
let statusChanged = false;
let jobsChanged = false;
const effectiveExpiresAt = decision.effectiveExpiresMs ? new Date(decision.effectiveExpiresMs).toISOString() : null;

if (decision.shouldTrimExpiry && effectiveExpiresAt) {
  fallback.expiresAt = effectiveExpiresAt;
  fallbackChanged = true;
  if (status?.coreSite?.verifiedFallback && typeof status.coreSite.verifiedFallback === 'object') {
    status.coreSite.verifiedFallback.expiresAt = effectiveExpiresAt;
    status.coreSite.verifiedFallback.maxAgeHours = MAX_FALLBACK_AGE_HOURS;
    status.coreSite.verifiedFallback.policy = 'CoreSite fallback roles may remain published for at most 96 hours after their last official verification.';
    statusChanged = true;
  }
}

if (decision.expired) {
  const prunedJobs = jobs.filter(job => !isCoreSite(job));
  const removedPublic = jobs.length - prunedJobs.length;
  if (removedPublic) {
    jobs.splice(0, jobs.length, ...prunedJobs);
    jobsChanged = true;
  }

  const checkedAt = new Date(nowMs).toISOString();
  status.updatedAt = checkedAt;
  status.jobs = jobs.length;
  status.countsByType = jobs.reduce((acc, job) => {
    const key = clean(job?.type) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  status.countsByExperience = jobs.reduce((acc, job) => {
    const key = clean(job?.experience) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  status.coreSite = {
    ...(status.coreSite || {}),
    sourceHealthy: false,
    qualifyingRoles: 0,
    verifiedFallback: {
      ...(status?.coreSite?.verifiedFallback || {}),
      active: false,
      expired: true,
      verifiedAt: clean(fallback.verifiedAt) || null,
      expiresAt: effectiveExpiresAt,
      checkedAt,
      maxAgeHours: MAX_FALLBACK_AGE_HOURS,
      expiredAgeHours: decision.ageHours === null ? null : Math.round(decision.ageHours * 10) / 10,
      roles: 0,
      rolesRemoved: removedPublic,
      policy: 'CoreSite fallback roles may remain published for at most 96 hours after their last official verification.'
    }
  };
  statusChanged = true;
}

if (fallbackChanged) await writeFile(FALLBACK_PATH, JSON.stringify(fallback, null, 2) + '\n');
if (jobsChanged) await writeFile(JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n');
if (statusChanged) await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

if (decision.expired) {
  console.warn(`CoreSite fallback exceeded the ${MAX_FALLBACK_AGE_HOURS}-hour verification window; stale public roles were removed.`);
} else if (decision.shouldTrimExpiry) {
  console.log(`CoreSite fallback expiry capped at ${effectiveExpiresAt} (${MAX_FALLBACK_AGE_HOURS} hours after verification).`);
} else if (sourceHealthy) {
  console.log('CoreSite direct source is healthy; fallback freshness cap is recorded but no public roles were pruned.');
} else {
  const age = decision.ageHours === null ? 'unknown' : `${Math.round(decision.ageHours * 10) / 10}`;
  console.log(`CoreSite verified fallback is ${age} hours old and inside the ${MAX_FALLBACK_AGE_HOURS}-hour maximum.`);
}
