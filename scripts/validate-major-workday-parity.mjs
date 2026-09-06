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
function canonicalTitle(job) {
  let title = clean(job?.title);
  const location = normalize(job?.location);
  const locationTokens = new Set(location.split(' ').filter(token => token.length > 1));
  const tailBelongsToLocation = tail => {
    const tokens = normalize(tail).split(' ').filter(token => token.length > 1);
    return tokens.length > 0 && tokens.every(token => locationTokens.has(token));
  };
  title = title.replace(/^\s*\d{2,5}\s*[-–—]\s*/u, '');
  title = title.replace(/\s+[-–—]\s+([^|]+)$/u, (full, tail) => tailBelongsToLocation(tail) ? '' : full);
  title = title.replace(/\s*\(([^)]+)\)\s*$/u, (full, tail) => tailBelongsToLocation(tail) ? '' : full);
  title = title.replace(/\s*[-–—,:()]?\s*(?:day|night|overnight|weekend)\s+shift(?:\s*\d+)?\s*$/iu, '');
  return normalize(title);
}
const uniqueTitles = records => new Set((records || []).map(canonicalTitle).filter(Boolean));

async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }

function validateOfficialUrl(job, context, violations) {
  const company = clean(job?.company);
  const expectedHost = officialHosts.get(company);
  if (!expectedHost) { violations.push(`${context}: unexpected company ${company || '(missing company)'}`); return ''; }
  let parsed;
  try { parsed = new URL(clean(job?.sourceUrl)); } catch { violations.push(`${context}: ${clean(job?.id) || '(missing id)'} has an invalid source URL`); return ''; }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== expectedHost) violations.push(`${context}: ${clean(job?.id) || '(missing id)'} points to ${parsed.hostname || '(missing host)'} instead of ${expectedHost}`);
  return parsed.href;
}

function clearlyForeign(job) {
  const text = ` ${normalize(`${job?.location || ''} ${job?.sourceUrl || ''}`)} `;
  return clearlyForeignTerms.some(term => text.includes(` ${normalize(term)} `));
}

function duplicateValues(values) {
  const seen = new Set(), duplicates = new Set();
  for (const value of values) { if (!value) continue; if (seen.has(value)) duplicates.add(value); seen.add(value); }
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
  if (snapshotIsReconciled && clearlyForeign(job)) violations.push(`${company || 'Major Workday'} reconciled snapshot still contains a clearly non-U.S. role: ${clean(job?.id) || '(missing id)'}`);
}
for (const job of publicMajor) {
  const company = clean(job?.company);
  validateOfficialUrl(job, `${company} public feed`, violations);
  if (clearlyForeign(job)) violations.push(`${company} public feed contains a clearly non-U.S. role: ${clean(job?.id) || '(missing id)'}`);
}

for (const company of officialHosts.keys()) {
  const snapshotJobs = (Array.isArray(majorSnapshot) ? majorSnapshot : []).filter(job => clean(job?.company) === company);
  const publicJobs = publicMajor.filter(job => clean(job?.company) === company);
  const snapshotUrls = snapshotJobs.map(job => clean(job?.sourceUrl));
  const publicUrls = publicJobs.map(job => clean(job?.sourceUrl));
  const snapshotUrlSet = new Set(snapshotUrls.filter(Boolean));
  const duplicateSnapshotUrls = duplicateValues(snapshotUrls);
  const duplicatePublicUrls = duplicateValues(publicUrls);
  if (duplicateSnapshotUrls.length) violations.push(`${company}: major snapshot contains ${duplicateSnapshotUrls.length} duplicate source URL(s)`);
  if (duplicatePublicUrls.length) violations.push(`${company}: public feed contains ${duplicatePublicUrls.length} duplicate source URL(s)`);

  // Every public representative card must still trace to an authoritative
  // employer snapshot requisition.
  const unexpectedInPublic = publicJobs.filter(job => !snapshotUrlSet.has(clean(job?.sourceUrl)));
  if (unexpectedInPublic.length) violations.push(`${company}: public feed contains ${unexpectedInPublic.length} role(s) missing from the major Workday snapshot`);

  const snapshotTitles = uniqueTitles(snapshotJobs);
  const publicTitles = uniqueTitles(publicJobs);
  if (snapshotIsReconciled) {
    const missingTitles = [...snapshotTitles].filter(title => !publicTitles.has(title));
    const unexpectedTitles = [...publicTitles].filter(title => !snapshotTitles.has(title));
    if (missingTitles.length) violations.push(`${company}: ${missingTitles.length}/${snapshotTitles.size} reconciled unique role title(s) are missing from the public feed`);
    if (unexpectedTitles.length) violations.push(`${company}: public feed contains ${unexpectedTitles.length} unique role title(s) not represented in the reconciled snapshot`);
  } else if (snapshotTitles.size >= 3 && publicTitles.size === 0) {
    violations.push(`${company}: ${snapshotTitles.size} unique source role titles collapsed to zero in the public feed`);
  }
}

if (snapshotIsReconciled) {
  const snapshotPortfolioTitles = new Set();
  const publicPortfolioTitles = new Set();
  for (const company of officialHosts.keys()) {
    for (const title of uniqueTitles(majorSnapshot.filter(job => clean(job?.company) === company))) snapshotPortfolioTitles.add(`${company}|${title}`);
    for (const title of uniqueTitles(publicMajor.filter(job => clean(job?.company) === company))) publicPortfolioTitles.add(`${company}|${title}`);
  }
  const missing = [...snapshotPortfolioTitles].filter(key => !publicPortfolioTitles.has(key));
  if (missing.length) violations.push(`Reconciled major Workday portfolio is missing ${missing.length}/${snapshotPortfolioTitles.size} unique company/title combination(s) in the public feed`);
}
if (Number.isFinite(reconciledCount) && reconciledCount > majorSnapshot.length) violations.push(`Collector status reports ${reconciledCount} reconciled U.S. roles but ${MAJOR_PATH} contains only ${majorSnapshot.length}`);

if (violations.length) {
  for (const violation of violations) console.error(`Major Workday parity violation: ${violation}`);
  throw new Error(`Blocked ${violations.length} major Workday snapshot/public-feed integrity violation(s).`);
}
const mode = snapshotIsReconciled ? 'reconciled unique-title parity' : 'raw snapshot coverage';
console.log(`Major Workday parity guard passed in ${mode} mode: ${publicMajor.length} clean public cards are employer-direct and traceable to ${majorSnapshot.length} snapshot requisitions.`);
for (const company of officialHosts.keys()) {
  const snapshotCount = uniqueTitles(majorSnapshot.filter(job => clean(job?.company) === company)).size;
  const publicCount = uniqueTitles(publicMajor.filter(job => clean(job?.company) === company)).size;
  console.log(`  ${company}: ${publicCount} public titles / ${snapshotCount} snapshot titles`);
}
