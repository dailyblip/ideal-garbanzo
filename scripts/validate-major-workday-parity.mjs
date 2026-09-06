import { readFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const MAJOR_PATH = 'data/major-jobs.json';
const STATUS_PATH = 'data/collector-status.json';

const officialHosts = new Map([
  ['Vantage Data Centers', 'vantagedc.wd1.myworkdayjobs.com'],
  ['QTS Data Centers', 'qtsdatacenters.wd5.myworkdayjobs.com'],
  ['CyrusOne', 'cyrusone.wd1.myworkdayjobs.com'],
  ['STACK Infrastructure', 'stackinfra.wd108.myworkdayjobs.com'],
  ['NTT Global Data Centers', 'nttglobaldatacenters.wd501.myworkdayjobs.com'],
  ['Aligned Data Centers', 'aligneddc.wd12.myworkdayjobs.com']
]);

const usStateNames = [
  'alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','florida','georgia',
  'hawaii','idaho','illinois','indiana','iowa','kansas','kentucky','louisiana','maine','maryland','massachusetts',
  'michigan','minnesota','mississippi','missouri','montana','nebraska','nevada','new hampshire','new jersey',
  'new mexico','new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island',
  'south carolina','south dakota','tennessee','texas','utah','vermont','virginia','washington','west virginia',
  'wisconsin','wyoming','district of columbia'
];
const usStateAbbreviations = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI',
  'MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT',
  'VT','VA','WA','WV','WI','WY','DC'
]);

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function confidentUsLocation(value = '') {
  const text = clean(value);
  if (!text) return false;
  const lower = text.toLowerCase().replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ');
  if (/\b(?:united states|usa|u\.s\.a\.|u\.s\.)\b/i.test(text)) return true;
  if (usStateNames.some(state => new RegExp(`\\b${state.replace(/ /g, '\\s+')}\\b`, 'i').test(lower))) return true;
  const abbreviationMatch = text.match(/,\s*([A-Z]{2})(?:\b|\s|$)/);
  return Boolean(abbreviationMatch && usStateAbbreviations.has(abbreviationMatch[1]));
}

function validateOfficialUrl(job, context, violations) {
  const company = clean(job?.company);
  const expectedHost = officialHosts.get(company);
  if (!expectedHost) {
    violations.push(`${context}: unexpected company ${company || '(missing company)'}`);
    return '';
  }

  let parsed;
  try {
    parsed = new URL(clean(job?.sourceUrl));
  } catch {
    violations.push(`${context}: ${clean(job?.id) || '(missing id)'} has an invalid source URL`);
    return '';
  }

  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== expectedHost) {
    violations.push(`${context}: ${clean(job?.id) || '(missing id)'} points to ${parsed.hostname || '(missing host)'} instead of ${expectedHost}`);
  }
  return parsed.href;
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (!value) continue;
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

const violations = [];
const jobs = await readJson(JOBS_PATH);
const majorSnapshot = await readJson(MAJOR_PATH);
const status = await readJson(STATUS_PATH);

if (!Array.isArray(jobs) || !jobs.length) violations.push(`${JOBS_PATH} must contain a non-empty job array`);
if (!Array.isArray(majorSnapshot) || !majorSnapshot.length) violations.push(`${MAJOR_PATH} must contain a non-empty major-employer array`);

const majorCompanies = new Set(officialHosts.keys());
const publicMajor = Array.isArray(jobs) ? jobs.filter(job => majorCompanies.has(clean(job?.company))) : [];

for (const job of Array.isArray(majorSnapshot) ? majorSnapshot : []) {
  const company = clean(job?.company);
  validateOfficialUrl(job, `${company || 'Major Workday'} snapshot`, violations);
  if (!confidentUsLocation(job?.location)) {
    violations.push(`${company || 'Major Workday'} snapshot: ${clean(job?.id) || '(missing id)'} is not confidently U.S. (${clean(job?.location) || 'missing location'})`);
  }
}

for (const job of publicMajor) {
  const company = clean(job?.company);
  validateOfficialUrl(job, `${company} public feed`, violations);
}

for (const company of officialHosts.keys()) {
  const snapshotJobs = (Array.isArray(majorSnapshot) ? majorSnapshot : []).filter(job => clean(job?.company) === company);
  const publicJobs = publicMajor.filter(job => clean(job?.company) === company);
  const snapshotUrls = snapshotJobs.map(job => clean(job?.sourceUrl));
  const publicUrls = publicJobs.map(job => clean(job?.sourceUrl));
  const snapshotUrlSet = new Set(snapshotUrls.filter(Boolean));
  const publicUrlSet = new Set(publicUrls.filter(Boolean));

  const duplicateSnapshotUrls = duplicateValues(snapshotUrls);
  const duplicatePublicUrls = duplicateValues(publicUrls);
  if (duplicateSnapshotUrls.length) violations.push(`${company}: major snapshot contains ${duplicateSnapshotUrls.length} duplicate source URL(s)`);
  if (duplicatePublicUrls.length) violations.push(`${company}: public feed contains ${duplicatePublicUrls.length} duplicate source URL(s)`);

  if (snapshotJobs.length !== publicJobs.length) {
    violations.push(`${company}: major snapshot/public feed count mismatch (${snapshotJobs.length} snapshot vs ${publicJobs.length} public)`);
  }

  const missingFromPublic = snapshotJobs.filter(job => !publicUrlSet.has(clean(job?.sourceUrl)));
  const unexpectedInPublic = publicJobs.filter(job => !snapshotUrlSet.has(clean(job?.sourceUrl)));
  if (missingFromPublic.length) {
    violations.push(`${company}: ${missingFromPublic.length}/${snapshotJobs.length} authoritative major snapshot role(s) are missing from the public feed`);
  }
  if (unexpectedInPublic.length) {
    violations.push(`${company}: public feed contains ${unexpectedInPublic.length} role(s) not present in the authoritative major snapshot`);
  }
}

if (Array.isArray(majorSnapshot) && publicMajor.length !== majorSnapshot.length) {
  violations.push(`Major Workday portfolio count mismatch (${majorSnapshot.length} snapshot vs ${publicMajor.length} public)`);
}

const reconciledCount = Number(status?.majorSources?.reconciliation?.publishedUsJobs);
if (Number.isFinite(reconciledCount) && Array.isArray(majorSnapshot) && reconciledCount !== majorSnapshot.length) {
  violations.push(`Collector status reports ${reconciledCount} reconciled U.S. major roles but ${MAJOR_PATH} contains ${majorSnapshot.length}`);
}

if (violations.length) {
  for (const violation of violations) console.error(`Major Workday parity violation: ${violation}`);
  throw new Error(`Blocked ${violations.length} major Workday snapshot/public-feed integrity violation(s).`);
}

console.log(`Major Workday parity guard passed: ${majorSnapshot.length} authoritative U.S. roles match the public feed exactly.`);
for (const company of officialHosts.keys()) {
  const count = majorSnapshot.filter(job => clean(job?.company) === company).length;
  console.log(`  ${company}: ${count}`);
}
