import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const STATUS_PATH = 'data/collector-status.json';
const MAX_FALLBACK_AGE_HOURS = 96;
const HISTORY_LIMIT = 2000;

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

function isHealthyAmazon(amazon = {}) {
  const attempted = Number(amazon?.queriesAttempted || 0);
  const succeeded = Number(amazon?.queriesSucceeded || 0);
  return amazon?.sourceHealthy === true &&
    attempted > 0 &&
    succeeded === attempted &&
    Number(amazon?.preservedPreviousRoles || 0) === 0;
}

function amazonFingerprint(amazon = {}) {
  if (!amazon || typeof amazon !== 'object') return '';
  const copy = { ...amazon };
  delete copy.checkedAt;
  delete copy.lastHealthyAt;
  delete copy.fallbackFreshness;
  delete copy.fallbackMaxAgeHours;
  return JSON.stringify(copy);
}

function knownVerificationCommit(subject = '') {
  return /^(?:Recover verified AWS roles|Recover verified AWS roles and refresh QA|Refresh verified jobs, events, and QA report)$/.test(String(subject).trim());
}

function findLastHealthyAmazonCheck() {
  const history = gitText(['log', `-${HISTORY_LIMIT}`, '--format=%H%x09%cI%x09%s', '--', STATUS_PATH]);
  if (!history) return null;

  for (const line of history.split('\n').filter(Boolean)) {
    const [sha, committedAt, ...subjectParts] = line.split('\t');
    const subject = subjectParts.join('\t');
    if (!sha || !committedAt) continue;

    const current = readStatusAtCommit(sha);
    const amazon = current?.amazonDatacenter;
    if (!isHealthyAmazon(amazon)) continue;
    if (knownVerificationCommit(subject)) return committedAt;

    let parentAmazon = null;
    try {
      const parentSha = gitText(['rev-parse', `${sha}^`]);
      parentAmazon = readStatusAtCommit(parentSha)?.amazonDatacenter || null;
    } catch {}

    if (!parentAmazon || amazonFingerprint(amazon) !== amazonFingerprint(parentAmazon)) {
      return committedAt;
    }
  }
  return null;
}

function validTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? String(value) : null;
}

const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
if (!status || typeof status !== 'object' || Array.isArray(status)) {
  throw new Error(`${STATUS_PATH} must contain an object.`);
}

const amazon = status.amazonDatacenter;
if (!amazon || typeof amazon !== 'object' || Array.isArray(amazon)) {
  throw new Error('AWS source diagnostic is missing.');
}

const checkedAt = new Date().toISOString();
if (isHealthyAmazon(amazon)) {
  status.amazonDatacenter = {
    ...amazon,
    checkedAt,
    lastHealthyAt: checkedAt,
    fallbackMaxAgeHours: MAX_FALLBACK_AGE_HOURS,
    fallbackFreshness: {
      ...(amazon.fallbackFreshness || {}),
      active: false,
      expired: false,
      lastHealthyAt: checkedAt,
      checkedAt,
      maxAgeHours: MAX_FALLBACK_AGE_HOURS,
      policy: 'Retain previously verified AWS employer-direct roles for at most 96 hours after the last evidenced complete official Amazon Jobs search.'
    }
  };
  await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
  console.log(`Stamped healthy AWS source verification at ${checkedAt}.`);
  process.exit(0);
}

if (Number(amazon.preservedPreviousRoles || 0) <= 0) {
  console.log('AWS source is degraded without preserved roles; no fallback verification stamp is needed.');
  process.exit(0);
}

const lastHealthyAt =
  validTimestamp(amazon?.fallbackFreshness?.lastHealthyAt) ||
  validTimestamp(amazon?.lastHealthyAt) ||
  findLastHealthyAmazonCheck();

if (!lastHealthyAt) {
  console.warn('AWS source is degraded and no historical healthy verification could be proven; freshness enforcement will fail closed.');
  process.exit(0);
}

const ageHours = Math.max(0, (Date.now() - Date.parse(lastHealthyAt)) / 36e5);
status.amazonDatacenter = {
  ...amazon,
  lastHealthyAt,
  fallbackMaxAgeHours: MAX_FALLBACK_AGE_HOURS,
  fallbackFreshness: {
    ...(amazon.fallbackFreshness || {}),
    active: true,
    expired: ageHours >= MAX_FALLBACK_AGE_HOURS,
    lastHealthyAt,
    checkedAt,
    maxAgeHours: MAX_FALLBACK_AGE_HOURS,
    policy: 'Retain previously verified AWS employer-direct roles for at most 96 hours after the last evidenced complete official Amazon Jobs search.'
  }
};

await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
console.log(`Recovered AWS fallback verification from ${lastHealthyAt}; current age ${ageHours.toFixed(1)} hours.`);
