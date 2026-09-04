import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const SNAPSHOT_PATH = 'data/microsoft-jobs.json';
const COMPANY = 'Microsoft';
const OFFICIAL_HOST = 'apply.careers.microsoft.com';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalize = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const isMicrosoft = job => clean(job?.company) === COMPANY || /^https:\/\/apply\.careers\.microsoft\.com\//i.test(clean(job?.sourceUrl));

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

function validateSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.jobs) || !snapshot.jobs.length) {
    throw new Error('Microsoft verified snapshot must contain at least one job.');
  }
  const verifiedAt = Date.parse(snapshot.verifiedAt);
  const expiresAt = Date.parse(snapshot.expiresAt);
  if (!Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt) || expiresAt <= verifiedAt) {
    throw new Error('Microsoft verified snapshot has invalid verification timestamps.');
  }
  for (const job of snapshot.jobs) {
    if (clean(job.company) !== COMPANY) throw new Error(`Unexpected Microsoft fallback company: ${job.company || '(missing)'}`);
    let url;
    try { url = new URL(clean(job.sourceUrl)); }
    catch { throw new Error(`Microsoft fallback has an invalid source URL for ${job.id || '(missing id)'}.`); }
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== OFFICIAL_HOST) {
      throw new Error(`Microsoft fallback role is not employer-direct: ${job.sourceUrl || '(missing)'}`);
    }
    if (!['internship', 'apprenticeship', 'trainee', 'entry-level'].includes(job.type)) throw new Error(`Unsupported Microsoft fallback type: ${job.type}`);
    if (!['no-experience', '0-2-years', '2-5-years'].includes(job.experience)) throw new Error(`Unsupported Microsoft fallback experience: ${job.experience}`);
  }
  return { verifiedAt, expiresAt };
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
    const identity = [job.company, job.title, job.location].map(normalize).join('|');
    if ((id && ids.has(id)) || (url && urls.has(url)) || identities.has(identity)) continue;
    if (id) ids.add(id);
    if (url) urls.add(url);
    identities.add(identity);
    out.push(job);
  }
  return out;
}

const jobs = await readJson(JOBS_PATH, null);
if (!Array.isArray(jobs)) throw new Error('data/jobs.json must contain an array.');

const currentMicrosoft = jobs.filter(isMicrosoft);
if (currentMicrosoft.length) {
  console.log(`Microsoft public feed already contains ${currentMicrosoft.length} role(s); zero-collapse fallback not needed.`);
  process.exit(0);
}

const snapshot = await readJson(SNAPSHOT_PATH, null);
if (!snapshot) {
  console.log('No Microsoft verified snapshot exists yet; zero-collapse fallback skipped.');
  process.exit(0);
}

const { expiresAt } = validateSnapshot(snapshot);
if (Date.now() > expiresAt) {
  console.warn(`Microsoft verified snapshot expired at ${snapshot.expiresAt}; stale roles were not restored.`);
  process.exit(0);
}

const restored = snapshot.jobs.map(job => ({ ...job, active: true, demo: false }));
const merged = dedupe([...jobs.filter(job => !isMicrosoft(job)), ...restored]);
const countsByType = merged.reduce((acc, job) => { acc[job.type] = (acc[job.type] || 0) + 1; return acc; }, {});
const countsByExperience = merged.reduce((acc, job) => { acc[job.experience] = (acc[job.experience] || 0) + 1; return acc; }, {});
const status = await readJson(STATUS_PATH, {});

await writeFile(JOBS_PATH, JSON.stringify(merged, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify({
  ...status,
  updatedAt: new Date().toISOString(),
  jobs: merged.length,
  countsByType,
  countsByExperience,
  microsoftDatacenter: {
    ...(status.microsoftDatacenter || {}),
    snapshotFallback: {
      active: true,
      verifiedAt: snapshot.verifiedAt,
      expiresAt: snapshot.expiresAt,
      roles: restored.length,
      reason: 'Recovered only after Microsoft roles collapsed to zero before a fresh direct-source refresh.'
    }
  }
}, null, 2) + '\n');

console.log(`Recovered ${restored.length} Microsoft roles from the fresh employer-direct snapshot after a zero-role collapse.`);
