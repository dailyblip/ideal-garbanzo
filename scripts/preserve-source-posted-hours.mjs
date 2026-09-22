import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';

function stableKey(job = {}) {
  const id = String(job.id || '').trim();
  if (id) return `id:${id}`;
  const url = String(job.sourceUrl || '').trim();
  if (url) return `url:${url}`;
  return '';
}

export function preserveNonSourcePostedHours(currentJobs, baselineJobs, sourceCompany) {
  if (!sourceCompany) throw new Error('sourceCompany is required');

  const baseline = new Map();
  for (const job of baselineJobs) {
    if (job?.company === sourceCompany) continue;
    const key = stableKey(job);
    if (key) baseline.set(key, job);
  }

  let restored = 0;
  let removed = 0;
  for (const job of currentJobs) {
    if (job?.company === sourceCompany) continue;
    const key = stableKey(job);
    const prior = key ? baseline.get(key) : null;
    if (!prior) continue;

    if (Object.prototype.hasOwnProperty.call(prior, 'postedHours')) {
      if (job.postedHours !== prior.postedHours) {
        job.postedHours = prior.postedHours;
        restored += 1;
      }
    } else if (Object.prototype.hasOwnProperty.call(job, 'postedHours')) {
      delete job.postedHours;
      removed += 1;
    }
  }

  return { jobs: currentJobs, restored, removed };
}

function runTests() {
  const baseline = [
    { id: 'aws-1', company: 'Amazon Web Services', postedHours: 12 },
    { id: 'ms-1', company: 'Microsoft' },
    { id: 'oracle-1', company: 'Oracle', postedHours: 4 }
  ];
  const current = [
    { id: 'aws-1', company: 'Amazon Web Services', postedHours: 13 },
    { id: 'ms-1', company: 'Microsoft', postedHours: 9999 },
    { id: 'oracle-1', company: 'Oracle', postedHours: 5 }
  ];

  const result = preserveNonSourcePostedHours(current, baseline, 'Oracle');
  if (result.jobs[0].postedHours !== 12) throw new Error('non-source postedHours was not restored');
  if (Object.prototype.hasOwnProperty.call(result.jobs[1], 'postedHours')) throw new Error('non-source synthetic postedHours was not removed');
  if (result.jobs[2].postedHours !== 5) throw new Error('source postedHours must remain current');
  if (result.restored !== 1 || result.removed !== 1) throw new Error('change counters are incorrect');
  console.log('Source-scoped posted-hours preservation tests passed.');
}

if (process.argv.includes('--test')) {
  runTests();
} else {
  const sourceCompany = String(process.argv[2] || '').trim();
  const baselinePath = String(process.argv[3] || '').trim();
  const jobsPath = String(process.argv[4] || JOBS_PATH).trim();
  if (!sourceCompany || !baselinePath) {
    throw new Error('Usage: node scripts/preserve-source-posted-hours.mjs <source company> <baseline jobs path> [jobs path]');
  }

  const baselineJobs = JSON.parse(await readFile(baselinePath, 'utf8'));
  const currentJobs = JSON.parse(await readFile(jobsPath, 'utf8'));
  const result = preserveNonSourcePostedHours(currentJobs, baselineJobs, sourceCompany);
  await writeFile(jobsPath, JSON.stringify(result.jobs, null, 2) + '\n');
  console.log(`Preserved non-${sourceCompany} postedHours values: ${result.restored} restored, ${result.removed} removed.`);
}
