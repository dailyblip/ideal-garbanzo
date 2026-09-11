import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const DEFAULT_BASELINE_PATH = '/tmp/jobs-before-generic.json';

// These employers have stronger dedicated collectors, snapshots, and/or
// source-specific freshness guards elsewhere in the pipeline. The shared ATS
// refresh may inspect the same boards for diagnostics, but it must never
// replace the already-published dedicated-source result for these companies.
const DEDICATED_OVERLAP = [
  'Cologix',
  'T5 Data Centers',
  'CoreWeave',
  'Flexential',
  'EdgeConneX'
];
const DEDICATED_SET = new Set(DEDICATED_OVERLAP);

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalize = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
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

function countsBy(records, field) {
  return records.reduce((counts, record) => {
    const value = clean(record?.[field]) || 'unknown';
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function restoreDedicatedOverlap(baseline, refreshed) {
  const protectedBaseline = baseline.filter(job => DEDICATED_SET.has(clean(job?.company)));
  const genericSafe = refreshed.filter(job => !DEDICATED_SET.has(clean(job?.company)));
  const restored = dedupe([...genericSafe, ...protectedBaseline]);
  restored.sort((a, b) => Number(a?.postedHours ?? 9999) - Number(b?.postedHours ?? 9999));
  return restored;
}

function restoredCounts(baseline) {
  const counts = {};
  for (const company of DEDICATED_OVERLAP) {
    counts[company] = baseline.filter(job => clean(job?.company) === company).length;
  }
  return counts;
}

function runSelfTest() {
  const baseline = [
    { id: 't5-dedicated', company: 'T5 Data Centers', title: 'Jr. Critical Facilities Technician', location: 'Dallas, TX', sourceUrl: 'https://jobs.lever.co/t5datacenters/dedicated' },
    { id: 'flex-dedicated', company: 'Flexential', title: 'Data Center Technician', location: 'Denver, CO', sourceUrl: 'https://boards.greenhouse.io/flexential/dedicated' },
    { id: 'generic-old', company: 'Serverfarm', title: 'Data Center Technician', location: 'Dallas, TX', sourceUrl: 'https://jobs.lever.co/serverfarm/old' }
  ];
  const refreshed = [
    { id: 't5-generic', company: 'T5 Data Centers', title: 'Critical Facilities Technician', location: 'Newark, CA', sourceUrl: 'https://jobs.lever.co/t5datacenters/generic' },
    { id: 'flex-generic', company: 'Flexential', title: 'Data Center Technician II', location: 'Denver, CO', sourceUrl: 'https://boards.greenhouse.io/flexential/generic' },
    { id: 'generic-new', company: 'Serverfarm', title: 'Data Center Technician', location: 'Dallas, TX', sourceUrl: 'https://jobs.lever.co/serverfarm/new' }
  ];

  const result = restoreDedicatedOverlap(baseline, refreshed);
  if (!result.some(job => job.id === 't5-dedicated')) throw new Error('dedicated T5 result was not restored');
  if (!result.some(job => job.id === 'flex-dedicated')) throw new Error('dedicated Flexential result was not restored');
  if (result.some(job => job.id === 't5-generic' || job.id === 'flex-generic')) throw new Error('generic overlap survived dedicated-source protection');
  if (!result.some(job => job.id === 'generic-new')) throw new Error('fresh generic-only employer result was lost');
  if (result.some(job => job.id === 'generic-old')) throw new Error('stale generic-only baseline role was incorrectly restored');

  console.log('Generic/dedicated source-isolation regression tests passed.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

const baselinePath = process.argv[2] || process.env.GENERIC_REFRESH_BASELINE || DEFAULT_BASELINE_PATH;
const baseline = await readJson(baselinePath, null);
const refreshed = await readJson(JOBS_PATH, null);
const status = await readJson(STATUS_PATH, {});
if (!Array.isArray(baseline)) throw new Error(`Generic refresh baseline is missing or invalid: ${baselinePath}`);
if (!Array.isArray(refreshed)) throw new Error(`${JOBS_PATH} must contain an array.`);

const restored = restoreDedicatedOverlap(baseline, refreshed);
const restoredByCompany = restoredCounts(baseline);
const genericOverlapCounts = Object.fromEntries(
  DEDICATED_OVERLAP.map(company => [company, refreshed.filter(job => clean(job?.company) === company).length])
);

const nextStatus = {
  ...status,
  jobs: restored.length,
  countsByType: countsBy(restored, 'type'),
  countsByExperience: countsBy(restored, 'experience'),
  genericDedicatedOverlapProtection: {
    checkedAt: new Date().toISOString(),
    companies: DEDICATED_OVERLAP,
    restoredByCompany,
    genericResultsSuppressedByCompany: genericOverlapCounts,
    policy: 'The six-hour shared ATS refresh may verify overlapping boards, but published roles for employers with stronger dedicated collectors remain exactly as they were before the generic refresh.'
  }
};

await writeFile(JOBS_PATH, JSON.stringify(restored, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(nextStatus, null, 2) + '\n');

console.log(`Protected dedicated-source overlap after generic refresh: ${DEDICATED_OVERLAP.map(company => `${company}=${restoredByCompany[company]}`).join(', ')}.`);
