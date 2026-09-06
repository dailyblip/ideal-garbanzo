import { readFile } from 'node:fs/promises';

const SNAPSHOT_PATH = 'data/microsoft-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'Microsoft';
const OFFICIAL_HOST = 'apply.careers.microsoft.com';
const MIN_PUBLIC_RETENTION = 0.80;

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' && fallback !== null) return fallback;
    throw error;
  }
}

let snapshot;
try {
  snapshot = await readJson(SNAPSHOT_PATH);
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

const jobs = await readJson(JOBS_PATH, []);
if (!Array.isArray(jobs)) throw new Error('data/jobs.json must contain an array.');
const publicMicrosoft = jobs.filter(job => clean(job?.company) === COMPANY);
const publicUrls = new Set(publicMicrosoft.map(job => clean(job?.sourceUrl)).filter(Boolean));

// The snapshot is mission-filtered, so a large downstream loss is not expected.
// Allow modest churn/dedupe, but stop deployment if most verified Microsoft
// roles disappear before the next direct-source refresh.
if (snapshot.jobs.length >= 8) {
  const minimumRetained = Math.ceil(snapshot.jobs.length * MIN_PUBLIC_RETENTION);
  if (publicMicrosoft.length < minimumRetained) {
    throw new Error(`Microsoft public feed retained only ${publicMicrosoft.length}/${snapshot.jobs.length} verified snapshot roles; expected at least ${minimumRetained}.`);
  }
}

const status = await readJson(STATUS_PATH, {});
const fallback = status?.microsoftDatacenter?.snapshotFallback || {};
if (fallback.active === true) {
  const fallbackExpiresAt = Date.parse(clean(fallback.expiresAt));
  const fallbackRoles = Number(fallback.roles || 0);
  if (!Number.isFinite(fallbackExpiresAt)) {
    throw new Error('Microsoft snapshot fallback is active without a valid expiry timestamp.');
  }
  if (Date.now() >= fallbackExpiresAt) {
    throw new Error(`Microsoft snapshot fallback is still active after its ${fallback.expiresAt} expiry.`);
  }
  if (fallbackRoles !== snapshot.jobs.length) {
    throw new Error(`Microsoft fallback metadata expects ${fallbackRoles} role(s), but the verified snapshot contains ${snapshot.jobs.length}.`);
  }
  if (publicMicrosoft.length !== fallbackRoles) {
    throw new Error(`Microsoft active fallback/public feed count mismatch (${fallbackRoles} restored vs ${publicMicrosoft.length} public).`);
  }
  const missingFallbackUrls = snapshot.jobs.filter(job => !publicUrls.has(clean(job.sourceUrl)));
  if (missingFallbackUrls.length) {
    throw new Error(`Microsoft active fallback lost ${missingFallbackUrls.length}/${snapshot.jobs.length} verified role URL(s) before deployment.`);
  }
}

if (Date.now() > expiresAt) {
  console.warn(`Microsoft snapshot is structurally valid but expired at ${snapshot.expiresAt}; fallback restoration is disabled until a fresh direct-source refresh.`);
} else {
  console.log(`Microsoft snapshot validation passed: ${snapshot.jobs.length} employer-direct roles, ${publicMicrosoft.length} public, recoverable through ${snapshot.expiresAt}.`);
}
if (fallback.active === true) {
  console.log(`Microsoft zero-collapse fallback integrity passed: ${publicMicrosoft.length}/${fallback.roles} restored roles remain public.`);
}
