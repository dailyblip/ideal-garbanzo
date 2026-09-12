import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function countsBy(records, field) {
  return records.reduce((counts, job) => {
    const value = clean(job?.[field]) || 'unknown';
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
if (!Array.isArray(jobs)) throw new Error('data/jobs.json must contain an array.');
if (!status || typeof status !== 'object' || Array.isArray(status)) {
  throw new Error('data/collector-status.json must contain an object.');
}

const nextJobs = jobs.length;
const nextTypes = countsBy(jobs, 'type');
const nextExperience = countsBy(jobs, 'experience');
const changed = Number(status.jobs) !== nextJobs ||
  JSON.stringify(status.countsByType || {}) !== JSON.stringify(nextTypes) ||
  JSON.stringify(status.countsByExperience || {}) !== JSON.stringify(nextExperience);

if (!changed) {
  console.log(`Publication counts already match the ${nextJobs}-job feed.`);
  process.exit(0);
}

status.jobs = nextJobs;
status.countsByType = nextTypes;
status.countsByExperience = nextExperience;
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
console.log(`Publication counts synchronized to ${nextJobs} jobs after publication filtering.`);
