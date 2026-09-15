import { readFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/sabey-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'Sabey Data Centers';
const SOURCE = 'Official Sabey careers';
const MAX_AGE_HOURS = 168;
const MAX_FUTURE_SKEW_MINUTES = 10;
const ALLOWED_TYPES = new Set(['entry-level', 'internship', 'apprenticeship', 'trainee']);
const ALLOWED_EXPERIENCE = new Set(['no-experience', '0-2-years', '2-5-years']);

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function normalizeSnapshot(value) {
  if (Array.isArray(value)) return { verifiedAt: null, jobs: value };
  if (value && typeof value === 'object' && Array.isArray(value.jobs)) {
    return { verifiedAt: clean(value.verifiedAt) || null, jobs: value.jobs };
  }
  throw new Error(`${SNAPSHOT_PATH} must contain a job array or an object with a jobs array.`);
}

function normalizedUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

function assertOfficialRole(job, where) {
  if (clean(job?.company) !== COMPANY) throw new Error(`${where} contains a non-Sabey role.`);
  if (clean(job?.source) !== SOURCE) throw new Error(`${where} role ${clean(job?.id) || '(missing id)'} is not labeled as ${SOURCE}.`);
  if (!/^sabey-\d+$/i.test(clean(job?.id))) throw new Error(`${where} role has an invalid Sabey requisition id: ${clean(job?.id) || '(missing)'}.`);
  if (!clean(job?.title) || !clean(job?.location)) throw new Error(`${where} role ${job.id} is missing title or location.`);
  if (!ALLOWED_TYPES.has(clean(job?.type))) throw new Error(`${where} role ${job.id} has unsupported type ${clean(job?.type) || '(missing)'}.`);
  if (!ALLOWED_EXPERIENCE.has(clean(job?.experience))) throw new Error(`${where} role ${job.id} has unsupported experience ${clean(job?.experience) || '(missing)'}.`);
  if (job?.active !== true || job?.demo === true) throw new Error(`${where} role ${job.id} is not a live production role.`);

  const sourceUrl = normalizedUrl(job?.sourceUrl);
  if (!sourceUrl) throw new Error(`${where} role ${job.id} has an invalid source URL.`);
  const url = new URL(sourceUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'careers2-anothersource.icims.com') {
    throw new Error(`${where} role ${job.id} does not point to Sabey's verified iCIMS recruiter host.`);
  }
  const requisition = clean(job.id).replace(/^sabey-/i, '');
  if (!new RegExp(`^/jobs/${requisition}/`, 'i').test(url.pathname) || !/\/job\/?$/i.test(url.pathname)) {
    throw new Error(`${where} role ${job.id} source URL does not match its requisition id.`);
  }
}

function parityFields(job) {
  return {
    title: clean(job?.title),
    location: clean(job?.location),
    type: clean(job?.type),
    experience: clean(job?.experience),
    source: clean(job?.source),
    sourceUrl: normalizedUrl(job?.sourceUrl)
  };
}

const [jobs, snapshotRaw, status] = await Promise.all([
  readJson(JOBS_PATH),
  readJson(SNAPSHOT_PATH),
  readJson(STATUS_PATH)
]);

if (!Array.isArray(jobs)) throw new Error(`${JOBS_PATH} must contain an array.`);
if (!status || typeof status !== 'object' || Array.isArray(status)) {
  throw new Error(`${STATUS_PATH} must contain an object.`);
}

const snapshot = normalizeSnapshot(snapshotRaw);
const publicRoles = jobs.filter(job => clean(job?.company) === COMPANY);
const snapshotRoles = snapshot.jobs.filter(job => clean(job?.company) === COMPANY);
const source = status.sabeyCareers || {};
const fallback = source.fallbackFreshness || {};
const configuredMaxAge = Number(source.snapshotMaxAgeHours ?? fallback.maxAgeHours);
if (Number.isFinite(configuredMaxAge) && configuredMaxAge > MAX_AGE_HOURS) {
  throw new Error(`Sabey fallback policy cannot exceed ${MAX_AGE_HOURS} hours (found ${configuredMaxAge}).`);
}

if (fallback.expired === true && (publicRoles.length || snapshotRoles.length)) {
  throw new Error(`Sabey fallback is marked expired but ${publicRoles.length} public and ${snapshotRoles.length} snapshot role(s) remain.`);
}

if (!publicRoles.length && !snapshotRoles.length) {
  console.log('Sabey snapshot guard passed: no Sabey roles are currently published.');
  process.exit(0);
}

if (!snapshot.verifiedAt) throw new Error('Sabey roles are published without snapshot verification evidence.');
const verifiedMs = Date.parse(snapshot.verifiedAt);
if (!Number.isFinite(verifiedMs)) throw new Error(`Sabey snapshot verification timestamp is invalid: ${snapshot.verifiedAt}.`);
const ageMs = Date.now() - verifiedMs;
if (ageMs < -(MAX_FUTURE_SKEW_MINUTES * 60 * 1000)) {
  throw new Error(`Sabey snapshot verification is unexpectedly future-dated: ${snapshot.verifiedAt}.`);
}
const ageHours = Math.max(0, ageMs / 36e5);
if (ageHours >= MAX_AGE_HOURS) {
  throw new Error(`Sabey employer-direct snapshot is stale (${Math.floor(ageHours)}h old; maximum ${MAX_AGE_HOURS}h).`);
}

const statusVerifiedAt = clean(source.snapshotVerifiedAt);
if (statusVerifiedAt && statusVerifiedAt !== snapshot.verifiedAt) {
  throw new Error(`Sabey status verification timestamp ${statusVerifiedAt} does not match snapshot ${snapshot.verifiedAt}.`);
}
if (source.snapshotFresh === false) throw new Error('Sabey roles are published while collector status marks the snapshot stale.');

const snapshotById = new Map();
for (const job of snapshotRoles) {
  assertOfficialRole(job, 'Sabey snapshot');
  if (snapshotById.has(job.id)) throw new Error(`Sabey snapshot has duplicate requisition ${job.id}.`);
  snapshotById.set(job.id, job);
}

const publicById = new Map();
for (const job of publicRoles) {
  assertOfficialRole(job, 'Public feed');
  if (publicById.has(job.id)) throw new Error(`Public feed has duplicate Sabey requisition ${job.id}.`);
  publicById.set(job.id, job);
}

if (publicById.size !== snapshotById.size) {
  throw new Error(`Sabey snapshot/public-feed count drift: ${snapshotById.size} snapshot role(s), ${publicById.size} public role(s).`);
}

for (const [id, snapshotJob] of snapshotById) {
  const publicJob = publicById.get(id);
  if (!publicJob) throw new Error(`Sabey snapshot requisition ${id} is missing from the public feed.`);
  const expected = parityFields(snapshotJob);
  const actual = parityFields(publicJob);
  for (const field of Object.keys(expected)) {
    if (actual[field] !== expected[field]) {
      throw new Error(`Sabey requisition ${id} ${field} drift: snapshot=${JSON.stringify(expected[field])}, public=${JSON.stringify(actual[field])}.`);
    }
  }
}

console.log(
  `Sabey snapshot guard passed: ${snapshotRoles.length} verified requisition(s), exact public-feed parity, ` +
  `${ageHours.toFixed(1)}h since official verification (limit ${MAX_AGE_HOURS}h).`
);
