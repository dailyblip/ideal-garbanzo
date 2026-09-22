import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const STATUS_PATH = 'data/collector-status.json';
const HISTORY_SCRIPT = 'scripts/stamp-job-history.mjs';
const additiveMetrics = [
  'newJobsThisRun',
  'changedJobsThisRun',
  'migratedEntriesThisRun',
  'seededExistingThisRun',
  'repairedEntriesThisRun',
  'recencySentinelsRepairedThisRun',
  'normalizedWorkdayPostingDatesThisRun',
  'firstSeenRecencyFallbackJobs'
];

export function parseCompanies(value) {
  const companies = String(value || '')
    .split('|')
    .map(item => item.trim())
    .filter(Boolean);
  if (!companies.length) throw new Error('At least one company is required.');
  return [...new Set(companies)];
}

export function aggregateHistoryScopes(scopes, companies) {
  if (!scopes.length) throw new Error('At least one history scope is required.');
  const next = { ...scopes.at(-1) };
  delete next.scopeCompany;
  next.scopeCompanies = companies;
  next.scopedJobs = scopes.reduce((sum, scope) => sum + Number(scope?.scopedJobs || 0), 0);
  for (const key of additiveMetrics) {
    next[key] = scopes.reduce((sum, scope) => sum + Number(scope?.[key] || 0), 0);
  }
  return next;
}

function runTests() {
  const companies = parseCompanies('Vantage Data Centers|QTS Data Centers|Vantage Data Centers');
  if (companies.join('|') !== 'Vantage Data Centers|QTS Data Centers') {
    throw new Error('history group parser must trim and deduplicate company names');
  }

  const aggregate = aggregateHistoryScopes([
    {
      initializedAt: '2026-09-01T00:00:00.000Z',
      trackedJobs: 10,
      currentJobs: 8,
      scopeCompany: 'Vantage Data Centers',
      scopedJobs: 2,
      newJobsThisRun: 1,
      changedJobsThisRun: 2,
      firstSeenRecencyFallbackJobs: 1,
      updatedAt: '2026-09-22T17:00:00.000Z'
    },
    {
      initializedAt: '2026-09-01T00:00:00.000Z',
      trackedJobs: 11,
      currentJobs: 8,
      scopeCompany: 'QTS Data Centers',
      scopedJobs: 3,
      newJobsThisRun: 2,
      changedJobsThisRun: 1,
      firstSeenRecencyFallbackJobs: 2,
      updatedAt: '2026-09-22T17:00:01.000Z'
    }
  ], companies);

  if (aggregate.scopeCompany !== undefined) throw new Error('group history summary must not retain a single-company scope');
  if (aggregate.scopeCompanies.join('|') !== companies.join('|')) throw new Error('group history summary lost company scope');
  if (aggregate.scopedJobs !== 5 || aggregate.newJobsThisRun !== 3 || aggregate.changedJobsThisRun !== 3) {
    throw new Error('group history summary did not aggregate scoped counters');
  }
  if (aggregate.firstSeenRecencyFallbackJobs !== 3) throw new Error('group history summary did not aggregate recency fallbacks');
  if (aggregate.trackedJobs !== 11 || aggregate.updatedAt !== '2026-09-22T17:00:01.000Z') {
    throw new Error('group history summary must keep final global history state');
  }

  console.log('Source-group history aggregation tests passed.');
}

if (process.argv.includes('--test')) {
  runTests();
  process.exit(0);
}

const companies = parseCompanies(process.argv[2]);
const scopes = [];
for (const company of companies) {
  const child = spawnSync(process.execPath, [HISTORY_SCRIPT, '--company', company], {
    stdio: 'inherit',
    env: process.env
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(`Job-history stamping failed for ${company} with exit code ${child.status}.`);
  }

  const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
  if (!status?.jobHistory || status.jobHistory.scopeCompany !== company) {
    throw new Error(`Job-history stamping did not report the expected ${company} scope.`);
  }
  scopes.push(status.jobHistory);
}

const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
status.jobHistory = aggregateHistoryScopes(scopes, companies);
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
console.log(`Job history updated for ${companies.length} source-scoped employers (${status.jobHistory.scopedJobs} published jobs) without touching unrelated employer rows.`);
