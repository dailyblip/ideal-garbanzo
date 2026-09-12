import { readFile } from 'node:fs/promises';

const sourceWorkflows = [
  '.github/workflows/aws-detail-recovery.yml',
  '.github/workflows/cologix-bootstrap.yml',
  '.github/workflows/compass-bootstrap.yml',
  '.github/workflows/coreweave-bootstrap.yml',
  '.github/workflows/databank-bootstrap.yml',
  '.github/workflows/edgeconnex-bootstrap.yml',
  '.github/workflows/equinix-bootstrap.yml',
  '.github/workflows/flexential-bootstrap.yml',
  '.github/workflows/google-bootstrap.yml',
  '.github/workflows/iron-mountain-bootstrap.yml',
  '.github/workflows/meta-bootstrap.yml',
  '.github/workflows/microsoft-bootstrap.yml',
  '.github/workflows/novva-bootstrap.yml',
  '.github/workflows/oracle-bootstrap.yml',
  '.github/workflows/sabey-bootstrap.yml',
  '.github/workflows/stream-data-centers-bootstrap.yml',
  '.github/workflows/switch-bootstrap.yml',
  '.github/workflows/t5-data-centers-bootstrap.yml',
  '.github/workflows/tierpoint-bootstrap.yml',
  '.github/workflows/major-workday-targeted-recovery.yml'
];

const sharedPipelinePaths = [
  'data/jobs.json',
  'scripts/filter-mission-fit.mjs',
  'scripts/normalize-job-locations.mjs',
  'scripts/dedupe-normalized-jobs.mjs',
  'scripts/stamp-job-history.mjs',
  'scripts/validate-job-history.mjs',
  'scripts/validate-priority-employer-sources.mjs'
];

const sharedWriterQueue = new Set([
  '.github/workflows/cologix-bootstrap.yml',
  '.github/workflows/compass-bootstrap.yml',
  '.github/workflows/coreweave-bootstrap.yml',
  '.github/workflows/databank-bootstrap.yml',
  '.github/workflows/edgeconnex-bootstrap.yml',
  '.github/workflows/equinix-bootstrap.yml',
  '.github/workflows/flexential-bootstrap.yml',
  '.github/workflows/google-bootstrap.yml',
  '.github/workflows/iron-mountain-bootstrap.yml',
  '.github/workflows/novva-bootstrap.yml',
  '.github/workflows/sabey-bootstrap.yml',
  '.github/workflows/stream-data-centers-bootstrap.yml',
  '.github/workflows/switch-bootstrap.yml',
  '.github/workflows/t5-data-centers-bootstrap.yml',
  '.github/workflows/tierpoint-bootstrap.yml'
]);

const violations = [];

for (const path of sourceWorkflows) {
  const text = await readFile(path, 'utf8');
  const onBlock = text.match(/^on:\s*\n([\s\S]*?)^permissions:/m)?.[1] || '';
  if (!onBlock) {
    violations.push(`${path}: could not isolate the trigger block`);
    continue;
  }

  for (const sharedPath of sharedPipelinePaths) {
    if (onBlock.includes(sharedPath)) {
      violations.push(`${path}: push trigger includes shared pipeline path ${sharedPath}`);
    }
  }

  if (sharedWriterQueue.has(path) && !/group:\s*careers-source-writers\b/.test(text)) {
    violations.push(`${path}: shared-feed writer must use careers-source-writers concurrency`);
  }

  if (!/cancel-in-progress:\s*false\b/.test(text)) {
    violations.push(`${path}: source refreshes must not cancel an in-progress run`);
  }
}

if (violations.length) {
  for (const violation of violations) console.error(`Source workflow isolation violation: ${violation}`);
  throw new Error(`Blocked ${violations.length} source-workflow isolation regression(s).`);
}

console.log(`Source workflow isolation guard passed for ${sourceWorkflows.length} feed-writing workflows.`);
