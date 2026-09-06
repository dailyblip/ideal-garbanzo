import { readFile } from 'node:fs/promises';

const SNAPSHOT_PATH = 'data/flexential-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'Flexential';
const allowedTypes = new Set(['internship', 'apprenticeship', 'trainee', 'entry-level']);
const allowedExperience = new Set(['no-experience', '0-2-years', '2-5-years']);
const missionTitlePattern = /\b(?:data\s*center\s+technician(?:\s+[i1-3v]+)?|critical\s+infrastructure\s+engineer(?:\s+[i1-3v]+)?|critical\s+facilities\s+(?:technician|engineer)|data\s*center\s+operations\s+technician|facilities\s+technician)\b/i;
const excludedTitlePattern = /\b(?:talent community|senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|superintendent|foreman)\b/i;
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
if (!Array.isArray(snapshot)) throw new Error('Flexential snapshot must contain an array.');
if (!Array.isArray(jobs)) throw new Error('Aggregate jobs feed must contain an array.');

const aggregate = jobs.filter(job => clean(job?.company) === COMPANY);
if (aggregate.length !== snapshot.length) {
  throw new Error(`Flexential aggregate/snapshot mismatch: ${aggregate.length} aggregate vs ${snapshot.length} snapshot.`);
}

const aggregateUrls = new Set(aggregate.map(job => clean(job?.sourceUrl)));
const seenIds = new Set();
const seenUrls = new Set();
for (const job of snapshot) {
  const id = clean(job?.id);
  const title = clean(job?.title);
  const sourceUrl = clean(job?.sourceUrl);
  if (clean(job?.company) !== COMPANY) throw new Error(`Unexpected company in Flexential snapshot: ${job?.company || 'missing'}`);
  if (!id) throw new Error(`Flexential role missing id: ${title || 'untitled'}`);
  if (seenIds.has(id)) throw new Error(`Duplicate Flexential id: ${id}`);
  seenIds.add(id);
  if (!/^https:\/\/job-boards\.greenhouse\.io\/flexentialcorp\/jobs\/\d+\/?(?:\?.*)?$/i.test(sourceUrl)) {
    throw new Error(`Flexential role has non-official apply URL: ${sourceUrl || 'missing'}`);
  }
  if (seenUrls.has(sourceUrl)) throw new Error(`Duplicate Flexential apply URL: ${sourceUrl}`);
  seenUrls.add(sourceUrl);
  if (!missionTitlePattern.test(title) || excludedTitlePattern.test(title)) throw new Error(`Flexential snapshot includes out-of-scope title: ${title}`);
  if (!allowedTypes.has(job?.type)) throw new Error(`Flexential role has unsupported type: ${title} (${job?.type || 'missing'})`);
  if (!allowedExperience.has(job?.experience)) throw new Error(`Flexential role has unsupported experience: ${title} (${job?.experience || 'missing'})`);
  if (job?.active === false || job?.demo === true) throw new Error(`Flexential role is inactive/demo: ${title}`);
  if (!aggregateUrls.has(sourceUrl)) throw new Error(`Flexential snapshot role missing from aggregate feed: ${sourceUrl}`);
}

const sourceStatus = status?.flexential;
if (!sourceStatus) {
  if (snapshot.length === 0 && aggregate.length === 0) {
    console.log('Flexential snapshot validation passed in pre-bootstrap state: no Flexential roles published yet.');
    process.exit(0);
  }
  throw new Error('Flexential collector status is missing.');
}
if (sourceStatus.sourceHealthy !== true) throw new Error('Flexential collector status is not healthy.');
if (sourceStatus.listingComplete !== true) throw new Error('Flexential collector did not complete the official listing.');
if (sourceStatus.authoritativeSnapshot !== true) throw new Error('Flexential snapshot is not marked authoritative.');
if (Number(sourceStatus.qualifyingRoles) !== snapshot.length) {
  throw new Error(`Flexential status count mismatch: ${sourceStatus.qualifyingRoles} vs ${snapshot.length}.`);
}

console.log(`Flexential validation passed: ${snapshot.length} official 0–5 year data center role(s), authoritative snapshot and aggregate feed aligned.`);
