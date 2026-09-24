import { readFile } from 'node:fs/promises';

const COMPANY = 'Csquare';
const COLLECTOR_PATH = 'scripts/collect-csquare-jobs.mjs';
const SNAPSHOT_PATH = 'data/csquare-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const EXPECTED_HOST = 'recruiting.ultipro.com';
const EXPECTED_PREFIX = '/cyx1000cyxt/jobboard/6ce3c532-60ea-4691-8e59-5f0a86be31a9/opportunitydetail';
const STATE_CODES = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC']);
const ALLOWED_TYPES = new Set(['entry-level','internship','apprenticeship','trainee']);
const ALLOWED_EXPERIENCE = new Set(['no-experience','0-2-years','2-5-years']);
const seniorTitlePattern = /\b(?:senior|sr\.?|lead|principal|staff|director|vice president|vp|chief|head of|supervisor|architect)\b/i;

const collector = await readFile(COLLECTOR_PATH, 'utf8');
const staticMarkers = [
  "const COMPANY = 'Csquare'",
  "const TENANT = 'CYX1000CYXT'",
  "const BOARD_ID = '6ce3c532-60ea-4691-8e59-5f0a86be31a9'",
  'JobBoardView/LoadSearchResults',
  'CandidateOpportunityDetail(',
  'years.some(year => year > 5)',
  "previousJobs.filter(job => clean(job?.company) !== COMPANY)",
  "source: 'Employer career site'",
  '--test-classifier',
  '--test-detail-parser'
];
const violations = [];
for (const marker of staticMarkers) {
  if (!collector.includes(marker)) violations.push(`collector contract missing ${marker}`);
}
if (collector.includes('hero-overrides.css')) violations.push('collector must not reference deleted hero-overrides.css');

if (process.argv.includes('--static-only')) {
  if (violations.length) {
    violations.forEach(item => console.error(`Csquare source guard: ${item}`));
    throw new Error(`Blocked ${violations.length} Csquare static source regression(s).`);
  }
  console.log('Csquare static source contract passed.');
  process.exit(0);
}

async function readArray(path, label) {
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { violations.push(`${label} could not be read (${error.message})`); return []; }
  if (!Array.isArray(value)) { violations.push(`${label} must be an array`); return []; }
  return value;
}

function validateUrl(job) {
  let parsed;
  try { parsed = new URL(String(job?.sourceUrl || '')); }
  catch { violations.push(`${job?.id || '(missing id)'} has an invalid source URL`); return; }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== EXPECTED_HOST) {
    violations.push(`${job?.id || '(missing id)'} must point to the official Csquare UKG host`);
    return;
  }
  if (!parsed.pathname.toLowerCase().startsWith(EXPECTED_PREFIX)) {
    violations.push(`${job?.id || '(missing id)'} points to the wrong UKG tenant or board path`);
  }
  const opportunityId = String(parsed.searchParams.get('opportunityId') || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(opportunityId)) {
    violations.push(`${job?.id || '(missing id)'} is missing a valid UKG opportunityId`);
  }
}

function validateJob(job, context) {
  const id = String(job?.id || '').trim();
  const title = String(job?.title || '').trim();
  const location = String(job?.location || '').trim();
  if (String(job?.company || '').trim() !== COMPANY) violations.push(`${context}: ${id || '(missing id)'} belongs to another company`);
  if (!/^ukg-csquare-[0-9a-f-]{36}$/i.test(id)) violations.push(`${context}: ${id || '(missing id)'} has an invalid Csquare id`);
  if (!title) violations.push(`${context}: ${id || '(missing id)'} has no title`);
  if (seniorTitlePattern.test(title)) violations.push(`${context}: ${id || '(missing id)'} leaked a senior title (${title})`);
  if (!ALLOWED_TYPES.has(String(job?.type || ''))) violations.push(`${context}: ${id || '(missing id)'} has unsupported type ${job?.type}`);
  if (!ALLOWED_EXPERIENCE.has(String(job?.experience || ''))) violations.push(`${context}: ${id || '(missing id)'} has unsupported experience ${job?.experience}`);
  const state = location.match(/,\s*([A-Z]{2})$/)?.[1];
  if (!state || !STATE_CODES.has(state)) violations.push(`${context}: ${id || '(missing id)'} lacks a confident U.S. city/state location (${location || 'blank'})`);
  if (job?.active !== true || job?.demo === true) violations.push(`${context}: ${id || '(missing id)'} must be active and non-demo`);
  if (String(job?.source || '') !== 'Employer career site') violations.push(`${context}: ${id || '(missing id)'} must identify the employer career site`);
  validateUrl(job);
}

const snapshot = await readArray(SNAPSHOT_PATH, 'Csquare snapshot');
const jobs = await readArray(JOBS_PATH, 'Public jobs feed');
const ids = new Set();
const urls = new Set();
for (const job of snapshot) {
  validateJob(job, 'snapshot');
  if (ids.has(job.id)) violations.push(`snapshot duplicate id ${job.id}`);
  if (urls.has(job.sourceUrl)) violations.push(`snapshot duplicate URL ${job.sourceUrl}`);
  ids.add(job.id);
  urls.add(job.sourceUrl);
}

const publicCsquare = jobs.filter(job => String(job?.company || '').trim() === COMPANY);
for (const job of publicCsquare) validateJob(job, 'public feed');
const snapshotIds = new Set(snapshot.map(job => job.id));
const publicIds = new Set(publicCsquare.map(job => job.id));
for (const id of snapshotIds) if (!publicIds.has(id)) violations.push(`authoritative snapshot role ${id} is missing from public feed`);
for (const id of publicIds) if (!snapshotIds.has(id)) violations.push(`public Csquare role ${id} is not present in the authoritative snapshot`);

if (violations.length) {
  violations.forEach(item => console.error(`Csquare source guard: ${item}`));
  throw new Error(`Blocked ${violations.length} Csquare source regression(s).`);
}
console.log(`Csquare source guard passed: ${snapshot.length} authoritative role(s), ${publicCsquare.length} public role(s), exact publication parity.`);
