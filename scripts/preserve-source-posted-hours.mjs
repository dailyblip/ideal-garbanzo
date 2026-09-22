import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';

function stableKey(job = {}) {
  const id = String(job.id || '').trim();
  if (id) return `id:${id}`;
  const url = String(job.sourceUrl || '').trim();
  if (url) return `url:${url}`;
  return '';
}

function restoreBaselineOrder(currentJobs, baselineJobs) {
  const currentByKey = new Map();
  for (const job of currentJobs) {
    const key = stableKey(job);
    if (key && !currentByKey.has(key)) currentByKey.set(key, job);
  }

  const ordered = [];
  const used = new Set();
  for (const prior of baselineJobs) {
    const key = stableKey(prior);
    const current = key ? currentByKey.get(key) : null;
    if (!current || used.has(current)) continue;
    ordered.push(current);
    used.add(current);
  }

  for (const job of currentJobs) {
    if (used.has(job)) continue;
    ordered.push(job);
    used.add(job);
  }
  return ordered;
}

export function preserveNonSourcePostedHours(currentJobs, baselineJobs, sourceCompany) {
  if (!sourceCompany) throw new Error('sourceCompany is required');

  const baseline = new Map();
  for (const job of baselineJobs) {
    if (job?.company === sourceCompany) continue;
    const key = stableKey(job);
    if (key) baseline.set(key, job);
  }

  let restored = 0;
  let removed = 0;
  for (const job of currentJobs) {
    if (job?.company === sourceCompany) continue;
    const key = stableKey(job);
    const prior = key ? baseline.get(key) : null;
    if (!prior) continue;

    if (Object.prototype.hasOwnProperty.call(prior, 'postedHours')) {
      if (job.postedHours !== prior.postedHours) {
        job.postedHours = prior.postedHours;
        restored += 1;
      }
    } else if (Object.prototype.hasOwnProperty.call(job, 'postedHours')) {
      delete job.postedHours;
      removed += 1;
    }
  }

  return { jobs: restoreBaselineOrder(currentJobs, baselineJobs), restored, removed };
}

export function preserveNonSourceJobs(currentJobs, baselineJobs, sourceCompany) {
  if (!sourceCompany) throw new Error('sourceCompany is required');

  const currentByKey = new Map();
  const currentSourceByKey = new Map();
  const baselineNonSourceKeys = new Set();
  for (const job of currentJobs) {
    const key = stableKey(job);
    if (key && !currentByKey.has(key)) currentByKey.set(key, job);
    if (job?.company === sourceCompany && key && !currentSourceByKey.has(key)) {
      currentSourceByKey.set(key, job);
    }
  }
  for (const job of baselineJobs) {
    if (job?.company === sourceCompany) continue;
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
    if (prior?.company === sourceCompany) {
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
    if (job?.company === sourceCompany) {
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

function runTests() {
  const baseline = [
    { id: 'aws-1', company: 'Amazon Web Services', postedHours: 12 },
    { id: 'oracle-1', company: 'Oracle', postedHours: 4 },
    { id: 'ms-1', company: 'Microsoft' }
  ];
  const current = [
    { id: 'aws-1', company: 'Amazon Web Services', postedHours: 13 },
    { id: 'ms-1', company: 'Microsoft', postedHours: 9999 },
    { id: 'oracle-1', company: 'Oracle', postedHours: 5 },
    { id: 'oracle-2', company: 'Oracle', postedHours: 1 }
  ];

  const result = preserveNonSourcePostedHours(current, baseline, 'Oracle');
  const byId = new Map(result.jobs.map(job => [job.id, job]));
  if (byId.get('aws-1').postedHours !== 12) throw new Error('non-source postedHours was not restored');
  if (Object.prototype.hasOwnProperty.call(byId.get('ms-1'), 'postedHours')) throw new Error('non-source synthetic postedHours was not removed');
  if (byId.get('oracle-1').postedHours !== 5) throw new Error('source postedHours must remain current');
  if (result.restored !== 1 || result.removed !== 1) throw new Error('change counters are incorrect');
  if (result.jobs.map(job => job.id).join(',') !== 'aws-1,oracle-1,ms-1,oracle-2') {
    throw new Error('existing source roles must retain baseline feed position while new source roles append safely');
  }

  const fullBaseline = [
    { id: 'aws-1', company: 'Amazon Web Services', postedHours: 12, tags: ['baseline'] },
    { id: 'oracle-1', company: 'Oracle', postedHours: 4, tags: ['old'] },
    { id: 'ms-1', company: 'Microsoft', postedHours: 8 },
    { id: 'oracle-removed', company: 'Oracle', postedHours: 20 }
  ];
  const fullCurrent = [
    { id: 'aws-1', company: 'Amazon Web Services', postedHours: 13, tags: ['mutated'] },
    { id: 'oracle-1', company: 'Oracle', postedHours: 5, tags: ['fresh'] },
    { id: 'google-added', company: 'Google', postedHours: 1 },
    { id: 'oracle-new', company: 'Oracle', postedHours: 1, tags: ['new'] }
  ];
  const fullResult = preserveNonSourceJobs(fullCurrent, fullBaseline, 'Oracle');
  const fullById = new Map(fullResult.jobs.map(job => [job.id, job]));
  if (JSON.stringify(fullById.get('aws-1')) !== JSON.stringify(fullBaseline[0])) {
    throw new Error('full source isolation did not restore a mutated non-source job exactly');
  }
  if (JSON.stringify(fullById.get('ms-1')) !== JSON.stringify(fullBaseline[2])) {
    throw new Error('full source isolation did not restore a removed non-source job');
  }
  if (fullById.has('google-added')) throw new Error('full source isolation retained an unrelated newly-added job');
  if (fullById.has('oracle-removed')) throw new Error('full source isolation resurrected a removed source job');
  if (fullById.get('oracle-1')?.postedHours !== 5 || fullById.get('oracle-1')?.tags?.[0] !== 'fresh') {
    throw new Error('full source isolation overwrote refreshed source content');
  }
  if (!fullById.has('oracle-new')) throw new Error('full source isolation dropped a newly-added source job');
  if (fullResult.jobs.map(job => job.id).join(',') !== 'aws-1,oracle-1,ms-1,oracle-new') {
    throw new Error('full source isolation did not preserve baseline positions while appending new source jobs');
  }
  if (fullResult.restoredChanged !== 1 || fullResult.restoredMissing !== 1 || fullResult.droppedNonSourceAdditions !== 1) {
    throw new Error('full source-isolation counters are incorrect');
  }

  console.log('Source-scoped posted-hours, feed-order, and full non-source isolation tests passed.');
}

if (process.argv.includes('--test')) {
  runTests();
} else {
  const args = process.argv.slice(2);
  const fullIsolation = args.includes('--full');
  const positional = args.filter(arg => arg !== '--full');
  const sourceCompany = String(positional[0] || '').trim();
  const baselinePath = String(positional[1] || '').trim();
  const jobsPath = String(positional[2] || JOBS_PATH).trim();
  if (!sourceCompany || !baselinePath) {
    throw new Error('Usage: node scripts/preserve-source-posted-hours.mjs <source company> <baseline jobs path> [jobs path] [--full]');
  }

  const baselineJobs = JSON.parse(await readFile(baselinePath, 'utf8'));
  const currentJobs = JSON.parse(await readFile(jobsPath, 'utf8'));
  if (fullIsolation) {
    const result = preserveNonSourceJobs(currentJobs, baselineJobs, sourceCompany);
    await writeFile(jobsPath, JSON.stringify(result.jobs, null, 2) + '\n');
    console.log(`Reapplied ${sourceCompany} source boundary: ${result.restoredChanged} mutated and ${result.restoredMissing} removed non-source role(s) restored; ${result.droppedNonSourceAdditions} unrelated addition(s) dropped.`);
  } else {
    const result = preserveNonSourcePostedHours(currentJobs, baselineJobs, sourceCompany);
    await writeFile(jobsPath, JSON.stringify(result.jobs, null, 2) + '\n');
    console.log(`Preserved non-${sourceCompany} postedHours values: ${result.restored} restored, ${result.removed} removed; existing feed order retained.`);
  }
}
