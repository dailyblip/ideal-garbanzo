import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';

const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));

if (!Array.isArray(jobs)) throw new Error('data/jobs.json must contain an array.');

const clean = value => String(value ?? '').trim();
const jobsWithRegion = jobs.filter(job => clean(job?.region));
const missing = jobs.filter(job => !clean(job?.region));
const countsByRegion = jobsWithRegion.reduce((counts, job) => {
  const region = clean(job.region);
  counts[region] = (counts[region] || 0) + 1;
  return counts;
}, {});

status.locationNormalization = {
  ...(status.locationNormalization || {}),
  regionAssigned: jobsWithRegion.length,
  regionMissing: missing.length,
  coveragePct: jobs.length ? Math.round((jobsWithRegion.length / jobs.length) * 1000) / 10 : 100,
  missingSamples: missing.slice(0, 12).map(job => ({
    id: job.id,
    company: job.company,
    location: job.location,
    sourceUrl: job.sourceUrl
  })),
  countsByRegion
};

await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
console.log(`Post-QA regional coverage: ${jobsWithRegion.length}/${jobs.length} jobs (${status.locationNormalization.coveragePct}%).`);
