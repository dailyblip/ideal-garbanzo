import { readFile, writeFile } from 'node:fs/promises';

const SNAPSHOT_PATH = 'data/meta-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';

function countsBy(field, jobs) {
  return jobs.reduce((acc, job) => {
    const value = String(job?.[field] ?? '').trim();
    if (value) acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function reconcileStatus(status, snapshot, jobs, checkedAt = new Date().toISOString()) {
  return {
    ...status,
    updatedAt: checkedAt,
    jobs: jobs.length,
    countsByType: countsBy('type', jobs),
    countsByExperience: countsBy('experience', jobs),
    metaCareers: {
      ...(status.metaCareers || {}),
      qualifyingRoles: snapshot.length
    }
  };
}

function runTests() {
  const status = {
    jobs: 3,
    countsByType: { 'entry-level': 3 },
    countsByExperience: { '0-2yrs': 3 },
    metaCareers: { sourceHealthy: false, qualifyingRoles: 2, errors: ['rate limited'] }
  };
  const snapshot = [{ id: 'meta-1' }];
  const jobs = [
    { company: 'Meta', type: 'entry-level', experience: '0-2yrs' },
    { company: 'Google', type: 'internship', experience: 'no-exp' }
  ];
  const reconciled = reconcileStatus(status, snapshot, jobs, '2026-09-21T00:00:00.000Z');

  if (reconciled.jobs !== 2) throw new Error('Meta status reconciliation must update the public job count.');
  if (reconciled.metaCareers.qualifyingRoles !== 1) throw new Error('Meta status reconciliation must match the post-prune snapshot count.');
  if (reconciled.metaCareers.sourceHealthy !== false || reconciled.metaCareers.errors?.[0] !== 'rate limited') {
    throw new Error('Meta status reconciliation must preserve source-health diagnostics.');
  }
  if (reconciled.countsByType['entry-level'] !== 1 || reconciled.countsByType.internship !== 1) {
    throw new Error('Meta status reconciliation must rebuild type counts from the final public feed.');
  }
  if (reconciled.countsByExperience['0-2yrs'] !== 1 || reconciled.countsByExperience['no-exp'] !== 1) {
    throw new Error('Meta status reconciliation must rebuild experience counts from the final public feed.');
  }

  console.log('Meta collector-status reconciliation regression tests passed.');
}

runTests();
if (process.argv.includes('--test')) process.exit(0);

const [snapshot, jobs, status] = await Promise.all([
  readFile(SNAPSHOT_PATH, 'utf8').then(JSON.parse),
  readFile(JOBS_PATH, 'utf8').then(JSON.parse),
  readFile(STATUS_PATH, 'utf8').then(JSON.parse)
]);

if (!Array.isArray(snapshot)) throw new Error(`${SNAPSHOT_PATH} must contain an array.`);
if (!Array.isArray(jobs)) throw new Error(`${JOBS_PATH} must contain an array.`);
if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error(`${STATUS_PATH} must contain an object.`);

const nextStatus = reconcileStatus(status, snapshot, jobs);
await writeFile(STATUS_PATH, JSON.stringify(nextStatus, null, 2) + '\n');

console.log(`Meta collector status reconciled to ${snapshot.length} qualifying role(s) and ${jobs.length} public job(s).`);
