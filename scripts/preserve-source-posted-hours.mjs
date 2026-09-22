import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const FRESHNESS_FIELDS = ['postedAt', 'postedHours', 'firstSeenAt', 'lastChangedAt'];

function stableKey(job = {}) {
  const id = String(job.id || '').trim();
  if (id) return `id:${id}`;
  const url = String(job.sourceUrl || '').trim();
  if (url) return `url:${url}`;
  return '';
}

export function preserveNonSourceFreshness(currentJobs, baselineJobs, sourceCompany) {
  if (!sourceCompany) throw new Error('sourceCompany is required');

  const baseline = new Map();
  for (const job of baselineJobs) {
    if (job?.company === sourceCompany) continue;
    const key = stableKey(job);
    if (key) baseline.set(key, job);
  }

  const restoredByField = Object.fromEntries(FRESHNESS_FIELDS.map(field => [field, 0]));
  const removedByField = Object.fromEntries(FRESHNESS_FIELDS.map(field => [field, 0]));

  for (const job of currentJobs) {
    if (job?.company === sourceCompany) continue;
    const key = stableKey(job);
    const prior = key ? baseline.get(key) : null;
    if (!prior) continue;

    for (const field of FRESHNESS_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(prior, field)) {
        if (job[field] !== prior[field]) {
          job[field] = prior[field];
          restoredByField[field] += 1;
        }
      } else if (Object.prototype.hasOwnProperty.call(job, field)) {
        delete job[field];
        removedByField[field] += 1;
      }
    }
  }

  return { jobs: currentJobs, restoredByField, removedByField };
}

function runTests() {
  const baseline = [
    {
      id: 'aws-1',
      company: 'Amazon Web Services',
      postedAt: '2026-09-20T12:00:00.000Z',
      postedHours: 12,
      firstSeenAt: '2026-09-20T12:00:00.000Z',
      lastChangedAt: '2026-09-20T12:00:00.000Z'
    },
    { id: 'ms-1', company: 'Microsoft' },
    {
      id: 'oracle-1',
      company: 'Oracle',
      postedAt: '2026-09-22T00:00:00.000Z',
      postedHours: 4,
      firstSeenAt: '2026-09-22T01:00:00.000Z',
      lastChangedAt: '2026-09-22T01:00:00.000Z'
    }
  ];
  const current = [
    {
      id: 'aws-1',
      company: 'Amazon Web Services',
      postedAt: '2026-09-20T00:00:00.000Z',
      postedHours: 13,
      firstSeenAt: '2026-09-20T12:00:00.000Z',
      lastChangedAt: '2026-09-22T03:00:00.000Z'
    },
    {
      id: 'ms-1',
      company: 'Microsoft',
      postedAt: '2026-09-22T00:00:00.000Z',
      postedHours: 9999,
      firstSeenAt: '2026-09-22T03:00:00.000Z',
      lastChangedAt: '2026-09-22T03:00:00.000Z'
    },
    {
      id: 'oracle-1',
      company: 'Oracle',
      postedAt: '2026-09-22T02:00:00.000Z',
      postedHours: 5,
      firstSeenAt: '2026-09-22T02:00:00.000Z',
      lastChangedAt: '2026-09-22T02:00:00.000Z'
    }
  ];

  const result = preserveNonSourceFreshness(current, baseline, 'Oracle');
  const aws = result.jobs[0];
  const microsoft = result.jobs[1];
  const oracle = result.jobs[2];

  if (aws.postedAt !== baseline[0].postedAt) throw new Error('non-source postedAt was not restored');
  if (aws.postedHours !== 12) throw new Error('non-source postedHours was not restored');
  if (aws.lastChangedAt !== baseline[0].lastChangedAt) throw new Error('non-source lastChangedAt was not restored');
  for (const field of FRESHNESS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(microsoft, field)) {
      throw new Error(`non-source synthetic ${field} was not removed`);
    }
  }
  if (oracle.postedHours !== 5 || oracle.postedAt !== '2026-09-22T02:00:00.000Z') {
    throw new Error('source freshness fields must remain current');
  }
  if (result.restoredByField.postedAt !== 1 || result.restoredByField.postedHours !== 1 || result.restoredByField.lastChangedAt !== 1) {
    throw new Error('freshness restore counters are incorrect');
  }
  if (Object.values(result.removedByField).some(count => count !== 1)) {
    throw new Error('freshness removal counters are incorrect');
  }
  console.log('Source-scoped freshness preservation tests passed.');
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
  const result = preserveNonSourceFreshness(currentJobs, baselineJobs, sourceCompany);
  await writeFile(jobsPath, JSON.stringify(result.jobs, null, 2) + '\n');

  const restored = Object.entries(result.restoredByField).filter(([, count]) => count).map(([field, count]) => `${field}:${count}`);
  const removed = Object.entries(result.removedByField).filter(([, count]) => count).map(([field, count]) => `${field}:${count}`);
  console.log(
    `Preserved non-${sourceCompany} freshness state; restored ${restored.join(', ') || 'none'}; removed synthetic ${removed.join(', ') || 'none'}.`
  );
}
