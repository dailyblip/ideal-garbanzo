import { readFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const MAJOR_PATH = 'data/major-jobs.json';

const employers = new Map([
  ['Vantage Data Centers', { host: 'vantagedc.wd1.myworkdayjobs.com', prefix: 'workday-vantagedc-' }],
  ['QTS Data Centers', { host: 'qtsdatacenters.wd5.myworkdayjobs.com', prefix: 'workday-qtsdatacenters-' }],
  ['CyrusOne', { host: 'cyrusone.wd1.myworkdayjobs.com', prefix: 'workday-cyrusone-' }],
  ['STACK Infrastructure', { host: 'stackinfra.wd108.myworkdayjobs.com', prefix: 'workday-stackinfra-' }],
  ['NTT Global Data Centers', { host: 'nttglobaldatacenters.wd501.myworkdayjobs.com', prefix: 'workday-nttglobaldatacenters-' }],
  ['Aligned Data Centers', { host: 'aligneddc.wd12.myworkdayjobs.com', prefix: 'workday-aligneddc-' }]
]);

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function validateRecord(job, context) {
  const violations = [];
  const company = clean(job?.company);
  const config = employers.get(company);
  if (!config) return [`${context}: unexpected company ${company || '(missing company)'}`];

  const id = clean(job?.id);
  if (!id.startsWith(config.prefix) || id.length <= config.prefix.length) {
    violations.push(`${context}: ${id || '(missing id)'} does not use ${config.prefix}<requisition>`);
    return violations;
  }
  const requisition = id.slice(config.prefix.length);

  let url;
  try { url = new URL(clean(job?.sourceUrl)); }
  catch { return [...violations, `${context}: ${id} has an invalid source URL`]; }

  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== config.host) {
    violations.push(`${context}: ${id} points to ${url.hostname || '(missing host)'} instead of ${config.host}`);
  }

  let tail = url.pathname.split('/').filter(Boolean).at(-1) || '';
  try { tail = decodeURIComponent(tail); } catch {}
  const requisitionPattern = new RegExp(`_${escapeRegExp(requisition)}(?:-\\d+)?$`);
  if (!requisitionPattern.test(tail)) {
    violations.push(`${context}: ${id} does not match official Workday detail URL requisition`);
  }

  if (clean(job?.source) !== 'Employer career site') {
    violations.push(`${context}: ${id} has unexpected source label ${clean(job?.source) || '(missing)'}`);
  }
  if (job?.active !== true || job?.demo === true) {
    violations.push(`${context}: ${id} is not an active production role`);
  }
  return violations;
}

const regressions = [
  {
    job: { id: 'workday-cyrusone-R0007750', company: 'CyrusOne', source: 'Employer career site', sourceUrl: 'https://cyrusone.wd1.myworkdayjobs.com/en-US/CyrusOneCareerPortal/job/Whitney-TX/Critical-Environments-Operator-III_R0007750-1', active: true, demo: false },
    violations: 0
  },
  {
    job: { id: 'workday-nttglobaldatacenters-R-138957', company: 'NTT Global Data Centers', source: 'Employer career site', sourceUrl: 'https://nttglobaldatacenters.wd501.myworkdayjobs.com/en-US/External/job/Ashburn-Virginia/Data-Center-Technician-L1_R-138957-1', active: true, demo: false },
    violations: 0
  },
  {
    job: { id: 'workday-qtsdatacenters-R2026-9999', company: 'QTS Data Centers', source: 'Employer career site', sourceUrl: 'https://qtsdatacenters.wd5.myworkdayjobs.com/en-US/QTS/job/Ashburn-VA/Critical-Operations-Technician-I_R2026-1841', active: true, demo: false },
    violations: 1
  }
];
for (const testCase of regressions) {
  const actual = validateRecord(testCase.job, 'regression').length;
  if (actual !== testCase.violations) {
    throw new Error(`Major Workday requisition regression: expected ${testCase.violations} violation(s), got ${actual}.`);
  }
}

const [jobs, snapshot] = await Promise.all([
  readFile(JOBS_PATH, 'utf8').then(JSON.parse),
  readFile(MAJOR_PATH, 'utf8').then(JSON.parse)
]);
if (!Array.isArray(jobs) || !jobs.length) throw new Error(`${JOBS_PATH} must contain a non-empty job array.`);
if (!Array.isArray(snapshot) || !snapshot.length) throw new Error(`${MAJOR_PATH} must contain a non-empty major-employer array.`);

const publicMajor = jobs.filter(job => employers.has(clean(job?.company)));
const violations = [];
for (const job of snapshot) violations.push(...validateRecord(job, `${clean(job?.company) || 'Major Workday'} snapshot`));
for (const job of publicMajor) violations.push(...validateRecord(job, `${clean(job?.company) || 'Major Workday'} public feed`));

for (const company of employers.keys()) {
  const sourceJobs = snapshot.filter(job => clean(job?.company) === company);
  const publicJobs = publicMajor.filter(job => clean(job?.company) === company);
  const sourceIds = new Set();
  const sourceUrls = new Map();
  for (const job of sourceJobs) {
    const id = clean(job?.id);
    const url = clean(job?.sourceUrl);
    if (id && sourceIds.has(id)) violations.push(`${company}: duplicate authoritative requisition ID ${id}`);
    if (url && sourceUrls.has(url)) violations.push(`${company}: duplicate authoritative Workday URL ${url}`);
    if (id) sourceIds.add(id);
    if (url) sourceUrls.set(url, id);
  }
  for (const job of publicJobs) {
    const id = clean(job?.id);
    const url = clean(job?.sourceUrl);
    if (!sourceIds.has(id) || sourceUrls.get(url) !== id) {
      violations.push(`${company}: public requisition ${id || '(missing id)'} is not traceable to the same authoritative Workday requisition and URL`);
    }
  }
}

if (violations.length) {
  for (const violation of violations) console.error(`Major Workday requisition integrity violation: ${violation}`);
  throw new Error(`Blocked ${violations.length} major Workday requisition-integrity violation(s).`);
}

console.log(`Major Workday requisition-integrity guard passed: ${publicMajor.length} public cards and ${snapshot.length} authoritative snapshot roles retain canonical requisition IDs, official employer URLs, source labels, and production state.`);
