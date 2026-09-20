import { readFile } from 'node:fs/promises';

const COMPANY = 'TierPoint';
const SNAPSHOT_PATH = 'data/tierpoint-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const EXPECTED_SOURCE = 'Employer career site';
const allowedExperience = new Set(['no-experience', '0-2-years', '2-5-years']);
const allowedTypes = new Set(['entry-level', 'internship', 'apprenticeship', 'trainee']);
const seniorPattern = /\b(?:senior|sr\.?|lead|leader|principal|chief|manager|mgr\.?|director|vice president|vp|head of|staff|supervisor|superintendent|foreman|architect|sales|account executive)\b/i;
const usLocationPattern = /,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)$/;
const parityFields = ['title', 'company', 'location', 'type', 'experience', 'source', 'sourceUrl', 'active', 'demo'];

function officialTierPointId(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'careers-tierpoint.icims.com') return '';
    const match = parsed.pathname.match(/^\/jobs\/(\d+)\/[^/]+\/job\/?$/i);
    return match?.[1] || '';
  } catch {
    return '';
  }
}

const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
if (!Array.isArray(snapshot)) throw new Error('data/tierpoint-jobs.json must contain an array');
if (!Array.isArray(jobs)) throw new Error('data/jobs.json must contain an array');

const violations = [];
const snapshotIds = new Set();
const snapshotUrls = new Set();
const snapshotById = new Map();
for (const [index, job] of snapshot.entries()) {
  const label = job?.id || `snapshot-${index}`;
  if (job?.company !== COMPANY) violations.push(`${label}: unexpected company ${job?.company || '(missing)'}`);
  if (!allowedTypes.has(job?.type)) violations.push(`${label}: unsupported type ${job?.type || '(missing)'}`);
  if (!allowedExperience.has(job?.experience)) violations.push(`${label}: unsupported experience ${job?.experience || '(missing)'}`);
  if (seniorPattern.test(String(job?.title || ''))) violations.push(`${label}: senior-title role leaked into TierPoint snapshot (${job?.title})`);
  if (!usLocationPattern.test(String(job?.location || ''))) violations.push(`${label}: unresolved or non-U.S. location ${job?.location || '(missing)'}`);
  if (job?.active !== true || job?.demo === true) violations.push(`${label}: published TierPoint role must be active and non-demo`);
  if (job?.source !== EXPECTED_SOURCE) violations.push(`${label}: source must remain ${EXPECTED_SOURCE}`);

  const requisitionId = officialTierPointId(job?.sourceUrl);
  if (!requisitionId) {
    violations.push(`${label}: sourceUrl must be a direct official TierPoint iCIMS role URL`);
  } else if (job?.id !== `icims-tierpoint-${requisitionId}`) {
    violations.push(`${label}: id/sourceUrl requisition mismatch (expected icims-tierpoint-${requisitionId})`);
  }
  if (snapshotIds.has(job?.id)) violations.push(`${label}: duplicate snapshot id`);
  snapshotIds.add(job?.id);
  if (snapshotUrls.has(job?.sourceUrl)) violations.push(`${label}: duplicate snapshot sourceUrl`);
  snapshotUrls.add(job?.sourceUrl);
  if (job?.id) snapshotById.set(job.id, job);
}

const publicJobs = jobs.filter(job => String(job?.company || '').trim() === COMPANY);
if (publicJobs.length !== snapshot.length) {
  violations.push(`public TierPoint feed must exactly match the authoritative snapshot count (${publicJobs.length}/${snapshot.length})`);
}

const sourceStatus = status?.tierPoint || {};
if (typeof sourceStatus.sourceHealthy !== 'boolean') violations.push('collector-status.tierPoint.sourceHealthy must be a boolean');
if (sourceStatus.sourceHealthy === true) {
  if (sourceStatus.usedPreviousSnapshot === true) violations.push('healthy TierPoint source cannot report usedPreviousSnapshot=true');
  if (Number(sourceStatus.qualifyingRoles) !== snapshot.length) {
    violations.push(`collector status says ${sourceStatus.qualifyingRoles ?? '(missing)'} qualifying roles but snapshot contains ${snapshot.length}`);
  }
  const attempted = Number(sourceStatus.listing?.pagesAttempted);
  const succeeded = Number(sourceStatus.listing?.pagesSucceeded);
  const candidates = Number(sourceStatus.listing?.candidateLinks);
  if (!Number.isFinite(attempted) || attempted < 1 || !Number.isFinite(succeeded) || succeeded < 1 || succeeded > attempted) {
    violations.push('healthy TierPoint source must report successful iCIMS listing-page evidence');
  }
  if (!Number.isFinite(candidates) || candidates < snapshot.length) {
    violations.push(`TierPoint listing candidate evidence is inconsistent (${sourceStatus.listing?.candidateLinks ?? '(missing)'} vs ${snapshot.length} snapshot roles)`);
  }
} else {
  // The current TierPoint collector historically retained its previous snapshot
  // indefinitely on transport failure. Until that collector records a bounded,
  // timestamped verification window, deployments must fail closed rather than
  // publish an unbounded stale fallback.
  if (snapshot.length || publicJobs.length || sourceStatus.usedPreviousSnapshot === true) {
    violations.push('unhealthy TierPoint source cannot publish or retain an unbounded previous snapshot');
  }
}

const publicIds = new Set();
const publicUrls = new Set();
for (const job of publicJobs) {
  const label = job?.id || job?.sourceUrl || '(unknown public TierPoint role)';
  if (publicIds.has(job?.id)) violations.push(`${label}: duplicate public id`);
  publicIds.add(job?.id);
  if (publicUrls.has(job?.sourceUrl)) violations.push(`${label}: duplicate public sourceUrl`);
  publicUrls.add(job?.sourceUrl);

  const expected = snapshotById.get(job?.id);
  if (!expected) {
    violations.push(`${label}: public TierPoint role is not backed by the authoritative snapshot id`);
    continue;
  }
  for (const field of parityFields) {
    if (job?.[field] !== expected?.[field]) {
      violations.push(`${label}: public ${field} drifted from authoritative snapshot (${JSON.stringify(job?.[field])} vs ${JSON.stringify(expected?.[field])})`);
    }
  }
  const requisitionId = officialTierPointId(job?.sourceUrl);
  if (!requisitionId || job?.id !== `icims-tierpoint-${requisitionId}`) {
    violations.push(`${label}: public requisition id/sourceUrl identity is invalid`);
  }
  if (!job?.region) violations.push(`${label}: public TierPoint role is missing regional classification`);
}

for (const job of snapshot) {
  if (!publicIds.has(job?.id)) violations.push(`${job?.id || job?.sourceUrl}: authoritative TierPoint role is missing from the public feed`);
}

if (violations.length) {
  for (const violation of violations) console.error(`TierPoint validation: ${violation}`);
  throw new Error(`Blocked ${violations.length} TierPoint source regression(s).`);
}

console.log(`TierPoint validation passed: exact authoritative-public parity for ${snapshot.length} verified role(s), official iCIMS requisition identity, 0–5-year audience fit, and fail-closed protection against unbounded stale fallback.`);
