import { readFile } from 'node:fs/promises';

const SNAPSHOT_PATH = 'data/microsoft-jobs.json';
const COMPANY = 'Microsoft';
const OFFICIAL_HOST = 'apply.careers.microsoft.com';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

let snapshot;
try {
  snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
} catch (error) {
  if (error?.code === 'ENOENT') {
    console.warn('Microsoft verified snapshot has not been created yet; validation will become active after the next healthy Microsoft refresh.');
    process.exit(0);
  }
  throw error;
}

if (!snapshot || !Array.isArray(snapshot.jobs) || !snapshot.jobs.length) {
  throw new Error('Microsoft snapshot must contain at least one verified job.');
}
const verifiedAt = Date.parse(snapshot.verifiedAt);
const expiresAt = Date.parse(snapshot.expiresAt);
if (!Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt) || expiresAt <= verifiedAt) {
  throw new Error('Microsoft snapshot verification timestamps are invalid.');
}
if (expiresAt - verifiedAt > 8 * 24 * 60 * 60 * 1000) {
  throw new Error('Microsoft snapshot fallback window exceeds the allowed short-term recovery period.');
}

const ids = new Set();
const urls = new Set();
for (const job of snapshot.jobs) {
  if (!job || typeof job !== 'object') throw new Error('Microsoft snapshot contains a non-object role.');
  if (clean(job.company) !== COMPANY) throw new Error(`Microsoft snapshot contains unexpected company ${job.company || '(missing)'}.`);
  if (!clean(job.id) || ids.has(job.id)) throw new Error(`Microsoft snapshot contains a missing or duplicate job id: ${job.id || '(missing)'}`);
  ids.add(job.id);
  let url;
  try { url = new URL(clean(job.sourceUrl)); }
  catch { throw new Error(`Microsoft snapshot contains an invalid URL for ${job.id}.`); }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== OFFICIAL_HOST) {
    throw new Error(`Microsoft snapshot contains a non-official URL for ${job.id}: ${url.hostname || '(missing host)'}`);
  }
  if (urls.has(url.href)) throw new Error(`Microsoft snapshot contains duplicate URL ${url.href}.`);
  urls.add(url.href);
  if (!['internship', 'apprenticeship', 'trainee', 'entry-level'].includes(job.type)) throw new Error(`Microsoft snapshot has unsupported type ${job.type || '(missing)'}.`);
  if (!['no-experience', '0-2-years', '2-5-years'].includes(job.experience)) throw new Error(`Microsoft snapshot has unsupported experience ${job.experience || '(missing)'}.`);
}

if (Date.now() > expiresAt) {
  console.warn(`Microsoft snapshot is structurally valid but expired at ${snapshot.expiresAt}; fallback restoration is disabled until a fresh direct-source refresh.`);
} else {
  console.log(`Microsoft snapshot validation passed: ${snapshot.jobs.length} employer-direct roles, recoverable through ${snapshot.expiresAt}.`);
}
