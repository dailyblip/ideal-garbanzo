import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const SNAPSHOT_PATH = 'data/sabey-jobs.json';
const COMPANY = 'Sabey Data Centers';
const MAX_SNAPSHOT_AGE_MS = 96 * 60 * 60 * 1000;

const isSabey = job => String(job?.company || '').trim() === COMPANY;
const identity = job => [job?.company, job?.title, job?.location]
  .map(value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())
  .join('|');

const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
if (!Array.isArray(jobs)) throw new Error('jobs.json must contain an array');

let status = {};
try { status = JSON.parse(await readFile(STATUS_PATH, 'utf8')); } catch {}
const source = status?.sabeyCareers;
if (!source || typeof source.sourceHealthy !== 'boolean') {
  throw new Error('Sabey snapshot persistence requires sabeyCareers source health from the collector.');
}

let snapshotJobs = [];
let snapshotVerifiedAt = null;
try {
  const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
  if (Array.isArray(snapshot)) {
    snapshotJobs = snapshot;
  } else if (snapshot && typeof snapshot === 'object' && Array.isArray(snapshot.jobs)) {
    snapshotJobs = snapshot.jobs;
    snapshotVerifiedAt = snapshot.verifiedAt || null;
  } else {
    throw new Error('snapshot must be a job array or an object with a jobs array');
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const now = Date.now();
const verifiedAtMs = snapshotVerifiedAt ? Date.parse(snapshotVerifiedAt) : NaN;
const snapshotAgeMs = Number.isFinite(verifiedAtMs) ? now - verifiedAtMs : Infinity;
const snapshotFresh = snapshotJobs.length > 0
  && snapshotAgeMs >= 0
  && snapshotAgeMs <= MAX_SNAPSHOT_AGE_MS;

const currentSabey = jobs.filter(isSabey);
let effectiveSabey = currentSabey;
let snapshotRestored = 0;
let removedExpiredFallback = 0;

if (source.sourceHealthy) {
  const verifiedAt = new Date(now).toISOString();
  await writeFile(SNAPSHOT_PATH, JSON.stringify({ verifiedAt, jobs: currentSabey }, null, 2) + '\n');
  snapshotVerifiedAt = verifiedAt;
} else {
  const withoutSabey = jobs.filter(job => !isSabey(job));

  if (snapshotFresh) {
    effectiveSabey = snapshotJobs;
    const existingUrls = new Set(withoutSabey.map(job => String(job?.sourceUrl || '')).filter(Boolean));
    const existingIdentities = new Set(withoutSabey.map(identity));
    for (const job of snapshotJobs) {
      const key = identity(job);
      if ((job?.sourceUrl && existingUrls.has(job.sourceUrl)) || existingIdentities.has(key)) continue;
      withoutSabey.push(job);
      if (job?.sourceUrl) existingUrls.add(job.sourceUrl);
      existingIdentities.add(key);
    }
    snapshotRestored = snapshotJobs.length;
  } else {
    effectiveSabey = [];
    removedExpiredFallback = currentSabey.length;
  }

  await writeFile(JOBS_PATH, JSON.stringify(withoutSabey, null, 2) + '\n');
  status.jobs = withoutSabey.length;
}

status.sabeyCareers.snapshotRoles = effectiveSabey.length;
status.sabeyCareers.snapshotRestored = snapshotRestored;
status.sabeyCareers.snapshotVerifiedAt = snapshotVerifiedAt;
status.sabeyCareers.snapshotFresh = source.sourceHealthy ? true : snapshotFresh;
status.sabeyCareers.snapshotMaxAgeHours = MAX_SNAPSHOT_AGE_MS / (60 * 60 * 1000);
status.sabeyCareers.snapshotAgeHours = Number.isFinite(snapshotAgeMs)
  ? Math.round((snapshotAgeMs / (60 * 60 * 1000)) * 10) / 10
  : null;
status.sabeyCareers.removedExpiredFallback = removedExpiredFallback;
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

if (source.sourceHealthy) {
  console.log(`Sabey snapshot refreshed with ${currentSabey.length} verified role(s).`);
} else if (snapshotFresh) {
  console.warn(`Sabey source was unhealthy; restored ${snapshotJobs.length} role(s) from a snapshot no older than 96 hours.`);
} else if (currentSabey.length) {
  console.warn(`Sabey source was unhealthy and the fallback snapshot was missing or older than 96 hours; removed ${currentSabey.length} preserved role(s) instead of publishing stale jobs.`);
} else {
  console.warn('Sabey source was unhealthy and no fresh fallback snapshot was available.');
}
