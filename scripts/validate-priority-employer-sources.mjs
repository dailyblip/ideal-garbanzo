import { readFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';

// Priority operators should enter the public feed only through their own career
// systems. This guard prevents a future collector/merge change from quietly
// replacing employer-direct links with job-board or aggregator URLs.
const officialHostsByCompany = new Map([
  ['Amazon Web Services', new Set(['amazon.jobs', 'www.amazon.jobs'])],
  ['Google', new Set(['www.google.com'])],
  ['Microsoft', new Set(['apply.careers.microsoft.com'])],
  ['Meta', new Set(['metacareers.com', 'www.metacareers.com'])],
  ['Oracle', new Set(['eeho.fa.us2.oraclecloud.com'])],
  ['Equinix', new Set(['careers.equinix.com'])],
  ['Digital Realty', new Set(['hdep.fa.us2.oraclecloud.com'])],
  ['CoreSite', new Set(['jobs.coresite.com'])],
  ['Iron Mountain', new Set(['ironmountain.wd5.myworkdayjobs.com'])],
  ['Vantage Data Centers', new Set(['vantagedc.wd1.myworkdayjobs.com'])],
  ['QTS Data Centers', new Set(['qtsdatacenters.wd5.myworkdayjobs.com'])],
  ['CyrusOne', new Set(['cyrusone.wd1.myworkdayjobs.com'])],
  ['STACK Infrastructure', new Set(['stackinfra.wd108.myworkdayjobs.com'])],
  ['NTT Global Data Centers', new Set(['nttglobaldatacenters.wd501.myworkdayjobs.com'])],
  ['Aligned Data Centers', new Set(['aligneddc.wd12.myworkdayjobs.com'])]
]);

// Oracle and Digital Realty both use Oracle Recruiting Cloud, but on different
// tenants. Protect their dedicated snapshots independently so a generic
// oraclecloud.com reconciliation rule cannot silently delete another employer's
// records. Allow some post-collector QA attrition; block only severe divergence.
const protectedSnapshots = [
  { company: 'Oracle', path: 'data/oracle-jobs.json' },
  { company: 'Digital Realty', path: 'data/digital-realty-jobs.json' }
];

// The six major Workday operators share one snapshot. Protect each employer
// independently so one reconciliation mistake cannot erase STACK, NTT, Aligned,
// Vantage, QTS, or CyrusOne while the aggregate source still looks healthy.
const protectedMajorWorkdayCompanies = [
  'Vantage Data Centers',
  'QTS Data Centers',
  'CyrusOne',
  'STACK Infrastructure',
  'NTT Global Data Centers',
  'Aligned Data Centers'
];

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

function confidentUsLocation(value = '') {
  const text = String(value || '').trim();
  if (!text) return false;
  const lower = text.toLowerCase().replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ');
  if (/\b(?:united states|usa|u\.s\.a\.|u\.s\.)\b/i.test(text)) return true;
  if (usStateNames.some(state => new RegExp(`\\b${state.replace(/ /g, '\\s+')}\\b`, 'i').test(lower))) return true;
  const abbreviationMatch = text.match(/,\s*([A-Z]{2})(?:\b|\s|$)/);
  return Boolean(abbreviationMatch && usStateAbbreviations.has(abbreviationMatch[1]));
}

const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
if (!Array.isArray(jobs) || jobs.length === 0) throw new Error('Priority-source guard requires a non-empty jobs.json array.');

const counts = new Map();
const violations = [];
for (const job of jobs) {
  const company = String(job?.company || '').trim();
  const allowedHosts = officialHostsByCompany.get(company);
  if (!allowedHosts) continue;

  counts.set(company, (counts.get(company) || 0) + 1);
  let parsed;
  try { parsed = new URL(String(job?.sourceUrl || '')); }
  catch {
    violations.push(`${company}: ${job?.id || '(missing id)'} has an invalid source URL`);
    continue;
  }

  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || !allowedHosts.has(host)) {
    violations.push(`${company}: ${job?.id || '(missing id)'} points to non-official host ${host || '(missing host)'}`);
  }
}

for (const { company, path } of protectedSnapshots) {
  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    violations.push(`${company}: dedicated snapshot ${path} could not be read (${error.message})`);
    continue;
  }
  if (!Array.isArray(snapshot)) {
    violations.push(`${company}: dedicated snapshot ${path} is not an array`);
    continue;
  }
  const foreign = snapshot.filter(job => String(job?.company || '').trim() !== company);
  if (foreign.length) {
    violations.push(`${company}: dedicated snapshot contains ${foreign.length} record(s) owned by another company`);
  }

  const snapshotCount = snapshot.length;
  const publicCount = counts.get(company) || 0;
  if (snapshotCount >= 3 && publicCount === 0) {
    violations.push(`${company}: ${snapshotCount} dedicated snapshot roles collapsed to zero in the public feed`);
  } else if (snapshotCount >= 8 && publicCount < Math.ceil(snapshotCount * 0.40)) {
    violations.push(`${company}: public feed retained only ${publicCount}/${snapshotCount} dedicated snapshot roles`);
  }
}

let majorSnapshot = [];
try {
  majorSnapshot = JSON.parse(await readFile('data/major-jobs.json', 'utf8'));
  if (!Array.isArray(majorSnapshot)) {
    violations.push('Major Workday snapshot data/major-jobs.json is not an array');
    majorSnapshot = [];
  }
} catch (error) {
  violations.push(`Major Workday snapshot data/major-jobs.json could not be read (${error.message})`);
}

for (const company of protectedMajorWorkdayCompanies) {
  const companySnapshot = majorSnapshot.filter(job => String(job?.company || '').trim() === company);
  const usSnapshot = companySnapshot.filter(job => confidentUsLocation(job?.location));
  const publicCount = counts.get(company) || 0;

  // Hiring can legitimately reach zero. Only enforce retention when the shared
  // snapshot itself contains a meaningful number of confidently U.S. roles.
  if (usSnapshot.length >= 3 && publicCount === 0) {
    violations.push(`${company}: ${usSnapshot.length} U.S. roles in the major Workday snapshot collapsed to zero in the public feed`);
  } else if (usSnapshot.length >= 8 && publicCount < Math.ceil(usSnapshot.length * 0.40)) {
    violations.push(`${company}: public feed retained only ${publicCount}/${usSnapshot.length} confidently U.S. major Workday roles`);
  }
}

if (violations.length) {
  for (const violation of violations) console.error(`Priority-source violation: ${violation}`);
  throw new Error(`Blocked ${violations.length} priority-employer source or snapshot integrity violation(s).`);
}

const represented = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
const representedCompanies = represented.length;
const priorityJobs = represented.reduce((sum, [, count]) => sum + count, 0);

// Do not require every operator to have a live opening every day; hiring can
// legitimately reach zero. A broad collapse, however, should not pass silently.
if (representedCompanies < 6) {
  throw new Error(`Priority-employer coverage collapsed to ${representedCompanies} represented operators; expected at least 6 before deployment.`);
}

console.log(`Priority employer source guard passed: ${priorityJobs} jobs from ${representedCompanies}/${officialHostsByCompany.size} priority operators use employer-direct career URLs.`);
for (const [company, count] of represented) console.log(`  ${company}: ${count}`);
