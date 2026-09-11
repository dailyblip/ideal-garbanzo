import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'Equinix';
const VERIFIED_SOURCE = 'Equinix official careers (verified fallback)';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function canonicalUrl(value = '') {
  const raw = clean(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return raw.replace(/\/$/, '');
  }
}

function isManaged(job) {
  return clean(job?.company) === COMPANY && (
    /^equinix-verified-/i.test(clean(job?.id)) ||
    clean(job?.source) === VERIFIED_SOURCE
  );
}

function fallbackWindowActive(fallback, nowMs = Date.now()) {
  if (!fallback || typeof fallback !== 'object' || fallback.expired === true) return false;
  const expiresAt = Date.parse(clean(fallback.expiresAt));
  return Number.isFinite(expiresAt) && nowMs < expiresAt;
}

function hasExactEvidence(job, fallback) {
  if (!fallbackWindowActive(fallback)) return false;
  const jobUrl = canonicalUrl(job?.sourceUrl);
  if (!jobUrl || !Array.isArray(fallback.checks)) return false;
  return fallback.checks.some(check =>
    check?.ok === true && canonicalUrl(check?.sourceUrl) === jobUrl
  );
}

function runSelfTest() {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 60 * 1000).toISOString();
  const job = {
    id: 'equinix-verified-test',
    company: COMPANY,
    source: VERIFIED_SOURCE,
    sourceUrl: 'https://careers.equinix.com/jobs/search?query=JR-123456'
  };
  const valid = {
    expired: false,
    expiresAt: future,
    retainedManaged: 2,
    liveChecksPassed: 2,
    checks: [
      { ok: true, sourceUrl: job.sourceUrl },
      { ok: true, sourceUrl: 'https://careers.equinix.com/jobs/search?query=JR-999999' }
    ]
  };
  if (!hasExactEvidence(job, valid)) {
    throw new Error('Exact Equinix per-role evidence was not accepted.');
  }
  const unrelated = {
    ...valid,
    checks: [{ ok: true, sourceUrl: 'https://careers.equinix.com/jobs/search?query=JR-999999' }]
  };
  if (hasExactEvidence(job, unrelated)) {
    throw new Error('Aggregate Equinix verification incorrectly protected a role without exact evidence.');
  }
  if (hasExactEvidence(job, { ...valid, expiresAt: past })) {
    throw new Error('Expired Equinix evidence window was incorrectly accepted.');
  }
  if (hasExactEvidence(job, { ...valid, checks: [] })) {
    throw new Error('Missing Equinix role checks were incorrectly accepted.');
  }
  console.log('Equinix verified-fallback evidence regression tests passed.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
if (!Array.isArray(jobs)) throw new Error(`${JOBS_PATH} must contain an array.`);
if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error(`${STATUS_PATH} must contain an object.`);

const fallback = status.equinixVerifiedFallback;
const managed = jobs.filter(isManaged);
if (!managed.length) {
  console.log('No managed Equinix verified-fallback roles are published.');
  process.exit(0);
}

const invalid = managed.filter(job => !hasExactEvidence(job, fallback));
if (!invalid.length) {
  console.log(`All ${managed.length} managed Equinix fallback role(s) have exact active per-role verification evidence.`);
  process.exit(0);
}

const invalidIds = new Set(invalid.map(job => clean(job.id)));
const nextJobs = jobs.filter(job => !invalidIds.has(clean(job.id)));
const countBy = key => nextJobs.reduce((counts, job) => {
  const value = clean(job?.[key]) || 'unknown';
  counts[value] = (counts[value] || 0) + 1;
  return counts;
}, {});
const checkedAt = new Date().toISOString();

status.updatedAt = checkedAt;
status.jobs = nextJobs.length;
status.countsByType = countBy('type');
status.countsByExperience = countBy('experience');
status.equinixVerifiedEvidenceGuard = {
  checkedAt,
  managedBefore: managed.length,
  removed: invalid.length,
  retained: managed.length - invalid.length,
  policy: 'A managed Equinix verified-fallback role must have its own successful official-source check and an unexpired fallback window; aggregate source counts cannot protect an unrelated role.',
  removedRoles: invalid.map(job => ({
    id: clean(job.id),
    title: clean(job.title),
    sourceUrl: clean(job.sourceUrl)
  }))
};

await writeFile(JOBS_PATH, JSON.stringify(nextJobs, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
console.warn(`Removed ${invalid.length} Equinix verified-fallback role(s) without exact active per-role evidence.`);
