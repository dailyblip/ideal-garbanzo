import { readFile } from 'node:fs/promises';

// Dedicated source guard for the official CyrusOne Workday feed.
const COMPANY = 'CyrusOne';
const HOST = 'cyrusone.wd1.myworkdayjobs.com';
const SNAPSHOT_PATH = 'data/cyrusone-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const errors = [];
const requireOk = (condition, message) => { if (!condition) errors.push(message); };

const [snapshot, jobs, status] = await Promise.all([
  readFile(SNAPSHOT_PATH, 'utf8').then(JSON.parse),
  readFile(JOBS_PATH, 'utf8').then(JSON.parse),
  readFile(STATUS_PATH, 'utf8').then(JSON.parse)
]);

requireOk(Array.isArray(snapshot) && snapshot.length > 0, 'CyrusOne snapshot must contain at least one verified role.');
requireOk(Array.isArray(jobs), 'Combined jobs feed must be an array.');
const ids = new Set(jobs.map(job => clean(job?.id)));
const identities = new Set();

for (const job of snapshot) {
  requireOk(clean(job?.company) === COMPANY, `Unexpected company in CyrusOne snapshot: ${job?.company}`);
  requireOk(['internship','apprenticeship','trainee','entry-level'].includes(job?.type), `Invalid type for ${job?.id}: ${job?.type}`);
  requireOk(['no-experience','0-2-years','2-5-years'].includes(job?.experience), `Invalid experience for ${job?.id}: ${job?.experience}`);
  requireOk(job?.active === true && job?.demo === false, `CyrusOne role ${job?.id} must be active production data.`);
  requireOk(clean(job?.source) === 'Employer career site', `CyrusOne role ${job?.id} must use employer career site source label.`);
  requireOk(clean(job?.sourceUrl).startsWith(`https://${HOST}/`), `CyrusOne role ${job?.id} has a non-official source URL.`);
  requireOk(!/\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|security)\b/i.test(clean(job?.title)), `CyrusOne role ${job?.id} violates senior/noise title policy.`);
  requireOk(ids.has(clean(job?.id)), `CyrusOne role ${job?.id} is missing from combined jobs feed.`);
  const identity = [job?.title, job?.location].map(value => clean(value).toLowerCase()).join('|');
  requireOk(!identities.has(identity), `Duplicate CyrusOne role identity: ${identity}`);
  identities.add(identity);
}

const feedCyrusOne = jobs.filter(job => clean(job?.company) === COMPANY);
requireOk(feedCyrusOne.length === snapshot.length, `Combined feed CyrusOne count ${feedCyrusOne.length} does not match snapshot count ${snapshot.length}.`);
requireOk(status?.cyrusOne?.sourceHealthy === true, 'Collector status must report CyrusOne source healthy.');
requireOk(Number(status?.cyrusOne?.qualifyingRoles) === snapshot.length, 'Collector status qualifyingRoles must match snapshot count.');
requireOk(Number(status?.cyrusOne?.listedJobs) >= snapshot.length, 'Collector status listedJobs must cover published roles.');

if (errors.length) {
  console.error('CyrusOne validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`CyrusOne validation passed: ${snapshot.length} official Workday role(s), all present in combined feed.`);
