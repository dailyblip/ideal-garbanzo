import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/amazon-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'Amazon Web Services';
const MAX_FALLBACK_AGE_HOURS = 96;
const HISTORY_LIMIT = 120;

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function isHealthyAmazonStatus(amazon = {}) {
  const attempted = Number(amazon?.queriesAttempted || 0);
  const succeeded = Number(amazon?.queriesSucceeded || 0);
  return amazon?.sourceHealthy === true &&
    attempted > 0 &&
    succeeded === attempted &&
    Number(amazon?.preservedPreviousRoles || 0) === 0;
}

function hasPreservedFallback(amazon = {}) {
  return !isHealthyAmazonStatus(amazon) && Number(amazon?.preservedPreviousRoles || 0) > 0;
}

function freshnessDecision({ fallbackActive, lastHealthyAt, nowMs, maxAgeHours = MAX_FALLBACK_AGE_HOURS }) {
  if (!fallbackActive) return { active: false, expired: false, ageHours: 0 };

  const lastHealthyMs = Date.parse(String(lastHealthyAt || ''));
  if (!Number.isFinite(lastHealthyMs)) {
    return { active: true, expired: true, ageHours: null };
  }

  const ageHours = Math.max(0, (nowMs - lastHealthyMs) / 36e5);
  return { active: true, expired: ageHours >= maxAgeHours, ageHours };
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function readStatusAtCommit(sha) {
  try { return JSON.parse(git(['show', `${sha}:${STATUS_PATH}`])); }
  catch { return null; }
}

function amazonFingerprint(amazon = {}) {
  if (!amazon || typeof amazon !== 'object') return '';
  const copy = { ...amazon };
  delete copy.fallbackFreshness;
  return JSON.stringify(copy);
}

function isKnownAmazonVerificationCommit(subject = '') {
  return /^(?:Recover verified AWS roles and refresh QA|Refresh verified jobs, events, and QA report)$/.test(String(subject).trim());
}

function findLastHealthyAmazonCheck() {
  let history = '';
  try {
    history = git(['log', `-${HISTORY_LIMIT}`, '--format=%H%x09%cI%x09%s', '--', STATUS_PATH]);
  } catch {
    return null;
  }

  for (const line of history.split('\n').filter(Boolean)) {
    const [sha, committedAt, ...subjectParts] = line.split('\t');
    const subject = subjectParts.join('\t');
    if (!sha || !committedAt) continue;

    const current = readStatusAtCommit(sha);
    const amazon = current?.amazonDatacenter;
    if (!isHealthyAmazonStatus(amazon)) continue;

    if (isKnownAmazonVerificationCommit(subject)) return committedAt;

    let parentAmazon = null;
    try {
      const parent = readStatusAtCommit(git(['rev-parse', `${sha}^`]));
      parentAmazon = parent?.amazonDatacenter || null;
    } catch {}

    // Older AWS workflows did not stamp a source-check timestamp. Treat a
    // changed healthy AWS diagnostic block as evidence of a real source check,
    // while ignoring unrelated commits that merely carried it forward.
    if (!parentAmazon || amazonFingerprint(amazon) !== amazonFingerprint(parentAmazon)) {
      return committedAt;
    }
  }

  return null;
}

function runSelfTest() {
  const now = Date.parse('2026-09-10T12:00:00Z');
  const healthy = freshnessDecision({ fallbackActive: false, lastHealthyAt: '2026-09-01T00:00:00Z', nowMs: now });
  if (healthy.active || healthy.expired || healthy.ageHours !== 0) throw new Error('healthy AWS source incorrectly entered fallback mode');

  const freshFallback = freshnessDecision({ fallbackActive: true, lastHealthyAt: '2026-09-06T13:00:00Z', nowMs: now });
  if (!freshFallback.active || freshFallback.expired) throw new Error('AWS fallback expired before 96 hours');

  const boundary = freshnessDecision({ fallbackActive: true, lastHealthyAt: '2026-09-06T12:00:00Z', nowMs: now });
  if (!boundary.expired) throw new Error('AWS fallback did not expire at the 96-hour boundary');

  const unknown = freshnessDecision({ fallbackActive: true, lastHealthyAt: null, nowMs: now });
  if (!unknown.expired) throw new Error('AWS fallback without healthy-source evidence was not failed closed');

  const healthyStatus = { sourceHealthy: true, queriesAttempted: 5, queriesSucceeded: 5, preservedPreviousRoles: 0 };
  if (!isHealthyAmazonStatus(healthyStatus)) throw new Error('healthy AWS diagnostics were not recognized');
  if (isHealthyAmazonStatus({ ...healthyStatus, queriesSucceeded: 4 })) throw new Error('partial AWS query set was treated as healthy');
  if (!hasPreservedFallback({ sourceHealthy: false, queriesAttempted: 5, queriesSucceeded: 4, preservedPreviousRoles: 2 })) throw new Error('preserved AWS fallback was not detected');
  if (!isKnownAmazonVerificationCommit('Recover verified AWS roles and refresh QA')) throw new Error('AWS recovery commit was not recognized as source-verification evidence');
  if (isKnownAmazonVerificationCommit('Refresh verified Oracle roles')) throw new Error('unrelated commit was incorrectly recognized as AWS source-verification evidence');

  console.log('AWS fallback freshness regression tests passed.');
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

const amazonStatus = status.amazonDatacenter || {};
if (isHealthyAmazonStatus(amazonStatus)) {
  console.log('AWS employer source is healthy; stale-fallback enforcement is not active.');
  process.exit(0);
}
if (!hasPreservedFallback(amazonStatus)) {
  console.log('AWS source is degraded but no previously verified roles are being preserved; stale-fallback enforcement is not active.');
  process.exit(0);
}

const priorFreshness = amazonStatus.fallbackFreshness || {};
const lastHealthyAt = clean(priorFreshness.lastHealthyAt) || findLastHealthyAmazonCheck();
const nowMs = Date.now();
const checkedAt = new Date(nowMs).toISOString();
const decision = freshnessDecision({ fallbackActive: true, lastHealthyAt, nowMs });
const roundedAgeHours = decision.ageHours === null ? null : Math.round(decision.ageHours * 10) / 10;

if (!decision.expired) {
  const nextFreshness = {
    active: true,
    expired: false,
    lastHealthyAt,
    checkedAt,
    maxAgeHours: MAX_FALLBACK_AGE_HOURS,
    policy: 'Retain previously verified AWS employer-direct roles for at most 96 hours after the last evidenced complete official Amazon Jobs search.'
  };

  const alreadyInitialized = clean(priorFreshness.lastHealthyAt) === lastHealthyAt &&
    Number(priorFreshness.maxAgeHours) === MAX_FALLBACK_AGE_HOURS &&
    priorFreshness.active === true && priorFreshness.expired === false;

  if (alreadyInitialized) {
    console.log(`AWS source remains degraded; fallback is ${roundedAgeHours} hours old and still inside the ${MAX_FALLBACK_AGE_HOURS}-hour window.`);
    process.exit(0);
  }

  status.amazonDatacenter = { ...amazonStatus, fallbackFreshness: nextFreshness };
  await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
  console.log(`Initialized AWS fallback freshness window from ${lastHealthyAt}; current age ${roundedAgeHours} hours.`);
  process.exit(0);
}

const awsJobsBefore = jobs.filter(job => clean(job?.company) === COMPANY).length;
const awsSnapshotBefore = snapshot.filter(job => clean(job?.company) === COMPANY).length;
const prunedJobs = jobs.filter(job => clean(job?.company) !== COMPANY && !/amazon\.jobs\//i.test(String(job?.sourceUrl || '')));
const prunedSnapshot = snapshot.filter(job => clean(job?.company) !== COMPANY);

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
status.amazonDatacenter = {
  ...amazonStatus,
  preservedPreviousRoles: 0,
  qualifyingRoles: 0,
  fallbackFreshness: {
    active: false,
    expired: true,
    lastHealthyAt: lastHealthyAt || null,
    checkedAt,
    maxAgeHours: MAX_FALLBACK_AGE_HOURS,
    expiredAgeHours: roundedAgeHours,
    rolesRemoved: Math.max(awsJobsBefore, awsSnapshotBefore),
    policy: 'AWS fallback exceeded 96 hours without an evidenced complete healthy official-source search, so retained AWS roles were removed until the source recovers.'
  }
};

await writeFile(JOBS_PATH, JSON.stringify(prunedJobs, null, 2) + '\n');
await writeFile(SNAPSHOT_PATH, JSON.stringify(prunedSnapshot, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

console.warn(`Expired AWS fallback after ${roundedAgeHours ?? 'unknown'} hours without a complete healthy source check; removed ${awsJobsBefore} public role(s) and ${awsSnapshotBefore} snapshot role(s).`);
