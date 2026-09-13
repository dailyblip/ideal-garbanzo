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

// These staggered source workflows intentionally share a queue. Other writers
// use dedicated concurrency groups plus fresh-main publication safeguards so a
// burst of independent source runs cannot replace older pending GitHub runs.
const sharedWriterQueue = new Set([
  '.github/workflows/cologix-bootstrap.yml',
  '.github/workflows/coreweave-bootstrap.yml',
  '.github/workflows/databank-bootstrap.yml',
  '.github/workflows/edgeconnex-bootstrap.yml',
  '.github/workflows/equinix-bootstrap.yml',
  '.github/workflows/flexential-bootstrap.yml',
  '.github/workflows/google-bootstrap.yml',
  '.github/workflows/novva-bootstrap.yml',
  '.github/workflows/stream-data-centers-bootstrap.yml',
  '.github/workflows/switch-bootstrap.yml',
  '.github/workflows/t5-data-centers-bootstrap.yml'
]);

// Employer-direct collectors that rebuild or reconcile the shared public feed
// must never rebase generated JSON from a stale checkout. If another writer moves
// main while collection is running, rebuild against that newest revision and
// retry the push so unrelated employer updates cannot be silently overwritten.
const raceSafeWriters = new Set([
  '.github/workflows/aws-detail-recovery.yml',
  '.github/workflows/coreweave-bootstrap.yml',
  '.github/workflows/databank-bootstrap.yml',
  '.github/workflows/edgeconnex-bootstrap.yml',
  '.github/workflows/equinix-bootstrap.yml',
  '.github/workflows/flexential-bootstrap.yml',
  '.github/workflows/google-bootstrap.yml',
  '.github/workflows/meta-bootstrap.yml',
  '.github/workflows/microsoft-bootstrap.yml',
  '.github/workflows/oracle-bootstrap.yml',
  '.github/workflows/switch-bootstrap.yml'
]);

const raceSafeMarkers = [
  'rebuild_from_latest_main()',
  'git reset --hard origin/main',
  'for attempt in 1 2 3',
  'if git push origin HEAD:main; then'
];

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
    violations.push(`${path}: staggered shared-feed writer must use careers-source-writers concurrency`);
  }

  if (!/cancel-in-progress:\s*false\b/.test(text)) {
    violations.push(`${path}: source refreshes must not cancel an in-progress run`);
  }

  if (raceSafeWriters.has(path)) {
    for (const marker of raceSafeMarkers) {
      if (!text.includes(marker)) {
        violations.push(`${path}: race-safe source publication is missing ${marker}`);
      }
    }
    if (/git\s+rebase\s+origin\/main/.test(text)) {
      violations.push(`${path}: generated source data must rebuild from latest main instead of rebasing a stale snapshot`);
    }
  }
}

// The daily full refresh writes the same generated feed as the source-specific
// workflows. It may keep its deployment-oriented concurrency policy, but its
// publication path must follow the same fresh-main rebuild rule.
const fullRefreshPath = '.github/workflows/pages.yml';
const fullRefreshText = await readFile(fullRefreshPath, 'utf8');
for (const marker of raceSafeMarkers) {
  if (!fullRefreshText.includes(marker)) {
    violations.push(`${fullRefreshPath}: race-safe full-refresh publication is missing ${marker}`);
  }
}
if (/git\s+rebase\s+origin\/main/.test(fullRefreshText)) {
  violations.push(`${fullRefreshPath}: generated full-refresh data must rebuild from latest main instead of rebasing a stale snapshot`);
}

if (violations.length) {
  for (const violation of violations) console.error(`Source workflow isolation violation: ${violation}`);
  throw new Error(`Blocked ${violations.length} source-workflow isolation regression(s).`);
}

console.log(`Source workflow isolation guard passed for ${sourceWorkflows.length} feed-writing workflows; ${raceSafeWriters.size} employer-direct collectors plus the full refresh enforce fresh-main rebuilds before retrying publication.`);
