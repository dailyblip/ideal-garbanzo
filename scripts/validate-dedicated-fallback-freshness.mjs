import { readFile } from 'node:fs/promises';

const DEFAULT_MAX_AGE_HOURS = 96;
const FUTURE_SKEW_MINUTES = 10;
const nowMs = Date.now();

const sources = [
  { company: 'Amazon Web Services', snapshot: 'data/amazon-jobs.json', diagnostic: status => status.amazonDatacenter },
  { company: 'Google', snapshot: 'data/google-jobs.json', diagnostic: status => status.googleCareers },
  { company: 'Microsoft', snapshot: 'data/microsoft-jobs.json', diagnostic: status => status.microsoftDatacenter,
    evidence: (status, rawSnapshot, diagnostic) => [diagnostic?.snapshotFallback, rawSnapshot] },
  { company: 'Meta', snapshot: 'data/meta-jobs.json', diagnostic: status => status.metaCareers,
    evidence: status => [status.metaFallbackFreshness] },
  { company: 'Oracle', snapshot: 'data/oracle-jobs.json', diagnostic: status => status.oracleCareers },
  { company: 'Digital Realty', snapshot: 'data/digital-realty-jobs.json', diagnostic: status => status.digitalRealty }
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

const status = await readJson('data/collector-status.json');
const publicJobs = await readJson('data/jobs.json');
if (!status || typeof status !== 'object' || Array.isArray(status)) {
  throw new Error('data/collector-status.json must contain an object.');
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
  const violation = degradedFallbackViolation({ diagnostic, extraEvidence, publishedRoles, snapshotRoles: dedicatedSnapshotRoles });
  if (violation) violations.push(`${source.company}: ${violation}`);

  const state = diagnostic.sourceHealthy ? 'healthy' : (Math.max(publishedRoles, dedicatedSnapshotRoles) ? 'verified-retained' : 'degraded-empty');
  summary.push(`${source.company}=${state}:${publishedRoles}`);
}

if (violations.length) {
  for (const violation of violations) console.error(`Dedicated fallback freshness guard: ${violation}`);
  throw new Error(`Blocked ${violations.length} stale or unverifiable dedicated-source fallback regression(s).`);
}

console.log(`Dedicated employer fallback freshness passed. ${summary.join(', ')}`);
