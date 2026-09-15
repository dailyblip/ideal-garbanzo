import { readFile } from 'node:fs/promises';

const COMPANY = 'DataBank';
const SNAPSHOT_PATH = 'data/databank-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const PORTAL_PREFIX = 'https://www.databankcareers.com/clients/';
const allowedTypes = new Set(['entry-level', 'internship', 'apprenticeship', 'trainee']);
const allowedExperience = new Set(['no-experience', '0-2-years', '2-5-years']);
const excludedTitlePattern = /\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|superintendent|foreman|architect|security|sales|account executive|solutions engineer|technical support|support engineer|project manager|product manager|analyst|finance|procurement|marketing|software|developer|data scientist|human resources|recruiter)\b/i;
const missionTitlePattern = /\b(?:data cent(?:er|re)|critical infrastructure|critical facilit(?:y|ies)|critical environment|facilit(?:y|ies) technician|electrical technician|mechanical technician)\b/i;
const contextualInfraTitlePattern = /\b(?:technician|operator|engineer|electrician|mechanic|intern|apprentice|trainee)\b/i;
const missionEvidenceTags = new Set(['Critical Facilities', 'Electrical']);
const stateAbbrPattern = /(?:,|\s)\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)(?:\b|$)/i;
const usStateNames = ['alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi','missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico','new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota','tennessee','texas','utah','vermont','virginia','washington','west virginia','wisconsin','wyoming','district of columbia'];

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const lower = value => clean(value).toLowerCase();
const normalize = value => lower(value).replace(/[^a-z0-9]+/g, ' ').trim();
const isUsLocation = value => stateAbbrPattern.test(clean(value)) || usStateNames.some(state => lower(value).includes(state));
const hasMissionEvidence = job => {
  const title = clean(job?.title);
  if (missionTitlePattern.test(title)) return true;
  if (!contextualInfraTitlePattern.test(title)) return false;
  return (Array.isArray(job?.tags) ? job.tags : []).some(tag => missionEvidenceTags.has(clean(tag)));
};
const identity = job => [job?.company, job?.title, job?.location].map(normalize).join('|');

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

const [snapshot, jobs, status] = await Promise.all([
  readJson(SNAPSHOT_PATH),
  readJson(JOBS_PATH),
  readJson(STATUS_PATH)
]);
const sourceStatus = status?.databank || {};
const violations = [];

if (!Array.isArray(snapshot)) violations.push('snapshot is not a JSON array');
if (!Array.isArray(jobs)) violations.push('jobs.json is not a JSON array');
if (sourceStatus.sourceHealthy !== true) violations.push('collector status does not mark the employer source healthy');
if (sourceStatus.listingComplete !== true) violations.push('collector status does not mark the TalentReef listing complete');
if (sourceStatus.authoritativeSnapshot !== true) violations.push('collector status does not mark the snapshot authoritative');
if (sourceStatus.officialCareerPage !== 'https://www.databank.com/about-databank/careers-at-databank/') violations.push('official DataBank careers URL drifted');
if (sourceStatus.officialTalentReefPortal !== 'https://www.databankcareers.com') violations.push('official DataBank TalentReef portal drifted');
if (!clean(sourceStatus.talentReefClientId)) violations.push('TalentReef client ID was not recorded');
if (!Number.isFinite(Number(sourceStatus.listedJobs)) || Number(sourceStatus.listedJobs) <= 0) violations.push('TalentReef listing count is missing or zero');
if (Number(sourceStatus.qualifyingRoles) !== (Array.isArray(snapshot) ? snapshot.length : 0)) violations.push(`snapshot/status count mismatch: ${Array.isArray(snapshot) ? snapshot.length : 0} vs ${sourceStatus.qualifyingRoles}`);

function validateRole(job, context) {
  const prefix = `${context} ${clean(job?.id) || clean(job?.title) || '(unknown role)'}`;
  if (clean(job?.company) !== COMPANY) violations.push(`${prefix}: wrong company`);
  if (!clean(job?.title)) violations.push(`${prefix}: blank title`);
  if (excludedTitlePattern.test(clean(job?.title))) violations.push(`${prefix}: senior/out-of-scope title survived: ${job?.title}`);
  if (!hasMissionEvidence(job)) violations.push(`${prefix}: non-mission title survived without physical-infrastructure evidence: ${job?.title}`);
  if (!allowedTypes.has(clean(job?.type))) violations.push(`${prefix}: invalid type ${job?.type}`);
  if (!allowedExperience.has(clean(job?.experience))) violations.push(`${prefix}: invalid experience ${job?.experience}`);
  if (!isUsLocation(job?.location)) violations.push(`${prefix}: non-US or unresolved location ${job?.location}`);
  if (clean(job?.source) !== 'Employer career site') violations.push(`${prefix}: source must be Employer career site`);
  if (!clean(job?.sourceUrl).startsWith(PORTAL_PREFIX)) violations.push(`${prefix}: non-employer-direct source URL ${job?.sourceUrl}`);
  if (job?.active !== true || job?.demo === true) violations.push(`${prefix}: role must be active and non-demo`);
}

const snapshotUrls = new Set();
const snapshotIds = new Set();
const snapshotIdentities = new Set();
for (const job of Array.isArray(snapshot) ? snapshot : []) {
  validateRole(job, 'snapshot');
  const id = clean(job?.id);
  const url = clean(job?.sourceUrl);
  const roleIdentity = identity(job);
  if (!id) violations.push(`snapshot ${clean(job?.title) || '(untitled role)'}: id missing`);
  else if (snapshotIds.has(id)) violations.push(`snapshot duplicate id: ${id}`);
  if (url && snapshotUrls.has(url)) violations.push(`snapshot duplicate source URL: ${url}`);
  if (snapshotIdentities.has(roleIdentity)) violations.push(`snapshot duplicate role identity: ${job?.title} | ${job?.location}`);
  if (id) snapshotIds.add(id);
  if (url) snapshotUrls.add(url);
  snapshotIdentities.add(roleIdentity);
}

const publicJobs = (Array.isArray(jobs) ? jobs : []).filter(job => clean(job?.company) === COMPANY);
const publicById = new Map();
for (const job of publicJobs) {
  validateRole(job, 'public');
  const id = clean(job?.id);
  if (!id) violations.push(`public ${clean(job?.title) || '(untitled role)'}: id missing`);
  else if (publicById.has(id)) violations.push(`public duplicate id: ${id}`);
  else publicById.set(id, job);
}

const snapshotById = new Map((Array.isArray(snapshot) ? snapshot : []).map(job => [clean(job?.id), job]).filter(([id]) => id));
for (const [id, sourceJob] of snapshotById) {
  const publicJob = publicById.get(id);
  if (!publicJob) {
    violations.push(`authoritative snapshot role missing from jobs.json: ${id} | ${sourceJob.title} | ${sourceJob.location}`);
    continue;
  }
  if (clean(publicJob.sourceUrl) !== clean(sourceJob.sourceUrl)) violations.push(`${id}: public source URL drifted from authoritative TalentReef requisition`);
  if (normalize(publicJob.title) !== normalize(sourceJob.title)) violations.push(`${id}: public title drifted from authoritative snapshot`);
  if (normalize(publicJob.location) !== normalize(sourceJob.location)) violations.push(`${id}: public location drifted from authoritative snapshot`);
  if (clean(publicJob.type) !== clean(sourceJob.type)) violations.push(`${id}: public type drifted from authoritative snapshot`);
  if (clean(publicJob.experience) !== clean(sourceJob.experience)) violations.push(`${id}: public experience drifted from authoritative snapshot`);
}

for (const [id, publicJob] of publicById) {
  if (!snapshotById.has(id)) violations.push(`stale or unverified public DataBank role is absent from authoritative snapshot: ${id} | ${publicJob.title} | ${publicJob.location}`);
}

if (publicJobs.length !== (Array.isArray(snapshot) ? snapshot.length : 0)) {
  violations.push(`public/snapshot count mismatch: ${publicJobs.length} vs ${Array.isArray(snapshot) ? snapshot.length : 0}`);
}

if (violations.length) {
  violations.forEach(violation => console.error(`DataBank source validation: ${violation}`));
  throw new Error(`Blocked ${violations.length} DataBank employer-direct publication regression(s).`);
}

console.log(`DataBank employer-direct publication passed: ${snapshot.length} authoritative TalentReef requisition(s) exactly represented in jobs.json from ${sourceStatus.listedJobs} public postings.`);
