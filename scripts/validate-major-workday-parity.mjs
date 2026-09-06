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

const clearlyForeignTerms = [
  'malaysia','india','indonesia','japan','taiwan','thailand','germany','england','united kingdom','wales',
  'netherlands','switzerland','ireland','canada','hong kong','china','singapore','australia','france','spain',
  'italy','poland','sweden','norway','denmark','belgium','austria','portugal','brazil','mexico','south africa',
  'united arab emirates','montreal quebec','toronto on','frankfurt','amsterdam','eemshaven','bengaluru','noida',
  'navi mumbai','mumbai','osaka','taipei','cyberjaya','munich','zurich','jakarta','chon buri','dagenham'
];

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalize = value => clean(value).toLowerCase().replace(/[-_/]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
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

function clearlyForeign(job) {
  const text = ` ${normalize(`${job?.location || ''} ${job?.sourceUrl || ''}`)} `;
  return clearlyForeignTerms.some(term => text.includes(` ${normalize(term)} `));
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
const reconciliation = status?.majorSources?.reconciliation;
const reconciledCount = Number(reconciliation?.publishedUsJobs);
const snapshotIsReconciled = Number.isFinite(reconciledCount) && reconciledCount === majorSnapshot.length;

for (const job of Array.isArray(majorSnapshot) ? majorSnapshot : []) {
  const company = clean(job?.company);
  validateOfficialUrl(job, `${company || 'Major Workday'} snapshot`, violations);
  if (snapshotIsReconciled && clearlyForeign(job)) {
    violations.push(`${company || 'Major Workday'} reconciled snapshot still contains a clearly non-U.S. role: ${clean(job?.id) || '(missing id)'}`);
  }
}

for (const job of publicMajor) {
  const company = clean(job?.company);
  validateOfficialUrl(job, `${company} public feed`, violations);
  if (clearlyForeign(job)) {
    violations.push(`${company} public feed contains a clearly non-U.S. role: ${clean(job?.id) || '(missing id)'}`);
  }
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

  // A public major-operator role must always be traceable to the employer's
  // major Workday snapshot. This catches downstream merge/recovery drift even
  // while the snapshot is still in its broader pre-reconciliation form.
  const unexpectedInPublic = publicJobs.filter(job => !snapshotUrlSet.has(clean(job?.sourceUrl)));
  if (unexpectedInPublic.length) {
    violations.push(`${company}: public feed contains ${unexpectedInPublic.length} role(s) missing from the major Workday snapshot`);
  }

  if (snapshotIsReconciled) {
    if (snapshotJobs.length !== publicJobs.length) {
      violations.push(`${company}: reconciled snapshot/public feed count mismatch (${snapshotJobs.length} snapshot vs ${publicJobs.length} public)`);
    }
    const missingFromPublic = snapshotJobs.filter(job => !publicUrlSet.has(clean(job?.sourceUrl)));
    if (missingFromPublic.length) {
      violations.push(`${company}: ${missingFromPublic.length}/${snapshotJobs.length} reconciled snapshot role(s) are missing from the public feed`);
    }
  } else if (snapshotJobs.length >= 3 && publicJobs.length === 0) {
    violations.push(`${company}: ${snapshotJobs.length} source roles collapsed to zero in the public feed`);
  }
}

if (snapshotIsReconciled && publicMajor.length !== majorSnapshot.length) {
  violations.push(`Reconciled major Workday portfolio count mismatch (${majorSnapshot.length} snapshot vs ${publicMajor.length} public)`);
}

if (Number.isFinite(reconciledCount) && reconciledCount > majorSnapshot.length) {
  violations.push(`Collector status reports ${reconciledCount} reconciled U.S. roles but ${MAJOR_PATH} contains only ${majorSnapshot.length}`);
}

if (violations.length) {
  for (const violation of violations) console.error(`Major Workday parity violation: ${violation}`);
  throw new Error(`Blocked ${violations.length} major Workday snapshot/public-feed integrity violation(s).`);
}

const mode = snapshotIsReconciled ? 'reconciled exact-parity' : 'raw snapshot coverage';
console.log(`Major Workday parity guard passed in ${mode} mode: ${publicMajor.length} public roles are employer-direct and traceable to ${majorSnapshot.length} snapshot roles.`);
for (const company of officialHosts.keys()) {
  const snapshotCount = majorSnapshot.filter(job => clean(job?.company) === company).length;
  const publicCount = publicMajor.filter(job => clean(job?.company) === company).length;
  console.log(`  ${company}: ${publicCount} public / ${snapshotCount} snapshot`);
}
