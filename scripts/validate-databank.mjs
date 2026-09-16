import { readFile } from 'node:fs/promises';

const COMPANY = 'DataBank';
const SNAPSHOT_PATH = 'data/databank-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const CAREERS_URL = 'https://www.databank.com/about-databank/careers-at-databank/';
const PORTAL_HOST = 'www.databankcareers.com';
const PORTAL_ROOT = `https://${PORTAL_HOST}`;
const EXPECTED_SOURCE = 'Employer career site';
const allowedTypes = new Set(['entry-level', 'internship', 'apprenticeship', 'trainee']);
const allowedExperience = new Set(['no-experience', '0-2-years', '2-5-years']);
const excludedTitlePattern = /\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|superintendent|foreman|architect|security|sales|account executive|solutions engineer|technical support|support engineer|project manager|product manager|analyst|finance|procurement|marketing|software|developer|data scientist|human resources|recruiter)\b/i;
const missionTitlePattern = /\b(?:data cent(?:er|re)|critical infrastructure|critical facilit(?:y|ies)|critical environment|facilit(?:y|ies) technician|electrical technician|mechanical technician)\b/i;
const contextualInfraTitlePattern = /\b(?:technician|operator|engineer|electrician|mechanic|intern|apprentice|trainee)\b/i;
const missionEvidenceTags = new Set(['Critical Facilities', 'Electrical']);
const stateAbbrPattern = /(?:,|\s)\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)(?:\b|$)/i;
const usStateNames = ['alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi','missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico','new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota','tennessee','texas','utah','vermont','virginia','washington','west virginia','wisconsin','wyoming','district of columbia'];
const parityFields = ['title', 'company', 'location', 'type', 'experience', 'source', 'sourceUrl', 'active', 'demo'];

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

function canonicalTalentReefIdentity(job = {}, expectedClientId = '') {
  const sourceUrl = clean(job?.sourceUrl);
  let url;
  try { url = new URL(sourceUrl); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== PORTAL_HOST) return null;
  if (url.username || url.password || url.search || url.hash) return null;

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 4 || segments[0].toLowerCase() !== 'clients' || segments[2].toLowerCase() !== 'posting') return null;
  const clientId = segments[1];
  const postingId = segments[3];
  if (!/^\d+$/.test(clientId) || !/^\d+$/.test(postingId)) return null;
  if (expectedClientId && clientId !== expectedClientId) return null;

  const expectedId = `talentreef-databank-${postingId}`;
  const expectedUrl = `${PORTAL_ROOT}/clients/${clientId}/posting/${postingId}`;
  if (clean(job?.id) !== expectedId || sourceUrl !== expectedUrl) return null;
  return { clientId, postingId, expectedId, expectedUrl };
}

function isDataBankJob(job = {}) {
  if (clean(job?.company) === COMPANY) return true;
  try {
    const url = new URL(clean(job?.sourceUrl));
    const segments = url.pathname.split('/').filter(Boolean);
    return url.protocol === 'https:' &&
      url.hostname.toLowerCase() === PORTAL_HOST &&
      segments.length >= 4 &&
      segments[0].toLowerCase() === 'clients' &&
      segments[2].toLowerCase() === 'posting';
  } catch {
    return false;
  }
}

function validateRole(job, context, expectedClientId, violations) {
  const prefix = `${context} ${clean(job?.id) || clean(job?.title) || '(unknown role)'}`;
  if (clean(job?.company) !== COMPANY) violations.push(`${prefix}: wrong company`);
  if (!clean(job?.title)) violations.push(`${prefix}: blank title`);
  if (excludedTitlePattern.test(clean(job?.title))) violations.push(`${prefix}: senior/out-of-scope title survived: ${job?.title}`);
  if (!hasMissionEvidence(job)) violations.push(`${prefix}: non-mission title survived without physical-infrastructure evidence: ${job?.title}`);
  if (!allowedTypes.has(clean(job?.type))) violations.push(`${prefix}: invalid type ${job?.type}`);
  if (!allowedExperience.has(clean(job?.experience))) violations.push(`${prefix}: invalid experience ${job?.experience}`);
  if (!isUsLocation(job?.location)) violations.push(`${prefix}: non-US or unresolved location ${job?.location}`);
  if (clean(job?.source) !== EXPECTED_SOURCE) violations.push(`${prefix}: source must be ${EXPECTED_SOURCE}`);
  if (!canonicalTalentReefIdentity(job, expectedClientId)) violations.push(`${prefix}: id/sourceUrl must be the same canonical DataBank TalentReef requisition for client ${expectedClientId || '(missing)'}`);
  if (job?.active !== true || job?.demo === true) violations.push(`${prefix}: role must be active and non-demo`);
}

function validateState(snapshot, jobs, status) {
  const violations = [];
  const sourceStatus = status?.databank || {};
  const expectedClientId = clean(sourceStatus.talentReefClientId);

  if (!Array.isArray(snapshot)) violations.push('snapshot is not a JSON array');
  if (!Array.isArray(jobs)) violations.push('jobs.json is not a JSON array');
  if (sourceStatus.sourceHealthy !== true) violations.push('collector status does not mark the employer source healthy');
  if (sourceStatus.listingComplete !== true) violations.push('collector status does not mark the TalentReef listing complete');
  if (sourceStatus.authoritativeSnapshot !== true) violations.push('collector status does not mark the snapshot authoritative');
  if (sourceStatus.officialCareerPage !== CAREERS_URL) violations.push('official DataBank careers URL drifted');
  if (sourceStatus.officialTalentReefPortal !== PORTAL_ROOT) violations.push('official DataBank TalentReef portal drifted');
  if (!expectedClientId || !/^\d+$/.test(expectedClientId)) violations.push('TalentReef client ID is missing or invalid');
  if (!Number.isFinite(Number(sourceStatus.listedJobs)) || Number(sourceStatus.listedJobs) <= 0) violations.push('TalentReef listing count is missing or zero');
  if (Number(sourceStatus.qualifyingRoles) !== (Array.isArray(snapshot) ? snapshot.length : 0)) violations.push(`snapshot/status count mismatch: ${Array.isArray(snapshot) ? snapshot.length : 0} vs ${sourceStatus.qualifyingRoles}`);

  const authoritative = new Map();
  const snapshotUrls = new Set();
  const snapshotIdentities = new Set();
  for (const job of Array.isArray(snapshot) ? snapshot : []) {
    validateRole(job, 'snapshot', expectedClientId, violations);
    const id = clean(job?.id);
    const url = clean(job?.sourceUrl);
    const roleIdentity = identity(job);
    if (!id) violations.push(`snapshot ${clean(job?.title) || '(untitled role)'}: id missing`);
    else if (authoritative.has(id)) violations.push(`snapshot duplicate id: ${id}`);
    else authoritative.set(id, job);
    if (!url) violations.push(`snapshot ${id || clean(job?.title) || '(untitled role)'}: source URL missing`);
    else if (snapshotUrls.has(url)) violations.push(`snapshot duplicate source URL: ${url}`);
    else snapshotUrls.add(url);
    if (snapshotIdentities.has(roleIdentity)) violations.push(`snapshot duplicate role identity: ${job?.title} | ${job?.location}`);
    else snapshotIdentities.add(roleIdentity);
  }

  const publicJobs = (Array.isArray(jobs) ? jobs : []).filter(isDataBankJob);
  const publicIds = new Set();
  const publicUrls = new Set();
  for (const job of publicJobs) {
    const id = clean(job?.id);
    const title = clean(job?.title);
    validateRole(job, 'public', expectedClientId, violations);
    if (clean(job?.company) !== COMPANY) violations.push(`${id || title}: DataBank TalentReef requisition is misattributed to ${clean(job?.company) || 'no company'}`);
    if (!id) violations.push(`public ${title || clean(job?.sourceUrl) || '(untitled role)'}: id missing`);
    else if (publicIds.has(id)) violations.push(`public duplicate id: ${id}`);
    else publicIds.add(id);
    const url = clean(job?.sourceUrl);
    if (url && publicUrls.has(url)) violations.push(`public duplicate source URL: ${url}`);
    else if (url) publicUrls.add(url);

    const sourceJob = authoritative.get(id);
    if (!sourceJob) {
      violations.push(`stale or unverified public DataBank role is absent from authoritative snapshot: ${id || title} | ${job?.location || ''}`);
      continue;
    }
    for (const field of parityFields) {
      const publicValue = typeof job?.[field] === 'string' ? clean(job[field]) : job?.[field];
      const sourceValue = typeof sourceJob?.[field] === 'string' ? clean(sourceJob[field]) : sourceJob?.[field];
      if (publicValue !== sourceValue) violations.push(`${id}: public ${field} drifted from authoritative snapshot`);
    }
    if (!job?.region) violations.push(`${id}: public DataBank role is missing regional classification`);
  }

  for (const [id, sourceJob] of authoritative) {
    if (!publicIds.has(id)) violations.push(`authoritative snapshot role missing from jobs.json: ${id} | ${sourceJob.title} | ${sourceJob.location}`);
  }
  if (publicJobs.length !== authoritative.size) violations.push(`public/snapshot count mismatch: ${publicJobs.length} vs ${authoritative.size}`);

  return violations;
}

if (process.argv.includes('--test')) {
  const base = {
    id: 'talentreef-databank-11129551',
    title: 'Data Center Technician 1',
    company: COMPANY,
    location: 'Houston, TX',
    type: 'entry-level',
    experience: '2-5-years',
    tags: ['2–5 Years', 'Electrical', 'Critical Facilities'],
    source: EXPECTED_SOURCE,
    sourceUrl: `${PORTAL_ROOT}/clients/14459/posting/11129551`,
    active: true,
    demo: false,
    region: 'texas'
  };
  const healthy = {
    databank: {
      sourceHealthy: true,
      listingComplete: true,
      authoritativeSnapshot: true,
      officialCareerPage: CAREERS_URL,
      officialTalentReefPortal: PORTAL_ROOT,
      talentReefClientId: '14459',
      listedJobs: 40,
      qualifyingRoles: 1
    }
  };
  const alternate = {
    ...base,
    id: 'talentreef-databank-11128534',
    sourceUrl: `${PORTAL_ROOT}/clients/14459/posting/11128534`,
    title: 'Data Center Technician 1',
    location: 'Red Oak, TX'
  };
  const regressions = [
    ['canonical pair accepted', [base], [base], healthy, true],
    ['mismatched id/url rejected', [{ ...base, id: alternate.id }], [base], healthy, false],
    ['wrong TalentReef client rejected', [{ ...base, sourceUrl: `${PORTAL_ROOT}/clients/99999/posting/11129551` }], [base], healthy, false],
    ['wrong portal host rejected', [{ ...base, sourceUrl: 'https://example.com/clients/14459/posting/11129551' }], [base], healthy, false],
    ['missing public requisition rejected', [base], [], healthy, false],
    ['unexpected public requisition rejected', [base], [base, alternate], healthy, false],
    ['field drift rejected', [base], [{ ...base, experience: '0-2-years' }], healthy, false],
    ['duplicate public requisition rejected', [base], [base, { ...base }], healthy, false],
    ['misattributed portal requisition rejected', [base], [{ ...base, company: 'Example Data Centers' }], healthy, false]
  ];
  const testFailures = [];
  for (const [name, snapshot, jobs, status, shouldPass] of regressions) {
    const failures = validateState(snapshot, jobs, status);
    if ((failures.length === 0) !== shouldPass) testFailures.push(`${name}: ${failures.join(' | ') || 'unexpected pass'}`);
  }
  if (testFailures.length) {
    for (const failure of testFailures) console.error(`DataBank integrity regression: ${failure}`);
    process.exit(1);
  }
  console.log(`DataBank source-integrity validator passed ${regressions.length} regression cases.`);
  process.exit(0);
}

const [snapshot, jobs, status] = await Promise.all([
  readFile(SNAPSHOT_PATH, 'utf8').then(JSON.parse),
  readFile(JOBS_PATH, 'utf8').then(JSON.parse),
  readFile(STATUS_PATH, 'utf8').then(JSON.parse)
]);
const violations = validateState(snapshot, jobs, status);

if (violations.length) {
  violations.forEach(violation => console.error(`DataBank source validation: ${violation}`));
  throw new Error(`Blocked ${violations.length} DataBank employer-direct publication regression(s).`);
}

const sourceStatus = status.databank;
console.log(`DataBank employer-direct publication passed: exact authoritative-public parity for ${snapshot.length} TalentReef requisition(s) from ${sourceStatus.listedJobs} public postings.`);
