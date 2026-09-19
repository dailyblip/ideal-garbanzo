import { readFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';

// Generic employer-direct collectors share ATS hosts. Keep the employer/board
// binding explicit so a provider response, mapping mistake, or future collector
// change cannot publish a role under the wrong employer or a third-party URL.
const GENERIC_BOARDS = new Map([
  ['lever-serverfarm', { provider: 'lever', company: 'Serverfarm', slug: 'serverfarm' }],
  ['lever-lightedge', { provider: 'lever', company: 'LightEdge Solutions', slug: 'lightedge' }],
  ['lever-cologix', { provider: 'lever', company: 'Cologix', slug: 'cologix' }],
  ['lever-ecldc', { provider: 'lever', company: 'ECL', slug: 'ecldc' }],
  ['lever-hive', { provider: 'lever', company: 'Hive', slug: 'hive' }],
  ['lever-cagents', { provider: 'lever', company: 'CAI', slug: 'cagents' }],
  ['lever-t5datacenters', { provider: 'lever', company: 'T5 Data Centers', slug: 't5datacenters' }],
  ['gh-xai', { provider: 'greenhouse', company: 'xAI', slug: 'xai' }],
  ['gh-elementcritical', { provider: 'greenhouse', company: 'Element Critical', slug: 'elementcritical' }],
  ['gh-coreweave', { provider: 'greenhouse', company: 'CoreWeave', slug: 'coreweave' }],
  ['gh-flexentialcorp', { provider: 'greenhouse', company: 'Flexential', slug: 'flexentialcorp' }],
  ['gh-edgeconnex', { provider: 'greenhouse', company: 'EdgeConneX', slug: 'edgeconnex' }],
  ['gh-lightningai', { provider: 'greenhouse', company: 'Lightning AI', slug: 'lightningai' }],
  ['ashby-lambda', { provider: 'ashby', company: 'Lambda', slug: 'lambda' }],
  ['ashby-crusoe', { provider: 'ashby', company: 'Crusoe', slug: 'crusoe' }],
  ['ashby-fluidstack', { provider: 'ashby', company: 'Fluidstack', slug: 'fluidstack' }],
  ['ashby-gimlet', { provider: 'ashby', company: 'Gimlet Labs', slug: 'gimlet' }],
  ['ashby-tensorwave', { provider: 'ashby', company: 'TensorWave', slug: 'tensorwave' }]
]);

const TRUSTED_HOSTS = {
  lever: new Set(['jobs.lever.co', 'jobs.eu.lever.co']),
  greenhouse: new Set(['job-boards.greenhouse.io', 'boards.greenhouse.io']),
  ashby: new Set(['jobs.ashbyhq.com'])
};

function boardKeyFromId(id = '') {
  const value = String(id || '').trim().toLowerCase();
  if (value.startsWith('lever-')) {
    const match = value.match(/^(lever-[a-z0-9]+)-/);
    return match?.[1] || '';
  }
  if (value.startsWith('gh-')) {
    const match = value.match(/^(gh-[a-z0-9]+)-/);
    return match?.[1] || '';
  }
  if (value.startsWith('ashby-')) {
    const match = value.match(/^(ashby-[a-z0-9]+)-/);
    return match?.[1] || '';
  }
  return '';
}

function validateGenericJob(job) {
  const id = String(job?.id || '').trim();
  const key = boardKeyFromId(id);
  if (!key) return [];

  const violations = [];
  const expected = GENERIC_BOARDS.get(key);
  if (!expected) {
    violations.push(`${id}: generic ATS board ${key} is not registered in the provenance guard`);
    return violations;
  }

  const company = String(job?.company || '').trim();
  if (company !== expected.company) {
    violations.push(`${id}: board ${expected.slug} is bound to ${expected.company}, not ${company || '(missing company)'}`);
  }

  let parsed;
  try {
    parsed = new URL(String(job?.sourceUrl || ''));
  } catch {
    violations.push(`${id}: missing or invalid employer source URL`);
    return violations;
  }

  const host = parsed.hostname.toLowerCase();
  const allowedHosts = TRUSTED_HOSTS[expected.provider];
  if (parsed.protocol !== 'https:' || !allowedHosts?.has(host)) {
    violations.push(`${id}: ${expected.provider} role points to non-official ATS host ${host || '(missing host)'}`);
    return violations;
  }

  const path = parsed.pathname.toLowerCase();
  const expectedPrefix = `/${expected.slug.toLowerCase()}/`;
  if (!path.startsWith(expectedPrefix)) {
    violations.push(`${id}: ${host} URL points to the wrong employer board path ${parsed.pathname || '/'}`);
  }

  return violations;
}

function runRegressionTests() {
  const cases = [
    {
      name: 'valid Greenhouse employer board',
      job: { id: 'gh-lightningai-123', company: 'Lightning AI', sourceUrl: 'https://job-boards.greenhouse.io/lightningai/jobs/123' },
      valid: true
    },
    {
      name: 'valid Lever employer board',
      job: { id: 'lever-serverfarm-abc', company: 'Serverfarm', sourceUrl: 'https://jobs.lever.co/serverfarm/abc' },
      valid: true
    },
    {
      name: 'valid Ashby employer board',
      job: { id: 'ashby-crusoe-abc', company: 'Crusoe', sourceUrl: 'https://jobs.ashbyhq.com/crusoe/abc' },
      valid: true
    },
    {
      name: 'wrong company on valid board',
      job: { id: 'gh-lightningai-123', company: 'CoreWeave', sourceUrl: 'https://job-boards.greenhouse.io/lightningai/jobs/123' },
      valid: false
    },
    {
      name: 'wrong shared ATS board path',
      job: { id: 'gh-lightningai-123', company: 'Lightning AI', sourceUrl: 'https://job-boards.greenhouse.io/coreweave/jobs/123' },
      valid: false
    },
    {
      name: 'third-party redirect host',
      job: { id: 'ashby-crusoe-abc', company: 'Crusoe', sourceUrl: 'https://jobs.example.com/crusoe/abc' },
      valid: false
    },
    {
      name: 'unregistered generic board',
      job: { id: 'gh-newoperator-123', company: 'New Operator', sourceUrl: 'https://job-boards.greenhouse.io/newoperator/jobs/123' },
      valid: false
    },
    {
      name: 'dedicated collector is outside generic guard scope',
      job: { id: 'coreweave-123', company: 'CoreWeave', sourceUrl: 'https://www.coreweave.com/careers?gh_jid=123' },
      valid: true
    }
  ];

  const failures = [];
  for (const testCase of cases) {
    const violations = validateGenericJob(testCase.job);
    const valid = violations.length === 0;
    if (valid !== testCase.valid) failures.push(`${testCase.name}: ${violations.join('; ') || 'unexpectedly accepted'}`);
  }
  if (failures.length) throw new Error(`Generic ATS provenance regression failure:\n${failures.join('\n')}`);
}

runRegressionTests();

if (process.argv.includes('--test')) {
  console.log('Generic ATS source provenance regression tests passed.');
  process.exit(0);
}

let jobs;
try {
  jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
} catch (error) {
  console.error(`Generic ATS provenance guard could not read ${JOBS_PATH}: ${error.message}`);
  process.exit(1);
}

if (!Array.isArray(jobs) || jobs.length === 0) {
  console.error('Generic ATS provenance guard requires a non-empty public jobs feed.');
  process.exit(1);
}

const violations = [];
let checked = 0;
for (const job of jobs) {
  if (!boardKeyFromId(job?.id)) continue;
  checked += 1;
  violations.push(...validateGenericJob(job));
}

if (violations.length) {
  console.error(`Generic ATS provenance guard failed with ${violations.length} violation(s):`);
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`Generic ATS provenance guard passed for ${checked} employer-direct ATS role(s).`);
