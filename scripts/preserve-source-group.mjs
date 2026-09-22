import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';

export function parseCompanies(value) {
  const companies = String(value || '')
    .split('|')
    .map(item => item.trim())
    .filter(Boolean);
  if (!companies.length) throw new Error('At least one source company is required.');
  return [...new Set(companies)];
}

function stableKey(job = {}) {
  const id = String(job.id || '').trim();
  if (id) return `id:${id}`;
  const url = String(job.sourceUrl || '').trim();
  if (url) return `url:${url}`;
  return '';
}

function isSource(job, sourceCompanies) {
  return sourceCompanies.has(String(job?.company || '').trim());
}

export function preserveSourceGroup(currentJobs, baselineJobs, sourceCompanyNames) {
  const sourceCompanies = new Set(sourceCompanyNames);
  if (!sourceCompanies.size) throw new Error('At least one source company is required.');

  const currentByKey = new Map();
  const currentSourceByKey = new Map();
  const baselineNonSourceKeys = new Set();

  for (const job of currentJobs) {
    const key = stableKey(job);
    if (key && !currentByKey.has(key)) currentByKey.set(key, job);
    if (isSource(job, sourceCompanies) && key && !currentSourceByKey.has(key)) {
      currentSourceByKey.set(key, job);
    }
  }

  for (const job of baselineJobs) {
    if (isSource(job, sourceCompanies)) continue;
    const key = stableKey(job);
    if (key) baselineNonSourceKeys.add(key);
  }

  const ordered = [];
  const usedSourceKeys = new Set();
  let restoredChanged = 0;
  let restoredMissing = 0;
  let droppedNonSourceAdditions = 0;

  for (const prior of baselineJobs) {
    const key = stableKey(prior);
    if (isSource(prior, sourceCompanies)) {
      const currentSource = key ? currentSourceByKey.get(key) : null;
      if (!currentSource) continue;
      ordered.push(currentSource);
      if (key) usedSourceKeys.add(key);
      continue;
    }

    const current = key ? currentByKey.get(key) : null;
    if (!current) restoredMissing += 1;
    else if (JSON.stringify(current) !== JSON.stringify(prior)) restoredChanged += 1;
    ordered.push(prior);
  }

  for (const job of currentJobs) {
    if (isSource(job, sourceCompanies)) {
      const key = stableKey(job);
      if (key && usedSourceKeys.has(key)) continue;
      ordered.push(job);
      if (key) usedSourceKeys.add(key);
      continue;
    }

    const key = stableKey(job);
    if (!key || !baselineNonSourceKeys.has(key)) droppedNonSourceAdditions += 1;
  }

  return {
    jobs: ordered,
    restoredChanged,
    restoredMissing,
    droppedNonSourceAdditions
  };
}

export function verifyNonSourceBoundary(currentJobs, baselineJobs, sourceCompanyNames) {
  const sourceCompanies = new Set(sourceCompanyNames);
  const currentNonSource = currentJobs.filter(job => !isSource(job, sourceCompanies));
  const baselineNonSource = baselineJobs.filter(job => !isSource(job, sourceCompanies));
  return JSON.stringify(currentNonSource) === JSON.stringify(baselineNonSource);
}

function runTests() {
  const companies = parseCompanies('Vantage Data Centers|QTS Data Centers|Vantage Data Centers');
  if (companies.join('|') !== 'Vantage Data Centers|QTS Data Centers') {
    throw new Error('source company parser must trim and deduplicate names');
  }

  const baseline = [
    { id: 'aws-1', company: 'Amazon Web Services', postedHours: 12, tags: ['baseline'] },
    { id: 'vantage-1', company: 'Vantage Data Centers', postedHours: 4, tags: ['old'] },
    { id: 'ms-1', company: 'Microsoft', postedHours: 8 },
    { id: 'qts-removed', company: 'QTS Data Centers', postedHours: 20 }
  ];
  const current = [
    { id: 'aws-1', company: 'Amazon Web Services', postedHours: 13, tags: ['mutated'] },
    { id: 'vantage-1', company: 'Vantage Data Centers', postedHours: 5, tags: ['fresh'] },
    { id: 'google-added', company: 'Google', postedHours: 1 },
    { id: 'qts-new', company: 'QTS Data Centers', postedHours: 1, tags: ['new'] }
  ];

  const result = preserveSourceGroup(current, baseline, companies);
  const byId = new Map(result.jobs.map(job => [job.id, job]));
  if (JSON.stringify(byId.get('aws-1')) !== JSON.stringify(baseline[0])) {
    throw new Error('source-group isolation did not restore a mutated non-source job exactly');
  }
  if (JSON.stringify(byId.get('ms-1')) !== JSON.stringify(baseline[2])) {
    throw new Error('source-group isolation did not restore a removed non-source job');
  }
  if (byId.has('google-added')) throw new Error('source-group isolation retained an unrelated new job');
  if (byId.has('qts-removed')) throw new Error('source-group isolation resurrected a removed source job');
  if (byId.get('vantage-1')?.postedHours !== 5 || byId.get('vantage-1')?.tags?.[0] !== 'fresh') {
    throw new Error('source-group isolation overwrote refreshed source content');
  }
  if (!byId.has('qts-new')) throw new Error('source-group isolation dropped a new source job');
  if (result.jobs.map(job => job.id).join(',') !== 'aws-1,vantage-1,ms-1,qts-new') {
    throw new Error('source-group isolation did not preserve baseline positions while appending new source jobs');
  }
  if (result.restoredChanged !== 1 || result.restoredMissing !== 1 || result.droppedNonSourceAdditions !== 1) {
    throw new Error('source-group isolation counters are incorrect');
  }
  if (!verifyNonSourceBoundary(result.jobs, baseline, companies)) {
    throw new Error('source-group isolation verification failed after restoration');
  }

  console.log('Source-group feed isolation tests passed.');
}

if (process.argv.includes('--test')) {
  runTests();
} else {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes('--verify');
  const positional = args.filter(arg => arg !== '--verify');
  const sourceCompanyNames = parseCompanies(positional[0]);
  const baselinePath = String(positional[1] || '').trim();
  const jobsPath = String(positional[2] || JOBS_PATH).trim();
  if (!baselinePath) {
    throw new Error('Usage: node scripts/preserve-source-group.mjs <company1|company2|...> <baseline jobs path> [jobs path] [--verify]');
  }

  const baselineJobs = JSON.parse(await readFile(baselinePath, 'utf8'));
  const currentJobs = JSON.parse(await readFile(jobsPath, 'utf8'));
  if (!Array.isArray(baselineJobs) || !Array.isArray(currentJobs)) {
    throw new Error('Source-group isolation requires array-shaped baseline and current job feeds.');
  }

  if (verifyOnly) {
    if (!verifyNonSourceBoundary(currentJobs, baselineJobs, sourceCompanyNames)) {
      throw new Error(`Source-group boundary violation: non-source jobs changed while refreshing ${sourceCompanyNames.join(', ')}.`);
    }
    console.log(`Source-group boundary verified for ${sourceCompanyNames.length} employer(s); non-source jobs are byte-for-byte unchanged.`);
    process.exit(0);
  }

  const result = preserveSourceGroup(currentJobs, baselineJobs, sourceCompanyNames);
  await writeFile(jobsPath, JSON.stringify(result.jobs, null, 2) + '\n');
  console.log(
    `Reapplied ${sourceCompanyNames.length}-employer source boundary: ` +
    `${result.restoredChanged} mutated and ${result.restoredMissing} removed non-source role(s) restored; ` +
    `${result.droppedNonSourceAdditions} unrelated addition(s) dropped.`
  );
}
