import { readFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/tierpoint-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'TierPoint';
const SOURCE = 'Employer career site';
const HOST = 'careers-tierpoint.icims.com';
const ALLOWED_TYPES = new Set(['entry-level']);
const ALLOWED_EXPERIENCE = new Set(['no-experience', '0-2-years', '2-5-years']);

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function normalizeSnapshot(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray(value.jobs)) return value.jobs;
  throw new Error(`${SNAPSHOT_PATH} must contain a job array or an object with a jobs array.`);
}

function normalizedUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    return url.href;
  } catch {
    return '';
  }
}

function requisitionFromId(value) {
  return clean(value).match(/^icims-tierpoint-(\d+)$/i)?.[1] || '';
}

function assertOfficialRole(job, where) {
  if (clean(job?.company) !== COMPANY) throw new Error(`${where} contains a non-TierPoint role.`);
  if (clean(job?.source) !== SOURCE) throw new Error(`${where} role ${clean(job?.id) || '(missing id)'} is not labeled as ${SOURCE}.`);

  const requisition = requisitionFromId(job?.id);
  if (!requisition) throw new Error(`${where} role has an invalid TierPoint requisition id: ${clean(job?.id) || '(missing)'}.`);
  if (!clean(job?.title) || !clean(job?.location)) throw new Error(`${where} role ${job.id} is missing title or location.`);
  if (!ALLOWED_TYPES.has(clean(job?.type))) throw new Error(`${where} role ${job.id} has unsupported type ${clean(job?.type) || '(missing)'}.`);
  if (!ALLOWED_EXPERIENCE.has(clean(job?.experience))) throw new Error(`${where} role ${job.id} has unsupported experience ${clean(job?.experience) || '(missing)'}.`);
  if (job?.active !== true || job?.demo === true) throw new Error(`${where} role ${job.id} is not a live production role.`);

  const sourceUrl = normalizedUrl(job?.sourceUrl);
  if (!sourceUrl) throw new Error(`${where} role ${job.id} has an invalid source URL.`);
  const url = new URL(sourceUrl);
  if (url.protocol !== 'https:' || url.hostname !== HOST) {
    throw new Error(`${where} role ${job.id} does not point to TierPoint's official iCIMS career host.`);
  }
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
    sourceUrl: normalizedUrl(job?.sourceUrl),
    pay: clean(job?.pay),
    salaryMin: job?.salaryMin ?? null,
    salaryMax: job?.salaryMax ?? null,
    salarySortMax: job?.salarySortMax ?? null
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

const snapshotRoles = normalizeSnapshot(snapshotRaw).filter(job => clean(job?.company) === COMPANY);
const publicRoles = jobs.filter(job => clean(job?.company) === COMPANY);
const sourceStatus = status.tierPoint || {};

if (!snapshotRoles.length && !publicRoles.length) {
  console.log('TierPoint snapshot guard passed: no TierPoint roles are currently published.');
  process.exit(0);
}

if (Number(sourceStatus.qualifyingRoles) !== snapshotRoles.length) {
  throw new Error(`TierPoint collector-status count drift: status=${sourceStatus.qualifyingRoles ?? '(missing)'}, snapshot=${snapshotRoles.length}.`);
}
if (sourceStatus.sourceHealthy === true && sourceStatus.usedPreviousSnapshot === true) {
  throw new Error('TierPoint status cannot be healthy while reporting previous-snapshot fallback use.');
}
if (sourceStatus.sourceHealthy === false && sourceStatus.usedPreviousSnapshot !== true) {
  throw new Error('TierPoint status reports an unhealthy source without declaring previous-snapshot fallback use.');
}

const snapshotById = new Map();
const snapshotUrls = new Set();
for (const job of snapshotRoles) {
  assertOfficialRole(job, 'TierPoint snapshot');
  if (snapshotById.has(job.id)) throw new Error(`TierPoint snapshot has duplicate requisition ${job.id}.`);
  const url = normalizedUrl(job.sourceUrl);
  if (snapshotUrls.has(url)) throw new Error(`TierPoint snapshot has duplicate source URL ${url}.`);
  snapshotById.set(job.id, job);
  snapshotUrls.add(url);
}

const publicById = new Map();
const publicUrls = new Set();
for (const job of publicRoles) {
  assertOfficialRole(job, 'Public feed');
  if (publicById.has(job.id)) throw new Error(`Public feed has duplicate TierPoint requisition ${job.id}.`);
  const url = normalizedUrl(job.sourceUrl);
  if (publicUrls.has(url)) throw new Error(`Public feed has duplicate TierPoint source URL ${url}.`);
  publicById.set(job.id, job);
  publicUrls.add(url);
}

if (publicById.size !== snapshotById.size) {
  throw new Error(`TierPoint snapshot/public-feed count drift: ${snapshotById.size} snapshot role(s), ${publicById.size} public role(s).`);
}

for (const [id, snapshotJob] of snapshotById) {
  const publicJob = publicById.get(id);
  if (!publicJob) throw new Error(`TierPoint snapshot requisition ${id} is missing from the public feed.`);
  const expected = parityFields(snapshotJob);
  const actual = parityFields(publicJob);
  for (const field of Object.keys(expected)) {
    if (actual[field] !== expected[field]) {
      throw new Error(`TierPoint requisition ${id} ${field} drift: snapshot=${JSON.stringify(expected[field])}, public=${JSON.stringify(actual[field])}.`);
    }
  }
}

console.log(`TierPoint snapshot guard passed: ${snapshotRoles.length} employer-direct requisition(s) with exact public-feed parity.`);
