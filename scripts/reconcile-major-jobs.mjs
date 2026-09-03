import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const MAJOR_PATH = 'data/major-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const preserveExisting = process.argv.includes('--preserve-existing');
const majorCompanies = new Set([
  'Vantage Data Centers',
  'QTS Data Centers',
  'CyrusOne',
  'STACK Infrastructure',
  'NTT Global Data Centers',
  'Aligned Data Centers'
]);

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalize = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const identity = job => [job?.company, job?.title, job?.location].map(normalize).join('|');
const jobKey = job => clean(job?.id) || clean(job?.sourceUrl) || identity(job);
const clearlyForeignLocationTerms = [
  'malaysia', 'india', 'indonesia', 'japan', 'taiwan', 'thailand', 'germany', 'england', 'united kingdom', 'uk',
  'wales', 'netherlands', 'switzerland', 'ireland', 'canada', 'hong kong', 'china', 'singapore', 'australia', 'france',
  'spain', 'italy', 'poland', 'sweden', 'norway', 'denmark', 'belgium', 'austria', 'portugal',
  'brazil', 'mexico', 'south africa', 'united arab emirates',
  'montreal quebec', 'toronto on', 'frankfurt', 'amsterdam', 'ams1', 'eemshaven', 'bengaluru', 'noida',
  'navi mumbai', 'mumbai', 'osaka', 'taipei', 'cyberjaya', 'munich', 'zurich', 'jakarta', 'chon buri'
].map(normalize);
const usStateNames = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware',
  'district of columbia', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa',
  'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota',
  'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey',
  'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon',
  'pennsylvania', 'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah',
  'vermont', 'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming'
];
const usStateCodes = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM',
  'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA',
  'WV', 'WI', 'WY'
]);

function clearlyOutsideUnitedStates(job) {
  const text = ` ${normalize(`${job?.location || ''} ${job?.sourceUrl || ''}`)} `;
  return clearlyForeignLocationTerms.some(term => term && text.includes(` ${term} `));
}

function confidentlyInsideUnitedStates(job) {
  const location = clean(job?.location);
  if (!location) return false;
  if (/\b(?:united states(?: of america)?|u\.s\.a\.?|usa)\b/i.test(location)) return true;

  const normalizedLocation = normalize(location);
  if (/\bus\s+(?:al|ak|az|ar|ca|co|ct|de|dc|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy)\b/.test(normalizedLocation)) return true;

  const parts = location.split(/[,|/]/).map(part => clean(part)).filter(Boolean);
  if (parts.some(part => usStateCodes.has(part.toUpperCase()))) return true;

  return usStateNames.some(state =>
    normalizedLocation === state ||
    normalizedLocation.startsWith(`${state} `) ||
    normalizedLocation.endsWith(` ${state}`) ||
    normalizedLocation.includes(` ${state} `)
  );
}

async function readJson(path) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(value)) throw new Error(`${path} must contain an array.`);
  return value;
}

async function readJsonObject(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function dedupe(jobs) {
  const ids = new Set();
  const urls = new Set();
  const identities = new Set();
  const out = [];
  for (const job of jobs) {
    if (!job || typeof job !== 'object') continue;
    const id = clean(job.id);
    const url = clean(job.sourceUrl);
    const key = identity(job);
    if ((id && ids.has(id)) || (url && urls.has(url)) || (key && identities.has(key))) continue;
    if (id) ids.add(id);
    if (url) urls.add(url);
    if (key) identities.add(key);
    out.push(job);
  }
  return out;
}

const jobs = await readJson(JOBS_PATH);
const rawMajorSnapshot = dedupe(await readJson(MAJOR_PATH));
const foreignMajor = rawMajorSnapshot.filter(clearlyOutsideUnitedStates);
const unresolvedMajor = rawMajorSnapshot.filter(job => !clearlyOutsideUnitedStates(job) && !confidentlyInsideUnitedStates(job));
const majorSnapshot = rawMajorSnapshot.filter(job => !clearlyOutsideUnitedStates(job) && confidentlyInsideUnitedStates(job));
if (!majorSnapshot.length) throw new Error('Refusing to reconcile an empty confidently U.S. major-employer snapshot.');

for (const job of majorSnapshot) {
  if (!majorCompanies.has(clean(job.company))) {
    throw new Error(`Unexpected company in ${MAJOR_PATH}: ${clean(job.company) || '(missing company)'}`);
  }
}

const oldMajor = jobs.filter(job => majorCompanies.has(clean(job?.company)));
const nonMajor = jobs.filter(job => !majorCompanies.has(clean(job?.company)));
const currentKeys = new Set(majorSnapshot.map(jobKey));
const staleRemoved = oldMajor.filter(job => !currentKeys.has(jobKey(job))).length;

let authoritativeMajor = majorSnapshot;
if (preserveExisting) {
  const retained = oldMajor.filter(job => currentKeys.has(jobKey(job)));
  const retainedKeys = new Set(retained.map(jobKey));
  const newJobs = majorSnapshot.filter(job => !retainedKeys.has(jobKey(job)));
  authoritativeMajor = dedupe([...retained, ...newJobs]);
}

const merged = dedupe([...nonMajor, ...authoritativeMajor]);
const now = Date.now();
for (const job of merged) {
  const posted = job.postedAt ? new Date(job.postedAt).getTime() : NaN;
  job.postedHours = Number.isFinite(posted) ? Math.max(0, Math.round((now - posted) / 36e5)) : 9999;
}
merged.sort((a, b) => (a.postedHours ?? 9999) - (b.postedHours ?? 9999));

const reconciledMajor = merged.filter(job => majorCompanies.has(clean(job?.company)));
if (reconciledMajor.length !== majorSnapshot.length) {
  throw new Error(`Major-employer reconciliation mismatch: snapshot=${majorSnapshot.length}, feed=${reconciledMajor.length}.`);
}

const status = await readJsonObject(STATUS_PATH);
status.majorSources = {
  ...(status.majorSources || {}),
  reconciliation: {
    checkedAt: new Date().toISOString(),
    rawJobs: rawMajorSnapshot.length,
    publishedUsJobs: majorSnapshot.length,
    nonUsRemoved: foreignMajor.length,
    unresolvedLocationRemoved: unresolvedMajor.length,
    nonUsSamples: foreignMajor.slice(0, 8).map(job => ({ company: clean(job.company), title: clean(job.title), location: clean(job.location) })),
    unresolvedLocationSamples: unresolvedMajor.slice(0, 8).map(job => ({ company: clean(job.company), title: clean(job.title), location: clean(job.location) }))
  }
};

await writeFile(MAJOR_PATH, JSON.stringify(majorSnapshot, null, 2) + '\n');
await writeFile(JOBS_PATH, JSON.stringify(merged, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
console.log(`Reconciled ${majorSnapshot.length} confidently U.S. major-employer jobs into the feed; filtered ${foreignMajor.length} clearly non-U.S. records, removed ${unresolvedMajor.length} unresolved-location records, and removed ${staleRemoved} stale records${preserveExisting ? ' while preserving normalized current records' : ''}.`);
