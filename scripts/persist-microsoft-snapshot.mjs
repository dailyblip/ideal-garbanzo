import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const SNAPSHOT_PATH = 'data/microsoft-jobs.json';
const COMPANY = 'Microsoft';
const OFFICIAL_HOST = 'apply.careers.microsoft.com';
const FALLBACK_DAYS = 7;

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const isMicrosoft = job => clean(job?.company) === COMPANY || /^https:\/\/apply\.careers\.microsoft\.com\//i.test(clean(job?.sourceUrl));

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

function validateJob(job) {
  if (!job || typeof job !== 'object') throw new Error('Microsoft snapshot contains a non-object job.');
  if (clean(job.company) !== COMPANY) throw new Error(`Microsoft snapshot contains an unexpected company: ${job.company || '(missing)'}`);
  let url;
  try { url = new URL(clean(job.sourceUrl)); }
  catch { throw new Error(`Microsoft snapshot contains an invalid source URL for ${job.id || '(missing id)'}.`); }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== OFFICIAL_HOST) {
    throw new Error(`Microsoft snapshot contains a non-official source URL for ${job.id || '(missing id)'}: ${url.hostname || '(missing host)'}`);
  }
  if (!['internship', 'apprenticeship', 'trainee', 'entry-level'].includes(job.type)) {
    throw new Error(`Microsoft snapshot contains unsupported type ${job.type || '(missing)'}.`);
  }
  if (!['no-experience', '0-2-years', '2-5-years'].includes(job.experience)) {
    throw new Error(`Microsoft snapshot contains unsupported experience ${job.experience || '(missing)'}.`);
  }
}

const jobs = await readJson(JOBS_PATH, null);
const status = await readJson(STATUS_PATH, {});
if (!Array.isArray(jobs)) throw new Error('data/jobs.json must contain an array.');

const microsoftStatus = status?.microsoftDatacenter || {};
const sourceHealthy = microsoftStatus.sourceHealthy === true && microsoftStatus.sourceMode !== 'retained-previous';
const microsoftJobs = jobs.filter(isMicrosoft).filter(job => clean(job.company) === COMPANY);

if (!sourceHealthy) {
  console.log('Microsoft direct source is not freshly healthy; preserved the existing verified snapshot unchanged.');
  process.exit(0);
}
if (!microsoftJobs.length) {
  throw new Error('Refused to overwrite the Microsoft snapshot with zero roles after a healthy source refresh.');
}

for (const job of microsoftJobs) validateJob(job);

const verifiedAt = new Date();
const expiresAt = new Date(verifiedAt.getTime() + FALLBACK_DAYS * 24 * 60 * 60 * 1000);
const snapshot = {
  verifiedAt: verifiedAt.toISOString(),
  expiresAt: expiresAt.toISOString(),
  officialSource: 'https://apply.careers.microsoft.com/careers',
  jobs: microsoftJobs
};

await writeFile(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n');

// A healthy employer-direct refresh supersedes any prior zero-collapse recovery.
// Persist that state explicitly so stale fallback metadata cannot remain active
// after Microsoft is reachable again.
const nextStatus = {
  ...status,
  microsoftDatacenter: {
    ...microsoftStatus,
    snapshotFallback: {
      active: false,
      verifiedAt: snapshot.verifiedAt,
      expiresAt: snapshot.expiresAt,
      roles: microsoftJobs.length,
      reason: 'Fresh employer-direct Microsoft refresh superseded zero-collapse recovery.'
    }
  }
};
await writeFile(STATUS_PATH, JSON.stringify(nextStatus, null, 2) + '\n');

console.log(`Persisted ${microsoftJobs.length} freshly verified Microsoft roles for zero-collapse recovery through ${snapshot.expiresAt}.`);
