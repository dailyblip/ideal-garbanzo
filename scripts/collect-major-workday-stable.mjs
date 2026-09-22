import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const STATUS_PATH = 'data/collector-status.json';
const RETRY_DELAY_MS = 3000;

function incompleteWorkdayEmployers(status = {}) {
  const diagnostics = status?.majorSources?.employerDiagnostics;
  if (!diagnostics || typeof diagnostics !== 'object') return [];

  return Object.entries(diagnostics)
    .filter(([, diagnostic]) => diagnostic?.usedPreviousSnapshot === true
      && /incomplete Workday listing/i.test(String(diagnostic?.incompleteReason || diagnostic?.error || '')))
    .map(([company]) => company);
}

function runCollector() {
  const result = spawnSync(process.execPath, ['scripts/collect-major-jobs.mjs'], {
    stdio: 'inherit',
    env: process.env
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function readStatus() {
  return JSON.parse(await readFile(STATUS_PATH, 'utf8'));
}

if (process.argv.includes('--test')) {
  const cases = [
    {
      name: 'healthy priority boards do not retry',
      status: { majorSources: { employerDiagnostics: { 'NTT Global Data Centers': { usedPreviousSnapshot: false, listingComplete: true } } } },
      expected: []
    },
    {
      name: 'incomplete listing fallback retries',
      status: { majorSources: { employerDiagnostics: { 'NTT Global Data Centers': { usedPreviousSnapshot: true, incompleteReason: 'short page returned 8 rows at 228/229' } } } },
      expected: ['NTT Global Data Centers']
    },
    {
      name: 'non-pagination fallback does not retry',
      status: { majorSources: { employerDiagnostics: { 'NTT Global Data Centers': { usedPreviousSnapshot: true, error: '503 Service Unavailable' } } } },
      expected: []
    }
  ];

  const failures = [];
  for (const testCase of cases) {
    const actual = incompleteWorkdayEmployers(testCase.status);
    if (JSON.stringify(actual) !== JSON.stringify(testCase.expected)) {
      failures.push(`${testCase.name}: expected ${JSON.stringify(testCase.expected)}, got ${JSON.stringify(actual)}`);
    }
  }

  if (failures.length) {
    for (const failure of failures) console.error(`Stable Workday retry regression: ${failure}`);
    process.exit(1);
  }
  console.log(`Stable Workday retry policy passed ${cases.length} regression cases.`);
  process.exit(0);
}

runCollector();
let status = await readStatus();
const retryEmployers = incompleteWorkdayEmployers(status);
if (!retryEmployers.length) process.exit(0);

console.warn(`Priority Workday listing changed during pagination for ${retryEmployers.join(', ')}; retrying one clean pass.`);
await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
runCollector();
status = await readStatus();
const remaining = incompleteWorkdayEmployers(status);
if (remaining.length) {
  console.warn(`Priority Workday listing remained incomplete after retry for ${remaining.join(', ')}; verified previous employer snapshot remains in place.`);
}
