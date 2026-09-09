import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';

// collect-jobs-core.mjs owns the provider integrations. This wrapper protects the
// combined production feed from a single transient Lever/Greenhouse/Ashby outage.
// A provider that responds successfully is authoritative, including a legitimate
// zero-result response. We preserve prior roles only when that provider actually
// failed to fetch.
const GENERIC_SOURCES = [
  { company: 'Serverfarm', provider: 'lever' },
  { company: 'LightEdge Solutions', provider: 'lever' },
  { company: 'Cologix', provider: 'lever' },
  { company: 'ECL', provider: 'lever' },
  { company: 'Hive', provider: 'lever' },
  { company: 'CAI', provider: 'lever' },
  { company: 'T5 Data Centers', provider: 'lever' },
  { company: 'xAI', provider: 'greenhouse' },
  { company: 'Element Critical', provider: 'greenhouse' },
  { company: 'CoreWeave', provider: 'greenhouse' },
  { company: 'Flexential', provider: 'greenhouse' },
  { company: 'EdgeConneX', provider: 'greenhouse' },
  { company: 'Lambda', provider: 'ashby' },
  { company: 'Crusoe', provider: 'ashby' },
  { company: 'Fluidstack', provider: 'ashby' },
  { company: 'Gimlet Labs', provider: 'ashby' },
  { company: 'TensorWave', provider: 'ashby' }
];
const GENERIC_COMPANIES = GENERIC_SOURCES.map(source => source.company);
const GENERIC_COMPANY_SET = new Set(GENERIC_COMPANIES);
const AUTHORITATIVE_SNAPSHOTS = [
  { company: 'Cologix', path: 'data/cologix-jobs.json' }
];

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

function buildGenericSourceDiagnostics(fresh = [], errors = []) {
  const failed = failedCompanies(errors);
  const counts = new Map();
  const errorByCompany = new Map();

  for (const job of fresh) {
    const company = clean(job?.company);
    if (!GENERIC_COMPANY_SET.has(company)) continue;
    counts.set(company, (counts.get(company) || 0) + 1);
  }
  for (const error of errors) {
    const message = clean(error);
    for (const company of GENERIC_COMPANIES) {
      if (!message.startsWith(`${company}:`)) continue;
      errorByCompany.set(company, clean(message.slice(company.length + 1)));
      break;
    }
  }

  return GENERIC_SOURCES.map(({ company, provider }) => ({
    company,
    provider,
    sourceHealthy: !failed.has(company),
    qualifyingRoles: counts.get(company) || 0,
    error: errorByCompany.get(company) || ''
  }));
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

function overlayCompanySnapshot(jobs, company, snapshot) {
  if (!Array.isArray(snapshot)) return jobs;
  return dedupe([
    ...jobs.filter(job => clean(job?.company) !== company),
    ...snapshot
  ]);
}

async function applyAuthoritativeSnapshots(jobs) {
  let merged = jobs;
  const restoredByCompany = {};
  for (const { company, path } of AUTHORITATIVE_SNAPSHOTS) {
    let snapshot;
    try { snapshot = JSON.parse(await readFile(path, 'utf8')); }
    catch { continue; }
    if (!Array.isArray(snapshot)) continue;
    merged = overlayCompanySnapshot(merged, company, snapshot);
    restoredByCompany[company] = snapshot.length;
  }
  return { jobs: merged, restoredByCompany };
}

function countsBy(jobs, field) {
  return jobs.reduce((counts, job) => {
    const value = clean(job?.[field]) || 'unknown';
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

// collect-jobs-core.mjs rewrites collector-status.json with the current generic
// ATS scan. Preserve diagnostics owned by dedicated collectors (major Workday,
// DataBank, Cologix, Meta, etc.) so a generic refresh cannot silently erase the
// evidence used by source-health guards. Current generic top-level fields still
// win, and its errors remain current-run-only for failure preservation logic.
function mergeCollectorStatus(previousStatus = {}, currentGenericStatus = {}) {
  return {
    ...previousStatus,
    ...currentGenericStatus,
    genericDirectSources: {
      updatedAt: currentGenericStatus.updatedAt || new Date().toISOString(),
      jobs: Number(currentGenericStatus.jobs || 0),
      sourcesAttempted: Number(currentGenericStatus.sourcesAttempted || 0),
      providers: currentGenericStatus.providers || {},
      countsByType: currentGenericStatus.countsByType || {},
      countsByExperience: currentGenericStatus.countsByExperience || {},
      sourceDiagnostics: Array.isArray(currentGenericStatus.sourceDiagnostics) ? currentGenericStatus.sourceDiagnostics : [],
      errors: Array.isArray(currentGenericStatus.errors) ? currentGenericStatus.errors : []
    }
  };
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

  const sourceDiagnostics = buildGenericSourceDiagnostics(fresh, ['EdgeConneX: 503 upstream unavailable']);
  const serverfarmDiagnostic = sourceDiagnostics.find(item => item.company === 'Serverfarm');
  const flexentialDiagnostic = sourceDiagnostics.find(item => item.company === 'Flexential');
  const edgeconnexDiagnostic = sourceDiagnostics.find(item => item.company === 'EdgeConneX');
  if (!serverfarmDiagnostic?.sourceHealthy || serverfarmDiagnostic.qualifyingRoles !== 1) throw new Error('healthy generic source role count was not diagnosed');
  if (!flexentialDiagnostic?.sourceHealthy || flexentialDiagnostic.qualifyingRoles !== 0) throw new Error('healthy zero-result generic source was not diagnosed distinctly');
  if (edgeconnexDiagnostic?.sourceHealthy !== false || !edgeconnexDiagnostic.error.includes('503')) throw new Error('failed generic source was not diagnosed with its error');
  if (sourceDiagnostics.length !== GENERIC_SOURCES.length) throw new Error('generic source diagnostics do not cover every configured source');

  const genericCologix = [
    ...fresh,
    { id:'generic-cologix', company:'Cologix', title:'Data Center Technician', location:'Columbus, OH', sourceUrl:'https://jobs.lever.co/cologix/generic', active:true, demo:false }
  ];
  const verifiedCologix = [
    { id:'verified-cologix', company:'Cologix', title:'Data Center Technician', location:'Columbus, OH', sourceUrl:'https://jobs.lever.co/cologix/verified', active:true, demo:false }
  ];
  const overlaid = overlayCompanySnapshot(genericCologix, 'Cologix', verifiedCologix);
  if (!overlaid.some(job => job.id === 'verified-cologix')) throw new Error('authoritative Cologix snapshot was not restored');
  if (overlaid.some(job => job.id === 'generic-cologix')) throw new Error('generic Cologix role survived authoritative overlay');
  const authoritativeEmpty = overlayCompanySnapshot(genericCologix, 'Cologix', []);
  if (authoritativeEmpty.some(job => job.company === 'Cologix')) throw new Error('authoritative empty Cologix snapshot did not clear stale generic roles');

  const previousStatus = {
    jobs: 688,
    errors: ['CoreSite Careers: 403 listing'],
    majorSources: { attempted: 6, succeeded: 6, jobs: 217 },
    dataBank: { sourceHealthy: true, qualifyingRoles: 17 },
    cologix: { sourceHealthy: true, qualifyingRoles: 9 }
  };
  const currentGenericStatus = {
    updatedAt: '2026-09-09T06:00:00.000Z',
    jobs: 42,
    sourcesAttempted: 17,
    providers: { lever: 7, greenhouse: 5, ashby: 5 },
    countsByType: { 'entry-level': 40, internship: 2 },
    countsByExperience: { '0-2-years': 25, '2-5-years': 17 },
    sourceDiagnostics,
    errors: ['EdgeConneX: 503 upstream unavailable']
  };
  const mergedStatus = mergeCollectorStatus(previousStatus, currentGenericStatus);
  if (mergedStatus.majorSources?.jobs !== 217) throw new Error('generic status merge erased major Workday diagnostics');
  if (mergedStatus.dataBank?.qualifyingRoles !== 17) throw new Error('generic status merge erased DataBank diagnostics');
  if (mergedStatus.cologix?.qualifyingRoles !== 9) throw new Error('generic status merge erased Cologix diagnostics');
  if (mergedStatus.jobs !== 42 || mergedStatus.sourcesAttempted !== 17) throw new Error('current generic status did not remain authoritative for current-run fields');
  if (mergedStatus.genericDirectSources?.sourceDiagnostics?.length !== GENERIC_SOURCES.length) throw new Error('generic per-source diagnostics were not namespaced');
  if (mergedStatus.genericDirectSources?.errors?.[0] !== 'EdgeConneX: 503 upstream unavailable') throw new Error('generic status diagnostics were not namespaced');
  if (mergedStatus.errors?.[0] !== 'EdgeConneX: 503 upstream unavailable') throw new Error('current generic errors were not kept current-run-only');

  console.log('Generic source failure, per-source health, authoritative overlay, and collector-status preservation regression tests passed.');
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
const previousStatus = await readJson(STATUS_PATH, {});
await import('./collect-jobs-core.mjs');
const fresh = await readJson(JOBS_PATH, []);
const currentGenericStatus = await readJson(STATUS_PATH, {});
const errors = Array.isArray(currentGenericStatus?.errors) ? currentGenericStatus.errors : [];
currentGenericStatus.sourceDiagnostics = buildGenericSourceDiagnostics(fresh, errors);
const status = mergeCollectorStatus(previousStatus, currentGenericStatus);
const result = preserveFailedSources(previous, fresh, errors);
const authoritative = await applyAuthoritativeSnapshots(result.jobs);

const now = Date.now();
for (const job of authoritative.jobs) {
  if (job?.postedAt) {
    const timestamp = new Date(job.postedAt).getTime();
    if (Number.isFinite(timestamp)) job.postedHours = Math.max(0, Math.round((now - timestamp) / 36e5));
  }
}

const nextStatus = {
  ...status,
  jobs: authoritative.jobs.length,
  countsByType: countsBy(authoritative.jobs, 'type'),
  countsByExperience: countsBy(authoritative.jobs, 'experience'),
  sourceFailurePreservation: {
    checkedAt: new Date().toISOString(),
    failedSources: result.failed,
    preservedJobs: Object.values(result.preservedByCompany).reduce((sum, count) => sum + count, 0),
    preservedByCompany: result.preservedByCompany,
    policy: 'Preserve last verified roles only for generic ATS providers that failed to fetch; successful zero-result refreshes remain authoritative.'
  },
  authoritativeSnapshotOverlay: {
    checkedAt: new Date().toISOString(),
    restoredByCompany: authoritative.restoredByCompany,
    policy: 'Dedicated employer-direct snapshots replace overlapping generic ATS results before later publication gates.'
  }
};

await writeFile(JOBS_PATH, JSON.stringify(authoritative.jobs, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(nextStatus, null, 2) + '\n');

const sourceSummary = currentGenericStatus.sourceDiagnostics
  .map(item => `${item.company}=${item.sourceHealthy ? item.qualifyingRoles : 'ERROR'}`)
  .join(', ');
console.log(`Generic source health: ${sourceSummary}`);
if (result.failed.length) {
  console.warn(`Preserved ${nextStatus.sourceFailurePreservation.preservedJobs} prior role(s) across failed generic source(s): ${result.failed.join(', ')}`);
} else {
  console.log('Generic employer-direct refresh completed without source-failure preservation.');
}
if (Object.keys(authoritative.restoredByCompany).length) {
  console.log(`Restored authoritative employer snapshots: ${Object.entries(authoritative.restoredByCompany).map(([company, count]) => `${company}=${count}`).join(', ')}`);
}
