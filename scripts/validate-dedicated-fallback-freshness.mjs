import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const DEFAULT_MAX_AGE_HOURS = 96;
const FUTURE_SKEW_MINUTES = 10;
const nowMs = Date.now();
const STATUS_PATH = 'data/collector-status.json';

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
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function oraclePublishedRefreshEvidence() {
  const history = gitText(['log', '-120', '--format=%H%x09%cI%x09%s', '--', STATUS_PATH]);
  if (!history) return null;

  for (const line of history.split('\n').filter(Boolean)) {
    const [sha, committedAt, ...subjectParts] = line.split('\t');
    const subject = subjectParts.join('\t');
    if (!sha || !committedAt) continue;
    if (subject !== 'Bootstrap verified Oracle Careers roles' && subject !== 'Refresh verified jobs, events, and QA report') continue;

    const oracle = readStatusAtCommit(sha)?.oracleCareers;
    if (oracle?.sourceHealthy === true && oracle?.listingComplete === true) {
      return { checkedAt: committedAt, evidenceSource: 'published-oracle-refresh' };
    }
  }
  return null;
}

const sources = [
  { company: 'Amazon Web Services', snapshot: 'data/amazon-jobs.json', diagnostic: status => status.amazonDatacenter },
  { company: 'Google', snapshot: 'data/google-jobs.json', diagnostic: status => status.googleCareers },
  { company: 'Microsoft', snapshot: 'data/microsoft-jobs.json', diagnostic: status => status.microsoftDatacenter,
    evidence: (status, rawSnapshot, diagnostic) => [diagnostic?.snapshotFallback, rawSnapshot] },
  { company: 'Meta', snapshot: 'data/meta-jobs.json', diagnostic: status => status.metaCareers,
    evidence: status => [status.metaFallbackFreshness] },
  { company: 'Oracle', snapshot: 'data/oracle-jobs.json', diagnostic: status => status.oracleCareers,
    evidence: status => [status.oracleCareers?.fallbackFreshness, oraclePublishedRefreshEvidence()] },
  { company: 'Digital Realty', snapshot: 'data/digital-realty-jobs.json', diagnostic: status => status.digitalRealty },
  { company: 'Flexential', snapshot: 'data/flexential-jobs.json', diagnostic: status => status.flexential },
  { company: 'Cologix', snapshot: 'data/cologix-jobs.json', diagnostic: status => status.cologix }
];

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read ${path}: ${error.message || error}`);
  }
}

function snapshotJobs(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray(value.jobs)) return value.jobs;
  return null;
}

function evidenceObjects(diagnostic = {}, extraEvidence = []) {
  return [
    diagnostic?.fallbackFreshness,
    diagnostic?.snapshotFallback,
    diagnostic,
    ...extraEvidence
  ].filter(value => value && typeof value === 'object' && !Array.isArray(value));
}

function firstTimestamp(diagnostic = {}, extraEvidence = []) {
  for (const evidence of evidenceObjects(diagnostic, extraEvidence)) {
    for (const value of [evidence.lastHealthyAt, evidence.verifiedAt, evidence.snapshotVerifiedAt]) {
      const parsed = Date.parse(String(value || ''));
      if (Number.isFinite(parsed)) return { value: String(value), parsed };
    }
  }
  return null;
}

function latestHealthyTimestamp(diagnostic = {}, extraEvidence = []) {
  let latest = null;
  for (const evidence of evidenceObjects(diagnostic, extraEvidence)) {
    for (const value of [evidence.checkedAt, evidence.lastHealthyAt, evidence.verifiedAt, evidence.snapshotVerifiedAt]) {
      const parsed = Date.parse(String(value || ''));
      if (!Number.isFinite(parsed)) continue;
      if (!latest || parsed > latest.parsed) latest = { value: String(value), parsed };
    }
  }
  return latest;
}

function fallbackMaxAgeHours(diagnostic = {}, extraEvidence = []) {
  for (const evidence of evidenceObjects(diagnostic, extraEvidence)) {
    for (const value of [evidence.maxAgeHours, evidence.fallbackMaxAgeHours, evidence.snapshotMaxAgeHours]) {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) return numeric;
    }
  }
  return DEFAULT_MAX_AGE_HOURS;
}

function explicitFallbackExpired(diagnostic = {}, extraEvidence = []) {
  return evidenceObjects(diagnostic, extraEvidence).some(evidence =>
    evidence.expired === true || evidence.fallbackExpired === true
  );
}

function healthySourceRecencyViolation({ diagnostic, extraEvidence = [], publishedRoles, snapshotRoles, atMs = nowMs }) {
  if (diagnostic?.sourceHealthy !== true) return null;
  const retainedRoles = Math.max(Number(publishedRoles || 0), Number(snapshotRoles || 0));
  if (retainedRoles === 0) return null;

  const verified = latestHealthyTimestamp(diagnostic, extraEvidence);
  if (!verified) {
    return `publishes ${retainedRoles} role(s) while marked healthy without a parseable source verification timestamp`;
  }

  const futureSkewMs = FUTURE_SKEW_MINUTES * 60 * 1000;
  if (verified.parsed > atMs + futureSkewMs) {
    return `healthy-source verification is unexpectedly future-dated (${verified.value})`;
  }

  const configuredMaxAge = fallbackMaxAgeHours(diagnostic, extraEvidence);
  const maxAgeHours = Math.min(configuredMaxAge, DEFAULT_MAX_AGE_HOURS);
  const ageHours = Math.max(0, (atMs - verified.parsed) / 36e5);
  if (ageHours >= maxAgeHours) {
    return `publishes ${retainedRoles} role(s) from a source still marked healthy ${ageHours.toFixed(1)}h after its last verification (maximum ${maxAgeHours}h)`;
  }
  return null;
}

function degradedFallbackViolation({ diagnostic, extraEvidence = [], publishedRoles, snapshotRoles, atMs = nowMs }) {
  if (diagnostic?.sourceHealthy === true) return null;
  const retainedRoles = Math.max(Number(publishedRoles || 0), Number(snapshotRoles || 0));
  if (retainedRoles === 0) return null;
  if (explicitFallbackExpired(diagnostic, extraEvidence)) {
    return `retains ${retainedRoles} role(s) even though its fallback is marked expired`;
  }

  const verified = firstTimestamp(diagnostic, extraEvidence);
  if (!verified) {
    return `retains ${retainedRoles} role(s) without a parseable last healthy verification timestamp`;
  }

  const futureSkewMs = FUTURE_SKEW_MINUTES * 60 * 1000;
  if (verified.parsed > atMs + futureSkewMs) {
    return `last healthy verification is unexpectedly future-dated (${verified.value})`;
  }

  const maxAgeHours = fallbackMaxAgeHours(diagnostic, extraEvidence);
  const ageHours = Math.max(0, (atMs - verified.parsed) / 36e5);
  if (ageHours >= maxAgeHours) {
    return `retains ${retainedRoles} role(s) ${ageHours.toFixed(1)}h after its last healthy verification (maximum ${maxAgeHours}h)`;
  }
  return null;
}

function runRegressionCases() {
  const fixedNow = Date.parse('2026-09-19T02:00:00Z');
  const healthyFresh = healthySourceRecencyViolation({
    diagnostic: { sourceHealthy: true, checkedAt: '2026-09-18T02:00:01Z' },
    publishedRoles: 3,
    snapshotRoles: 3,
    atMs: fixedNow
  });
  if (healthyFresh) throw new Error(`Dedicated source recency regression: fresh healthy source was rejected (${healthyFresh})`);

  const healthyExternalFresh = healthySourceRecencyViolation({
    diagnostic: { sourceHealthy: true },
    extraEvidence: [{ verifiedAt: '2026-09-18T02:00:01Z' }],
    publishedRoles: 3,
    snapshotRoles: 3,
    atMs: fixedNow
  });
  if (healthyExternalFresh) throw new Error(`Dedicated source recency regression: fresh external healthy evidence was rejected (${healthyExternalFresh})`);

  const healthyStale = healthySourceRecencyViolation({
    diagnostic: { sourceHealthy: true, checkedAt: '2026-09-15T02:00:00Z' },
    publishedRoles: 3,
    snapshotRoles: 3,
    atMs: fixedNow
  });
  if (!healthyStale) throw new Error('Dedicated source recency regression: stale sourceHealthy state was not rejected at the 96-hour boundary');

  const healthyMissing = healthySourceRecencyViolation({
    diagnostic: { sourceHealthy: true },
    publishedRoles: 1,
    snapshotRoles: 1,
    atMs: fixedNow
  });
  if (!healthyMissing) throw new Error('Dedicated source recency regression: healthy published roles without verification evidence were not rejected');

  const healthyFuture = healthySourceRecencyViolation({
    diagnostic: { sourceHealthy: true, checkedAt: '2026-09-19T02:11:00Z' },
    publishedRoles: 1,
    snapshotRoles: 1,
    atMs: fixedNow
  });
  if (!healthyFuture) throw new Error('Dedicated source recency regression: future-dated healthy verification was not rejected');

  const fresh = degradedFallbackViolation({
    diagnostic: { sourceHealthy: false, lastHealthyAt: '2026-09-18T02:00:01Z', fallbackMaxAgeHours: 96 },
    publishedRoles: 3,
    snapshotRoles: 3,
    atMs: fixedNow
  });
  if (fresh) throw new Error(`Dedicated fallback regression: fresh fallback was rejected (${fresh})`);

  const externalFresh = degradedFallbackViolation({
    diagnostic: { sourceHealthy: false },
    extraEvidence: [{ active: false, expired: false, lastHealthyAt: '2026-09-18T02:00:01Z', maxAgeHours: 96 }],
    publishedRoles: 3,
    snapshotRoles: 3,
    atMs: fixedNow
  });
  if (externalFresh) throw new Error(`Dedicated fallback regression: fresh external verification evidence was rejected (${externalFresh})`);

  const stale = degradedFallbackViolation({
    diagnostic: { sourceHealthy: false, fallbackFreshness: { lastHealthyAt: '2026-09-15T02:00:00Z', maxAgeHours: 96 } },
    publishedRoles: 3,
    snapshotRoles: 3,
    atMs: fixedNow
  });
  if (!stale) throw new Error('Dedicated fallback regression: stale fallback was not rejected at the 96-hour boundary');

  const missingEvidence = degradedFallbackViolation({
    diagnostic: { sourceHealthy: false },
    publishedRoles: 1,
    snapshotRoles: 1,
    atMs: fixedNow
  });
  if (!missingEvidence) throw new Error('Dedicated fallback regression: retained roles without verification evidence were not rejected');

  const expired = degradedFallbackViolation({
    diagnostic: { sourceHealthy: false },
    extraEvidence: [{ lastHealthyAt: '2026-09-18T02:00:00Z', expired: true }],
    publishedRoles: 1,
    snapshotRoles: 1,
    atMs: fixedNow
  });
  if (!expired) throw new Error('Dedicated fallback regression: explicitly expired fallback was not rejected');

  const empty = degradedFallbackViolation({
    diagnostic: { sourceHealthy: false },
    publishedRoles: 0,
    snapshotRoles: 0,
    atMs: fixedNow
  });
  if (empty) throw new Error('Dedicated fallback regression: fail-closed empty source was incorrectly rejected');
}

runRegressionCases();

const status = await readJson(STATUS_PATH);
const publicJobs = await readJson('data/jobs.json');
if (!status || typeof status !== 'object' || Array.isArray(status)) {
  throw new Error(`${STATUS_PATH} must contain an object.`);
}
if (!Array.isArray(publicJobs)) {
  throw new Error('data/jobs.json must contain an array.');
}

const violations = [];
const summary = [];
for (const source of sources) {
  const diagnostic = source.diagnostic(status);
  if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) {
    violations.push(`${source.company}: dedicated source diagnostic is missing`);
    continue;
  }
  if (typeof diagnostic.sourceHealthy !== 'boolean') {
    violations.push(`${source.company}: dedicated source diagnostic must report sourceHealthy as a boolean`);
    continue;
  }

  const rawSnapshot = await readJson(source.snapshot);
  const snapshot = snapshotJobs(rawSnapshot);
  if (!snapshot) {
    violations.push(`${source.company}: ${source.snapshot} must contain a job array or an object with a jobs array`);
    continue;
  }

  const publishedRoles = publicJobs.filter(job =>
    String(job?.company || '').trim() === source.company &&
    job?.active === true &&
    job?.demo !== true
  ).length;
  const dedicatedSnapshotRoles = snapshot.filter(job => String(job?.company || '').trim() === source.company).length;
  const extraEvidence = source.evidence ? source.evidence(status, rawSnapshot, diagnostic) : [];
  const healthyViolation = healthySourceRecencyViolation({ diagnostic, extraEvidence, publishedRoles, snapshotRoles: dedicatedSnapshotRoles });
  if (healthyViolation) violations.push(`${source.company}: ${healthyViolation}`);
  const fallbackViolation = degradedFallbackViolation({ diagnostic, extraEvidence, publishedRoles, snapshotRoles: dedicatedSnapshotRoles });
  if (fallbackViolation) violations.push(`${source.company}: ${fallbackViolation}`);

  const state = diagnostic.sourceHealthy ? 'healthy' : (Math.max(publishedRoles, dedicatedSnapshotRoles) ? 'verified-retained' : 'degraded-empty');
  summary.push(`${source.company}=${state}:${publishedRoles}`);
}

if (violations.length) {
  for (const violation of violations) console.error(`Dedicated source freshness guard: ${violation}`);
  throw new Error(`Blocked ${violations.length} stale or unverifiable dedicated-source publication regression(s).`);
}

console.log(`Dedicated employer source freshness passed. ${summary.join(', ')}`);
