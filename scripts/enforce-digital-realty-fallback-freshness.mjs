import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/digital-realty-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'Digital Realty';
const OFFICIAL_HOST = 'hdep.fa.us2.oraclecloud.com';
const MAX_FALLBACK_AGE_HOURS = 96;
const MAX_FALLBACK_AGE_MS = MAX_FALLBACK_AGE_HOURS * 60 * 60 * 1000;

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const isDigitalRealty = job => {
  if (clean(job?.company) === COMPANY) return true;
  try {
    return new URL(clean(job?.sourceUrl)).hostname.toLowerCase() === OFFICIAL_HOST;
  } catch {
    return false;
  }
};

function gitLastChangedAt(path) {
  try {
    const value = execFileSync('git', ['log', '-1', '--format=%cI', '--', path], { encoding: 'utf8' }).trim();
    return Number.isFinite(Date.parse(value)) ? value : null;
  } catch {
    return null;
  }
}

function sourceIsHealthy(source) {
  return source?.sourceHealthy === true && source?.fallbackUsed !== true;
}

function freshnessDecision({ verifiedAt, nowMs, sourceHealthy }) {
  if (sourceHealthy) return { expired: false, active: false, expiresAt: null, ageHours: 0 };
  const verifiedMs = Date.parse(String(verifiedAt || ''));
  if (!Number.isFinite(verifiedMs)) return { expired: true, active: false, expiresAt: null, ageHours: null };
  const expiresAt = verifiedMs + MAX_FALLBACK_AGE_MS;
  const ageHours = Math.max(0, (nowMs - verifiedMs) / 36e5);
  return { expired: nowMs >= expiresAt, active: nowMs < expiresAt, expiresAt, ageHours };
}

function runSelfTest() {
  const now = Date.parse('2026-09-10T12:00:00Z');
  const healthy = freshnessDecision({ sourceHealthy: true, verifiedAt: '2026-09-01T00:00:00Z', nowMs: now });
  if (healthy.active || healthy.expired) throw new Error('healthy Digital Realty source incorrectly entered fallback mode');
  const fresh = freshnessDecision({ sourceHealthy: false, verifiedAt: '2026-09-06T13:00:00Z', nowMs: now });
  if (!fresh.active || fresh.expired) throw new Error('Digital Realty fallback expired before 96 hours');
  const boundary = freshnessDecision({ sourceHealthy: false, verifiedAt: '2026-09-06T12:00:00Z', nowMs: now });
  if (!boundary.expired) throw new Error('Digital Realty fallback did not expire at 96 hours');
  const unknown = freshnessDecision({ sourceHealthy: false, verifiedAt: null, nowMs: now });
  if (!unknown.expired) throw new Error('Digital Realty fallback without verification evidence did not fail closed');
  console.log('Digital Realty fallback freshness regression tests passed.');
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
if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error(`${STATUS_PATH} must contain an object.`);

const source = status.digitalRealty || {};
if (sourceIsHealthy(source)) {
  console.log('Digital Realty employer source is healthy; stale-fallback enforcement is not active.');
  process.exit(0);
}

const nowMs = Date.now();
const verifiedAt = source.lastHealthyAt || source.snapshotVerifiedAt || gitLastChangedAt(SNAPSHOT_PATH);
const decision = freshnessDecision({ verifiedAt, nowMs, sourceHealthy: false });
const roundedAgeHours = decision.ageHours === null ? null : Math.round(decision.ageHours * 10) / 10;
const expiresIso = decision.expiresAt ? new Date(decision.expiresAt).toISOString() : null;
const currentPublic = jobs.filter(isDigitalRealty);

if (!decision.expired) {
  const nextSource = {
    ...source,
    snapshotMaxAgeHours: MAX_FALLBACK_AGE_HOURS,
    snapshotVerifiedAt: verifiedAt || source.snapshotVerifiedAt || null,
    fallbackUsed: snapshot.length > 0 || currentPublic.length > 0,
    fallbackFresh: snapshot.length > 0 || currentPublic.length > 0,
    fallbackExpired: false,
    fallbackExpiresAt: expiresIso
  };
  const unchanged = Number(source.snapshotMaxAgeHours || 0) === MAX_FALLBACK_AGE_HOURS
    && clean(source.snapshotVerifiedAt) === clean(nextSource.snapshotVerifiedAt)
    && source.fallbackUsed === nextSource.fallbackUsed
    && source.fallbackFresh === nextSource.fallbackFresh
    && source.fallbackExpired === false
    && clean(source.fallbackExpiresAt) === clean(expiresIso);
  if (unchanged) {
    console.log(`Digital Realty source remains unavailable; fallback age is ${roundedAgeHours} hours and still inside the ${MAX_FALLBACK_AGE_HOURS}-hour window.`);
    process.exit(0);
  }
  status.digitalRealty = nextSource;
  await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
  console.log(`Digital Realty fallback remains fresh through ${expiresIso}.`);
  process.exit(0);
}

const prunedJobs = jobs.filter(job => !isDigitalRealty(job));
const removedPublic = jobs.length - prunedJobs.length;
const removedSnapshot = snapshot.length;
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
status.digitalRealty = {
  ...source,
  qualifyingRoles: 0,
  snapshotRoles: 0,
  preservedPrevious: 0,
  snapshotMaxAgeHours: MAX_FALLBACK_AGE_HOURS,
  snapshotVerifiedAt: verifiedAt || source.snapshotVerifiedAt || null,
  fallbackUsed: false,
  fallbackFresh: false,
  fallbackExpired: true,
  fallbackExpiresAt: expiresIso,
  staleFallbackRemoved: removedPublic,
  staleSnapshotRemoved: removedSnapshot,
  fallbackReason: `Digital Realty employer-direct verification exceeded ${MAX_FALLBACK_AGE_HOURS} hours, so retained roles were removed until the official source recovers.`
};

await writeFile(JOBS_PATH, JSON.stringify(prunedJobs, null, 2) + '\n');
await writeFile(SNAPSHOT_PATH, '[]\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
console.warn(`Expired Digital Realty fallback after ${roundedAgeHours ?? 'unknown'} hours without employer-direct verification; removed ${removedPublic} public role(s) and ${removedSnapshot} snapshot role(s).`);
