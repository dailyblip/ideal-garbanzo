import { readFile } from 'node:fs/promises';

const COMPANY = 'EdgeConneX';
const SNAPSHOT_PATH = 'data/edgeconnex-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const HOST = 'ats.rippling.com';
const PATH_RE = /^\/edgeconnex\/jobs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i;
const LOCATION_RE = /^[A-Za-z][A-Za-z .'-]+,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)$/;
const SENIOR_RE = /\b(?:senior|sr\.?|lead|principal|staff|chief|manager|director|vice president|vp|head of|supervisor|superintendent|foreman)\b/i;

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function validateOfficialUrl(job, context, violations) {
  let url;
  try {
    url = new URL(String(job?.sourceUrl || ''));
  } catch {
    violations.push(`${context}: ${job?.id || '(missing id)'} has an invalid source URL`);
    return;
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== HOST || !PATH_RE.test(url.pathname)) {
    violations.push(`${context}: ${job?.id || '(missing id)'} is not an official EdgeConneX Rippling job URL`);
  }
}

const violations = [];
const snapshot = await readJson(SNAPSHOT_PATH);
const jobs = await readJson(JOBS_PATH);
const status = await readJson(STATUS_PATH);

if (!Array.isArray(snapshot)) violations.push(`${SNAPSHOT_PATH} must be an array`);
if (!Array.isArray(jobs)) violations.push(`${JOBS_PATH} must be an array`);

const snapshotJobs = Array.isArray(snapshot) ? snapshot : [];
const publicJobs = Array.isArray(jobs) ? jobs.filter(job => String(job?.company || '').trim() === COMPANY) : [];

for (const [label, records] of [['snapshot', snapshotJobs], ['public feed', publicJobs]]) {
  const seenIds = new Set();
  const seenUrls = new Set();
  for (const job of records) {
    if (String(job?.company || '').trim() !== COMPANY) violations.push(`${label}: foreign company record ${job?.id || '(missing id)'}`);
    if (!/^edgeconnex-[0-9a-f-]{36}$/i.test(String(job?.id || ''))) violations.push(`${label}: malformed EdgeConneX id ${job?.id || '(missing id)'}`);
    if (!LOCATION_RE.test(String(job?.location || '').trim())) violations.push(`${label}: unnormalized U.S. location for ${job?.id || '(missing id)'}: ${job?.location || '(missing)'}`);
    if (SENIOR_RE.test(String(job?.title || ''))) violations.push(`${label}: senior-role noise leaked into EdgeConneX feed: ${job?.title}`);
    if (!['0-2-years', '2-5-years'].includes(String(job?.experience || ''))) violations.push(`${label}: invalid early-career experience bucket for ${job?.id || '(missing id)'}`);
    if (job?.active !== true || job?.demo === true) violations.push(`${label}: inactive/demo EdgeConneX record ${job?.id || '(missing id)'}`);
    if (String(job?.source || '') !== 'Official EdgeConneX careers') violations.push(`${label}: non-direct source label for ${job?.id || '(missing id)'}`);
    validateOfficialUrl(job, label, violations);

    const id = String(job?.id || '');
    const sourceUrl = String(job?.sourceUrl || '');
    if (id && seenIds.has(id)) violations.push(`${label}: duplicate id ${id}`);
    if (sourceUrl && seenUrls.has(sourceUrl)) violations.push(`${label}: duplicate source URL ${sourceUrl}`);
    if (id) seenIds.add(id);
    if (sourceUrl) seenUrls.add(sourceUrl);
  }
}

const snapshotUrls = new Set(snapshotJobs.map(job => String(job?.sourceUrl || '')).filter(Boolean));
const publicUrls = new Set(publicJobs.map(job => String(job?.sourceUrl || '')).filter(Boolean));
const missingFromPublic = [...snapshotUrls].filter(url => !publicUrls.has(url));
const unexpectedPublic = [...publicUrls].filter(url => !snapshotUrls.has(url));
if (missingFromPublic.length) violations.push(`public feed is missing ${missingFromPublic.length} authoritative EdgeConneX snapshot role(s)`);
if (unexpectedPublic.length) violations.push(`public feed contains ${unexpectedPublic.length} EdgeConneX role(s) outside the authoritative snapshot`);

const health = status?.edgeconnexCareers;
if (!health || typeof health !== 'object') {
  violations.push('collector-status.json is missing edgeconnexCareers source health');
} else {
  if (health.provider !== 'rippling') violations.push(`collector status reports unexpected EdgeConneX provider: ${health.provider || '(missing)'}`);
  if (health.sourceHealthy === true && Number(health.qualifyingRoles) !== snapshotJobs.length) {
    violations.push(`healthy EdgeConneX source reports ${health.qualifyingRoles} qualifying role(s) but snapshot contains ${snapshotJobs.length}`);
  }
  if (health.sourceHealthy === false && snapshotJobs.length > 0 && Number(health.preservedPrevious || 0) !== snapshotJobs.length) {
    violations.push(`unhealthy EdgeConneX source did not report preservation of all ${snapshotJobs.length} snapshot role(s)`);
  }
}

if (violations.length) {
  console.error('EdgeConneX snapshot guard failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`EdgeConneX snapshot guard passed: ${snapshotJobs.length} authoritative role(s), exact public-feed parity, official Rippling URLs only.`);
