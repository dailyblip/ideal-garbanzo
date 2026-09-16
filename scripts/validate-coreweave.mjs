import { readFile } from 'node:fs/promises';

const COMPANY = 'CoreWeave';
const SNAPSHOT_PATH = 'data/coreweave-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const EVIDENCE_PATH = 'data/coreweave-source-evidence.json';
const MAX_FALLBACK_AGE_HOURS = 96;
const MAX_HEALTHY_EVIDENCE_AGE_HOURS = 30;
const allowedExperience = new Set(['no-experience', '0-2-years', '2-5-years']);
const allowedTypes = new Set(['entry-level', 'internship', 'apprenticeship', 'trainee']);
const seniorPattern = /\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|head|supervisor)\b/i;
const missionPattern = /\b(?:data center technician|critical facilit(?:y|ies) technician|critical operations technician|data center operator|data center operations technician|command center systems engineer|facilities technician|electrical technician)\b/i;
const parityFields = ['title', 'company', 'location', 'type', 'experience', 'source', 'sourceUrl', 'active', 'demo'];
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function canonicalRole(value) {
  let parsed;
  try { parsed = new URL(clean(value)); } catch { return null; }
  const host = parsed.hostname.toLowerCase();
  const requisitionId = clean(parsed.searchParams.get('gh_jid'));
  const extraParams = [...parsed.searchParams.keys()].filter(key => key !== 'gh_jid');
  if (
    parsed.protocol !== 'https:'
    || !['coreweave.com', 'www.coreweave.com'].includes(host)
    || parsed.pathname !== '/careers'
    || !/^\d+$/.test(requisitionId)
    || extraParams.length > 0
  ) return null;
  return {
    requisitionId,
    id: `coreweave-${requisitionId}`,
    url: `https://www.coreweave.com/careers?gh_jid=${encodeURIComponent(requisitionId)}`
  };
}

function roleKey(job) {
  return canonicalRole(job?.sourceUrl)?.requisitionId || clean(job?.sourceUrl);
}

function runSelfTest() {
  const canonical = canonicalRole('https://www.coreweave.com/careers?gh_jid=1234567');
  if (!canonical || canonical.id !== 'coreweave-1234567') throw new Error('CoreWeave canonical requisition regression failed.');
  if (canonicalRole('https://example.com/careers?gh_jid=1234567')) throw new Error('CoreWeave non-official host was accepted.');
  if (canonicalRole('https://www.coreweave.com/careers?gh_jid=abc')) throw new Error('CoreWeave non-numeric Greenhouse id was accepted.');
  if (canonicalRole('https://www.coreweave.com/careers?gh_jid=1234567&utm_source=test')) throw new Error('CoreWeave non-canonical query parameters were accepted.');
  console.log('CoreWeave source identity regression tests passed.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

const snapshot = await readJson(SNAPSHOT_PATH, []);
const jobs = await readJson(JOBS_PATH, []);
const status = await readJson(STATUS_PATH, {});
const evidence = await readJson(EVIDENCE_PATH, {});
const source = status?.coreWeaveCareers;
const violations = [];
const requireOk = (condition, message) => { if (!condition) violations.push(message); };

requireOk(Array.isArray(snapshot), 'CoreWeave snapshot must be an array.');
requireOk(Array.isArray(jobs), 'jobs.json must be an array.');
requireOk(source && typeof source === 'object', 'CoreWeave collector status is missing.');

const publicJobs = Array.isArray(jobs)
  ? jobs.filter(job => clean(job?.company) === COMPANY || canonicalRole(job?.sourceUrl))
  : [];
const nowMs = Date.now();
const lastHealthyMs = Date.parse(String(evidence?.lastHealthyAt || source?.lastHealthyAt || ''));
const evidenceAgeHours = Number.isFinite(lastHealthyMs) ? Math.max(0, (nowMs - lastHealthyMs) / 36e5) : null;
const fallbackExpiredByTime = snapshot.length > 0 && (!Number.isFinite(lastHealthyMs) || evidenceAgeHours >= MAX_FALLBACK_AGE_HOURS);

if (source) {
  if (source.sourceHealthy === true) {
    requireOk(Boolean(source.boardToken), 'Healthy CoreWeave source is missing the selected Greenhouse board token.');
    requireOk(Number(source.sourceRoles || 0) >= snapshot.length, 'CoreWeave source role count is smaller than the retained snapshot.');
    requireOk(Number(source.qualifyingRoles || 0) === snapshot.length, `CoreWeave qualifying count ${source.qualifyingRoles || 0} does not match snapshot ${snapshot.length}.`);
    requireOk(Number(source.preservedPrevious || 0) === 0, 'Healthy CoreWeave source should not report preserved fallback roles.');
    requireOk(Number.isFinite(lastHealthyMs), 'Healthy CoreWeave source is missing a verification timestamp.');
    requireOk(evidenceAgeHours == null || evidenceAgeHours < MAX_HEALTHY_EVIDENCE_AGE_HOURS, `Healthy CoreWeave source evidence is ${evidenceAgeHours?.toFixed?.(1) ?? 'unknown'} hours old.`);
  } else if (source.fallbackExpired === true || fallbackExpiredByTime) {
    requireOk(snapshot.length === 0, `Expired CoreWeave fallback still contains ${snapshot.length} snapshot role(s).`);
    requireOk(publicJobs.length === 0, `Expired CoreWeave fallback still publishes ${publicJobs.length} role(s).`);
    requireOk(Number(source.preservedPrevious || 0) === 0, 'Expired CoreWeave fallback still reports preserved roles.');
  } else if (snapshot.length > 0 || publicJobs.length > 0) {
    requireOk(Number.isFinite(lastHealthyMs), 'CoreWeave fallback has no valid lastHealthyAt verification anchor.');
    requireOk(evidenceAgeHours != null && evidenceAgeHours < MAX_FALLBACK_AGE_HOURS, `CoreWeave fallback exceeds the ${MAX_FALLBACK_AGE_HOURS}-hour verified window.`);
    requireOk(Number(source.preservedPrevious || 0) === snapshot.length, `CoreWeave preservation count ${source.preservedPrevious ?? 0} does not match snapshot count ${snapshot.length}.`);
  }
}

function validateRole(job, label, requireRegion) {
  const id = clean(job?.id) || '(missing id)';
  const title = clean(job?.title);
  const canonical = canonicalRole(job?.sourceUrl);
  requireOk(clean(job?.company) === COMPANY, `${label} ${id} has the wrong company.`);
  requireOk(Boolean(job?.id), `${label} role is missing an id.`);
  requireOk(Boolean(canonical), `${label} ${id} does not use the canonical official CoreWeave Greenhouse route.`);
  if (canonical) {
    requireOk(id === canonical.id, `${label} ${id} does not match Greenhouse requisition ${canonical.requisitionId}.`);
    requireOk(clean(job?.sourceUrl) === canonical.url, `${label} ${id} does not use the canonical CoreWeave requisition URL.`);
  }
  requireOk(missionPattern.test(title), `${label} ${id} has an off-mission title: ${title || '(missing)'}.`);
  requireOk(!seniorPattern.test(title), `${label} ${id} leaks a senior title: ${title || '(missing)'}.`);
  requireOk(allowedTypes.has(String(job?.type || '')), `${label} ${id} has invalid role type: ${job?.type || '(missing)'}.`);
  requireOk(allowedExperience.has(String(job?.experience || '')), `${label} ${id} has invalid experience bucket: ${job?.experience || '(missing)'}.`);
  requireOk(job?.active === true && job?.demo !== true, `${label} ${id} is inactive or demo data.`);
  requireOk(clean(job?.source).toLowerCase().includes('official coreweave'), `${label} ${id} must identify the official CoreWeave source.`);
  if (requireRegion) requireOk(Boolean(job?.region), `${label} ${id} is missing a regional classification.`);
}

const snapshotIds = new Set();
const snapshotReqs = new Set();
if (Array.isArray(snapshot)) {
  for (const job of snapshot) {
    validateRole(job, 'CoreWeave snapshot', false);
    const id = clean(job?.id);
    const req = roleKey(job);
    requireOk(!snapshotIds.has(id), `CoreWeave snapshot contains duplicate id ${id}.`);
    requireOk(!snapshotReqs.has(req), `CoreWeave snapshot contains duplicate requisition ${req}.`);
    snapshotIds.add(id);
    snapshotReqs.add(req);
  }
}

const publicIds = new Set();
const publicReqs = new Set();
for (const job of publicJobs) {
  validateRole(job, 'Published CoreWeave', true);
  const id = clean(job?.id);
  const req = roleKey(job);
  requireOk(!publicIds.has(id), `Published CoreWeave feed contains duplicate id ${id}.`);
  requireOk(!publicReqs.has(req), `Published CoreWeave feed contains duplicate requisition ${req}.`);
  publicIds.add(id);
  publicReqs.add(req);
}

if (Array.isArray(snapshot)) {
  requireOk(publicJobs.length === snapshot.length, `Published CoreWeave role count ${publicJobs.length} does not match snapshot count ${snapshot.length}.`);
  for (const req of snapshotReqs) requireOk(publicReqs.has(req), `Verified CoreWeave requisition ${req} is missing from public jobs.json.`);
  for (const req of publicReqs) requireOk(snapshotReqs.has(req), `Published CoreWeave requisition ${req} is not in the verified snapshot.`);

  const snapshotByReq = new Map(snapshot.map(job => [roleKey(job), job]));
  for (const publicJob of publicJobs) {
    const snapshotJob = snapshotByReq.get(roleKey(publicJob));
    if (!snapshotJob) continue;
    for (const field of parityFields) {
      const expected = typeof snapshotJob?.[field] === 'string' ? clean(snapshotJob[field]) : snapshotJob?.[field];
      const actual = typeof publicJob?.[field] === 'string' ? clean(publicJob[field]) : publicJob?.[field];
      requireOk(expected === actual, `Published CoreWeave ${publicJob.id} differs from the verified snapshot for ${field}.`);
    }
  }
}

if (violations.length) {
  console.error('CoreWeave source validation failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

const mode = source?.sourceHealthy === true ? 'fresh verified Greenhouse source' : source?.fallbackExpired === true ? 'expired fail-closed state' : 'time-bounded verified fallback';
console.log(`CoreWeave source validation passed: ${publicJobs.length} published employer-direct role(s) match the ${mode} with exact requisition parity.`);
