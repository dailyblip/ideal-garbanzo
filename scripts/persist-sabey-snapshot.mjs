import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const SNAPSHOT_PATH = 'data/sabey-jobs.json';
const COMPANY = 'Sabey Data Centers';

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

let snapshot = [];
try {
  snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
  if (!Array.isArray(snapshot)) throw new Error('snapshot is not an array');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const currentSabey = jobs.filter(isSabey);
let effectiveSabey = currentSabey;

if (source.sourceHealthy) {
  await writeFile(SNAPSHOT_PATH, JSON.stringify(currentSabey, null, 2) + '\n');
} else if (snapshot.length) {
  effectiveSabey = snapshot;
  const withoutSabey = jobs.filter(job => !isSabey(job));
  const existingUrls = new Set(withoutSabey.map(job => String(job?.sourceUrl || '')).filter(Boolean));
  const existingIdentities = new Set(withoutSabey.map(identity));
  for (const job of snapshot) {
    const key = identity(job);
    if ((job?.sourceUrl && existingUrls.has(job.sourceUrl)) || existingIdentities.has(key)) continue;
    withoutSabey.push(job);
    if (job?.sourceUrl) existingUrls.add(job.sourceUrl);
    existingIdentities.add(key);
  }
  await writeFile(JOBS_PATH, JSON.stringify(withoutSabey, null, 2) + '\n');
  status.jobs = withoutSabey.length;
}

status.sabeyCareers.snapshotRoles = effectiveSabey.length;
status.sabeyCareers.snapshotRestored = source.sourceHealthy ? 0 : effectiveSabey.length;
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

if (source.sourceHealthy) {
  console.log(`Sabey snapshot refreshed with ${currentSabey.length} verified role(s).`);
} else if (snapshot.length) {
  console.warn(`Sabey source was unhealthy; restored ${snapshot.length} role(s) from the last verified snapshot.`);
} else {
  console.warn('Sabey source was unhealthy and no prior verified snapshot was available.');
}
