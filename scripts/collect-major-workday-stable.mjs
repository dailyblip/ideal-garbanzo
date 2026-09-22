import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const STATUS_PATH = 'data/collector-status.json';
const RETRY_DELAY_MS = 3000;
const INCOMPLETE_WORKDAY = /incomplete Workday listing/i;

function incompleteWorkdayEmployers(status = {}) {
  const diagnostics = status?.majorSources?.employerDiagnostics;
  if (!diagnostics || typeof diagnostics !== 'object') return [];

  return Object.entries(diagnostics)
    .filter(([, diagnostic]) => diagnostic?.usedPreviousSnapshot === true
      && INCOMPLETE_WORKDAY.test(String(diagnostic?.incompleteReason || diagnostic?.error || '')))
    .map(([company]) => company);
}

function withoutStalePaginationErrors(status = {}) {
  const errors = Array.isArray(status?.errors) ? status.errors : [];
  return {
    ...status,
    errors: errors.filter(error => !INCOMPLETE_WORKDAY.test(String(error || '')))
  };
}

async function readStatus() {
  return JSON.parse(await readFile(STATUS_PATH, 'utf8'));
}

async function clearStalePaginationErrors() {
  const status = await readStatus();
  const cleaned = withoutStalePaginationErrors(status);
  if (cleaned.errors.length !== (Array.isArray(status.errors) ? status.errors.length : 0)) {
    await writeFile(STATUS_PATH, JSON.stringify(cleaned, null, 2) + '\n');
  }
}

function runCollector() {
  const result = spawnSync(process.execPath, ['scripts/collect-major-jobs.mjs'], {
    stdio: 'inherit',
    env: process.env
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.argv.includes('--test')) {
  const retryCases = [
    {
      name: 'healthy priority boards do not retry',
      status: { majorSources: { employerDiagnostics: { 'NTT Global Data Centers': { usedPreviousSnapshot: false, listingComplete: true } } } },
      expected: []
    },
    {
      name: 'incomplete listing fallback retries',
      status: { majorSources: { employerDiagnostics: { 'NTT Global Data Centers': { usedPreviousSnapshot: true, incompleteReason: 'incomplete Workday listing (short page returned 8 rows at 228/229)' } } } },
      expected: ['NTT Global Data Centers']
    },
    {
      name: 'non-pagination fallback does not retry',
      status: { majorSources: { employerDiagnostics: { 'NTT Global Data Centers': { usedPreviousSnapshot: true, error: '503 Service Unavailable' } } } },
      expected: []
    }
  ];

  const failures = [];
  for (const testCase of retryCases) {
    const actual = incompleteWorkdayEmployers(testCase.status);
    if (JSON.stringify(actual) !== JSON.stringify(testCase.expected)) {
      failures.push(`${testCase.name}: expected ${JSON.stringify(testCase.expected)}, got ${JSON.stringify(actual)}`);
    }
  }

  const cleaned = withoutStalePaginationErrors({
    errors: [
      'NTT Global Data Centers: incomplete Workday listing (short page returned 8 rows at 228/229); kept previous employer snapshot',
      'Unrelated source: timeout'
    ]
  });
  if (JSON.stringify(cleaned.errors) !== JSON.stringify(['Unrelated source: timeout'])) {
    failures.push(`stale pagination errors are cleared without deleting unrelated errors: got ${JSON.stringify(cleaned.errors)}`);
  }

  if (failures.length) {
    for (const failure of failures) console.error(`Stable Workday retry regression: ${failure}`);
    process.exit(1);
  }
  console.log(`Stable Workday retry policy passed ${retryCases.length + 1} regression cases.`);
  process.exit(0);
}

await clearStalePaginationErrors();
runCollector();
let status = await readStatus();
const retryEmployers = incompleteWorkdayEmployers(status);
if (!retryEmployers.length) process.exit(0);

console.warn(`Priority Workday listing changed during pagination for ${retryEmployers.join(', ')}; retrying one clean pass.`);
await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
await clearStalePaginationErrors();
runCollector();
status = await readStatus();
const remaining = incompleteWorkdayEmployers(status);
if (remaining.length) {
  console.warn(`Priority Workday listing remained incomplete after retry for ${remaining.join(', ')}; verified previous employer snapshot remains in place.`);
}
