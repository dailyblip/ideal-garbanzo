import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const MAJOR_PATH = 'data/major-jobs.json';
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

function clearlyOutsideUnitedStates(job) {
  const text = ` ${normalize(`${job?.location || ''} ${job?.sourceUrl || ''}`)} `;
  return clearlyForeignLocationTerms.some(term => term && text.includes(` ${term} `));
}

async function readJson(path) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(value)) throw new Error(`${path} must contain an array.`);
  return value;
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
const majorSnapshot = rawMajorSnapshot.filter(job => !clearlyOutsideUnitedStates(job));
if (!majorSnapshot.length) throw new Error('Refusing to reconcile an empty U.S. major-employer snapshot.');

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

await writeFile(MAJOR_PATH, JSON.stringify(majorSnapshot, null, 2) + '\n');
await writeFile(JOBS_PATH, JSON.stringify(merged, null, 2) + '\n');
console.log(`Reconciled ${majorSnapshot.length} U.S. major-employer jobs into the feed; filtered ${foreignMajor.length} clearly non-U.S. records and removed ${staleRemoved} stale records${preserveExisting ? ' while preserving normalized current records' : ''}.`);
