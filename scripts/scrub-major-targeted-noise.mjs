import { readFile, writeFile } from 'node:fs/promises';

// Targeted Workday recovery is intentionally broad so it can find roles missed
// by an employer's default listing. Keep a final, source-specific publication
// gate here so broad internship/operations searches cannot reintroduce
// enterprise IT, analytics, finance, legal, accounting or other corporate roles
// that the main Workday collector already rejects.
const TARGETED_EMPLOYERS = new Set([
  'Vantage Data Centers',
  'QTS Data Centers',
  'CyrusOne',
  'STACK Infrastructure',
  'NTT Global Data Centers',
  'Aligned Data Centers'
]);

const CORPORATE_TITLE_TERMS = [
  'enterprise applications',
  'enterprise it support',
  'process analytics',
  'business analyst',
  'financial operations',
  'financial analyst',
  'finance analyst',
  'accounting',
  'accountant',
  'finance',
  'legal',
  'paralegal',
  'law clerk',
  'procurement',
  'purchasing',
  'security operations',
  'security engineer',
  'cybersecurity',
  'information security',
  'software engineer',
  'software developer',
  'site reliability engineer',
  'machine learning engineer',
  'data scientist',
  'talent acquisition',
  'human resources',
  'marketing specialist'
];

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const lower = value => clean(value).toLowerCase();
const hasCorporateTitle = title => CORPORATE_TITLE_TERMS.some(term => lower(title).includes(term));
const shouldRemove = job => TARGETED_EMPLOYERS.has(clean(job?.company)) && hasCorporateTitle(job?.title);

function scrub(records) {
  const removed = [];
  const kept = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (shouldRemove(record)) removed.push(record);
    else kept.push(record);
  }
  return { kept, removed };
}

if (process.argv.includes('--test')) {
  const fixtures = [
    {
      title: 'Summer 2027 Internship: Enterprise Applications (SharePoint Access) Intern',
      company: 'QTS Data Centers',
      remove: true
    },
    {
      title: 'Summer 2027 Internship: Process Analytics - Technology Delivery Team',
      company: 'QTS Data Centers',
      remove: true
    },
    {
      title: 'Summer 2027 Internship: Corporate Accounting',
      company: 'QTS Data Centers',
      remove: true
    },
    {
      title: 'Summer 2027 Internship: Legal Assistant',
      company: 'QTS Data Centers',
      remove: true
    },
    {
      title: 'Summer Internship: Data Center Infrastructure Projects',
      company: 'QTS Data Centers',
      remove: false
    },
    {
      title: 'Critical Operations Technician I',
      company: 'Vantage Data Centers',
      remove: false
    },
    {
      title: 'Enterprise Applications Intern',
      company: 'Unrelated Company',
      remove: false
    }
  ];
  const failures = fixtures.filter(fixture => shouldRemove(fixture) !== fixture.remove);
  if (failures.length) {
    for (const failure of failures) console.error(`Targeted publication scrub regression failed: ${failure.company} — ${failure.title}`);
    process.exit(1);
  }
  console.log(`Targeted publication scrub passed ${fixtures.length} regression cases.`);
  process.exit(0);
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

const jobs = await readJson('data/jobs.json', []);
const majorJobs = await readJson('data/major-jobs.json', []);
const status = await readJson('data/collector-status.json', {});
if (!Array.isArray(jobs) || !Array.isArray(majorJobs)) throw new Error('Expected jobs and major-jobs snapshots to be arrays.');

const jobsResult = scrub(jobs);
const majorResult = scrub(majorJobs);
const removedByUrl = new Map(
  [...jobsResult.removed, ...majorResult.removed]
    .map(job => [clean(job?.sourceUrl), job])
    .filter(([url]) => Boolean(url))
);
const removed = [...removedByUrl.values()];

if (removed.length) {
  await writeFile('data/jobs.json', JSON.stringify(jobsResult.kept, null, 2) + '\n');
  await writeFile('data/major-jobs.json', JSON.stringify(majorResult.kept, null, 2) + '\n');
}

if (status?.majorTargetedRecovery && typeof status.majorTargetedRecovery === 'object') {
  const recoveredRoles = Array.isArray(status.majorTargetedRecovery.recoveredRoles)
    ? status.majorTargetedRecovery.recoveredRoles.filter(role => !shouldRemove(role))
    : [];
  status.majorTargetedRecovery.recoveredRoles = recoveredRoles;
  status.majorTargetedRecovery.recovered = recoveredRoles.length;
  status.majorTargetedRecovery.publicationScrub = {
    checkedAt: new Date().toISOString(),
    removed: removed.length,
    removedRoles: removed.map(job => ({
      company: clean(job.company),
      title: clean(job.title),
      location: clean(job.location),
      sourceUrl: clean(job.sourceUrl)
    })),
    policy: 'Reject corporate title families from targeted major-employer recovery before publication.'
  };
  await writeFile('data/collector-status.json', JSON.stringify(status, null, 2) + '\n');
}

if (removed.length) {
  console.log(`Targeted publication scrub removed ${removed.length} corporate-noise role(s): ${removed.map(job => `${job.company} — ${job.title}`).join('; ')}`);
} else {
  console.log('Targeted publication scrub found no corporate-noise roles to remove.');
}
