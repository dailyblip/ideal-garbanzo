import { readFile } from 'node:fs/promises';

const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));
const compass = JSON.parse(await readFile('data/compass-status.json', 'utf8'));
const violations = [];

if (!compass || typeof compass !== 'object') violations.push('compass-status.json is missing source diagnostics');
else {
  if (compass.boardUrl !== 'https://compass-datacenters.breezy.hr/') violations.push(`unexpected Compass board URL: ${compass.boardUrl || '(missing)'}`);
  if (compass.sourceHealthy !== true) violations.push('Compass source is not healthy');
  if (!Number.isInteger(compass.listedPositions) || compass.listedPositions < 1) violations.push('Compass board returned no public positions');
  if (!Number.isInteger(compass.detailFetched) || compass.detailFetched < 1) violations.push('Compass detail fetch coverage is empty');
  if (!Number.isInteger(compass.structuredDetails) || compass.structuredDetails < Math.ceil((compass.detailFetched || 0) * 0.5)) {
    violations.push(`Compass structured-data coverage is too low: ${compass.structuredDetails || 0}/${compass.detailFetched || 0}`);
  }
}

const compassJobs = Array.isArray(jobs) ? jobs.filter(job => String(job?.company || '').trim() === 'Compass Datacenters') : [];
const allowedTypes = new Set(['internship', 'apprenticeship', 'trainee', 'entry-level']);
const allowedExperience = new Set(['no-experience', '0-2-years', '2-5-years']);
const bannedSenior = /\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|architect)\b/i;

for (const job of compassJobs) {
  let url;
  try { url = new URL(String(job.sourceUrl || '')); }
  catch {
    violations.push(`${job.id || '(missing id)'} has an invalid source URL`);
    continue;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'compass-datacenters.breezy.hr') {
    violations.push(`${job.id || '(missing id)'} does not use the official Compass Breezy host`);
  }
  if (!allowedTypes.has(job.type)) violations.push(`${job.id || '(missing id)'} has invalid type ${job.type}`);
  if (!allowedExperience.has(job.experience)) violations.push(`${job.id || '(missing id)'} has invalid experience ${job.experience}`);
  if (bannedSenior.test(String(job.title || ''))) violations.push(`${job.id || '(missing id)'} leaked a senior/leadership title: ${job.title}`);
}

if (violations.length) {
  for (const violation of violations) console.error(`Compass validation: ${violation}`);
  throw new Error(`Compass source validation failed with ${violations.length} violation(s).`);
}

console.log(`Compass source validation passed: ${compass.listedPositions} public positions scanned, ${compass.structuredDetails}/${compass.detailFetched} structured details parsed, ${compassJobs.length} mission-fit roles published.`);
