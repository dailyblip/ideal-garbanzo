import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/novva-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'Novva Data Centers';
const SOURCE_KEY = 'novvaCareers';
const MAX_FALLBACK_AGE_HOURS = 96;
const MAX_FALLBACK_AGE_MS = MAX_FALLBACK_AGE_HOURS * 60 * 60 * 1000;

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

export function freshnessDecision({ verifiedAt, nowMs, hasPublishedRoles }) {
  if (!hasPublishedRoles) return { expired: false, ageHours: 0, expiresAt: null };
  const verifiedMs = Date.parse(String(verifiedAt || ''));
  if (!Number.isFinite(verifiedMs)) return { expired: true, ageHours: null, expiresAt: null };
  const expiresAt = verifiedMs + MAX_FALLBACK_AGE_MS;
  return {
    expired: nowMs >= expiresAt,
    ageHours: Math.max(0, (nowMs - verifiedMs) / 36e5),
    expiresAt
  };
}

export function pruneExpiredNovva({ jobs, snapshot, status, nowMs }) {
  const publicJobs = jobs.filter(job => clean(job?.company) === COMPANY);
  const snapshotJobs = snapshot.filter(job => clean(job?.company) === COMPANY);
  const hasPublishedRoles = publicJobs.length > 0 || snapshotJobs.length > 0;
  const source = status?.[SOURCE_KEY] || {};
  const verifiedAt = clean(source.lastHealthyAt);
  const decision = freshnessDecision({ verifiedAt, nowMs, hasPublishedRoles });

  if (!decision.expired) {
    return {
      changed: false,
      jobs,
      snapshot,
      status,
      decision,
      removedPublic: 0,
      removedSnapshot: 0,
      verifiedAt: verifiedAt || null
    };
  }

  const nextJobs = jobs.filter(job => clean(job?.company) !== COMPANY);
  const removedPublic = jobs.length - nextJobs.length;
  const removedSnapshot = snapshotJobs.length;
  const checkedAt = new Date(nowMs).toISOString();
  const roundedAgeHours = decision.ageHours === null ? null : Math.round(decision.ageHours * 10) / 10;
  const expiresAt = decision.expiresAt ? new Date(decision.expiresAt).toISOString() : null;

  const nextStatus = {
    ...status,
    updatedAt: checkedAt,
    jobs: nextJobs.length,
    countsByType: nextJobs.reduce((acc, job) => {
      const key = clean(job?.type) || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    countsByExperience: nextJobs.reduce((acc, job) => {
      const key = clean(job?.experience) || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    [SOURCE_KEY]: {
      ...source,
      sourceHealthy: false,
      checkedAt,
      lastHealthyAt: verifiedAt || null,
      fallbackMaxAgeHours: MAX_FALLBACK_AGE_HOURS,
      fallbackAgeHours: roundedAgeHours,
      fallbackExpired: true,
      usedPreviousSnapshot: false,
      qualifyingRoles: 0,
      preservedPrevious: 0,
      removedExpiredFallback: Math.max(removedPublic, removedSnapshot),
      fallbackPolicy: `Retain the last fully verified Novva snapshot for at most ${MAX_FALLBACK_AGE_HOURS} hours after official-source verification; then remove Novva roles until fresh verification succeeds.`,
      fallbackFreshness: {
        active: false,
        expired: true,
        lastHealthyAt: verifiedAt || null,
        checkedAt,
        expiresAt,
        maxAgeHours: MAX_FALLBACK_AGE_HOURS,
        expiredAgeHours: roundedAgeHours,
        rolesRemoved: Math.max(removedPublic, removedSnapshot),
        policy: 'Novva Data Centers employer-direct roles may remain published for at most 96 hours after the last successful official-source verification.'
      }
    }
  };

  return {
    changed: true,
    jobs: nextJobs,
    snapshot: [],
    status: nextStatus,
    decision,
    removedPublic,
    removedSnapshot,
    verifiedAt: verifiedAt || null
  };
}

function runSelfTest() {
  const now = Date.parse('2026-09-24T12:00:00Z');

  const fresh = freshnessDecision({
    verifiedAt: '2026-09-20T12:00:01Z',
    nowMs: now,
    hasPublishedRoles: true
  });
  if (fresh.expired) throw new Error('Novva fallback expired before 96 hours');

  const boundary = freshnessDecision({
    verifiedAt: '2026-09-20T12:00:00Z',
    nowMs: now,
    hasPublishedRoles: true
  });
  if (!boundary.expired) throw new Error('Novva fallback did not expire at 96 hours');

  const missing = freshnessDecision({ verifiedAt: null, nowMs: now, hasPublishedRoles: true });
  if (!missing.expired) throw new Error('Novva roles without successful verification evidence did not fail closed');

  const empty = freshnessDecision({ verifiedAt: null, nowMs: now, hasPublishedRoles: false });
  if (empty.expired) throw new Error('Empty Novva feed incorrectly entered expiry');

  const sampleJobs = [
    { company: COMPANY, id: 'novva-stale' },
    { company: 'Microsoft', id: 'unrelated-role' }
  ];
  const sampleSnapshot = [{ company: COMPANY, id: 'novva-stale' }];
  const sampleStatus = {
    jobs: 2,
    [SOURCE_KEY]: {
      candidateLinks: 1,
      detailSucceeded: 1,
      lastHealthyAt: '2026-09-20T12:00:00Z',
      sourceHealthy: true
    }
  };
  const evaluated = pruneExpiredNovva({
    jobs: sampleJobs,
    snapshot: sampleSnapshot,
    status: sampleStatus,
    nowMs: now
  });
  if (!evaluated.changed) throw new Error('Expired Novva state was not changed');
  if (evaluated.jobs.some(job => job.id === 'novva-stale')) throw new Error('Expired Novva role was not removed');
  if (!evaluated.jobs.some(job => job.id === 'unrelated-role')) throw new Error('Unrelated employer role was incorrectly removed');
  if (evaluated.snapshot.length !== 0) throw new Error('Expired Novva snapshot was not cleared');
  if (evaluated.status[SOURCE_KEY].candidateLinks !== 1 || evaluated.status[SOURCE_KEY].detailSucceeded !== 1) {
    throw new Error('Novva source evidence metadata was not preserved during expiry');
  }

  console.log('Novva fallback freshness regression tests passed.');
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

const result = pruneExpiredNovva({ jobs, snapshot, status, nowMs: Date.now() });
if (!result.changed) {
  if (result.decision.ageHours === 0 && !result.verifiedAt) {
    console.log('No Novva Data Centers roles are currently published; stale-fallback enforcement is not active.');
  } else {
    const age = Math.round((result.decision.ageHours || 0) * 10) / 10;
    console.log(`Novva verification is ${age} hours old and inside the ${MAX_FALLBACK_AGE_HOURS}-hour maximum.`);
  }
  process.exit(0);
}

await writeFile(JOBS_PATH, JSON.stringify(result.jobs, null, 2) + '\n');
await writeFile(SNAPSHOT_PATH, '[]\n');
await writeFile(STATUS_PATH, JSON.stringify(result.status, null, 2) + '\n');

const age = result.decision.ageHours === null ? 'unknown' : `${Math.round(result.decision.ageHours * 10) / 10}`;
console.warn(`Expired Novva Data Centers snapshot after ${age} hours without official-source verification; removed ${result.removedPublic} public role(s) and ${result.removedSnapshot} snapshot role(s).`);
