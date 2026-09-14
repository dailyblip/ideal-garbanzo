import { readFile } from 'node:fs/promises';

const COMPANY = 'CloudHQ';
const SNAPSHOT_PATH = 'data/cloudhq-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const allowedExperience = new Set(['no-experience', '0-2-years', '2-5-years']);
const allowedTypes = new Set(['entry-level', 'internship', 'apprenticeship', 'trainee']);
const allowedModes = new Set(['paylocity-feed', 'verified-direct-role-fallback']);
const seniorPattern = /\b(?:senior|sr\.?|lead|leader|principal|chief|manager|mgr\.?|director|vice president|vp|head of|staff|supervisor|superintendent|foreman|architect)\b/i;
const usLocationPattern = /,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)$/;

const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
if (!Array.isArray(snapshot)) throw new Error('data/cloudhq-jobs.json must contain an array');
if (!Array.isArray(jobs)) throw new Error('data/jobs.json must contain an array');

const violations = [];
const urls = new Set();
for (const [index, job] of snapshot.entries()) {
  const label = job?.id || `snapshot-${index}`;
  if (job?.company !== COMPANY) violations.push(`${label}: unexpected company ${job?.company || '(missing)'}`);
  if (!job?.id || !String(job.id).startsWith('cloudhq-')) violations.push(`${label}: CloudHQ id must use cloudhq- prefix`);
  if (!allowedTypes.has(job?.type)) violations.push(`${label}: unsupported type ${job?.type || '(missing)'}`);
  if (!allowedExperience.has(job?.experience)) violations.push(`${label}: unsupported experience ${job?.experience || '(missing)'}`);
  if (seniorPattern.test(String(job?.title || ''))) violations.push(`${label}: senior-title role leaked into CloudHQ snapshot (${job?.title})`);
  if (!usLocationPattern.test(String(job?.location || ''))) violations.push(`${label}: unresolved or non-U.S. location ${job?.location || '(missing)'}`);
  if (job?.active !== true || job?.demo === true) violations.push(`${label}: published CloudHQ role must be active and non-demo`);
  try {
    const parsed = new URL(String(job?.sourceUrl || ''));
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'recruiting.paylocity.com' || !/^\/recruiting\/jobs\/(?:details|apply)\/\d+/i.test(parsed.pathname)) {
      violations.push(`${label}: sourceUrl must be a direct official Paylocity role URL`);
    }
  } catch {
    violations.push(`${label}: invalid sourceUrl`);
  }
  if (urls.has(job?.sourceUrl)) violations.push(`${label}: duplicate sourceUrl`);
  urls.add(job?.sourceUrl);
}

const sourceStatus = status?.cloudHqCareers || {};
if (sourceStatus.sourceHealthy !== true) violations.push('collector-status.cloudHqCareers.sourceHealthy must be true after a published refresh');
if (!allowedModes.has(sourceStatus.mode)) violations.push(`collector-status.cloudHqCareers.mode is unsupported: ${sourceStatus.mode || '(missing)'}`);
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

const publicJobs = jobs.filter(job => String(job?.company || '').trim() === COMPANY);
if (snapshot.length > 0 && publicJobs.length === 0) violations.push(`all ${snapshot.length} verified CloudHQ roles disappeared from the public feed`);
if (snapshot.length >= 4 && publicJobs.length < Math.ceil(snapshot.length * 0.5)) {
  violations.push(`public feed retained only ${publicJobs.length}/${snapshot.length} verified CloudHQ roles`);
}
const snapshotUrls = new Set(snapshot.map(job => job.sourceUrl));
for (const job of publicJobs) {
  if (!snapshotUrls.has(job?.sourceUrl)) violations.push(`public CloudHQ role is not backed by the current official snapshot: ${job?.id || job?.sourceUrl}`);
  if (!job?.region) violations.push(`public CloudHQ role is missing regional classification: ${job?.id || job?.sourceUrl}`);
}

if (violations.length) {
  for (const violation of violations) console.error(`CloudHQ validation: ${violation}`);
  throw new Error(`Blocked ${violations.length} CloudHQ source regression(s).`);
}

console.log(`CloudHQ validation passed: ${snapshot.length} verified snapshot role(s), ${publicJobs.length} public role(s), ${sourceStatus.listedJobs} official Paylocity role(s) checked via ${sourceStatus.mode}.`);
