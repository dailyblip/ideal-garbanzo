import { readFile, writeFile } from 'node:fs/promises';

const COMPANY = 'CoreWeave';
const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/coreweave-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const EVIDENCE_PATH = 'data/coreweave-source-evidence.json';
const MAX_FALLBACK_AGE_HOURS = 96;
const MAX_HEALTHY_EVIDENCE_AGE_HOURS = 30;
const MAX_FALLBACK_AGE_MS = MAX_FALLBACK_AGE_HOURS * 60 * 60 * 1000;

const clean = value => String(value ?? '').trim();

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

function isCoreWeave(job = {}) {
  if (clean(job.company) === COMPANY) return true;
  try {
    const url = new URL(clean(job.sourceUrl));
    return ['coreweave.com', 'www.coreweave.com'].includes(url.hostname.toLowerCase())
      && url.pathname === '/careers'
      && Boolean(url.searchParams.get('gh_jid'));
  } catch {
    return false;
  }
}

function evaluateFallback({ sourceHealthy, lastHealthyAt, nowMs, hasSnapshot }) {
  const lastHealthyMs = Date.parse(String(lastHealthyAt || ''));
  const hasAnchor = Number.isFinite(lastHealthyMs);
  const ageHours = hasAnchor ? Math.max(0, (nowMs - lastHealthyMs) / 36e5) : null;
  const expiresAt = hasAnchor ? lastHealthyMs + MAX_FALLBACK_AGE_MS : null;

  if (sourceHealthy) return { active: false, expired: false, hasAnchor, ageHours, expiresAt };
  if (!hasSnapshot) return { active: false, expired: false, hasAnchor, ageHours, expiresAt };
  return {
    active: hasAnchor && nowMs < expiresAt,
    expired: !hasAnchor || nowMs >= expiresAt,
    hasAnchor,
    ageHours,
    expiresAt
  };
}

function iso(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function runSelfTest() {
  const now = Date.parse('2026-09-16T12:00:00Z');
  const fresh = evaluateFallback({ sourceHealthy: false, lastHealthyAt: '2026-09-12T12:00:01Z', nowMs: now, hasSnapshot: true });
  const boundary = evaluateFallback({ sourceHealthy: false, lastHealthyAt: '2026-09-12T12:00:00Z', nowMs: now, hasSnapshot: true });
  const missing = evaluateFallback({ sourceHealthy: false, lastHealthyAt: null, nowMs: now, hasSnapshot: true });
  const healthy = evaluateFallback({ sourceHealthy: true, lastHealthyAt: '2026-09-01T00:00:00Z', nowMs: now, hasSnapshot: true });
  const empty = evaluateFallback({ sourceHealthy: false, lastHealthyAt: null, nowMs: now, hasSnapshot: false });

  if (!fresh.active || fresh.expired) throw new Error('CoreWeave fallback expired before 96 hours.');
  if (!boundary.expired || boundary.active) throw new Error('CoreWeave fallback did not expire at the 96-hour boundary.');
  if (!missing.expired) throw new Error('CoreWeave fallback without verification evidence did not fail closed.');
  if (healthy.expired || healthy.active) throw new Error('Healthy CoreWeave source incorrectly entered fallback mode.');
  if (empty.expired || empty.active) throw new Error('Empty CoreWeave snapshot incorrectly entered fallback mode.');

  console.log('CoreWeave fallback freshness regression tests passed.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

const checkOnly = process.argv.includes('--check');
const nowMs = Date.now();
const checkedAt = new Date(nowMs).toISOString();
const jobs = await readJson(JOBS_PATH, []);
const snapshot = await readJson(SNAPSHOT_PATH, []);
const status = await readJson(STATUS_PATH, {});
const evidence = await readJson(EVIDENCE_PATH, {});

if (!Array.isArray(jobs)) throw new Error('jobs.json must contain an array.');
if (!Array.isArray(snapshot)) throw new Error('CoreWeave snapshot must contain an array.');

const source = status?.coreWeaveCareers && typeof status.coreWeaveCareers === 'object'
  ? status.coreWeaveCareers
  : {};
const sourceHealthy = source.sourceHealthy === true;
const publicRoles = jobs.filter(isCoreWeave);
const lastHealthyAt = sourceHealthy && !checkOnly ? checkedAt : clean(evidence.lastHealthyAt) || null;
const fallback = evaluateFallback({
  sourceHealthy,
  lastHealthyAt,
  nowMs,
  hasSnapshot: snapshot.length > 0
});

if (checkOnly) {
  const violations = [];
  const lastHealthyMs = Date.parse(String(lastHealthyAt || ''));
  const evidenceAgeHours = Number.isFinite(lastHealthyMs) ? Math.max(0, (nowMs - lastHealthyMs) / 36e5) : null;

  if ((snapshot.length || publicRoles.length) && !Number.isFinite(lastHealthyMs)) {
    violations.push('published CoreWeave roles have no valid lastHealthyAt verification anchor');
  }
  if (sourceHealthy && snapshot.length > 0 && evidenceAgeHours > MAX_HEALTHY_EVIDENCE_AGE_HOURS) {
    violations.push(`healthy CoreWeave source evidence is ${evidenceAgeHours.toFixed(1)} hours old (limit ${MAX_HEALTHY_EVIDENCE_AGE_HOURS})`);
  }
  if (!sourceHealthy && fallback.expired && (snapshot.length || publicRoles.length)) {
    violations.push(`expired CoreWeave fallback still retains ${snapshot.length} snapshot / ${publicRoles.length} public role(s)`);
  }
  if (!sourceHealthy && snapshot.length > 0 && !fallback.active) {
    violations.push('unhealthy CoreWeave source has a retained snapshot outside the verified fallback window');
  }
  if (publicRoles.length !== snapshot.length) {
    violations.push(`CoreWeave public/snapshot count drift (${publicRoles.length}/${snapshot.length})`);
  }

  if (violations.length) {
    for (const violation of violations) console.error(`CoreWeave fallback violation: ${violation}`);
    throw new Error(`Blocked ${violations.length} CoreWeave fallback freshness violation(s).`);
  }

  const mode = sourceHealthy ? 'healthy source evidence' : fallback.active ? 'active verified fallback' : 'empty fail-closed state';
  console.log(`CoreWeave fallback freshness check passed: ${publicRoles.length} published role(s), ${mode}.`);
  process.exit(0);
}

let nextJobs = jobs;
let nextSnapshot = snapshot;
let removedExpiredFallback = 0;

if (!sourceHealthy && fallback.expired && snapshot.length > 0) {
  removedExpiredFallback = publicRoles.length;
  nextJobs = jobs.filter(job => !isCoreWeave(job));
  nextSnapshot = [];
}

const retainedSnapshot = sourceHealthy ? snapshot.length : (fallback.active ? nextSnapshot.length : 0);
const nextEvidence = {
  lastHealthyAt: sourceHealthy ? checkedAt : lastHealthyAt,
  checkedAt,
  maxFallbackAgeHours: MAX_FALLBACK_AGE_HOURS,
  maxHealthyEvidenceAgeHours: MAX_HEALTHY_EVIDENCE_AGE_HOURS,
  snapshotRoles: nextSnapshot.length,
  sourceHealthy
};

status.coreWeaveCareers = {
  ...source,
  checkedAt,
  lastHealthyAt: nextEvidence.lastHealthyAt,
  fallbackMaxAgeHours: MAX_FALLBACK_AGE_HOURS,
  fallbackAgeHours: fallback.ageHours == null ? null : Number(fallback.ageHours.toFixed(2)),
  fallbackExpiresAt: iso(fallback.expiresAt),
  fallbackExpired: !sourceHealthy && fallback.expired,
  usedPreviousSnapshot: !sourceHealthy && fallback.active,
  preservedPrevious: !sourceHealthy && fallback.active ? nextSnapshot.length : 0,
  publishedRoles: nextJobs.filter(isCoreWeave).length,
  removedExpiredFallback,
  fallbackPolicy: `Retain the last fully verified CoreWeave snapshot for at most ${MAX_FALLBACK_AGE_HOURS} hours after official-source failure; then remove CoreWeave roles until fresh verification succeeds.`
};
status.jobs = nextJobs.length;

await writeFile(JOBS_PATH, JSON.stringify(nextJobs, null, 2) + '\n');
if (nextSnapshot !== snapshot) await writeFile(SNAPSHOT_PATH, JSON.stringify(nextSnapshot, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
await writeFile(EVIDENCE_PATH, JSON.stringify(nextEvidence, null, 2) + '\n');

if (removedExpiredFallback) {
  console.warn(`CoreWeave fallback expired; removed ${removedExpiredFallback} public role(s) and cleared the stale snapshot.`);
} else if (!sourceHealthy && fallback.active) {
  console.warn(`CoreWeave source incomplete; retained ${retainedSnapshot} verified role(s) inside the ${MAX_FALLBACK_AGE_HOURS}-hour fallback window.`);
} else {
  console.log(`CoreWeave source evidence refreshed for ${retainedSnapshot} verified role(s).`);
}
