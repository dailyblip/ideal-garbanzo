import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const MAX_FALLBACK_AGE_HOURS = 96;
const MAX_FALLBACK_AGE_MS = MAX_FALLBACK_AGE_HOURS * 60 * 60 * 1000;

// These employers currently rely on the shared Lever/Greenhouse/Ashby collector.
// Employers with dedicated collector snapshots/watchdogs are intentionally omitted
// so this guard never overrides stronger provider-specific verification.
const MANAGED_COMPANIES = [
  'Serverfarm',
  'LightEdge Solutions',
  'ECL',
  'Hive',
  'CAI',
  'xAI',
  'Element Critical',
  'Lambda',
  'Crusoe',
  'Fluidstack',
  'Gimlet Labs',
  'TensorWave'
];
const MANAGED_SET = new Set(MANAGED_COMPANIES);

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

function sourceDecision({ diagnostic, prior = {}, scanAt, nowMs }) {
  const scanMs = Date.parse(String(scanAt || ''));
  const priorHealthyMs = Date.parse(String(prior.lastHealthyAt || ''));
  const latestScanIsHealthy = diagnostic?.sourceHealthy === true && Number.isFinite(scanMs);

  let lastHealthyMs = Number.isFinite(priorHealthyMs) ? priorHealthyMs : null;
  if (latestScanIsHealthy && (lastHealthyMs === null || scanMs > lastHealthyMs)) lastHealthyMs = scanMs;

  const ageMs = lastHealthyMs === null ? null : Math.max(0, nowMs - lastHealthyMs);
  const expired = ageMs === null || ageMs >= MAX_FALLBACK_AGE_MS;
  const sourceFailedAtLatestScan = diagnostic?.sourceHealthy === false;
  const latestScanMissing = !diagnostic || !Number.isFinite(scanMs);
  const fallbackActive = sourceFailedAtLatestScan && !expired;

  return {
    lastHealthyAt: lastHealthyMs === null ? null : new Date(lastHealthyMs).toISOString(),
    latestScanAt: Number.isFinite(scanMs) ? new Date(scanMs).toISOString() : null,
    sourceHealthyAtLatestScan: diagnostic?.sourceHealthy === true,
    fallbackActive,
    expired,
    error: clean(diagnostic?.error),
    reason: expired
      ? (lastHealthyMs === null ? 'no-verification-anchor' : 'verification-older-than-96-hours')
      : (fallbackActive ? 'latest-source-fetch-failed' : (latestScanMissing ? 'latest-scan-evidence-missing' : 'latest-source-fetch-healthy'))
  };
}

function countsBy(records, field) {
  return records.reduce((counts, record) => {
    const value = clean(record?.[field]) || 'unknown';
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function stableState(state = {}) {
  return {
    lastHealthyAt: state.lastHealthyAt || null,
    latestScanAt: state.latestScanAt || null,
    sourceHealthyAtLatestScan: state.sourceHealthyAtLatestScan === true,
    fallbackActive: state.fallbackActive === true,
    expired: state.expired === true,
    error: clean(state.error),
    reason: clean(state.reason)
  };
}

function stateChanged(previous = {}, next = {}) {
  return JSON.stringify(stableState(previous)) !== JSON.stringify(stableState(next));
}

function evaluate({ jobs, status, nowMs }) {
  const generic = status?.genericDirectSources || {};
  const diagnostics = Array.isArray(generic.sourceDiagnostics) ? generic.sourceDiagnostics : [];
  const byCompany = new Map(diagnostics.map(item => [clean(item?.company), item]));
  const priorSources = status?.genericFallbackFreshness?.sources || {};
  const sources = {};
  const expiredCompanies = new Set();
  let changed = Number(status?.genericFallbackFreshness?.maxAgeHours) !== MAX_FALLBACK_AGE_HOURS;

  for (const company of MANAGED_COMPANIES) {
    const next = sourceDecision({
      diagnostic: byCompany.get(company),
      prior: priorSources[company] || {},
      scanAt: generic.updatedAt,
      nowMs
    });
    sources[company] = next;
    if (next.expired) expiredCompanies.add(company);
    if (stateChanged(priorSources[company], next)) changed = true;
  }

  const nextJobs = jobs.filter(job => !expiredCompanies.has(clean(job?.company)));
  const removed = jobs.filter(job => expiredCompanies.has(clean(job?.company)));
  if (removed.length) changed = true;

  return { sources, expiredCompanies, nextJobs, removed, changed };
}

function validateState({ jobs, status, nowMs }) {
  const violations = [];
  const guard = status?.genericFallbackFreshness || {};
  if (Number(guard.maxAgeHours) > MAX_FALLBACK_AGE_HOURS) {
    violations.push(`maxAgeHours is ${guard.maxAgeHours}, above the ${MAX_FALLBACK_AGE_HOURS}-hour policy`);
  }

  const sources = guard.sources || {};
  for (const company of MANAGED_COMPANIES) {
    const published = jobs.filter(job => clean(job?.company) === company).length;
    if (!published) continue;
    const state = sources[company] || {};
    const healthyMs = Date.parse(String(state.lastHealthyAt || ''));
    if (!Number.isFinite(healthyMs)) {
      violations.push(`${company} has ${published} published role(s) without a verification anchor`);
      continue;
    }
    const ageMs = Math.max(0, nowMs - healthyMs);
    if (ageMs >= MAX_FALLBACK_AGE_MS || state.expired === true) {
      violations.push(`${company} has ${published} published role(s) ${(ageMs / 36e5).toFixed(1)} hours after the last healthy generic ATS verification`);
    }
  }
  return violations;
}

function runSelfTest() {
  const nowMs = Date.parse('2026-09-11T12:00:00Z');
  const healthy = sourceDecision({
    diagnostic: { sourceHealthy: true, error: '' },
    prior: {},
    scanAt: '2026-09-11T11:00:00Z',
    nowMs
  });
  if (healthy.expired || healthy.fallbackActive || healthy.lastHealthyAt !== '2026-09-11T11:00:00.000Z') {
    throw new Error('healthy generic source was not stamped correctly');
  }

  const fallback = sourceDecision({
    diagnostic: { sourceHealthy: false, error: '503 upstream' },
    prior: { lastHealthyAt: '2026-09-07T13:00:01Z' },
    scanAt: '2026-09-11T11:00:00Z',
    nowMs
  });
  if (fallback.expired || !fallback.fallbackActive) throw new Error('fresh fallback was not retained inside 96 hours');

  const boundary = sourceDecision({
    diagnostic: { sourceHealthy: false, error: '503 upstream' },
    prior: { lastHealthyAt: '2026-09-07T12:00:00Z' },
    scanAt: '2026-09-11T11:00:00Z',
    nowMs
  });
  if (!boundary.expired) throw new Error('generic fallback did not expire at 96 hours');

  const staleHealthyStatus = sourceDecision({
    diagnostic: { sourceHealthy: true, error: '' },
    prior: {},
    scanAt: '2026-09-07T12:00:00Z',
    nowMs
  });
  if (!staleHealthyStatus.expired) throw new Error('stale collector health status was incorrectly treated as current verification');

  const unknown = sourceDecision({ diagnostic: null, prior: {}, scanAt: '', nowMs });
  if (!unknown.expired) throw new Error('unanchored generic source did not fail closed');

  const sampleJobs = [
    { company: 'Serverfarm', id: 'stale-generic' },
    { company: 'Microsoft', id: 'unmanaged-major' }
  ];
  const sampleStatus = {
    genericDirectSources: {
      updatedAt: '2026-09-11T11:00:00Z',
      sourceDiagnostics: [
        { company: 'Serverfarm', sourceHealthy: false, error: '503' }
      ]
    },
    genericFallbackFreshness: {
      maxAgeHours: 96,
      sources: { Serverfarm: { lastHealthyAt: '2026-09-07T12:00:00Z' } }
    }
  };
  const evaluated = evaluate({ jobs: sampleJobs, status: sampleStatus, nowMs });
  if (evaluated.nextJobs.some(job => job.id === 'stale-generic')) throw new Error('expired generic role was not removed');
  if (!evaluated.nextJobs.some(job => job.id === 'unmanaged-major')) throw new Error('unmanaged major-employer role was incorrectly removed');

  console.log('Generic ATS fallback freshness regression tests passed.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

const jobs = await readJson(JOBS_PATH, []);
const status = await readJson(STATUS_PATH, {});
if (!Array.isArray(jobs)) throw new Error(`${JOBS_PATH} must contain an array.`);
if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error(`${STATUS_PATH} must contain an object.`);

if (process.argv.includes('--validate')) {
  const violations = validateState({ jobs, status, nowMs: Date.now() });
  if (violations.length) throw new Error(`Generic ATS fallback freshness validation failed:\n- ${violations.join('\n- ')}`);
  const managedPublished = jobs.filter(job => MANAGED_SET.has(clean(job?.company))).length;
  console.log(`Generic ATS freshness valid for ${managedPublished} published role(s) across ${MANAGED_COMPANIES.length} managed employers.`);
  process.exit(0);
}

const nowMs = Date.now();
const result = evaluate({ jobs, status, nowMs });
if (!result.changed) {
  console.log('Generic ATS fallback freshness state is unchanged.');
  process.exit(0);
}

const nextStatus = {
  ...status,
  genericFallbackFreshness: {
    maxAgeHours: MAX_FALLBACK_AGE_HOURS,
    managedCompanies: MANAGED_COMPANIES,
    sources: result.sources,
    policy: 'Shared ATS roles without a dedicated employer-specific freshness guard may remain published for at most 96 hours after the last healthy generic employer-direct verification. A stale generic collector status does not refresh the verification clock.'
  }
};

if (result.removed.length) {
  nextStatus.jobs = result.nextJobs.length;
  nextStatus.countsByType = countsBy(result.nextJobs, 'type');
  nextStatus.countsByExperience = countsBy(result.nextJobs, 'experience');
  nextStatus.genericFallbackFreshness.lastRemoval = {
    at: new Date(nowMs).toISOString(),
    roles: result.removed.map(job => ({
      id: clean(job?.id),
      company: clean(job?.company),
      title: clean(job?.title),
      sourceUrl: clean(job?.sourceUrl)
    }))
  };
  await writeFile(JOBS_PATH, JSON.stringify(result.nextJobs, null, 2) + '\n');
}
await writeFile(STATUS_PATH, JSON.stringify(nextStatus, null, 2) + '\n');

const activeFallbacks = Object.entries(result.sources).filter(([, state]) => state.fallbackActive).map(([company]) => company);
const expired = [...result.expiredCompanies];
console.log(`Generic ATS freshness updated: ${activeFallbacks.length} source fallback(s) active, ${expired.length} source(s) expired, ${result.removed.length} stale role(s) removed.`);
