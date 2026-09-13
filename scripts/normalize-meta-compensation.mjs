import { readFile, writeFile } from 'node:fs/promises';

const SNAPSHOT_PATH = 'data/meta-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const COMPANY = 'Meta';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function normalizeJob(job = {}) {
  if (clean(job.company) !== COMPANY) return job;
  if (!/^pay not listed$/i.test(clean(job.pay))) return job;
  return { ...job, pay: '' };
}

function normalizeJobs(jobs) {
  if (!Array.isArray(jobs)) throw new Error('Expected an array of jobs.');
  let changed = 0;
  const normalized = jobs.map(job => {
    const next = normalizeJob(job);
    if (next !== job) changed += 1;
    return next;
  });
  return { normalized, changed };
}

function runSelfTest() {
  const input = [
    { id: 'meta-missing', company: 'Meta', pay: 'Pay not listed', salaryMin: null, salaryMax: null },
    { id: 'meta-valid', company: 'Meta', pay: '$70,000–$90,000 / year', salaryMin: 70000, salaryMax: 90000 },
    { id: 'other-company', company: 'Google', pay: 'Pay not listed', salaryMin: null, salaryMax: null }
  ];
  const { normalized, changed } = normalizeJobs(input);
  if (changed !== 1) throw new Error(`Expected exactly one Meta compensation repair, got ${changed}.`);
  if (normalized[0].pay !== '') throw new Error('Missing Meta compensation was not normalized to blank.');
  if (normalized[1].pay !== input[1].pay) throw new Error('Published Meta compensation was unexpectedly changed.');
  if (normalized[2].pay !== input[2].pay) throw new Error('Non-Meta compensation was unexpectedly changed.');
  if (normalized[0].salaryMin !== null || normalized[0].salaryMax !== null) throw new Error('Missing salary bounds must remain null.');
  console.log('Meta compensation normalization regression tests passed.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

async function normalizeFile(path) {
  const jobs = JSON.parse(await readFile(path, 'utf8'));
  const { normalized, changed } = normalizeJobs(jobs);
  if (changed) await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`);
  return changed;
}

const snapshotChanged = await normalizeFile(SNAPSHOT_PATH);
const feedChanged = await normalizeFile(JOBS_PATH);
console.log(`Meta compensation normalization: ${snapshotChanged} snapshot role(s), ${feedChanged} public role(s) repaired.`);
