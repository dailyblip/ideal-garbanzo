import { readFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';

// Priority operators should enter the public feed only through their own career
// systems. This guard prevents a collector, fallback, or merge change from
// quietly replacing employer-direct links with job-board or aggregator URLs.
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
  ['Compass Datacenters', new Set(['compass-datacenters.breezy.hr'])],
  ['Flexential', new Set(['job-boards.greenhouse.io'])],
  ['T5 Data Centers', new Set(['jobs.lever.co'])],
  ['TierPoint', new Set(['careers-tierpoint.icims.com'])],
  ['Sabey Data Centers', new Set(['careers2-anothersource.icims.com'])],
  ['Novva Data Centers', new Set(['novva.com', 'www.novva.com'])],
  ['Vantage Data Centers', new Set(['vantagedc.wd1.myworkdayjobs.com'])],
  ['QTS Data Centers', new Set(['qtsdatacenters.wd5.myworkdayjobs.com'])],
  ['CyrusOne', new Set(['cyrusone.wd1.myworkdayjobs.com'])],
  ['STACK Infrastructure', new Set(['stackinfra.wd108.myworkdayjobs.com'])],
  ['NTT Global Data Centers', new Set(['nttglobaldatacenters.wd501.myworkdayjobs.com'])],
  ['Aligned Data Centers', new Set(['aligneddc.wd12.myworkdayjobs.com'])]
]);

// Dedicated employer snapshots are protected independently so a generic
// collector or reconciliation rule cannot silently erase a healthy source.
// Hyperscaler snapshots intentionally include a broader candidate set than the
// final mission-fit feed, so for those sources we guard against total collapse
// and source-host drift rather than requiring a fixed retention percentage.
const protectedSnapshots = [
  { company: 'Amazon Web Services', path: 'data/amazon-jobs.json', enforceRetentionRatio: false },
  { company: 'Google', path: 'data/google-jobs.json', enforceRetentionRatio: false },
  { company: 'Meta', path: 'data/meta-jobs.json', enforceRetentionRatio: false },
  { company: 'Oracle', path: 'data/oracle-jobs.json', enforceRetentionRatio: true },
  { company: 'Digital Realty', path: 'data/digital-realty-jobs.json', enforceRetentionRatio: true },
  { company: 'TierPoint', path: 'data/tierpoint-jobs.json', enforceRetentionRatio: true },
  { company: 'Sabey Data Centers', path: 'data/sabey-jobs.json', enforceRetentionRatio: true },
  { company: 'Novva Data Centers', path: 'data/novva-jobs.json', enforceRetentionRatio: true }
];

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

async function readArray(path, label, violations) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(value)) {
      violations.push(`${label}: ${path} is not an array`);
      return [];
    }
    return value;
  } catch (error) {
    violations.push(`${label}: ${path} could not be read (${error.message})`);
    return [];
  }
}

function checkOfficialSource(company, job, context, violations) {
  const allowedHosts = officialHostsByCompany.get(company);
  if (!allowedHosts) return;
  let parsed;
  try {
    parsed = new URL(String(job?.sourceUrl || ''));
  } catch {
    violations.push(`${context}: ${job?.id || '(missing id)'} has an invalid source URL`);
    return;
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || !allowedHosts.has(host)) {
    violations.push(`${context}: ${job?.id || '(missing id)'} points to non-official host ${host || '(missing host)'}`);
  }
}

const violations = [];
const jobs = await readArray(JOBS_PATH, 'Public feed', violations);
if (!jobs.length) violations.push('Priority-source guard requires a non-empty jobs.json array.');

const counts = new Map();
for (const job of jobs) {
  const company = String(job?.company || '').trim();
  if (!officialHostsByCompany.has(company)) continue;
  counts.set(company, (counts.get(company) || 0) + 1);
  checkOfficialSource(company, job, company, violations);
}

for (const { company, path, enforceRetentionRatio } of protectedSnapshots) {
  const snapshot = await readArray(path, company, violations);
  const foreign = snapshot.filter(job => String(job?.company || '').trim() !== company);
  if (foreign.length) violations.push(`${company}: dedicated snapshot contains ${foreign.length} record(s) owned by another company`);
  for (const job of snapshot) checkOfficialSource(company, job, `${company} snapshot`, violations);

  const snapshotCount = snapshot.length;
  const publicCount = counts.get(company) || 0;
  if (snapshotCount >= 3 && publicCount === 0) {
    violations.push(`${company}: ${snapshotCount} dedicated snapshot roles collapsed to zero in the public feed`);
  } else if (enforceRetentionRatio && snapshotCount >= 8 && publicCount < Math.ceil(snapshotCount * 0.40)) {
    violations.push(`${company}: public feed retained only ${publicCount}/${snapshotCount} dedicated snapshot roles`);
  }
}

const majorSnapshot = await readArray('data/major-jobs.json', 'Major Workday snapshot', violations);
for (const job of majorSnapshot) {
  const company = String(job?.company || '').trim();
  if (protectedMajorWorkdayCompanies.includes(company)) {
    checkOfficialSource(company, job, `${company} major snapshot`, violations);
  }
}

for (const company of protectedMajorWorkdayCompanies) {
  const companySnapshot = majorSnapshot.filter(job => String(job?.company || '').trim() === company);
  const usSnapshot = companySnapshot.filter(job => confidentUsLocation(job?.location));
  const publicCount = counts.get(company) || 0;
  if (usSnapshot.length >= 3 && publicCount === 0) {
    violations.push(`${company}: ${usSnapshot.length} U.S. roles in the major Workday snapshot collapsed to zero in the public feed`);
  } else if (usSnapshot.length >= 8 && publicCount < Math.ceil(usSnapshot.length * 0.40)) {
    violations.push(`${company}: public feed retained only ${publicCount}/${usSnapshot.length} confidently U.S. major Workday roles`);
  }
}

const represented = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
if (represented.length < 6) {
  violations.push(`Priority-employer coverage collapsed to ${represented.length} represented operators; expected at least 6 before deployment.`);
}

if (violations.length) {
  for (const violation of violations) console.error(`Priority-source violation: ${violation}`);
  throw new Error(`Blocked ${violations.length} priority-employer source or snapshot integrity violation(s).`);
}

const priorityJobs = represented.reduce((sum, [, count]) => sum + count, 0);
console.log(`Priority employer source guard passed: ${priorityJobs} jobs from ${represented.length}/${officialHostsByCompany.size} priority operators use employer-direct career URLs.`);
for (const [company, count] of represented) console.log(`  ${company}: ${count}`);
