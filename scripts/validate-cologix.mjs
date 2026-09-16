import { readFile } from 'node:fs/promises';

const SNAPSHOT_PATH = 'data/cologix-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'Cologix';
const BOARD_HOST = 'jobs.lever.co';
const BOARD_SLUG = 'cologix';
const BOARD_ROOT = `https://${BOARD_HOST}/${BOARD_SLUG}/`;
const LEVER_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalize = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const allowedTypes = new Set(['entry-level', 'apprenticeship', 'internship', 'trainee']);
const allowedExperience = new Set(['no-experience', '0-2-years', '2-5-years']);
const missionTitlePattern = /\b(?:data cent(?:er|re) (?:operations? )?technician|data cent(?:er|re) electrician|data cent(?:er|re) hvac technician|critical facilities technician|facilities technician|facility technician)\b/i;
const excludedTitlePattern = /\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|superintendent|foreman|architect|security|sales|account executive)\b/i;
const stateAbbrPattern = /(?:,|\s)\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)(?:\b|$)/i;
const usStateNames = [
  'alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi','missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico','new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota','tennessee','texas','utah','vermont','virginia','washington','west virginia','wisconsin','wyoming','district of columbia'
];
const parityFields = ['title', 'company', 'location', 'type', 'experience', 'source', 'sourceUrl', 'active', 'demo'];

function isUsLocation(value = '') {
  const text = clean(value);
  const lower = text.toLowerCase();
  if (!text) return false;
  if (/\b(?:united states|usa|u\.s\.)\b/i.test(text)) return true;
  if (stateAbbrPattern.test(text)) return true;
  return usStateNames.some(state => lower.includes(state));
}

function canonicalLeverIdentity(job = {}) {
  const sourceUrl = clean(job.sourceUrl);
  let url;
  try { url = new URL(sourceUrl); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== BOARD_HOST) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 2 || segments[0].toLowerCase() !== BOARD_SLUG) return null;
  const leverId = segments[1].toLowerCase();
  if (!LEVER_UUID_PATTERN.test(leverId)) return null;
  const expectedId = `lever-cologix-${leverId}`;
  const expectedUrl = `${BOARD_ROOT}${leverId}`;
  if (clean(job.id).toLowerCase() !== expectedId) return null;
  if (sourceUrl.toLowerCase() !== expectedUrl) return null;
  return { leverId, expectedId, expectedUrl };
}

function isCologixJob(job = {}) {
  if (clean(job.company) === COMPANY) return true;
  try {
    const url = new URL(clean(job.sourceUrl));
    const segments = url.pathname.split('/').filter(Boolean);
    return url.protocol === 'https:' &&
      url.hostname.toLowerCase() === BOARD_HOST &&
      segments.length >= 1 &&
      segments[0].toLowerCase() === BOARD_SLUG;
  } catch {
    return false;
  }
}

function validateState(snapshot, jobs, status) {
  const failures = [];
  if (!Array.isArray(snapshot) || snapshot.length === 0) failures.push('Cologix snapshot must be a non-empty array.');
  if (!Array.isArray(jobs)) failures.push('jobs.json must contain an array.');

  const authoritative = new Map();
  const urls = new Set();
  const identities = new Set();

  for (const job of Array.isArray(snapshot) ? snapshot : []) {
    const id = clean(job?.id);
    const title = clean(job?.title);
    const location = clean(job?.location);
    const sourceUrl = clean(job?.sourceUrl);
    const identity = [COMPANY, title, location].map(normalize).join('|');
    const canonical = canonicalLeverIdentity(job);

    if (clean(job?.company) !== COMPANY) failures.push(`${id || title}: wrong company.`);
    if (job?.active !== true) failures.push(`${id || title}: active must be true.`);
    if (job?.demo !== false) failures.push(`${id || title}: demo must be false.`);
    if (!allowedTypes.has(clean(job?.type))) failures.push(`${id || title}: invalid type ${clean(job?.type)}.`);
    if (!allowedExperience.has(clean(job?.experience))) failures.push(`${id || title}: invalid experience ${clean(job?.experience)}.`);
    if (clean(job?.source) !== 'Employer career site') failures.push(`${id || title}: source must be Employer career site.`);
    if (!canonical) failures.push(`${id || title || sourceUrl}: id/sourceUrl must be the same canonical Cologix Lever requisition.`);
    if (!missionTitlePattern.test(title)) failures.push(`${id || title}: title is outside the approved mission-fit families.`);
    if (excludedTitlePattern.test(title)) failures.push(`${id || title}: senior/non-mission title leaked into snapshot.`);
    if (!isUsLocation(location)) failures.push(`${id || title}: U.S. location missing or unrecognized (${location || 'blank'}).`);

    if (!id) failures.push(`${title || sourceUrl}: id missing.`);
    else if (authoritative.has(id)) failures.push(`${id}: duplicate id in Cologix snapshot.`);
    else authoritative.set(id, job);

    if (!sourceUrl) failures.push(`${id || title}: source URL missing.`);
    else if (urls.has(sourceUrl)) failures.push(`${id || title}: duplicate source URL in Cologix snapshot.`);
    else urls.add(sourceUrl);

    if (identities.has(identity)) failures.push(`${id || title}: duplicate title/location identity in Cologix snapshot.`);
    else identities.add(identity);
  }

  const publicCologixJobs = (Array.isArray(jobs) ? jobs : []).filter(isCologixJob);
  const publicIds = new Set();
  for (const job of publicCologixJobs) {
    const id = clean(job?.id);
    const title = clean(job?.title);
    const canonical = canonicalLeverIdentity(job);
    if (clean(job?.company) !== COMPANY) failures.push(`${id || title}: Cologix Lever requisition is misattributed to ${clean(job?.company) || 'no company'}.`);
    if (!canonical) failures.push(`${id || title}: public Cologix card does not use a canonical employer-direct requisition id/URL pair.`);
    if (!id) failures.push(`${title || clean(job?.sourceUrl)}: public Cologix card is missing id.`);
    else if (publicIds.has(id)) failures.push(`${id}: duplicate Cologix requisition in jobs.json.`);
    else publicIds.add(id);

    const source = authoritative.get(id);
    if (!source) {
      failures.push(`${id || title}: public Cologix requisition is not present in the authoritative snapshot.`);
      continue;
    }
    for (const field of parityFields) {
      const publicValue = typeof job?.[field] === 'string' ? clean(job[field]) : job?.[field];
      const sourceValue = typeof source?.[field] === 'string' ? clean(source[field]) : source?.[field];
      if (publicValue !== sourceValue) failures.push(`${id}: ${field} drifted from authoritative snapshot.`);
    }
  }

  const missingIds = [...authoritative.keys()].filter(id => !publicIds.has(id));
  if (missingIds.length) {
    failures.push(`${missingIds.length}/${authoritative.size} verified Cologix requisition(s) are missing from jobs.json: ${missingIds.slice(0, 5).join(', ')}${missingIds.length > 5 ? ', ...' : ''}.`);
  }
  if (publicCologixJobs.length !== authoritative.size && missingIds.length === 0) {
    failures.push(`public Cologix requisition count ${publicCologixJobs.length} does not match authoritative snapshot ${authoritative.size}.`);
  }

  const cologixStatus = status?.cologix;
  if (!cologixStatus || cologixStatus.sourceHealthy !== true) failures.push('collector-status: cologix.sourceHealthy must be true.');
  if (!cologixStatus || cologixStatus.listingComplete !== true) failures.push('collector-status: cologix.listingComplete must be true.');
  if (!cologixStatus || cologixStatus.authoritativeSnapshot !== true) failures.push('collector-status: cologix.authoritativeSnapshot must be true.');
  if (cologixStatus && Number(cologixStatus.qualifyingRoles) !== (Array.isArray(snapshot) ? snapshot.length : 0)) {
    failures.push(`collector-status: qualifyingRoles ${cologixStatus.qualifyingRoles} does not match snapshot ${snapshot.length}.`);
  }

  return failures;
}

if (process.argv.includes('--test')) {
  const base = {
    id: 'lever-cologix-59d81e29-13a8-4970-934d-2da3d5de4e9d',
    title: 'Data Center Electrician- 1st shift (Sunday- Wednesday)',
    company: COMPANY,
    location: 'Columbus, OH',
    type: 'entry-level',
    experience: '2-5-years',
    source: 'Employer career site',
    sourceUrl: `${BOARD_ROOT}59d81e29-13a8-4970-934d-2da3d5de4e9d`,
    active: true,
    demo: false
  };
  const healthy = { cologix: { sourceHealthy: true, listingComplete: true, authoritativeSnapshot: true, qualifyingRoles: 1 } };
  const alternate = {
    ...base,
    id: 'lever-cologix-5465ac4b-a315-439f-b325-8a742d4f4a88',
    sourceUrl: `${BOARD_ROOT}5465ac4b-a315-439f-b325-8a742d4f4a88`,
    title: 'Data Center Electrician- 2nd shift (Sunday- Wednesday)'
  };
  const regressions = [
    ['canonical pair accepted', [base], [base], healthy, true],
    ['mismatched id/url rejected', [{ ...base, id: alternate.id }], [base], healthy, false],
    ['wrong board rejected', [{ ...base, sourceUrl: 'https://jobs.lever.co/example/59d81e29-13a8-4970-934d-2da3d5de4e9d' }], [base], healthy, false],
    ['missing public requisition rejected', [base], [], healthy, false],
    ['unexpected public requisition rejected', [base], [base, alternate], healthy, false],
    ['field drift rejected', [base], [{ ...base, experience: '0-2-years' }], healthy, false],
    ['duplicate public requisition rejected', [base], [base, { ...base }], healthy, false],
    ['misattributed board requisition rejected', [base], [{ ...base, company: 'Example Data Centers' }], healthy, false]
  ];
  const testFailures = [];
  for (const [name, snapshot, jobs, status, shouldPass] of regressions) {
    const failures = validateState(snapshot, jobs, status);
    if ((failures.length === 0) !== shouldPass) testFailures.push(`${name}: ${failures.join(' | ') || 'unexpected pass'}`);
  }
  if (testFailures.length) {
    for (const failure of testFailures) console.error(`Cologix integrity regression: ${failure}`);
    process.exit(1);
  }
  console.log(`Cologix source-integrity validator passed ${regressions.length} regression cases.`);
  process.exit(0);
}

const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
const failures = validateState(snapshot, jobs, status);

if (failures.length) {
  for (const failure of failures) console.error(`Cologix validation: ${failure}`);
  process.exit(1);
}

const publicCount = jobs.filter(isCologixJob).length;
console.log(`Cologix validation passed: ${snapshot.length} authoritative requisition(s) match ${publicCount} public employer-direct card(s) exactly.`);
