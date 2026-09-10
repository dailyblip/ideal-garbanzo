import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const MAJOR_PATH = 'data/major-jobs.json';
const STATUS_PATH = 'data/collector-status.json';

const majorCompanies = new Set([
  'Vantage Data Centers',
  'QTS Data Centers',
  'CyrusOne',
  'STACK Infrastructure',
  'NTT Global Data Centers',
  'Aligned Data Centers'
]);

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalize = value => clean(value)
  .toLowerCase()
  .replace(/[-_/]+/g, ' ')
  .replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function canonicalTitle(job) {
  let title = clean(job?.title);
  const location = normalize(job?.location);
  const locationTokens = new Set(location.split(' ').filter(token => token.length > 1));
  const tailBelongsToLocation = tail => {
    const tokens = normalize(tail).split(' ').filter(token => token.length > 1);
    return tokens.length > 0 && tokens.every(token => locationTokens.has(token));
  };

  title = title.replace(/^\s*\d{2,5}\s*[-–—]\s*/u, '');
  title = title.replace(/\s+[-–—]\s+([^|]+)$/u, (full, tail) => tailBelongsToLocation(tail) ? '' : full);
  title = title.replace(/\s*\(([^)]+)\)\s*$/u, (full, tail) => tailBelongsToLocation(tail) ? '' : full);
  title = title.replace(/\s*\([A-Z][A-Z0-9]{1,10}\)\s*$/u, '');
  title = title.replace(/\s*[-–—,:()]?\s*(?:day|night|overnight|weekend)\s+shift(?:\s*\d+)?\s*$/iu, '');
  return normalize(title);
}

function uniqueTitles(records) {
  return new Set(records.map(canonicalTitle).filter(Boolean));
}

function sameSet(a, b) {
  return a.size === b.size && [...a].every(value => b.has(value));
}

const titleRegression = canonicalTitle({
  title: 'Regional Data Center Controls Quality Engineer (CBQE)',
  location: 'Suwanee, GA'
});
if (titleRegression !== 'regional data center controls quality engineer') {
  throw new Error(`Major reconciliation title regression: ${titleRegression}`);
}

const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
const majorSnapshot = JSON.parse(await readFile(MAJOR_PATH, 'utf8'));
const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
if (!Array.isArray(jobs) || !Array.isArray(majorSnapshot) || !majorSnapshot.length) {
  throw new Error('Major reconciliation sync requires non-empty jobs and major-jobs arrays.');
}

const reconciliation = status?.majorSources?.reconciliation;
const publishedUsJobs = Number(reconciliation?.publishedUsJobs);
if (!Number.isFinite(publishedUsJobs)) {
  console.log('Major reconciliation sync skipped: no finite publishedUsJobs marker exists.');
  process.exit(0);
}

if (publishedUsJobs <= majorSnapshot.length) {
  // A smaller marker is an intentional coverage mode used by additive targeted
  // recovery. Never promote that state to exact parity here.
  console.log(`Major reconciliation sync not needed: status=${publishedUsJobs}, snapshot=${majorSnapshot.length}.`);
  process.exit(0);
}

const publicMajor = jobs.filter(job => majorCompanies.has(clean(job?.company)));
const snapshotUrls = new Set(majorSnapshot.map(job => clean(job?.sourceUrl)).filter(Boolean));
const untraceable = publicMajor.filter(job => !snapshotUrls.has(clean(job?.sourceUrl)));
if (untraceable.length) {
  throw new Error(`Refusing to lower the reconciliation marker: ${untraceable.length} public major-employer role(s) are missing from the snapshot.`);
}

for (const company of majorCompanies) {
  const snapshotTitles = uniqueTitles(majorSnapshot.filter(job => clean(job?.company) === company));
  const publicTitles = uniqueTitles(publicMajor.filter(job => clean(job?.company) === company));
  if (!sameSet(snapshotTitles, publicTitles)) {
    throw new Error(`Refusing to lower the reconciliation marker: ${company} title parity is not exact (${publicTitles.size} public / ${snapshotTitles.size} snapshot).`);
  }
}

const previousPublishedUsJobs = publishedUsJobs;
reconciliation.publishedUsJobs = majorSnapshot.length;
reconciliation.publicationGuardAdjustedAt = new Date().toISOString();
reconciliation.publicationGuardPreviousPublishedUsJobs = previousPublishedUsJobs;
reconciliation.publicationGuardReason = 'snapshot-pruned-after-reconciliation';
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
console.log(`Major reconciliation marker repaired from ${previousPublishedUsJobs} to ${majorSnapshot.length} after exact public/snapshot title and source parity checks.`);
