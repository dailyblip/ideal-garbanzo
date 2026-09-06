import { readFile } from 'node:fs/promises';

const SNAPSHOT_PATH = 'data/microsoft-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'Microsoft';
const OFFICIAL_HOST = 'apply.careers.microsoft.com';
const MIN_PUBLIC_RETENTION = 0.80;

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalize = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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
for (const job of publicMicrosoft) {
  let url;
  try { url = new URL(clean(job?.sourceUrl)); }
  catch { throw new Error(`Microsoft public role ${job?.id || '(missing)'} has an invalid URL.`); }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== OFFICIAL_HOST) {
    throw new Error(`Microsoft public role ${job?.id || '(missing)'} is not employer-direct.`);
  }
}
const snapshotTitles = uniqueTitles(snapshot.jobs);
const publicTitles = uniqueTitles(publicMicrosoft);
const missingTitles = [...snapshotTitles].filter(title => !publicTitles.has(title));

// The public feed intentionally collapses same-employer/same-title postings
// across locations and shifts. Protect unique role coverage rather than raw
// requisition count so source integrity and a clean feed can coexist.
if (snapshotTitles.size >= 8) {
  const minimumRetained = Math.ceil(snapshotTitles.size * MIN_PUBLIC_RETENTION);
  if (publicTitles.size < minimumRetained) {
    throw new Error(`Microsoft public feed retained only ${publicTitles.size}/${snapshotTitles.size} unique verified role titles; expected at least ${minimumRetained}.`);
  }
}
if (missingTitles.length > Math.floor(snapshotTitles.size * (1 - MIN_PUBLIC_RETENTION))) {
  throw new Error(`Microsoft public feed is missing ${missingTitles.length}/${snapshotTitles.size} unique verified role title(s).`);
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
  if (missingTitles.length) {
    throw new Error(`Microsoft active fallback lost ${missingTitles.length}/${snapshotTitles.size} unique verified role title(s) before deployment.`);
  }
}

if (Date.now() > expiresAt) {
  console.warn(`Microsoft snapshot is structurally valid but expired at ${snapshot.expiresAt}; fallback restoration is disabled until a fresh direct-source refresh.`);
} else {
  console.log(`Microsoft snapshot validation passed: ${snapshot.jobs.length} employer-direct requisitions represented by ${publicTitles.size} clean public role title(s), recoverable through ${snapshot.expiresAt}.`);
}
if (fallback.active === true) {
  console.log(`Microsoft zero-collapse fallback integrity passed: ${publicTitles.size}/${snapshotTitles.size} unique verified role titles remain public.`);
}
