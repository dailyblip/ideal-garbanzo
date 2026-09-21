import { readFile } from 'node:fs/promises';

const MAX_AGE_HOURS = 96;
const MAX_AGE_MS = MAX_AGE_HOURS * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 10 * 60 * 1000;
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
  'TensorWave',
  'Lightning AI'
];

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read ${path}: ${error.message || error}`);
  }
}

function parseTimestamp(value) {
  const text = clean(value);
  const parsed = Date.parse(text);
  return text && Number.isFinite(parsed) ? { text, parsed } : null;
}

function validate({ jobs, status, nowMs = Date.now() }) {
  const violations = [];
  const guard = status?.genericFallbackFreshness;
  const generic = status?.genericDirectSources;

  if (!guard || typeof guard !== 'object' || Array.isArray(guard)) {
    return ['genericFallbackFreshness state is missing'];
  }
  if (!generic || typeof generic !== 'object' || Array.isArray(generic)) {
    return ['genericDirectSources state is missing'];
  }

  const configuredMaxAge = Number(guard.maxAgeHours);
  if (!Number.isFinite(configuredMaxAge) || configuredMaxAge <= 0 || configuredMaxAge > MAX_AGE_HOURS) {
    violations.push(`generic fallback maxAgeHours must be between 0 and ${MAX_AGE_HOURS} hours`);
  }

  const declared = Array.isArray(guard.managedCompanies) ? guard.managedCompanies.map(clean).filter(Boolean) : [];
  const declaredSet = new Set(declared);
  if (declared.length !== declaredSet.size) violations.push('generic fallback managedCompanies contains duplicates');
  for (const company of MANAGED_COMPANIES) {
    if (!declaredSet.has(company)) violations.push(`${company}: missing from generic fallback managedCompanies`);
  }

  const scanAt = parseTimestamp(generic.updatedAt);
  if (!scanAt) {
    violations.push('genericDirectSources.updatedAt is missing or invalid');
  } else if (scanAt.parsed > nowMs + FUTURE_SKEW_MS) {
    violations.push(`genericDirectSources.updatedAt is unexpectedly future-dated (${scanAt.text})`);
  }

  const diagnostics = Array.isArray(generic.sourceDiagnostics) ? generic.sourceDiagnostics : [];
  const diagnosticByCompany = new Map(diagnostics.map(item => [clean(item?.company), item]));
  const sources = guard.sources && typeof guard.sources === 'object' && !Array.isArray(guard.sources) ? guard.sources : {};
  const failedSources = new Set(Array.isArray(status?.sourceFailurePreservation?.failedSources)
    ? status.sourceFailurePreservation.failedSources.map(clean)
    : []);
  const preservedByCompany = status?.sourceFailurePreservation?.preservedByCompany || {};

  for (const company of MANAGED_COMPANIES) {
    const published = jobs.filter(job => clean(job?.company) === company && job?.active !== false && job?.demo !== true).length;
    const diagnostic = diagnosticByCompany.get(company);
    const state = sources[company];

    if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) {
      violations.push(`${company}: generic source diagnostic is missing`);
      continue;
    }
    if (typeof diagnostic.sourceHealthy !== 'boolean') {
      violations.push(`${company}: sourceHealthy diagnostic must be boolean`);
      continue;
    }
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      violations.push(`${company}: generic fallback freshness state is missing`);
      continue;
    }

    const latestScan = parseTimestamp(state.latestScanAt);
    if (!latestScan) {
      violations.push(`${company}: latestScanAt is missing or invalid`);
    } else {
      if (latestScan.parsed > nowMs + FUTURE_SKEW_MS) {
        violations.push(`${company}: latestScanAt is unexpectedly future-dated (${latestScan.text})`);
      }
      if (scanAt && latestScan.parsed !== scanAt.parsed) {
        violations.push(`${company}: latestScanAt does not match the current generic ATS scan timestamp`);
      }
    }

    if ((state.sourceHealthyAtLatestScan === true) !== diagnostic.sourceHealthy) {
      violations.push(`${company}: fallback source-health state disagrees with the current generic ATS diagnostic`);
    }

    const lastHealthy = parseTimestamp(state.lastHealthyAt);
    if (lastHealthy?.parsed > nowMs + FUTURE_SKEW_MS) {
      violations.push(`${company}: lastHealthyAt is unexpectedly future-dated (${lastHealthy.text})`);
    }

    if (diagnostic.sourceHealthy) {
      if (state.fallbackActive === true) violations.push(`${company}: healthy source is incorrectly marked as fallback-active`);
      if (state.expired === true) violations.push(`${company}: healthy current source is incorrectly marked expired`);
      if (!lastHealthy) violations.push(`${company}: healthy current source is missing lastHealthyAt`);
      else if (latestScan && lastHealthy.parsed !== latestScan.parsed) {
        violations.push(`${company}: healthy source did not advance lastHealthyAt to the latest scan`);
      }
    }

    if (!published) continue;
    if (!lastHealthy) {
      violations.push(`${company}: ${published} published role(s) lack a healthy verification timestamp`);
      continue;
    }

    const ageMs = nowMs - lastHealthy.parsed;
    if (ageMs >= MAX_AGE_MS || state.expired === true) {
      violations.push(`${company}: ${published} published role(s) remain after the ${MAX_AGE_HOURS}-hour verification window`);
    }

    if (!diagnostic.sourceHealthy) {
      if (state.fallbackActive !== true) {
        violations.push(`${company}: failed source retains ${published} role(s) without an active bounded fallback`);
      }
      if (!failedSources.has(company)) {
        violations.push(`${company}: failed source retains roles but is absent from sourceFailurePreservation.failedSources`);
      }
      const preserved = Number(preservedByCompany?.[company] || 0);
      if (!Number.isFinite(preserved) || preserved < published) {
        violations.push(`${company}: failed source publishes ${published} role(s) but only ${preserved || 0} are recorded as preserved`);
      }
    }
  }

  return violations;
}

function runSelfTest() {
  const nowMs = Date.parse('2026-09-21T18:00:00Z');
  const baseState = {
    genericDirectSources: {
      updatedAt: '2026-09-21T17:00:00Z',
      sourceDiagnostics: MANAGED_COMPANIES.map(company => ({ company, sourceHealthy: true, error: '' }))
    },
    genericFallbackFreshness: {
      maxAgeHours: 96,
      managedCompanies: MANAGED_COMPANIES,
      sources: Object.fromEntries(MANAGED_COMPANIES.map(company => [company, {
        lastHealthyAt: '2026-09-21T17:00:00Z',
        latestScanAt: '2026-09-21T17:00:00Z',
        sourceHealthyAtLatestScan: true,
        fallbackActive: false,
        expired: false
      }]))
    },
    sourceFailurePreservation: { failedSources: [], preservedByCompany: {} }
  };
  const jobs = [{ company: 'Serverfarm', active: true, demo: false }];
  const healthyViolations = validate({ jobs, status: structuredClone(baseState), nowMs });
  if (healthyViolations.length) throw new Error(`healthy regression case failed: ${healthyViolations.join('; ')}`);

  const failedFresh = structuredClone(baseState);
  failedFresh.genericDirectSources.sourceDiagnostics.find(item => item.company === 'Serverfarm').sourceHealthy = false;
  Object.assign(failedFresh.genericFallbackFreshness.sources.Serverfarm, {
    lastHealthyAt: '2026-09-20T18:00:01Z',
    sourceHealthyAtLatestScan: false,
    fallbackActive: true,
    expired: false
  });
  failedFresh.sourceFailurePreservation = { failedSources: ['Serverfarm'], preservedByCompany: { Serverfarm: 1 } };
  const freshViolations = validate({ jobs, status: failedFresh, nowMs });
  if (freshViolations.length) throw new Error(`fresh fallback regression case failed: ${freshViolations.join('; ')}`);

  const stale = structuredClone(failedFresh);
  stale.genericFallbackFreshness.sources.Serverfarm.lastHealthyAt = '2026-09-17T18:00:00Z';
  if (!validate({ jobs, status: stale, nowMs }).some(value => value.includes('96-hour'))) {
    throw new Error('stale fallback regression was not rejected at the 96-hour boundary');
  }

  const future = structuredClone(baseState);
  future.genericFallbackFreshness.sources.Serverfarm.lastHealthyAt = '2026-09-21T19:00:00Z';
  if (!validate({ jobs, status: future, nowMs }).some(value => value.includes('future-dated'))) {
    throw new Error('future-dated generic verification regression was not rejected');
  }

  const inconsistent = structuredClone(failedFresh);
  inconsistent.genericFallbackFreshness.sources.Serverfarm.fallbackActive = false;
  if (!validate({ jobs, status: inconsistent, nowMs }).some(value => value.includes('active bounded fallback'))) {
    throw new Error('failed-source fallback-state mismatch was not rejected');
  }

  console.log('Generic ATS fallback publication-state regression tests passed.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

const jobs = await readJson('data/jobs.json');
const status = await readJson('data/collector-status.json');
if (!Array.isArray(jobs)) throw new Error('data/jobs.json must contain an array.');
if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error('data/collector-status.json must contain an object.');

const violations = validate({ jobs, status });
if (violations.length) {
  for (const violation of violations) console.error(`Generic ATS publication guard: ${violation}`);
  throw new Error(`Blocked ${violations.length} generic ATS fallback publication-state regression(s).`);
}

const published = jobs.filter(job => MANAGED_COMPANIES.includes(clean(job?.company)) && job?.active !== false && job?.demo !== true).length;
console.log(`Generic ATS fallback publication state passed for ${published} published role(s) across ${MANAGED_COMPANIES.length} managed employers.`);
