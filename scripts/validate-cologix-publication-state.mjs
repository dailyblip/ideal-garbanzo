import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/cologix-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'Cologix';
const BOARD_HOST = 'jobs.lever.co';
const BOARD_SLUG = 'cologix';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function isCologix(job = {}) {
  if (clean(job?.company) === COMPANY) return true;
  try {
    const url = new URL(clean(job?.sourceUrl));
    const parts = url.pathname.split('/').filter(Boolean);
    return url.hostname.toLowerCase() === BOARD_HOST && parts[0]?.toLowerCase() === BOARD_SLUG;
  } catch {
    return false;
  }
}

function expiredStateFailures(snapshot, jobs, source) {
  const failures = [];
  const publicJobs = (Array.isArray(jobs) ? jobs : []).filter(isCologix);
  if (!Array.isArray(snapshot)) failures.push('Cologix snapshot must be an array.');
  else if (snapshot.length !== 0) failures.push(`Expired Cologix fallback still has ${snapshot.length} snapshot role(s).`);
  if (publicJobs.length !== 0) failures.push(`Expired Cologix fallback still publishes ${publicJobs.length} public role(s).`);
  if (source?.sourceHealthy !== false) failures.push('Expired Cologix fallback must set sourceHealthy=false.');
  if (source?.listingComplete !== false) failures.push('Expired Cologix fallback must set listingComplete=false.');
  if (source?.authoritativeSnapshot !== false) failures.push('Expired Cologix fallback must set authoritativeSnapshot=false.');
  if (Number(source?.qualifyingRoles || 0) !== 0) failures.push('Expired Cologix fallback must set qualifyingRoles=0.');
  return failures;
}

if (process.argv.includes('--test')) {
  const expired = {
    sourceHealthy: false,
    listingComplete: false,
    authoritativeSnapshot: false,
    qualifyingRoles: 0,
    fallbackFreshness: { expired: true }
  };
  const valid = expiredStateFailures([], [], expired);
  if (valid.length) throw new Error(`Valid expired state rejected: ${valid.join(' | ')}`);
  const leaked = expiredStateFailures([], [{ company: COMPANY, sourceUrl: 'https://jobs.lever.co/cologix/example' }], expired);
  if (!leaked.length) throw new Error('Expired-state validator did not reject a leaked public Cologix role.');
  console.log('Cologix publication-state regression tests passed.');
  process.exit(0);
}

const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
const source = status?.cologix || {};

if (source?.fallbackFreshness?.expired === true) {
  const failures = expiredStateFailures(snapshot, jobs, source);
  if (failures.length) {
    for (const failure of failures) console.error(`Cologix publication state: ${failure}`);
    process.exit(1);
  }
  console.log('Cologix publication state passed: expired fallback is fully removed from snapshot and public feed.');
  process.exit(0);
}

const result = spawnSync(process.execPath, ['scripts/validate-cologix.mjs'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
