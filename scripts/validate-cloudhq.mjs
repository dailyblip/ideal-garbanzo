import { readFile } from 'node:fs/promises';

const COMPANY = 'CloudHQ';
const SNAPSHOT_PATH = 'data/cloudhq-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const EXPECTED_SOURCE = 'Official CloudHQ Paylocity careers';
const MAX_FALLBACK_AGE_HOURS = 96;
const MAX_HEALTHY_EVIDENCE_AGE_HOURS = 30;
const allowedExperience = new Set(['no-experience', '0-2-years', '2-5-years']);
const allowedTypes = new Set(['entry-level', 'internship', 'apprenticeship', 'trainee']);
const healthyModes = new Set(['paylocity-feed', 'verified-direct-role-fallback']);
const allowedModes = new Set([...healthyModes, 'verified-snapshot-fallback', 'fail-closed']);
const seniorPattern = /\b(?:senior|sr\.?|lead|leader|principal|chief|manager|mgr\.?|director|vice president|vp|head of|staff|supervisor|superintendent|foreman|architect)\b/i;
const usLocationPattern = /,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)$/;
const parityFields = ['title', 'company', 'location', 'type', 'experience', 'source', 'sourceUrl', 'active', 'demo'];

function officialPaylocityJobId(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'recruiting.paylocity.com') return '';
    const match = parsed.pathname.match(/^\/recruiting\/jobs\/(?:details|apply)\/(\d+)(?:\/|$)/i);
    return match?.[1] || '';
  } catch {
    return '';
  }
}

const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
if (!Array.isArray(snapshot)) throw new Error('data/cloudhq-jobs.json must contain an array');
if (!Array.isArray(jobs)) throw new Error('data/jobs.json must contain an array');

const violations = [];
const urls = new Set();
const ids = new Set();
const snapshotById = new Map();
for (const [index, job] of snapshot.entries()) {
  const label = job?.id || `snapshot-${index}`;
  if (job?.company !== COMPANY) violations.push(`${label}: unexpected company ${job?.company || '(missing)'}`);
  if (!job?.id || !String(job.id).startsWith('cloudhq-')) violations.push(`${label}: CloudHQ id must use cloudhq- prefix`);
  if (ids.has(job?.id)) violations.push(`${label}: duplicate snapshot id`);
  ids.add(job?.id);
  if (!allowedTypes.has(job?.type)) violations.push(`${label}: unsupported type ${job?.type || '(missing)'}`);
  if (!allowedExperience.has(job?.experience)) violations.push(`${label}: unsupported experience ${job?.experience || '(missing)'}`);
  if (seniorPattern.test(String(job?.title || ''))) violations.push(`${label}: senior-title role leaked into CloudHQ snapshot (${job?.title})`);
  if (!usLocationPattern.test(String(job?.location || ''))) violations.push(`${label}: unresolved or non-U.S. location ${job?.location || '(missing)'}`);
  if (job?.active !== true || job?.demo === true) violations.push(`${label}: published CloudHQ role must be active and non-demo`);
  if (job?.source !== EXPECTED_SOURCE) violations.push(`${label}: source must remain ${EXPECTED_SOURCE}`);

  const requisitionId = officialPaylocityJobId(job?.sourceUrl);
  if (!requisitionId) {
    violations.push(`${label}: sourceUrl must be a direct official Paylocity role URL`);
  } else if (job?.id !== `cloudhq-${requisitionId}`) {
    violations.push(`${label}: id/sourceUrl requisition mismatch (expected cloudhq-${requisitionId})`);
  }
  if (urls.has(job?.sourceUrl)) violations.push(`${label}: duplicate sourceUrl`);
  urls.add(job?.sourceUrl);
  if (job?.id) snapshotById.set(job.id, job);
}

const publicJobs = jobs.filter(job => String(job?.company || '').trim() === COMPANY);
if (publicJobs.length !== snapshot.length) {
  violations.push(`public CloudHQ feed must exactly match the authoritative snapshot count (${publicJobs.length}/${snapshot.length})`);
}

const sourceStatus = status?.cloudHqCareers || {};
if (!allowedModes.has(sourceStatus.mode)) violations.push(`collector-status.cloudHqCareers.mode is unsupported: ${sourceStatus.mode || '(missing)'}`);
const legacyHealthyAnchor = sourceStatus.sourceHealthy === true ? sourceStatus.checkedAt : null;
const lastHealthyAt = sourceStatus.lastHealthyAt || legacyHealthyAnchor;
const lastHealthyMs = Date.parse(String(lastHealthyAt || ''));
const evidenceAgeHours = Number.isFinite(lastHealthyMs) ? Math.max(0, (Date.now() - lastHealthyMs) / 3_600_000) : null;

if ((snapshot.length || publicJobs.length) && !Number.isFinite(lastHealthyMs)) {
  violations.push('published CloudHQ roles have no valid lastHealthyAt verification anchor');
}

if (sourceStatus.sourceHealthy === true) {
  if (!healthyModes.has(sourceStatus.mode)) violations.push(`healthy CloudHQ source cannot use mode ${sourceStatus.mode || '(missing)'}`);
  if (snapshot.length > 0 && evidenceAgeHours > MAX_HEALTHY_EVIDENCE_AGE_HOURS) {
    violations.push(`healthy CloudHQ source evidence is ${evidenceAgeHours.toFixed(1)} hours old (limit ${MAX_HEALTHY_EVIDENCE_AGE_HOURS})`);
  }
  if (sourceStatus.usedPreviousSnapshot === true) violations.push('healthy CloudHQ source cannot report usedPreviousSnapshot=true');
  if (sourceStatus.fallbackExpired === true) violations.push('healthy CloudHQ source cannot report fallbackExpired=true');
  if (Number(sourceStatus.qualifyingRoles) !== snapshot.length) {
    violations.push(`collector status says ${sourceStatus.qualifyingRoles ?? '(missing)'} qualifying roles but snapshot contains ${snapshot.length}`);
  }
  if (!Number.isFinite(Number(sourceStatus.listedJobs)) || Number(sourceStatus.listedJobs) < snapshot.length) {
    violations.push(`collector status listedJobs is inconsistent with snapshot size (${sourceStatus.listedJobs ?? '(missing)'} vs ${snapshot.length})`);
  }
  if (sourceStatus.mode === 'paylocity-feed' && Number(sourceStatus.feedListedJobs) !== Number(sourceStatus.listedJobs)) {
    violations.push(`Paylocity-feed mode must report matching feed/listed counts (${sourceStatus.feedListedJobs} vs ${sourceStatus.listedJobs})`);
  }
  if (sourceStatus.mode === 'verified-direct-role-fallback') {
    if (Number(sourceStatus.feedListedJobs) !== 0) violations.push('direct-role fallback may only activate when the optional Paylocity feed returns zero rows');
    if (!Number.isFinite(Number(sourceStatus.directCandidatesChecked)) || Number(sourceStatus.directCandidatesChecked) < Number(sourceStatus.listedJobs)) {
      violations.push(`direct-role fallback evidence is incomplete (${sourceStatus.directCandidatesChecked ?? '(missing)'} checked vs ${sourceStatus.listedJobs} live)`);
    }
  }
} else if (sourceStatus.mode === 'verified-snapshot-fallback') {
  if (!snapshot.length) violations.push('verified snapshot fallback cannot be active with an empty CloudHQ snapshot');
  if (!Number.isFinite(lastHealthyMs)) violations.push('verified snapshot fallback requires a lastHealthyAt verification anchor');
  if (evidenceAgeHours != null && evidenceAgeHours >= MAX_FALLBACK_AGE_HOURS) {
    violations.push(`CloudHQ fallback is ${evidenceAgeHours.toFixed(1)} hours old and must fail closed at ${MAX_FALLBACK_AGE_HOURS} hours`);
  }
  if (sourceStatus.fallbackExpired === true) violations.push('verified snapshot fallback cannot report fallbackExpired=true');
  if (sourceStatus.usedPreviousSnapshot !== true) violations.push('verified snapshot fallback must report usedPreviousSnapshot=true');
  if (Number(sourceStatus.preservedPrevious) !== snapshot.length) {
    violations.push(`verified snapshot fallback preservation count is inconsistent (${sourceStatus.preservedPrevious ?? '(missing)'} vs ${snapshot.length})`);
  }
  if (sourceStatus.publishedRoles != null && Number(sourceStatus.publishedRoles) !== snapshot.length) {
    violations.push(`verified snapshot fallback publishedRoles is inconsistent (${sourceStatus.publishedRoles} vs ${snapshot.length})`);
  }
} else if (sourceStatus.mode === 'fail-closed') {
  if (snapshot.length || publicJobs.length) violations.push('fail-closed CloudHQ state must publish zero roles and retain no snapshot roles');
  if (sourceStatus.fallbackExpired !== true) violations.push('fail-closed CloudHQ state must report fallbackExpired=true');
  if (sourceStatus.usedPreviousSnapshot === true) violations.push('fail-closed CloudHQ state cannot report usedPreviousSnapshot=true');
} else if (sourceStatus.sourceHealthy !== true) {
  violations.push(`unhealthy CloudHQ source must use verified-snapshot-fallback or fail-closed mode, not ${sourceStatus.mode || '(missing)'}`);
}

if (sourceStatus.fallbackMaxAgeHours != null && Number(sourceStatus.fallbackMaxAgeHours) !== MAX_FALLBACK_AGE_HOURS) {
  violations.push(`CloudHQ fallbackMaxAgeHours must remain ${MAX_FALLBACK_AGE_HOURS}`);
}

const publicIds = new Set();
const publicUrls = new Set();
for (const job of publicJobs) {
  const label = job?.id || job?.sourceUrl || '(unknown public CloudHQ role)';
  if (publicIds.has(job?.id)) violations.push(`${label}: duplicate public id`);
  publicIds.add(job?.id);
  if (publicUrls.has(job?.sourceUrl)) violations.push(`${label}: duplicate public sourceUrl`);
  publicUrls.add(job?.sourceUrl);

  const expected = snapshotById.get(job?.id);
  if (!expected) {
    violations.push(`${label}: public CloudHQ role is not backed by the current authoritative snapshot id`);
    continue;
  }
  for (const field of parityFields) {
    if (job?.[field] !== expected?.[field]) {
      violations.push(`${label}: public ${field} drifted from authoritative snapshot (${JSON.stringify(job?.[field])} vs ${JSON.stringify(expected?.[field])})`);
    }
  }
  const requisitionId = officialPaylocityJobId(job?.sourceUrl);
  if (!requisitionId || job?.id !== `cloudhq-${requisitionId}`) {
    violations.push(`${label}: public requisition id/sourceUrl identity is invalid`);
  }
  if (!job?.region) violations.push(`${label}: public CloudHQ role is missing regional classification`);
}

for (const job of snapshot) {
  if (!publicIds.has(job?.id)) violations.push(`${job?.id || job?.sourceUrl}: authoritative CloudHQ role is missing from the public feed`);
}

if (violations.length) {
  for (const violation of violations) console.error(`CloudHQ validation: ${violation}`);
  throw new Error(`Blocked ${violations.length} CloudHQ source regression(s).`);
}

const modeSummary = sourceStatus.sourceHealthy === true
  ? `${sourceStatus.listedJobs} official Paylocity role(s) checked via ${sourceStatus.mode}`
  : sourceStatus.mode === 'verified-snapshot-fallback'
    ? `verified snapshot fallback active at ${evidenceAgeHours?.toFixed(1) ?? 'unknown'} hours`
    : 'empty fail-closed state';
console.log(`CloudHQ validation passed: exact authoritative-public parity for ${snapshot.length} verified role(s); ${modeSummary}.`);
