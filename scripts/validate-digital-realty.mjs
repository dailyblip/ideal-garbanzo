import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const COMPANY = 'Digital Realty';
const OFFICIAL_HOST = 'hdep.fa.us2.oraclecloud.com';
const OFFICIAL_PATH_PREFIX = '/hcmUI/CandidateExperience/en/sites/CX/job/';
const SNAPSHOT_PATH = 'data/digital-realty-jobs.json';
const MAX_FALLBACK_AGE_HOURS = 96;
const MAX_HEALTHY_EVIDENCE_AGE_HOURS = 30;
const MAX_FALLBACK_AGE_MS = MAX_FALLBACK_AGE_HOURS * 60 * 60 * 1000;
const VALID_EXPERIENCE = new Set(['no-experience', '0-2-years', '2-5-years']);
const VALID_TYPES = new Set(['entry-level', 'internship', 'apprenticeship', 'trainee']);
const EXECUTIVE_PATTERN = /\b(?:senior|sr\.?|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|superintendent|foreman)\b/i;
const PARITY_FIELDS = ['title', 'company', 'type', 'experience', 'source', 'sourceUrl', 'active', 'demo'];
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function gitLastChangedAt(path) {
  try {
    const value = execFileSync('git', ['log', '-1', '--format=%cI', '--', path], { encoding: 'utf8' }).trim();
    return Number.isFinite(Date.parse(value)) ? value : null;
  } catch {
    return null;
  }
}

function canonicalIdentity(job = {}) {
  const id = clean(job?.id);
  const sourceUrl = clean(job?.sourceUrl);
  let parsed;
  try { parsed = new URL(sourceUrl); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== OFFICIAL_HOST) return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (!parsed.pathname.startsWith(OFFICIAL_PATH_PREFIX)) return null;
  const requisition = decodeURIComponent(parsed.pathname.slice(OFFICIAL_PATH_PREFIX.length)).replace(/\/$/, '');
  if (!/^\d+$/.test(requisition)) return null;
  if (parsed.pathname !== `${OFFICIAL_PATH_PREFIX}${encodeURIComponent(requisition)}`) return null;
  const expectedId = `oracle-digitalrealty-${requisition}`;
  if (id !== expectedId) return null;
  return { requisition, expectedId, sourceUrl };
}

function validateRequisitionParity(snapshotJobs, publicJobs) {
  const issues = [];
  const snapshotByReq = new Map();
  const publicByReq = new Map();

  for (const job of snapshotJobs) {
    const canonical = canonicalIdentity(job);
    if (!canonical) {
      issues.push(`snapshot ${clean(job?.id) || '(missing id)'} does not bind to one canonical Digital Realty requisition URL`);
      continue;
    }
    if (snapshotByReq.has(canonical.requisition)) issues.push(`snapshot contains duplicate requisition ${canonical.requisition}`);
    else snapshotByReq.set(canonical.requisition, job);
  }

  for (const job of publicJobs) {
    const canonical = canonicalIdentity(job);
    if (!canonical) {
      issues.push(`public ${clean(job?.id) || '(missing id)'} does not bind to one canonical Digital Realty requisition URL`);
      continue;
    }
    if (publicByReq.has(canonical.requisition)) issues.push(`public feed contains duplicate requisition ${canonical.requisition}`);
    else publicByReq.set(canonical.requisition, job);
  }

  for (const [requisition, snapshotJob] of snapshotByReq) {
    const publicJob = publicByReq.get(requisition);
    if (!publicJob) {
      issues.push(`verified requisition ${requisition} is missing from the public feed`);
      continue;
    }
    for (const field of PARITY_FIELDS) {
      const expected = typeof snapshotJob?.[field] === 'string' ? clean(snapshotJob[field]) : snapshotJob?.[field];
      const actual = typeof publicJob?.[field] === 'string' ? clean(publicJob[field]) : publicJob?.[field];
      if (expected !== actual) issues.push(`requisition ${requisition} differs from the verified snapshot for ${field}`);
    }
  }

  for (const requisition of publicByReq.keys()) {
    if (!snapshotByReq.has(requisition)) issues.push(`public requisition ${requisition} is absent from the verified snapshot`);
  }

  if (publicByReq.size !== snapshotByReq.size) {
    issues.push(`public/snapshot requisition count drift (${publicByReq.size}/${snapshotByReq.size})`);
  }
  return issues;
}

function runRegressionTests() {
  const base = {
    id: 'oracle-digitalrealty-8510',
    title: 'Technician II',
    company: COMPANY,
    location: 'NY, United States',
    type: 'entry-level',
    experience: '2-5-years',
    source: 'Employer career site',
    sourceUrl: `https://${OFFICIAL_HOST}${OFFICIAL_PATH_PREFIX}8510`,
    active: true,
    demo: false
  };
  const alteredLocation = { ...base, location: 'New York, NY', region: 'northeast' };
  const cases = [
    ['canonical requisition accepted', [base], [alteredLocation], true],
    ['mismatched id/url rejected', [{ ...base, id: 'oracle-digitalrealty-8511' }], [alteredLocation], false],
    ['wrong host rejected', [{ ...base, sourceUrl: 'https://example.com/job/8510' }], [alteredLocation], false],
    ['missing public requisition rejected', [base], [], false],
    ['unexpected public requisition rejected', [base], [alteredLocation, { ...alteredLocation, id: 'oracle-digitalrealty-8511', sourceUrl: `https://${OFFICIAL_HOST}${OFFICIAL_PATH_PREFIX}8511` }], false],
    ['field drift rejected', [base], [{ ...alteredLocation, experience: '0-2-years' }], false]
  ];
  const failures = [];
  for (const [name, snapshot, published, shouldPass] of cases) {
    const issues = validateRequisitionParity(snapshot, published);
    if ((issues.length === 0) !== shouldPass) failures.push(`${name}: ${issues.join(' | ') || 'unexpected pass'}`);
  }
  if (failures.length) throw new Error(`Digital Realty requisition parity regression failed: ${failures.join(' || ')}`);
  console.log(`Digital Realty requisition parity regression passed ${cases.length} cases.`);
}

if (process.argv.includes('--test')) {
  runRegressionTests();
  process.exit(0);
}

const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));
const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
const status = JSON.parse(await readFile('data/collector-status.json', 'utf8'));
const source = status?.digitalRealty;
const errors = [];
const requireOk = (condition, message) => { if (!condition) errors.push(message); };
requireOk(Array.isArray(jobs), 'Public jobs feed is not an array.');
requireOk(Array.isArray(snapshot), 'Digital Realty dedicated snapshot is not an array.');
requireOk(source && typeof source === 'object', 'Digital Realty collector status is missing.');
const snapshotJobs = Array.isArray(snapshot) ? snapshot : [];
const publicJobs = Array.isArray(jobs) ? jobs.filter(job => clean(job?.company) === COMPANY) : [];

function validateOfficialUrl(job, label) {
  const canonical = canonicalIdentity(job);
  requireOk(Boolean(canonical), `${label} does not bind its id to one canonical official Digital Realty requisition URL.`);
}

function validateJob(job, label, requireRegion = false) {
  requireOk(Boolean(job?.id), `${label} is missing an id.`);
  requireOk(String(job?.id || '').startsWith('oracle-digitalrealty-'), `${label} has an unexpected id namespace.`);
  requireOk(clean(job?.company) === COMPANY, `${label} is owned by ${job?.company || '(blank)'} instead of Digital Realty.`);
  requireOk(Boolean(job?.title), `${label} is missing a title.`);
  requireOk(Boolean(job?.location), `${label} is missing a location.`);
  requireOk(VALID_TYPES.has(job?.type), `${label} has invalid role type ${job?.type || '(blank)'}.`);
  requireOk(VALID_EXPERIENCE.has(job?.experience), `${label} has invalid experience classification ${job?.experience || '(blank)'}.`);
  requireOk(!EXECUTIVE_PATTERN.test(String(job?.title || '')), `${label} leaked a senior/executive-heavy title: ${job?.title || '(blank)'}.`);
  requireOk(job?.active !== false && job?.demo !== true, `${label} is not an active production role.`);
  validateOfficialUrl(job, label);
  if (requireRegion) requireOk(Boolean(job?.region), `${label} is missing regional classification.`);
}
for (const job of snapshotJobs) validateJob(job, `Digital Realty snapshot job ${job?.id || '(unknown)'}`);
for (const job of publicJobs) validateJob(job, `Digital Realty public job ${job?.id || '(unknown)'}`, true);

if (source) {
  requireOk(String(source.officialSource || '') === 'https://www.digitalrealty.com/about/careers', 'Digital Realty official source metadata drifted from the employer careers page.');
  requireOk(String(source.boardUrl || '').startsWith(`https://${OFFICIAL_HOST}/hcmUI/CandidateExperience/en/sites/CX`), 'Digital Realty board URL metadata is not the official Oracle Recruiting Cloud board.');
  requireOk(Number(source.qualifyingRoles || 0) === snapshotJobs.length, `Digital Realty status reports ${Number(source.qualifyingRoles || 0)} qualifying role(s) but snapshot contains ${snapshotJobs.length}.`);
  requireOk(Number(source.preservedPrevious || 0) <= Number(source.detailFailures || 0), 'Digital Realty preservedPrevious exceeds reported detail failures.');
  requireOk(Number(source.snapshotMaxAgeHours) === MAX_FALLBACK_AGE_HOURS, `Digital Realty fallback window drifted from ${MAX_FALLBACK_AGE_HOURS} hours.`);

  const verifiedAt = source.lastHealthyAt || source.snapshotVerifiedAt || gitLastChangedAt(SNAPSHOT_PATH);
  const verifiedMs = Date.parse(String(verifiedAt || ''));
  const evidenceAgeHours = Number.isFinite(verifiedMs) ? Math.max(0, (Date.now() - verifiedMs) / (60 * 60 * 1000)) : null;

  if (source.sourceHealthy === true) {
    requireOk(Number(source.candidateRows || 0) > 0, 'Digital Realty source reported healthy but returned no candidate rows.');
    requireOk(Number(source.detailAttempts || 0) >= snapshotJobs.length, `Digital Realty healthy source attempted only ${Number(source.detailAttempts || 0)} detail page(s) for ${snapshotJobs.length} published snapshot role(s).`);
    requireOk(Number(source.candidateRows || 0) >= snapshotJobs.length, `Digital Realty healthy source has fewer candidates (${Number(source.candidateRows || 0)}) than qualifying snapshot roles (${snapshotJobs.length}).`);
    requireOk(Number.isFinite(verifiedMs), 'Digital Realty healthy source has no trustworthy verification timestamp.');
    requireOk(evidenceAgeHours == null || evidenceAgeHours < MAX_HEALTHY_EVIDENCE_AGE_HOURS, `Digital Realty healthy source evidence is ${evidenceAgeHours?.toFixed?.(1) ?? 'unknown'} hours old; maximum is ${MAX_HEALTHY_EVIDENCE_AGE_HOURS} hours.`);
    if (source.fallbackUsed !== undefined) requireOk(source.fallbackUsed === false, 'Digital Realty healthy source must not report fallback usage.');
    if (source.fallbackExpired !== undefined) requireOk(source.fallbackExpired === false, 'Digital Realty healthy source must not report an expired fallback.');
  } else {
    requireOk(Array.isArray(source.errors) && source.errors.length > 0, 'Digital Realty source is unhealthy without a recorded collector error.');

    if (snapshotJobs.length > 0) {
      const fallbackAgeMs = Number.isFinite(verifiedMs) ? Date.now() - verifiedMs : Infinity;
      const fallbackAgeHours = fallbackAgeMs / (60 * 60 * 1000);
      requireOk(Number.isFinite(verifiedMs), 'Digital Realty preserved snapshot has no trustworthy verification timestamp.');
      requireOk(fallbackAgeMs < MAX_FALLBACK_AGE_MS, `Digital Realty preserved snapshot is ${Number.isFinite(fallbackAgeHours) ? fallbackAgeHours.toFixed(1) : 'unknown'} hours old; maximum is ${MAX_FALLBACK_AGE_HOURS} hours.`);
      if (source.fallbackUsed !== undefined) requireOk(source.fallbackUsed === true, 'Digital Realty source is unhealthy with published snapshot roles but fallbackUsed is false.');
      if (source.fallbackFresh !== undefined) requireOk(source.fallbackFresh === true, 'Digital Realty source is unhealthy with published snapshot roles but fallbackFresh is false.');
      if (source.fallbackExpired !== undefined) requireOk(source.fallbackExpired === false, 'Digital Realty source is unhealthy with published snapshot roles but fallbackExpired is true.');
    } else {
      if (source.fallbackUsed !== undefined) requireOk(source.fallbackUsed === false, 'Digital Realty has no published fallback roles but fallbackUsed is true.');
      if (source.fallbackFresh !== undefined) requireOk(source.fallbackFresh === false, 'Digital Realty has no published fallback roles but fallbackFresh is true.');
    }
  }
}

const parityIssues = validateRequisitionParity(snapshotJobs, publicJobs);
for (const issue of parityIssues) errors.push(`Digital Realty requisition parity: ${issue}.`);

if (errors.length) {
  console.error('Digital Realty source validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
const sourceState = source?.sourceHealthy === true
  ? 'healthy'
  : snapshotJobs.length
    ? 'using a fresh preserved snapshot'
    : 'unavailable with no stale fallback published';
console.log(`Digital Realty source validation passed: ${snapshotJobs.length} protected requisition(s) have exact public requisition parity; source ${sourceState}.`);
