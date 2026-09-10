import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/microsoft-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'Microsoft';
const MAX_FALLBACK_AGE_HOURS = 96;

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const isMicrosoft = job => clean(job?.company) === COMPANY || /^https:\/\/apply\.careers\.microsoft\.com\//i.test(clean(job?.sourceUrl));
const sourceIsHealthy = status => status?.sourceHealthy === true && status?.sourceMode !== 'retained-previous';

function freshnessDecision({ verifiedAt, nowMs, sourceHealthy }) {
  if (sourceHealthy) return { expired: false, active: false, expiresAt: null, ageHours: 0 };
  const verifiedMs = Date.parse(String(verifiedAt || ''));
  if (!Number.isFinite(verifiedMs)) return { expired: true, active: false, expiresAt: null, ageHours: null };
  const expiresAt = verifiedMs + MAX_FALLBACK_AGE_HOURS * 60 * 60 * 1000;
  const ageHours = Math.max(0, (nowMs - verifiedMs) / 36e5);
  return { expired: nowMs >= expiresAt, active: nowMs < expiresAt, expiresAt, ageHours };
}

function runSelfTest() {
  const now = Date.parse('2026-09-10T12:00:00Z');
  const healthy = freshnessDecision({ sourceHealthy: true, verifiedAt: '2026-09-01T00:00:00Z', nowMs: now });
  if (healthy.active || healthy.expired) throw new Error('healthy Microsoft source incorrectly entered fallback mode');
  const fresh = freshnessDecision({ sourceHealthy: false, verifiedAt: '2026-09-06T13:00:00Z', nowMs: now });
  if (!fresh.active || fresh.expired) throw new Error('Microsoft fallback expired before 96 hours');
  const boundary = freshnessDecision({ sourceHealthy: false, verifiedAt: '2026-09-06T12:00:00Z', nowMs: now });
  if (!boundary.expired) throw new Error('Microsoft fallback did not expire at 96 hours');
  const unknown = freshnessDecision({ sourceHealthy: false, verifiedAt: null, nowMs: now });
  if (!unknown.expired) throw new Error('Microsoft fallback without verification evidence did not fail closed');
  console.log('Microsoft fallback freshness regression tests passed.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

const jobs = await readJson(JOBS_PATH, []);
const snapshot = await readJson(SNAPSHOT_PATH, null);
const status = await readJson(STATUS_PATH, {});
if (!Array.isArray(jobs)) throw new Error(`${JOBS_PATH} must contain an array.`);
if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error(`${STATUS_PATH} must contain an object.`);

const microsoftStatus = status.microsoftDatacenter || {};
if (sourceIsHealthy(microsoftStatus)) {
  console.log('Microsoft employer source is healthy; stale-fallback enforcement is not active.');
  process.exit(0);
}

const nowMs = Date.now();
const verifiedAt = snapshot?.verifiedAt || microsoftStatus?.snapshotFallback?.verifiedAt || null;
const decision = freshnessDecision({ verifiedAt, nowMs, sourceHealthy: false });
const roundedAgeHours = decision.ageHours === null ? null : Math.round(decision.ageHours * 10) / 10;
const expiresIso = decision.expiresAt ? new Date(decision.expiresAt).toISOString() : null;
const currentMicrosoft = jobs.filter(isMicrosoft);

if (!decision.expired) {
  const nextFallback = {
    active: true,
    expired: false,
    verifiedAt,
    expiresAt: expiresIso,
    roles: currentMicrosoft.length,
    maxAgeHours: MAX_FALLBACK_AGE_HOURS,
    reason: `Retain previously verified Microsoft roles for at most ${MAX_FALLBACK_AGE_HOURS} hours after the last employer-direct verification.`
  };
  const prior = microsoftStatus.snapshotFallback || {};
  const unchanged = prior.active === true && prior.expired === false && clean(prior.verifiedAt) === clean(verifiedAt) && clean(prior.expiresAt) === clean(expiresIso) && Number(prior.roles || 0) === currentMicrosoft.length && Number(prior.maxAgeHours || MAX_FALLBACK_AGE_HOURS) === MAX_FALLBACK_AGE_HOURS;
  if (unchanged) {
    console.log(`Microsoft source remains unavailable; fallback age is ${roundedAgeHours} hours and still inside the ${MAX_FALLBACK_AGE_HOURS}-hour window.`);
    process.exit(0);
  }
  status.microsoftDatacenter = { ...microsoftStatus, snapshotFallback: nextFallback };
  await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
  console.log(`Initialized Microsoft fallback freshness through ${expiresIso}.`);
  process.exit(0);
}

const prunedJobs = jobs.filter(job => !isMicrosoft(job));
const removed = jobs.length - prunedJobs.length;
status.updatedAt = new Date(nowMs).toISOString();
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
status.microsoftDatacenter = {
  ...microsoftStatus,
  qualifyingRoles: 0,
  retainedPrevious: false,
  snapshotFallback: {
    active: false,
    expired: true,
    verifiedAt: verifiedAt || null,
    expiresAt: expiresIso,
    roles: 0,
    rolesRemoved: removed,
    maxAgeHours: MAX_FALLBACK_AGE_HOURS,
    reason: `Microsoft employer-direct verification exceeded ${MAX_FALLBACK_AGE_HOURS} hours, so retained Microsoft roles were removed until the source recovers.`
  }
};

await writeFile(JOBS_PATH, JSON.stringify(prunedJobs, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
console.warn(`Expired Microsoft fallback after ${roundedAgeHours ?? 'unknown'} hours without employer-direct verification; removed ${removed} public role(s).`);
