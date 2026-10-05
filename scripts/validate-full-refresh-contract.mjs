import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = await readFile('.github/workflows/pages.yml', 'utf8');
const refresh = workflow.split('\n  deploy:')[0];
const [normal, publication] = refresh.split('      - name: Commit refreshed jobs and events when changed');
const rebuild = publication?.match(/rebuild_from_latest_main\(\) \{([\s\S]*?)\n          \}/)?.[1];
assert(rebuild, 'Full refresh must retain its race-safe rebuild');
const commands = text => [...text.matchAll(/^\s*(?:run:\s*)?node (scripts\/[\w-]+\.mjs)([^\n]*)/gm)]
  .map(([, file, args]) => `${file}${args.trim() ? ` ${args.trim()}` : ''}`);
const initial = commands(normal);
assert.deepEqual(commands(rebuild), initial, 'Initial refresh and latest-main rebuild must run the identical verified pipeline');

// These sources own durable snapshots that the aggregate validators require.
// Refresh them in the full run rather than depending on targeted jobs that may
// themselves be waiting for an unrelated stale-source gate to recover.
const requiredCollectors = [
  'collect-jobs', 'collect-major-jobs', 'collect-amazon-datacenter',
  'collect-microsoft-datacenter', 'collect-google-careers-fresh',
  'collect-meta-careers', 'collect-oracle-careers', 'collect-digital-realty',
  'collect-tierpoint-v3', 'collect-sabey-careers', 'collect-novva-careers',
  'collect-iron-mountain', 'collect-compass-datacenters', 'collect-t5-data-centers',
  'collect-coresite', 'collect-equinix-v2', 'collect-equinix-early',
  'collect-equinix-current-skillbridge',
  'collect-flexential', 'collect-cologix', 'collect-databank',
  'collect-cloudhq-careers', 'collect-coreweave-careers',
  'collect-edgeconnex-careers', 'collect-h5-data-centers', 'collect-csquare-jobs',
  'collect-prime-data-centers', 'collect-stream-data-centers', 'collect-switch-careers'
];
for (const name of requiredCollectors) {
  assert(initial.includes(`scripts/${name}.mjs`), `Full refresh is missing authoritative collector ${name}`);
}
assert(!initial.includes('scripts/collect-google-careers.mjs'), 'Google must use the freshness-enforcing wrapper');
for (const [collector, evidence] of [
  ['collect-amazon-datacenter', 'recover-amazon-details'],
  ['recover-amazon-details', 'stamp-amazon-source-verification'],
  ['collect-oracle-careers', 'stamp-oracle-source-freshness'],
  ['collect-microsoft-datacenter', 'persist-microsoft-snapshot'],
  ['qa-site', 'reconcile-qa-dead-snapshots']
]) {
  assert.equal(initial.indexOf(`scripts/${evidence}.mjs`), initial.indexOf(`scripts/${collector}.mjs`) + 1,
    `${evidence} must immediately follow its evidence-producing ${collector}`);
}
const fallbackOwners = [
  'amazon', 'generic', 'major-workday', 'google', 'microsoft', 'meta',
  'digital-realty', 'flexential', 'cologix', 'databank', 'cloudhq', 'coreweave',
  'edgeconnex', 'h5', 'csquare', 'prime', 'sabey', 'novva', 'iron-mountain',
  't5', 'coresite', 'equinix'
];
for (const owner of fallbackOwners) {
  const position = initial.indexOf(`scripts/enforce-${owner}-fallback-freshness.mjs`);
  assert(position >= 0 && position < initial.indexOf('scripts/qa-site.mjs'),
    `${owner} freshness enforcement must precede live QA and publication validation`);
}
const firstValidation = initial.indexOf('scripts/validate-refresh-health.mjs');
assert(firstValidation > initial.indexOf('scripts/reconcile-qa-dead-snapshots.mjs'), 'Refresh regression guard must inspect reconciled QA state');
assert(initial.includes('scripts/validate.mjs'), 'Full aggregate validation cannot be omitted');
const deploy = workflow.split('\n  deploy:')[1];
assert(deploy.includes('node scripts/validate-data-freshness.mjs'), 'Deployment must retain strict global freshness validation');
assert(deploy.includes('Verify custom-domain deployment'), 'Deployment must verify the actual custom domain');
console.log(`Full refresh contract passed: ${requiredCollectors.length} collector entrypoints; ${initial.length} identical normal/retry commands; source evidence and QA reconciliation precede strict publication gates.`);

const nightly = await readFile('.github/workflows/nightly-qa.yml', 'utf8');
const [qaInitial, qaPublication] = nightly.split('      - name: Commit safe QA corrections when needed');
const qaRebuild = qaPublication?.match(/rebuild_from_latest_main\(\) \{([\s\S]*?)\n          \}/)?.[1];
assert(qaRebuild, 'Nightly QA must rebuild confirmed-dead evidence against latest main on a race');
assert.deepEqual(commands(qaRebuild), commands(qaInitial), 'Nightly QA initial/retry checks must match');
assert(qaPublication.includes('reconcile-qa-dead-snapshots.mjs --list-paths'), 'Nightly commits must use the reconciler ownership manifest');
assert(qaPublication.includes('git add -- "${qa_paths[@]}"'), 'Nightly commits must stage all reconciled snapshots together');
assert(!/git\s+rebase\b/.test(qaPublication), 'Never rebase generated QA removals onto a newer collected feed');
console.log('Nightly QA contract passed: identical initial/retry checks and atomic snapshot ownership staging.');
