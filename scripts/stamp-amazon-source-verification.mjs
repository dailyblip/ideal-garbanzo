import { readFile, writeFile } from 'node:fs/promises';

const STATUS_PATH = 'data/collector-status.json';
const SNAPSHOT_PATH = 'data/amazon-jobs.json';
const MAX_FALLBACK_AGE_HOURS = 96;
const POLICY = 'Retain previously verified AWS employer-direct roles for at most 96 hours after the last evidenced complete official Amazon Jobs search.';

function timestamp(value, nowMs) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) && parsed <= nowMs ? String(value) : null;
}

function priorAnchor(amazon, nowMs) {
  // An explicit null means that verification evidence is absent. Do not replace
  // it with a global update time, a commit time, or older carried diagnostics.
  const value = Object.hasOwn(amazon, 'lastHealthyAt')
    ? amazon.lastHealthyAt
    : amazon.fallbackFreshness?.lastHealthyAt;
  return timestamp(value, nowMs);
}

function selectAttempt(amazon, recovery, nowMs) {
  const raw = amazon.attemptSource === 'raw-collection' ? amazon : amazon.collectionAttempt;
  const detail = recovery.attemptSource === 'detail-recovery' ? recovery : null;
  const rawTime = raw ? timestamp(raw.checkedAt, nowMs) : null;
  const detailTime = detail ? timestamp(detail.checkedAt, nowMs) : null;

  // A malformed timestamp on a known source attempt makes its ordering unknown.
  // Never silently prefer an earlier healthy attempt in that situation.
  if ((raw && !rawTime) || (detail && !detailTime)) {
    return { issue: 'AWS source attempt has a missing, invalid, or future checkedAt.' };
  }
  if (amazon.attemptSource === 'detail-recovery') {
    const stampedTime = timestamp(amazon.checkedAt, nowMs);
    if (!stampedTime || !detailTime || Date.parse(stampedTime) > Date.parse(detailTime)) {
      return { issue: 'AWS detail evidence is missing or predates its recorded verification.' };
    }
  }
  if (detail && (!raw || Date.parse(detailTime) >= Date.parse(rawTime))) {
    return { source: 'detail-recovery', diagnostic: detail, checkedAt: detailTime };
  }
  if (raw) return { source: 'raw-collection', diagnostic: raw, checkedAt: rawTime };
  // Legacy checkedAt values were written by the stamp, not by the source. They
  // may remain prior anchors, but cannot establish a new successful attempt.
  return { issue: 'No timestamped AWS source-owned attempt is available.' };
}

function completeSearch(attempt) {
  const diagnostic = attempt.diagnostic || {};
  const attempted = Number(diagnostic.queriesAttempted || 0);
  const succeeded = Number(diagnostic.queriesSucceeded || 0);
  const preserved = Number(attempt.source === 'detail-recovery'
    ? diagnostic.preservedPrevious || 0
    : diagnostic.preservedPreviousRoles || 0);
  return diagnostic.sourceHealthy === true && attempted > 0 && succeeded === attempted && preserved === 0
    && (attempt.source !== 'detail-recovery' || diagnostic.fullSearchHealthy === true);
}

const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error(`${STATUS_PATH} must contain an object.`);
if (!Array.isArray(snapshot)) throw new Error(`${SNAPSHOT_PATH} must contain an array.`);
const amazon = status.amazonDatacenter;
if (!amazon || typeof amazon !== 'object' || Array.isArray(amazon)) throw new Error('AWS source diagnostic is missing.');

const nowMs = Date.now();
const rawAttempt = amazon.attemptSource === 'raw-collection' ? amazon : amazon.collectionAttempt;
// Preserve the raw source evidence separately from the effective publication
// diagnostic. In particular, a failed/invalid attempt must remain visible to a
// repeated stamp instead of exposing an older healthy recovery on the next run.
const collectionAttempt = rawAttempt ? {
  attemptSource: 'raw-collection',
  checkedAt: rawAttempt.checkedAt ?? null,
  sourceHealthy: rawAttempt.sourceHealthy,
  queriesAttempted: rawAttempt.queriesAttempted,
  queriesSucceeded: rawAttempt.queriesSucceeded,
  queryStats: rawAttempt.queryStats,
  preservedPreviousRoles: rawAttempt.preservedPreviousRoles,
  qualifyingRoles: rawAttempt.qualifyingRoles
} : undefined;
const previousHealthyAt = priorAnchor(amazon, nowMs);
const attempt = selectAttempt(amazon, status.amazonDetailRecovery || {}, nowMs);
const invalidLatestAttempt = amazon.latestAttemptAt != null && !timestamp(amazon.latestAttemptAt, nowMs);
if (invalidLatestAttempt) {
  attempt.issue = 'AWS recorded latest attempt has an invalid or future timestamp.';
}
const latestAttemptAt = invalidLatestAttempt ? amazon.latestAttemptAt : [
  amazon.latestAttemptAt,
  amazon.attemptSource === 'raw-collection' || amazon.attemptSource === 'detail-recovery' ? amazon.checkedAt : null,
  collectionAttempt?.checkedAt,
  status.amazonDetailRecovery?.attemptSource === 'detail-recovery' ? status.amazonDetailRecovery.checkedAt : null
].map(value => timestamp(value, nowMs)).filter(Boolean)
  .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
if (attempt.checkedAt && latestAttemptAt && Date.parse(attempt.checkedAt) < Date.parse(latestAttemptAt)) {
  attempt.issue = 'AWS source diagnostics predate a later recorded attempt.';
}
if (attempt.checkedAt && previousHealthyAt && Date.parse(previousHealthyAt) > Date.parse(attempt.checkedAt)) {
  attempt.issue = 'AWS healthy anchor is later than its selected source attempt.';
}
const sourceHealthy = !attempt.issue && completeSearch(attempt);
const lastHealthyAt = sourceHealthy ? attempt.checkedAt : previousHealthyAt;
const checkedAt = attempt.checkedAt || null;
const diagnostic = attempt.diagnostic || {};
const preservedPreviousRoles = attempt.issue
  ? snapshot.length
  : Math.min(snapshot.length, Number(attempt.source === 'detail-recovery' ? diagnostic.preservedPrevious || 0 : diagnostic.preservedPreviousRoles || 0));
const ageHours = lastHealthyAt ? Math.max(0, (nowMs - Date.parse(lastHealthyAt)) / 36e5) : null;
const expired = !sourceHealthy && (ageHours === null || ageHours >= MAX_FALLBACK_AGE_HOURS);

status.amazonDatacenter = {
  ...amazon,
  attemptSource: attempt.source || 'unverified',
  verificationSource: attempt.source || 'unverified',
  verificationIssue: attempt.issue || null,
  collectionAttempt,
  latestAttemptAt,
  sourceHealthy,
  checkedAt,
  lastHealthyAt,
  queriesAttempted: Number(diagnostic.queriesAttempted || 0),
  queriesSucceeded: Number(diagnostic.queriesSucceeded || 0),
  queryStats: diagnostic.queryStats || [],
  freshQualifyingRoles: attempt.issue ? 0 : Math.max(0, snapshot.length - preservedPreviousRoles),
  preservedPreviousRoles,
  qualifyingRoles: snapshot.length,
  fallbackMaxAgeHours: MAX_FALLBACK_AGE_HOURS,
  fallbackFreshness: {
    active: !sourceHealthy && preservedPreviousRoles > 0 && !expired,
    expired,
    lastHealthyAt,
    checkedAt,
    maxAgeHours: MAX_FALLBACK_AGE_HOURS,
    policy: POLICY
  }
};
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

if (sourceHealthy) {
  console.log(`Stamped healthy AWS ${attempt.source} evidence from ${checkedAt}.`);
} else {
  console.warn(`AWS verification is degraded; preserved ${preservedPreviousRoles} role(s), last genuine healthy anchor ${lastHealthyAt || 'unavailable'}.${attempt.issue ? ` ${attempt.issue}` : ''}`);
}
