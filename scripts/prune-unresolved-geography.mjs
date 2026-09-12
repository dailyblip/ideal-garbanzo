import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const allowedRegions = new Set([
  'mid-atlantic',
  'texas',
  'southwest',
  'midwest',
  'southeast',
  'northeast',
  'west',
  'nationwide'
]);

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function hasPublishableGeography(job = {}) {
  return allowedRegions.has(clean(job?.region));
}

const regressionCases = [
  { job: { location: 'Santa Clara, CA', region: 'west' }, keep: true },
  { job: { location: 'Remote - US', region: 'nationwide' }, keep: true },
  { job: { location: 'Querétaro, Mexico - Data Center' }, keep: false },
  { job: { company: 'Serverfarm', location: 'AMS1' }, keep: false },
  { job: { location: 'Unknown campus', region: 'europe' }, keep: false }
];
for (const testCase of regressionCases) {
  const actual = hasPublishableGeography(testCase.job);
  if (actual !== testCase.keep) {
    throw new Error(`Publication geography regression for ${testCase.job.location}: expected keep=${testCase.keep}, got ${actual}`);
  }
}

const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
if (!Array.isArray(jobs)) throw new Error('data/jobs.json must contain an array.');

const kept = [];
const removed = [];
for (const job of jobs) {
  if (hasPublishableGeography(job)) {
    kept.push(job);
    continue;
  }
  removed.push({
    id: clean(job?.id),
    company: clean(job?.company),
    title: clean(job?.title),
    location: clean(job?.location),
    region: clean(job?.region) || '(missing)'
  });
}

if (removed.length) {
  await writeFile(JOBS_PATH, JSON.stringify(kept, null, 2) + '\n');
  console.warn(`Publication geography guard removed ${removed.length} role(s) that could not be assigned to a supported U.S. region after normalization.`);
  for (const sample of removed.slice(0, 12)) {
    console.warn(`- ${sample.company} / ${sample.title} / ${sample.location || '(missing location)'} / region=${sample.region}`);
  }
} else {
  console.log(`Publication geography guard passed: all ${kept.length} jobs have a supported U.S. region.`);
}
