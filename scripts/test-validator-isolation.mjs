import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep the existing order and every deployment gate when changing orchestration.
const nestedValidators = {
  'validate.mjs': [
    'validate-priority-employer-sources', 'validate-priority-source-diagnostics',
    'validate-direct-role-links', 'validate-cloudhq', 'validate-amazon-snapshot',
    'validate-google-snapshot', 'validate-oracle-snapshot', 'validate-data-freshness',
    'validate-career-event-freshness'
  ],
  'validate-priority-employer-sources.mjs': [
    'validate-amazon-snapshot', 'validate-amazon-parity', 'validate-google-freshness',
    'validate-google-snapshot', 'validate-microsoft-snapshot', 'validate-meta-snapshot',
    'validate-oracle-snapshot', 'validate-oracle-parity', 'validate-equinix-publication-state'
  ],
  'validate-priority-source-diagnostics.mjs': [
    'validate-dedicated-fallback-freshness', 'validate-amazon-parity',
    'validate-google-snapshot', 'validate-oracle-snapshot', 'validate-digital-realty',
    'validate-cloudhq', 'validate-major-workday-freshness-state',
    'validate-coresite-source-integrity', 'validate-coresite-fallback',
    'validate-databank', 'validate-iron-mountain', 'validate-novva',
    'validate-flexential', 'validate-cologix', 'validate-switch-careers',
    'validate-t5-data-centers', 'validate-tierpoint', 'validate-crusoe',
    'validate-sabey-snapshot', 'validate-prime-data-centers', 'validate-coreweave',
    'validate-compass-datacenters', 'validate-stream-data-centers',
    'validate-edgeconnex-snapshot', 'validate-edgeconnex', 'validate-h5-data-centers', 'validate-priority-region-coverage'
  ],
  'validate-data-freshness.mjs': ['validate-flexential-freshness', 'validate-novva'],
  'validate-flexential-freshness.mjs': ['validate-crusoe'],
  'validate-major-workday-parity.mjs': [
    'validate-major-workday-requisition-integrity', 'validate-major-workday-health',
    'validate-major-workday-freshness-state'
  ],
  'validate-site-copy.mjs': ['validate-accessibility'],
  'validate-mailing-list.mjs': ['validate-alert-job-detail-parity', 'validate-alert-signup-parity'],
  'validate-promotions.mjs': ['validate-employer-submissions', 'test-promotion-runtime-contract'],
  'validate-career-event-freshness.mjs': ['test-career-event-evidence'],
  'validate-google-analytics.mjs': ['validate-accessibility'],
  'refresh-region-status.mjs': ['validate-major-workday-health']
};

for (const [name, expected] of Object.entries(nestedValidators)) {
  const source = await readFile(new URL(name, import.meta.url), 'utf8');
  assert.doesNotMatch(source, /import\s*(?:\(\s*|)['"]\.\/(?:validate-|test-)/,
    `${name} must not import CLI validators into its own process`);
  const actual = [...source.matchAll(/await runValidator\(new URL\(['"]\.\/([^'"]+)\.mjs['"], import\.meta\.url\)\)/g)]
    .map(match => match[1]);
  assert.deepEqual(actual, expected, `${name} must retain every nested validation in order`);
}

const cwd = await mkdtemp(join(tmpdir(), 'validator isolation '));
const scripts = join(cwd, 'scripts');
const helperImport = "import { runValidator } from './run-validator.mjs';\n";
const run = (name, env = {}) => {
  const result = spawnSync(process.execPath, [join(scripts, name)], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30_000
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `${name} should return an exit status`);
  return result;
};
const writeScript = (name, content) => writeFile(join(scripts, name), content);
const writeJson = (name, value) => writeFile(join(cwd, 'data', name), JSON.stringify(value));
const copyScript = name => copyFile(new URL(name, import.meta.url), join(scripts, name));

try {
  await mkdir(scripts);
  await mkdir(join(cwd, 'data'));
  await copyScript('run-validator.mjs');
  await writeFile(join(cwd, 'cwd-evidence.txt'), 'same working directory');
  await writeScript('empty.mjs', `
    import assert from 'node:assert/strict';
    import { appendFileSync, readFileSync } from 'node:fs';
    assert.equal(process.env.NESTED_VALIDATOR_FIXTURE, 'same environment');
    assert.equal(readFileSync('cwd-evidence.txt', 'utf8'), 'same working directory');
    appendFileSync('runs.txt', 'run\\n');
    console.log('CHILD_STDOUT');
    console.error('CHILD_STDERR');
    process.exit(0);
  `);
  await writeScript('parent.mjs', helperImport + `
    await runValidator(new URL('./empty.mjs', import.meta.url));
    console.log('FIRST_RETURN');
    await runValidator(new URL('./empty.mjs', import.meta.url));
    console.log('LATER_VALIDATION');
  `);
  const success = run('parent.mjs', { NESTED_VALIDATOR_FIXTURE: 'same environment' });
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /CHILD_STDOUT[\s\S]*FIRST_RETURN[\s\S]*CHILD_STDOUT[\s\S]*LATER_VALIDATION/);
  assert.match(success.stderr, /CHILD_STDERR/);
  assert.equal(await readFile(join(cwd, 'runs.txt'), 'utf8'), 'run\nrun\n',
    'separate invocations must not be skipped by an ESM import cache');

  for (const [name, content, diagnostic] of [
    ['exit-one.mjs', "console.error('CHILD_FAILURE'); process.exit(1);", /exit 1/],
    ['throws.mjs', "throw new Error('THROWN_FAILURE');", /THROWN_FAILURE/],
    ['signal.mjs', "process.kill(process.pid, 'SIGTERM');", /signal SIGTERM/],
    ['missing.mjs', null, /MODULE_NOT_FOUND/]
  ]) {
    if (content) await writeScript(name, content);
    await writeScript('parent.mjs', helperImport + `
      await runValidator(new URL(${JSON.stringify(`./${name}`)}, import.meta.url));
      console.log('MUST_NOT_CONTINUE');
    `);
    const failure = run('parent.mjs');
    assert.notEqual(failure.status, 0, `${name} must fail the parent`);
    assert.match(failure.stderr, diagnostic);
    assert.doesNotMatch(failure.stdout, /MUST_NOT_CONTINUE/);
  }

  // Exercise a launch error separately from a validator that starts and fails.
  await writeScript('parent.mjs', helperImport + `
    Object.defineProperty(process, 'execPath', { value: ${JSON.stringify(join(cwd, 'missing-node'))} });
    await runValidator(new URL('./empty.mjs', import.meta.url));
    console.log('MUST_NOT_CONTINUE');
  `);
  const launchFailure = run('parent.mjs');
  assert.notEqual(launchFailure.status, 0);
  assert.match(launchFailure.stderr, /Unable to run validator/);
  assert.doesNotMatch(launchFailure.stdout, /MUST_NOT_CONTINUE/);

  // Run the real validate -> priority diagnostics -> Sabey chain. Only unrelated
  // source gates are fixture stubs: no network or repository data is touched.
  const stubNames = new Set([
    ...nestedValidators['validate.mjs'],
    ...nestedValidators['validate-priority-source-diagnostics.mjs']
  ]);
  for (const name of stubNames) {
    await writeScript(`${name}.mjs`, `console.log(${JSON.stringify(`FIXTURE ${name}`)}); process.exit(0);\n`);
  }
  for (const name of ['validate.mjs', 'validate-priority-source-diagnostics.mjs', 'validate-sabey-snapshot.mjs']) {
    await copyScript(name);
  }
  const healthy = { sourceHealthy: true };
  const status = Object.fromEntries([
    'amazonDatacenter', 'googleCareers', 'microsoftDatacenter', 'metaCareers',
    'oracleCareers', 'digitalRealty', 'cloudHqCareers', 'databank', 'coreSite',
    'ironMountain', 'sabeyCareers', 'novvaCareers', 'flexential', 'switchCareers',
    'cologix', 't5DataCenters', 'tierPoint', 'compass', 'streamDataCenters',
    'edgeconnexCareers', 'primeDataCenters', 'coreWeaveCareers'
  ].map(key => [key, healthy]));
  status.priorityEmployerExpansion = { Equinix: healthy };
  status.genericDirectSources = { sourceDiagnostics: [{ company: 'Crusoe', ...healthy }] };
  status.majorSources = { employerDiagnostics: Object.fromEntries([
    'Vantage Data Centers', 'QTS Data Centers', 'CyrusOne', 'STACK Infrastructure',
    'NTT Global Data Centers', 'Aligned Data Centers'
  ].map(company => [company, healthy])) };
  await writeJson('collector-status.json', status);
  for (const name of ['jobs', 'amazon-jobs', 'google-jobs', 'sabey-jobs', 'career-events', 'featured-jobs']) {
    await writeJson(`${name}.json`, []);
  }
  for (const directory of ['employers', 'assets']) await mkdir(join(cwd, directory));
  for (const name of ['index.html', 'employers/index.html', 'data/employer-products.json']) {
    await copyFile(new URL(`../${name}`, import.meta.url), join(cwd, name));
  }
  for (const name of ['assets/styles.css', 'assets/app.js']) await writeFile(join(cwd, name), 'fixture');

  const aggregate = run('validate.mjs');
  assert.equal(aggregate.status, 0, aggregate.stderr);
  assert.match(aggregate.stdout, /Sabey snapshot guard passed: no Sabey roles[\s\S]*FIXTURE validate-prime-data-centers[\s\S]*FIXTURE validate-priority-region-coverage[\s\S]*FIXTURE validate-data-freshness[\s\S]*Validation passed:/,
    'empty Sabey must return through both real orchestration layers before aggregate completion');
  assert.equal((aggregate.stdout.match(/Validation passed:/g) || []).length, 1);

  await writeJson('jobs.json', [{}]);
  const schemaFailure = run('validate.mjs');
  assert.notEqual(schemaFailure.status, 0, 'empty Sabey must not bypass later job-schema validation');
  assert.match(schemaFailure.stdout, /Sabey snapshot guard passed: no Sabey roles[\s\S]*FIXTURE validate-data-freshness/);
  assert.match(schemaFailure.stderr, /Job 0 missing id/);
  assert.doesNotMatch(schemaFailure.stdout, /Validation passed:/);

  await writeJson('jobs.json', []);
  await writeScript('validate-data-freshness.mjs', "throw new Error('FIXTURE_FRESHNESS_FAILURE');\n");
  const freshnessFailure = run('validate.mjs');
  assert.notEqual(freshnessFailure.status, 0, 'empty Sabey must not bypass later freshness failure');
  assert.match(freshnessFailure.stdout, /Sabey snapshot guard passed: no Sabey roles/);
  assert.match(freshnessFailure.stderr, /FIXTURE_FRESHNESS_FAILURE/);
  assert.doesNotMatch(freshnessFailure.stdout, /Validation passed:/);

  console.log(`Validator isolation passed: ${Object.keys(nestedValidators).length} orchestration contracts, exit-zero continuation, uncached repeat runs, inherited cwd/environment/output, failure/signal/launch propagation, and real empty-Sabey aggregate/schema/freshness regressions.`);
} finally {
  await rm(cwd, { recursive: true, force: true });
}
