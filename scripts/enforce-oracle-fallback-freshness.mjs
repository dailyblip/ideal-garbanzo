import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/oracle-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'Oracle';
const MAX_FALLBACK_AGE_HOURS = 96;
const HISTORY_LIMIT = 120;

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function isHealthyOracleStatus(status = {}) {
  return status?.sourceHealthy === true && status?.listingComplete === true;
}

function freshnessDecision({ lastHealthyAt, nowMs, hasPublishedRoles, maxAgeHours = MAX_FALLBACK_AGE_HOURS }) {
  if (!hasPublishedRoles) {
    return { expired: false, ageHours: 0 };
  }

  const lastHealthyMs = Date.parse(String(lastHealthyAt || ''));
  if (!Number.isFinite(lastHealthyMs)) {
    return { expired: true, ageHours: null };
  }

  const ageHours = Math.max(0, (nowMs - lastHealthyMs) / 36e5);
  return {
    expired: ageHours >= maxAgeHours,
    ageHours
  };
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function readStatusAtCommit(sha) {
  try {
    return JSON.parse(git(['show', `${sha}:${STATUS_PATH}`]));
  } catch {
    return null;
  }
}

function oracleFingerprint(oracle = {}) {
  if (!oracle || typeof oracle !== 'object') return '';
  const copy = { ...oracle };
  delete copy.fallbackFreshness;
  return JSON.stringify(copy);
}

function findLastHealthyOracleCheck() {
  let history = '';
  try {
    history = git(['log', `-${HISTORY_LIMIT}`, '--format=%H%x09%cI', '--', STATUS_PATH]);
  } catch {
    return null;
  }

  for (const line of history.split('\n').filter(Boolean)) {
    const [sha, committedAt] = line.split('\t');
    if (!sha || !committedAt) continue;
    const current = readStatusAtCommit(sha);
    const oracle = current?.oracleCareers;
    if (!isHealthyOracleStatus(oracle)) continue;

    let parentOracle = null;
    try {
      const parent = readStatusAtCommit(git(['rev-parse', `${sha}^`]));
      parentOracle = parent?.oracleCareers || null;
    } catch {}

    // Ignore unrelated commits that merely carried the same Oracle diagnostics
    // forward. A changed healthy Oracle block is evidence that the employer source
    // was actually checked again, rather than just copied by another collector.
    if (!parentOracle || oracleFingerprint(oracle) !== oracleFingerprint(parentOracle)) {
      return committedAt;
    }
  }

  return null;
}

function runSelfTest() {
  const now = Date.parse('2026-09-10T12:00:00Z');

  const fresh = freshnessDecision({ lastHealthyAt: '2026-09-06T12:00:01Z', nowMs: now, hasPublishedRoles: true });
  if (fresh.expired) throw new Error('Oracle verification expired before 96 hours');

  const boundary = freshnessDecision({ lastHealthyAt: '2026-09-06T12:00:00Z', nowMs: now, hasPublishedRoles: true });
  if (!boundary.expired) throw new Error('Oracle verification did not expire at the 96-hour boundary');

  const staleHealthyFlag = freshnessDecision({ lastHealthyAt: '2026-09-01T00:00:00Z', nowMs: now, hasPublishedRoles: true });
  if (!staleHealthyFlag.expired) throw new Error('stale Oracle verification was incorrectly kept alive by previously healthy status');

  const unknown = freshnessDecision({ lastHealthyAt: null, nowMs: now, hasPublishedRoles: true });
  if (!unknown.expired) throw new Error('Oracle roles without healthy-source evidence were not failed closed');

  const empty = freshnessDecision({ lastHealthyAt: null, nowMs: now, hasPublishedRoles: false });
  if (empty.expired) throw new Error('empty Oracle feed incorrectly entered expiry');

  console.log('Oracle verification freshness regression tests passed, including silent-refresh failure expiry.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

const jobs = await readJson(JOBS_PATH, []);
const snapshot = await readJson(SNAPSHOT_PATH, []);
const status = await readJson(STATUS_PATH, {});
if (!Array.isArray(jobs)) throw new Error(`${JOBS_PATH} must contain an array`);
if (!Array.isArray(snapshot)) throw new Error(`${SNAPSHOT_PATH} must contain an array`);
if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error(`${STATUS_PATH} must contain an object`);

const oracleStatus = status.oracleCareers || {};
const oracleJobsBefore = jobs.filter(job => clean(job?.company) === COMPANY).length;
const oracleSnapshotBefore = snapshot.filter(job => clean(job?.company) === COMPANY).length;
const hasPublishedRoles = oracleJobsBefore > 0 || oracleSnapshotBefore > 0;
const priorFreshness = oracleStatus.fallbackFreshness || {};
const lastHealthyAt = clean(priorFreshness.lastHealthyAt || oracleStatus.lastHealthyAt) || findLastHealthyOracleCheck();
const nowMs = Date.now();
const checkedAt = new Date(nowMs).toISOString();
const decision = freshnessDecision({ lastHealthyAt, nowMs, hasPublishedRoles });
const roundedAgeHours = decision.ageHours === null ? null : Math.round(decision.ageHours * 10) / 10;
const sourceHealthy = isHealthyOracleStatus(oracleStatus);

if (!decision.expired) {
  if (!hasPublishedRoles) {
    console.log('No Oracle roles are currently published; stale-verification enforcement is not active.');
    process.exit(0);
  }

  if (sourceHealthy) {
    console.log(`Oracle verification is ${roundedAgeHours} hours old and inside the ${MAX_FALLBACK_AGE_HOURS}-hour maximum.`);
    process.exit(0);
  }

  const nextFreshness = {
    active: true,
    expired: false,
    lastHealthyAt,
    checkedAt,
    maxAgeHours: MAX_FALLBACK_AGE_HOURS,
    ageHours: roundedAgeHours,
    policy: 'Retain the last verified Oracle employer-direct snapshot for at most 96 hours after the last evidenced healthy source check.'
  };

  const alreadyInitialized = clean(priorFreshness.lastHealthyAt) === lastHealthyAt &&
    Number(priorFreshness.maxAgeHours) === MAX_FALLBACK_AGE_HOURS &&
    priorFreshness.active === true && priorFreshness.expired === false;

  if (alreadyInitialized) {
    console.log(`Oracle source remains unavailable; fallback is ${roundedAgeHours} hours old and still inside the ${MAX_FALLBACK_AGE_HOURS}-hour window.`);
    process.exit(0);
  }

  status.oracleCareers = { ...oracleStatus, fallbackFreshness: nextFreshness };
  await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
  console.log(`Initialized Oracle fallback freshness window from ${lastHealthyAt}; current age ${roundedAgeHours} hours.`);
  process.exit(0);
}

const prunedJobs = jobs.filter(job => clean(job?.company) !== COMPANY);
const prunedSnapshot = snapshot.filter(job => clean(job?.company) !== COMPANY);

status.updatedAt = checkedAt;
status.jobs = prunedJobs.length;
if (status.countsByType && typeof status.countsByType === 'object') {
  status.countsByType = prunedJobs.reduce((acc, job) => {
    const key = clean(job?.type) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}
if (status.countsByExperience && typeof status.countsByExperience === 'object') {
  status.countsByExperience = prunedJobs.reduce((acc, job) => {
    const key = clean(job?.experience) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}
status.oracleCareers = {
  ...oracleStatus,
  sourceHealthy: false,
  listingComplete: false,
  qualifyingRoles: 0,
  preservedFromPrevious: 0,
  fallbackFreshness: {
    active: false,
    expired: true,
    lastHealthyAt: lastHealthyAt || null,
    checkedAt,
    maxAgeHours: MAX_FALLBACK_AGE_HOURS,
    ageHours: roundedAgeHours,
    rolesRemoved: Math.max(oracleJobsBefore, oracleSnapshotBefore),
    policy: 'Oracle verification exceeded 96 hours without a new evidenced healthy official-source check, so Oracle roles were removed until verification recovers.'
  }
};

await writeFile(JOBS_PATH, JSON.stringify(prunedJobs, null, 2) + '\n');
await writeFile(SNAPSHOT_PATH, JSON.stringify(prunedSnapshot, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

console.warn(`Expired Oracle verification after ${roundedAgeHours ?? 'unknown'} hours; removed ${oracleJobsBefore} public role(s) and ${oracleSnapshotBefore} snapshot role(s) pending a healthy official-source refresh.`);
