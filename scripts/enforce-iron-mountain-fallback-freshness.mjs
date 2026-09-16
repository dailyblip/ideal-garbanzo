import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/iron-mountain-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'Iron Mountain';
const HOST = 'ironmountain.wd5.myworkdayjobs.com';
const MAX_AGE_HOURS = 96;
const MAX_AGE_MS = MAX_AGE_HOURS * 60 * 60 * 1000;

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}
function isIronMountain(job = {}) {
  if (clean(job.company) === COMPANY) return true;
  try { return new URL(clean(job.sourceUrl)).hostname.toLowerCase() === HOST; }
  catch { return false; }
}
function freshness(lastHealthyAt, nowMs, hasRoles, legacyAuthoritative = false) {
  if (!hasRoles) return { expired: false, ageHours: 0, expiresAt: null, migrationPending: false };
  const verifiedMs = Date.parse(String(lastHealthyAt || ''));
  if (!Number.isFinite(verifiedMs)) {
    return legacyAuthoritative
      ? { expired: false, ageHours: null, expiresAt: null, migrationPending: true }
      : { expired: true, ageHours: null, expiresAt: null, migrationPending: false };
  }
  const expiresAt = verifiedMs + MAX_AGE_MS;
  const ageHours = Math.max(0, (nowMs - verifiedMs) / 36e5);
  return { expired: nowMs >= expiresAt, ageHours, expiresAt, migrationPending: false };
}
function legacyHealthy(source = {}) {
  return source.sourceHealthy === true &&
    source.listingComplete === true &&
    Number(source.detailAttempted || 0) === Number(source.candidateRows || 0) &&
    Number(source.detailSucceeded || 0) === Number(source.detailAttempted || 0) &&
    Number(source?.drops?.fetch || 0) === 0;
}

if (process.argv.includes('--test')) {
  const now = Date.parse('2026-09-16T12:00:00Z');
  if (freshness('2026-09-12T12:00:01Z', now, true).expired) throw new Error('fallback expired before 96 hours');
  if (!freshness('2026-09-12T12:00:00Z', now, true).expired) throw new Error('fallback did not expire at 96 hours');
  if (!freshness(null, now, true).expired) throw new Error('missing verification evidence did not fail closed');
  if (!freshness(null, now, true, true).migrationPending) throw new Error('legacy healthy migration was not protected');
  if (freshness(null, now, false).expired) throw new Error('empty feed incorrectly expired');
  console.log('Iron Mountain fallback freshness regression tests passed.');
  process.exit(0);
}

const jobs = await readJson(JOBS_PATH, []);
const snapshot = await readJson(SNAPSHOT_PATH, []);
const status = await readJson(STATUS_PATH, {});
if (!Array.isArray(jobs) || !Array.isArray(snapshot) || !status || typeof status !== 'object' || Array.isArray(status)) {
  throw new Error('Iron Mountain freshness enforcement requires valid jobs, snapshot, and collector-status JSON.');
}

const source = status.ironMountain && typeof status.ironMountain === 'object' ? status.ironMountain : {};
const publicRoles = jobs.filter(isIronMountain);
const snapshotRoles = snapshot.filter(isIronMountain);
const hasRoles = publicRoles.length > 0 || snapshotRoles.length > 0;
const lastHealthyAt = clean(source.lastHealthyAt || source.fallbackFreshness?.lastHealthyAt || '');
const nowMs = Date.now();
const decision = freshness(lastHealthyAt, nowMs, hasRoles, !lastHealthyAt && legacyHealthy(source));

if (decision.migrationPending) {
  console.log('Iron Mountain legacy snapshot is healthy but has no freshness timestamp yet; leaving it intact until the hardened collector seeds lastHealthyAt.');
  process.exit(0);
}
if (!decision.expired) {
  const age = decision.ageHours === null ? 'unknown' : Math.round(decision.ageHours * 10) / 10;
  console.log(hasRoles ? `Iron Mountain verification is ${age} hours old and inside the ${MAX_AGE_HOURS}-hour maximum.` : 'No Iron Mountain roles are published; freshness pruning is not active.');
  process.exit(0);
}

const prunedJobs = jobs.filter(job => !isIronMountain(job));
const checkedAt = new Date(nowMs).toISOString();
const roundedAge = decision.ageHours === null ? null : Math.round(decision.ageHours * 10) / 10;
status.updatedAt = checkedAt;
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
status.ironMountain = {
  ...source,
  checkedAt,
  sourceHealthy: false,
  authoritativeSnapshot: false,
  usedPreviousSnapshot: false,
  qualifyingRoles: 0,
  snapshotRoles: 0,
  removedExpiredFallback: Math.max(publicRoles.length, snapshotRoles.length),
  fallbackFreshness: {
    active: false,
    expired: true,
    lastHealthyAt: lastHealthyAt || null,
    checkedAt,
    expiresAt: decision.expiresAt ? new Date(decision.expiresAt).toISOString() : null,
    ageHours: roundedAge,
    maxAgeHours: MAX_AGE_HOURS,
    roles: 0,
    policy: 'Retain only the last fully verified Iron Mountain snapshot for at most 96 hours after official-source verification fails.'
  }
};

await writeFile(JOBS_PATH, JSON.stringify(prunedJobs, null, 2) + '\n');
await writeFile(SNAPSHOT_PATH, '[]\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
console.warn(`Expired Iron Mountain verified fallback after ${roundedAge ?? 'unknown'} hours; removed ${publicRoles.length} public role(s) and ${snapshotRoles.length} snapshot role(s).`);
