import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const MAJOR_PATH = 'data/major-jobs.json';
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
const majorSnapshot = dedupe(await readJson(MAJOR_PATH));
if (!majorSnapshot.length) throw new Error('Refusing to reconcile an empty major-employer snapshot.');

for (const job of majorSnapshot) {
  if (!majorCompanies.has(clean(job.company))) {
    throw new Error(`Unexpected company in ${MAJOR_PATH}: ${clean(job.company) || '(missing company)'}`);
  }
}

const oldMajor = jobs.filter(job => majorCompanies.has(clean(job?.company)));
const nonMajor = jobs.filter(job => !majorCompanies.has(clean(job?.company)));
const currentKeys = new Set(majorSnapshot.map(job => clean(job.id) || clean(job.sourceUrl) || identity(job)));
const staleRemoved = oldMajor.filter(job => !currentKeys.has(clean(job.id) || clean(job.sourceUrl) || identity(job))).length;

const merged = dedupe([...nonMajor, ...majorSnapshot]);
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

await writeFile(JOBS_PATH, JSON.stringify(merged, null, 2) + '\n');
console.log(`Reconciled ${majorSnapshot.length} authoritative major-employer jobs into the feed; removed ${staleRemoved} stale major-employer records.`);
