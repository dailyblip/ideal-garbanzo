import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const args = new Set(process.argv.slice(2));

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function countsBy(records, field) {
  return records.reduce((counts, job) => {
    const value = clean(job?.[field]) || 'unknown';
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function syncMajorPublicationMetrics(jobs, status) {
  const employers = Array.isArray(status?.majorSources?.employers)
    ? status.majorSources.employers.map(clean).filter(Boolean)
    : [];
  if (!employers.length) return;

  const publishedByEmployer = Object.fromEntries(employers.map(company => [company, 0]));
  for (const job of jobs) {
    const company = clean(job?.company);
    if (Object.hasOwn(publishedByEmployer, company)) publishedByEmployer[company] += 1;
  }

  const diagnostics = status.majorSources.employerDiagnostics;
  if (diagnostics && typeof diagnostics === 'object' && !Array.isArray(diagnostics)) {
    for (const company of employers) {
      const current = diagnostics[company];
      if (!current || typeof current !== 'object' || Array.isArray(current)) continue;
      const publishedRoles = publishedByEmployer[company];
      const qualifyingRoles = Number(current.qualifyingRoles);
      diagnostics[company] = {
        ...current,
        publishedRoles,
        ...(Number.isFinite(qualifyingRoles)
          ? { publicationFilteredRoles: Math.max(0, qualifyingRoles - publishedRoles) }
          : {})
      };
    }
  }

  status.majorSources.publishedJobs = Object.values(publishedByEmployer)
    .reduce((sum, count) => sum + count, 0);
  status.majorSources.publishedByEmployer = publishedByEmployer;
}

function buildSyncedStatus(jobs, status, { includeMajor = false } = {}) {
  const next = structuredClone(status);
  next.jobs = jobs.length;
  next.countsByType = countsBy(jobs, 'type');
  next.countsByExperience = countsBy(jobs, 'experience');
  if (includeMajor) syncMajorPublicationMetrics(jobs, next);
  return next;
}

function runTests() {
  const jobs = [
    { company: 'Vantage Data Centers', type: 'entry-level', experience: '0-2-years' },
    { company: 'QTS Data Centers', type: 'entry-level', experience: '2-5-years' },
    { company: 'QTS Data Centers', type: 'internship', experience: '0-2-years' },
    { company: 'Other Operator', type: 'trainee', experience: 'no-experience' }
  ];
  const status = {
    jobs: 99,
    countsByType: { stale: 99 },
    countsByExperience: { stale: 99 },
    majorSources: {
      jobs: 5,
      employers: ['Vantage Data Centers', 'QTS Data Centers'],
      employerDiagnostics: {
        'Vantage Data Centers': { qualifyingRoles: 3, sourceHealthy: true },
        'QTS Data Centers': { qualifyingRoles: 2, sourceHealthy: true }
      }
    }
  };

  const aggregateOnly = buildSyncedStatus(jobs, status);
  const next = buildSyncedStatus(jobs, status, { includeMajor: true });
  const vantage = next.majorSources.employerDiagnostics['Vantage Data Centers'];
  const qts = next.majorSources.employerDiagnostics['QTS Data Centers'];
  const failures = [];

  if (aggregateOnly.majorSources.publishedJobs !== undefined) failures.push('default synchronization must not rewrite source diagnostics');
  if (next.jobs !== 4) failures.push(`expected 4 published jobs, got ${next.jobs}`);
  if (next.countsByType['entry-level'] !== 2 || next.countsByType.internship !== 1 || next.countsByType.trainee !== 1) {
    failures.push('aggregate type counts did not match the public feed');
  }
  if (next.majorSources.jobs !== 5) failures.push('raw majorSources.jobs must remain the collector snapshot count');
  if (next.majorSources.publishedJobs !== 3) failures.push(`expected 3 published major jobs, got ${next.majorSources.publishedJobs}`);
  if (next.majorSources.publishedByEmployer['Vantage Data Centers'] !== 1 || next.majorSources.publishedByEmployer['QTS Data Centers'] !== 2) {
    failures.push('per-employer published counts are wrong');
  }
  if (vantage.publishedRoles !== 1 || vantage.publicationFilteredRoles !== 2) {
    failures.push('Vantage publication diagnostics are wrong');
  }
  if (qts.publishedRoles !== 2 || qts.publicationFilteredRoles !== 0) {
    failures.push('QTS publication diagnostics are wrong');
  }
  if (status.majorSources.publishedJobs !== undefined) failures.push('sync must not mutate its input status object');

  if (failures.length) throw new Error(`Publication count regression: ${failures.join('; ')}`);
  console.log('Publication count synchronization passed aggregate and priority-employer regression cases.');
}

if (args.has('--test')) {
  runTests();
  process.exit(0);
}

const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
if (!Array.isArray(jobs)) throw new Error('data/jobs.json must contain an array.');
if (!status || typeof status !== 'object' || Array.isArray(status)) {
  throw new Error('data/collector-status.json must contain an object.');
}

const includeMajor = args.has('--major');
const nextStatus = buildSyncedStatus(jobs, status, { includeMajor });
const changed = JSON.stringify(status) !== JSON.stringify(nextStatus);

if (!changed) {
  console.log(`Publication counts already match the ${jobs.length}-job feed.`);
  process.exit(0);
}

await writeFile(STATUS_PATH, JSON.stringify(nextStatus, null, 2) + '\n');
const majorPublished = includeMajor ? Number(nextStatus?.majorSources?.publishedJobs) : NaN;
const majorSuffix = Number.isFinite(majorPublished)
  ? `; ${majorPublished} published priority Workday roles recorded by employer`
  : '';
console.log(`Publication counts synchronized to ${jobs.length} jobs${majorSuffix}.`);
