import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const STATUS_PATH = 'data/collector-status.json';
const SNAPSHOT_PATH = 'data/oracle-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const COMPANY = 'Oracle';
const MAX_AGE_HOURS = 96;

const clean = value => String(value ?? '').trim();

function gitText(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function readStatusAtCommit(sha) {
  const raw = gitText(['show', `${sha}:${STATUS_PATH}`]);
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { return null; }
}

function legacySnapshotEvidence() {
  const history = gitText(['log', '-40', '--format=%H%x09%cI', '--', SNAPSHOT_PATH]);
  if (!history) return null;

  for (const line of history.split('\n').filter(Boolean)) {
    const [sha, committedAt] = line.split('\t');
    if (!sha || !committedAt) continue;
    const oracle = readStatusAtCommit(sha)?.oracleCareers;
    if (oracle?.sourceHealthy === true && oracle?.listingComplete === true) return committedAt;
  }
  return null;
}

function parseTime(value) {
  const parsed = Date.parse(clean(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function freshnessState({ sourceHealthy, checkedAt, priorLastHealthyAt, legacyLastHealthyAt, retainedRoles, maxAgeHours = MAX_AGE_HOURS }) {
  const checkedAtMs = parseTime(checkedAt);
  if (checkedAtMs === null) throw new Error(`Oracle freshness stamp received invalid checkedAt: ${checkedAt}`);

  const candidateLastHealthy = sourceHealthy
    ? checkedAt
    : (parseTime(priorLastHealthyAt) !== null ? priorLastHealthyAt : legacyLastHealthyAt);
  const lastHealthyMs = parseTime(candidateLastHealthy);
  const ageHours = lastHealthyMs === null ? null : Math.max(0, (checkedAtMs - lastHealthyMs) / 36e5);
  const expired = !sourceHealthy && (ageHours === null || ageHours >= maxAgeHours);

  return {
    lastHealthyAt: lastHealthyMs === null ? null : candidateLastHealthy,
    ageHours,
    expired,
    active: !sourceHealthy && retainedRoles > 0 && !expired
  };
}

function runTests() {
  const checkedAt = '2026-09-22T10:00:00.000Z';

  let state = freshnessState({ sourceHealthy: true, checkedAt, priorLastHealthyAt: null, legacyLastHealthyAt: null, retainedRoles: 15 });
  if (state.lastHealthyAt !== checkedAt || state.active || state.expired) throw new Error('Healthy Oracle source must stamp the current verification time and disable fallback.');

  state = freshnessState({ sourceHealthy: false, checkedAt, priorLastHealthyAt: '2026-09-21T10:01:00.000Z', legacyLastHealthyAt: null, retainedRoles: 15 });
  if (!state.active || state.expired) throw new Error('Fresh Oracle fallback evidence must retain roles inside the 96-hour window.');

  state = freshnessState({ sourceHealthy: false, checkedAt, priorLastHealthyAt: null, legacyLastHealthyAt: '2026-09-18T10:01:00.000Z', retainedRoles: 15 });
  if (!state.active || state.expired) throw new Error('Legacy snapshot evidence must safely bootstrap fallback freshness when prior status predates timestamp persistence.');

  state = freshnessState({ sourceHealthy: false, checkedAt, priorLastHealthyAt: '2026-09-18T10:00:00.000Z', legacyLastHealthyAt: null, retainedRoles: 15 });
  if (state.active || !state.expired) throw new Error('Oracle fallback must expire at the 96-hour boundary.');

  state = freshnessState({ sourceHealthy: false, checkedAt, priorLastHealthyAt: null, legacyLastHealthyAt: null, retainedRoles: 15 });
  if (state.active || !state.expired) throw new Error('Oracle fallback without trustworthy healthy-source evidence must fail closed.');

  console.log('Oracle source freshness stamp regression tests passed.');
}

if (process.argv.includes('--test')) {
  runTests();
  process.exit(0);
}

const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error(`${STATUS_PATH} must contain an object.`);
if (!Array.isArray(snapshot)) throw new Error(`${SNAPSHOT_PATH} must contain an array.`);
if (!Array.isArray(jobs)) throw new Error(`${JOBS_PATH} must contain an array.`);

const oracle = status.oracleCareers;
if (!oracle || typeof oracle !== 'object' || Array.isArray(oracle)) throw new Error('Oracle collector diagnostic is missing.');

const committedStatusRaw = gitText(['show', `HEAD:${STATUS_PATH}`]);
let committedOracle = {};
if (committedStatusRaw) {
  try { committedOracle = JSON.parse(committedStatusRaw)?.oracleCareers || {}; }
  catch { committedOracle = {}; }
}

const checkedAt = new Date().toISOString();
const sourceHealthy = oracle.sourceHealthy === true && oracle.listingComplete === true;
const priorLastHealthyAt = clean(
  oracle.lastHealthyAt ||
  oracle.fallbackFreshness?.lastHealthyAt ||
  committedOracle.lastHealthyAt ||
  committedOracle.fallbackFreshness?.lastHealthyAt
) || null;
const legacyLastHealthyAt = sourceHealthy || parseTime(priorLastHealthyAt) !== null ? null : legacySnapshotEvidence();
const state = freshnessState({
  sourceHealthy,
  checkedAt,
  priorLastHealthyAt,
  legacyLastHealthyAt,
  retainedRoles: snapshot.length
});

let nextSnapshot = snapshot;
let nextJobs = jobs;
if (!sourceHealthy && state.expired && snapshot.length > 0) {
  nextSnapshot = [];
  nextJobs = jobs.filter(job => clean(job?.company) !== COMPANY);
  await writeFile(SNAPSHOT_PATH, `${JSON.stringify(nextSnapshot, null, 2)}\n`);
  await writeFile(JOBS_PATH, `${JSON.stringify(nextJobs, null, 2)}\n`);
}

status.oracleCareers = {
  ...oracle,
  checkedAt,
  lastHealthyAt: state.lastHealthyAt,
  qualifyingRoles: nextSnapshot.length,
  fallbackFreshness: {
    active: state.active && nextSnapshot.length > 0,
    expired: state.expired,
    lastHealthyAt: state.lastHealthyAt,
    checkedAt,
    maxAgeHours: MAX_AGE_HOURS,
    ageHours: state.ageHours,
    policy: 'Retain the most recent verified Oracle snapshot for up to 96 hours when the official source is unavailable; fail closed after expiry.'
  }
};
status.jobs = nextJobs.length;
status.updatedAt = checkedAt;
await writeFile(STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`);

if (sourceHealthy) {
  console.log(`Oracle freshness evidence stamped at ${checkedAt}; ${nextSnapshot.length} verified role(s).`);
} else if (state.expired) {
  console.warn(`Oracle source is unhealthy and verified fallback evidence is expired or unavailable; failed closed with 0 Oracle roles.`);
} else {
  console.log(`Oracle source is unhealthy; retained ${nextSnapshot.length} role(s) with ${state.ageHours.toFixed(1)}h-old verified fallback evidence.`);
}
