import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';

// collect-jobs-core.mjs owns the provider integrations. This wrapper protects the
// combined production feed from a single transient Lever/Greenhouse/Ashby outage.
// A provider that responds successfully is authoritative, including a legitimate
// zero-result response. We preserve prior roles only when that provider actually
// failed to fetch.
const GENERIC_COMPANIES = [
  'Serverfarm',
  'LightEdge Solutions',
  'Cologix',
  'ECL',
  'Hive',
  'CAI',
  'T5 Data Centers',
  'xAI',
  'Element Critical',
  'CoreWeave',
  'Flexential',
  'Lambda',
  'Crusoe',
  'Fluidstack',
  'Gimlet Labs',
  'TensorWave'
];
const GENERIC_COMPANY_SET = new Set(GENERIC_COMPANIES);

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalize = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

function failedCompanies(errors = []) {
  const failures = new Set();
  for (const company of GENERIC_COMPANIES) {
    if (errors.some(error => clean(error).startsWith(`${company}:`))) failures.add(company);
  }
  return failures;
}

function dedupe(jobs) {
  const urls = new Set();
  const identities = new Set();
  const out = [];
  for (const job of jobs) {
    const url = clean(job?.sourceUrl);
    const identity = [job?.company, job?.title, job?.location].map(normalize).join('|');
    if ((url && urls.has(url)) || identities.has(identity)) continue;
    if (url) urls.add(url);
    identities.add(identity);
    out.push(job);
  }
  return out;
}

function preserveFailedSources(previous, fresh, errors = []) {
  const failed = failedCompanies(errors);
  const retained = [];
  const preservedByCompany = {};

  for (const job of previous) {
    const company = clean(job?.company);
    const isGeneric = GENERIC_COMPANY_SET.has(company);
    const keepFailedGeneric = isGeneric && failed.has(company) && job?.active !== false && job?.demo !== true;
    const keepOtherSource = !isGeneric;
    if (!keepFailedGeneric && !keepOtherSource) continue;
    retained.push(job);
    if (keepFailedGeneric) preservedByCompany[company] = (preservedByCompany[company] || 0) + 1;
  }

  return {
    jobs: dedupe([...fresh, ...retained]),
    failed: [...failed],
    preservedByCompany
  };
}

function countsBy(jobs, field) {
  return jobs.reduce((counts, job) => {
    const value = clean(job?.[field]) || 'unknown';
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function runSelfTest() {
  const previous = [
    { id:'old-lightedge', company:'LightEdge Solutions', title:'Data Center Operations Tier 1 Technician', location:'Lewisville, TX', sourceUrl:'https://jobs.lever.co/lightedge/old', active:true, demo:false },
    { id:'old-serverfarm', company:'Serverfarm', title:'Data Center Technician', location:'Dallas, TX', sourceUrl:'https://jobs.lever.co/serverfarm/old', active:true, demo:false },
    { id:'major-role', company:'Microsoft', title:'Datacenter Technician', location:'Boydton, VA', sourceUrl:'https://jobs.careers.microsoft.com/major', active:true, demo:false }
  ];
  const fresh = [
    { id:'new-serverfarm', company:'Serverfarm', title:'Data Center Technician', location:'Dallas, TX', sourceUrl:'https://jobs.lever.co/serverfarm/new', active:true, demo:false }
  ];

  const outage = preserveFailedSources(previous, fresh, ['LightEdge Solutions: 503 upstream unavailable']);
  if (!outage.jobs.some(job => job.id === 'old-lightedge')) throw new Error('failed source role was not preserved');
  if (!outage.jobs.some(job => job.id === 'major-role')) throw new Error('non-generic production role was not preserved');
  if (!outage.jobs.some(job => job.id === 'new-serverfarm')) throw new Error('fresh successful-source role was lost');
  if (outage.jobs.some(job => job.id === 'old-serverfarm')) throw new Error('old role from a successful source was incorrectly preserved');
  if (outage.preservedByCompany['LightEdge Solutions'] !== 1) throw new Error('preservation diagnostics were not recorded');

  const healthyEmpty = preserveFailedSources(previous, [], []);
  if (healthyEmpty.jobs.some(job => job.company === 'LightEdge Solutions')) throw new Error('successful zero-result source was treated as an outage');
  if (!healthyEmpty.jobs.some(job => job.id === 'major-role')) throw new Error('non-generic production role was lost on healthy refresh');

  console.log('Generic source failure preservation passed regression tests.');
}

if (process.argv.includes('--test-preservation')) {
  runSelfTest();
  process.exit(0);
}

// Keep the existing classifier test interface intact for the generic ATS guard.
if (process.argv.includes('--test-experience-parser')) {
  await import('./collect-jobs-core.mjs');
  process.exit(0);
}

const previous = await readJson(JOBS_PATH, []);
await import('./collect-jobs-core.mjs');
const fresh = await readJson(JOBS_PATH, []);
const status = await readJson(STATUS_PATH, {});
const errors = Array.isArray(status?.errors) ? status.errors : [];
const result = preserveFailedSources(previous, fresh, errors);

const now = Date.now();
for (const job of result.jobs) {
  if (job?.postedAt) {
    const timestamp = new Date(job.postedAt).getTime();
    if (Number.isFinite(timestamp)) job.postedHours = Math.max(0, Math.round((now - timestamp) / 36e5));
  }
}

const nextStatus = {
  ...status,
  jobs: result.jobs.length,
  countsByType: countsBy(result.jobs, 'type'),
  countsByExperience: countsBy(result.jobs, 'experience'),
  sourceFailurePreservation: {
    checkedAt: new Date().toISOString(),
    failedSources: result.failed,
    preservedJobs: Object.values(result.preservedByCompany).reduce((sum, count) => sum + count, 0),
    preservedByCompany: result.preservedByCompany,
    policy: 'Preserve last verified roles only for generic ATS providers that failed to fetch; successful zero-result refreshes remain authoritative.'
  }
};

await writeFile(JOBS_PATH, JSON.stringify(result.jobs, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(nextStatus, null, 2) + '\n');

if (result.failed.length) {
  console.warn(`Preserved ${nextStatus.sourceFailurePreservation.preservedJobs} prior role(s) across failed generic source(s): ${result.failed.join(', ')}`);
} else {
  console.log('Generic employer-direct refresh completed without source-failure preservation.');
}
