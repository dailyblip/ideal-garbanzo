import { readFile } from 'node:fs/promises';

const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));
const status = JSON.parse(await readFile('data/collector-status.json', 'utf8'));
const source = status?.ironMountain;
const errors = [];
const requireOk = (condition, message) => { if (!condition) errors.push(message); };

requireOk(source && typeof source === 'object', 'Iron Mountain collector status is missing.');
if (source) {
  requireOk(source.sourceHealthy === true, 'Iron Mountain official Workday source did not report healthy.');
  requireOk(source.listingComplete === true, 'Iron Mountain Workday listing was incomplete.');
  requireOk(Number(source.listingPagesSucceeded || 0) > 0, 'Iron Mountain listing returned no successful pages.');
  requireOk(Number(source.detailSucceeded || 0) > 0, 'Iron Mountain collector verified no job detail pages.');
}

const ironMountainJobs = Array.isArray(jobs) ? jobs.filter(job => job?.company === 'Iron Mountain') : [];
const seniorPattern = /\b(?:senior|sr\.?|principal|staff|manager|director|vice president|vp|chief|head of|supervisor)\b/i;
const missionPattern = /\b(?:critical facilit(?:y|ies)|data cent(?:er|re))\b/i;

for (const job of ironMountainJobs) {
  requireOk(Boolean(job.id), 'Iron Mountain job is missing an id.');
  requireOk(Boolean(job.sourceUrl) && /ironmountain\.wd5\.myworkdayjobs\.com/i.test(job.sourceUrl), `Iron Mountain job ${job.id || '(unknown)'} is not employer-direct.`);
  requireOk(missionPattern.test(String(job.title || '')), `Iron Mountain job ${job.id || '(unknown)'} has an out-of-scope title: ${job.title || '(blank)'}.`);
  requireOk(!seniorPattern.test(String(job.title || '')), `Iron Mountain job ${job.id || '(unknown)'} leaked a senior title: ${job.title || '(blank)'}.`);
  requireOk(['no-experience', '0-2-years', '2-5-years'].includes(job.experience), `Iron Mountain job ${job.id || '(unknown)'} has invalid experience classification.`);
  requireOk(Boolean(job.region), `Iron Mountain job ${job.id || '(unknown)'} is missing a regional classification.`);
}

if (source?.sourceHealthy === true && Number(source.qualifyingRoles || 0) > 0) {
  requireOk(ironMountainJobs.length > 0, 'Iron Mountain collector found qualifying roles but none survived QA.');
}

if (errors.length) {
  console.error('Iron Mountain source validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Iron Mountain source validation passed: ${ironMountainJobs.length} published role(s), ${Number(source?.qualifyingRoles || 0)} qualifying role(s) before QA.`);
