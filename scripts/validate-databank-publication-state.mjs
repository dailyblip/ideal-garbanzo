import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/databank-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'DataBank';
const PORTAL_HOST = 'www.databankcareers.com';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function isDataBank(job = {}) {
  if (clean(job?.company) === COMPANY) return true;
  try {
    const url = new URL(clean(job?.sourceUrl));
    const parts = url.pathname.split('/').filter(Boolean);
    return url.protocol === 'https:' &&
      url.hostname.toLowerCase() === PORTAL_HOST &&
      parts.length >= 4 &&
      parts[0].toLowerCase() === 'clients' &&
      parts[2].toLowerCase() === 'posting';
  } catch {
    return false;
  }
}

function expiredStateFailures(snapshot, jobs, source) {
  const failures = [];
  const publicJobs = (Array.isArray(jobs) ? jobs : []).filter(isDataBank);
  if (!Array.isArray(snapshot)) failures.push('DataBank snapshot must be an array.');
  else if (snapshot.length !== 0) failures.push(`Expired DataBank fallback still has ${snapshot.length} snapshot role(s).`);
  if (publicJobs.length !== 0) failures.push(`Expired DataBank fallback still publishes ${publicJobs.length} public role(s).`);
  if (source?.sourceHealthy !== false) failures.push('Expired DataBank fallback must set sourceHealthy=false.');
  if (source?.listingComplete !== false) failures.push('Expired DataBank fallback must set listingComplete=false.');
  if (source?.authoritativeSnapshot !== false) failures.push('Expired DataBank fallback must set authoritativeSnapshot=false.');
  if (Number(source?.qualifyingRoles || 0) !== 0) failures.push('Expired DataBank fallback must set qualifyingRoles=0.');
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
  const leaked = expiredStateFailures([], [{ company: COMPANY, sourceUrl: 'https://www.databankcareers.com/clients/14459/posting/11129551' }], expired);
  if (!leaked.length) throw new Error('Expired-state validator did not reject a leaked public DataBank role.');
  console.log('DataBank publication-state regression tests passed.');
  process.exit(0);
}

const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
const source = status?.databank || {};

if (source?.fallbackFreshness?.expired === true) {
  const failures = expiredStateFailures(snapshot, jobs, source);
  if (failures.length) {
    for (const failure of failures) console.error(`DataBank publication state: ${failure}`);
    process.exit(1);
  }
  console.log('DataBank publication state passed: expired fallback is fully removed from snapshot and public feed.');
  process.exit(0);
}

const result = spawnSync(process.execPath, ['scripts/validate-databank.mjs'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
