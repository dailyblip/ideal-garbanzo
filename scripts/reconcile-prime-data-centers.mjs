import { readFile, writeFile } from 'node:fs/promises';

const COMPANY = 'Prime Data Centers';
const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/prime-data-centers-jobs.json';
const STATUS_PATH = 'data/collector-status.json';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

const [jobs, snapshot, status] = await Promise.all([
  JSON.parse(await readFile(JOBS_PATH, 'utf8')),
  JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8')),
  JSON.parse(await readFile(STATUS_PATH, 'utf8'))
]);

if (!Array.isArray(jobs) || !Array.isArray(snapshot)) throw new Error('Prime reconciliation requires array feed and snapshot data.');
if (!status?.primeDataCenters) throw new Error('Prime reconciliation requires primeDataCenters collector diagnostics.');

const compensationSanitized = [];
for (const job of jobs) {
  if (clean(job?.company) !== COMPANY) continue;

  // Rippling descriptions sometimes express annual salary in shorthand such as
  // "$130-180k". The first-pass parser intentionally avoids guessing the missing
  // unit, but that shorthand can otherwise be misread as an unusually high hourly
  // range. Fail closed here rather than publish a materially wrong compensation
  // claim. Normal hourly technician ranges remain untouched.
  const min = Number(job?.salaryMin);
  const max = Number(job?.salaryMax);
  const suspiciousHourlyShorthand = /\/\s*hr\b/i.test(clean(job?.pay))
    && Number.isFinite(min)
    && Number.isFinite(max)
    && min >= 100
    && max < 1000;

  if (suspiciousHourlyShorthand) {
    compensationSanitized.push(clean(job?.title));
    job.pay = '';
    job.salaryMin = null;
    job.salaryMax = null;
    job.salarySortMax = null;
  }
}

const published = jobs.filter(job => clean(job?.company) === COMPANY);
const publishedIds = new Set(published.map(job => clean(job?.id)).filter(Boolean));
const removed = snapshot.filter(job => !publishedIds.has(clean(job?.id)));

status.primeDataCenters.qualifyingRolesBeforePublicationGate = snapshot.length;
status.primeDataCenters.qualifyingRoles = published.length;
status.primeDataCenters.publicationFilteredRoles = removed.length;
status.primeDataCenters.publicationFilteredTitles = removed.map(job => clean(job?.title)).filter(Boolean).slice(0, 20);
status.primeDataCenters.publicationGate = 'Shared mission-fit backstop is authoritative for the public Prime snapshot.';
status.primeDataCenters.compensationSanitizedRoles = compensationSanitized.length;
status.primeDataCenters.compensationSanitizedTitles = compensationSanitized.slice(0, 20);
status.primeDataCenters.compensationPolicy = 'Ambiguous three-digit hourly-looking ranges are suppressed instead of guessing whether source shorthand means thousands per year.';

await writeFile(JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n');
await writeFile(SNAPSHOT_PATH, JSON.stringify(published, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

console.log(`Prime publication reconciliation retained ${published.length}/${snapshot.length} collector-qualified role(s); ${removed.length} removed by the shared mission-fit backstop; ${compensationSanitized.length} ambiguous compensation range(s) suppressed.`);
