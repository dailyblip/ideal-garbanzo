import { readFile } from 'node:fs/promises';

const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));
const snapshot = JSON.parse(await readFile('data/iron-mountain-jobs.json', 'utf8'));
const status = JSON.parse(await readFile('data/collector-status.json', 'utf8'));
const source = status?.ironMountain;
const errors = [];
const requireOk = (condition, message) => { if (!condition) errors.push(message); };

requireOk(Array.isArray(jobs), 'Public jobs feed is not an array.');
requireOk(Array.isArray(snapshot), 'Iron Mountain dedicated snapshot is not an array.');
requireOk(source && typeof source === 'object', 'Iron Mountain collector status is missing.');
if (source) {
  requireOk(source.sourceHealthy === true, 'Iron Mountain official Workday source did not report healthy.');
  requireOk(source.listingComplete === true, 'Iron Mountain Workday listing was incomplete.');
  requireOk(Number(source.listingPagesSucceeded || 0) > 0, 'Iron Mountain listing returned no successful pages.');
  requireOk(Number(source.detailSucceeded || 0) > 0, 'Iron Mountain collector verified no job detail pages.');
  if (source.sourceHealthy === true && source.listingComplete === true) {
    requireOk(Number(source.qualifyingRoles || 0) === snapshot.length, `Iron Mountain healthy source found ${Number(source.qualifyingRoles || 0)} qualifying roles but snapshot contains ${snapshot.length}.`);
    requireOk(Number(source.snapshotRoles || 0) === snapshot.length, `Iron Mountain status reports ${Number(source.snapshotRoles || 0)} snapshot roles but snapshot contains ${snapshot.length}.`);
  }
}

const ironMountainJobs = Array.isArray(jobs) ? jobs.filter(job => job?.company === 'Iron Mountain') : [];
const snapshotJobs = Array.isArray(snapshot) ? snapshot : [];
const seniorPattern = /\b(?:senior|sr\.?|principal|staff|manager|director|vice president|vp|chief|head of|supervisor)\b/i;
const missionPattern = /\b(?:critical facilit(?:y|ies)|data cent(?:er|re))\b/i;
const officialHostPattern = /ironmountain\.wd5\.myworkdayjobs\.com/i;

function validateJob(job, label) {
  requireOk(Boolean(job.id), `${label} is missing an id.`);
  requireOk(job.company === 'Iron Mountain', `${label} is owned by ${job.company || '(blank)'} instead of Iron Mountain.`);
  requireOk(Boolean(job.sourceUrl) && officialHostPattern.test(job.sourceUrl), `${label} is not employer-direct.`);
  requireOk(missionPattern.test(String(job.title || '')), `${label} has an out-of-scope title: ${job.title || '(blank)'}.`);
  requireOk(!seniorPattern.test(String(job.title || '')), `${label} leaked a senior title: ${job.title || '(blank)'}.`);
  requireOk(['no-experience', '0-2-years', '2-5-years'].includes(job.experience), `${label} has invalid experience classification.`);
}

for (const job of snapshotJobs) validateJob(job, `Iron Mountain snapshot job ${job.id || '(unknown)'}`);
for (const job of ironMountainJobs) {
  validateJob(job, `Iron Mountain public job ${job.id || '(unknown)'}`);
  requireOk(Boolean(job.region), `Iron Mountain public job ${job.id || '(unknown)'} is missing a regional classification.`);
}

if (source?.sourceHealthy === true && Number(source.qualifyingRoles || 0) > 0) {
  requireOk(ironMountainJobs.length > 0, 'Iron Mountain collector found qualifying roles but none survived QA.');
}

if (snapshotJobs.length > 0) {
  requireOk(ironMountainJobs.length === snapshotJobs.length, `Iron Mountain snapshot/public feed count mismatch (${snapshotJobs.length} snapshot vs ${ironMountainJobs.length} public).`);
  const publicUrls = new Set(ironMountainJobs.map(job => String(job.sourceUrl || '').trim()).filter(Boolean));
  const missing = snapshotJobs.filter(job => !publicUrls.has(String(job.sourceUrl || '').trim()));
  requireOk(missing.length === 0, `Iron Mountain public feed is missing ${missing.length}/${snapshotJobs.length} authoritative snapshot URL(s).`);
}

if (errors.length) {
  console.error('Iron Mountain source validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Iron Mountain source validation passed: ${ironMountainJobs.length} published role(s), ${snapshotJobs.length} protected snapshot role(s), ${Number(source?.qualifyingRoles || 0)} qualifying role(s) before QA.`);