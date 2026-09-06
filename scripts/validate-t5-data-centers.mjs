import { readFile } from 'node:fs/promises';

const SNAPSHOT_PATH = 'data/t5-data-centers-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'T5 Data Centers';
const BOARD_ROOT = 'https://jobs.lever.co/t5datacenters/';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalize = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const allowedTypes = new Set(['entry-level', 'apprenticeship', 'internship', 'trainee']);
const allowedExperience = new Set(['no-experience', '0-2-years', '2-5-years']);
const missionTitlePattern = /\b(?:jr\.?\s+critical facilities technician|critical facilities technician|critical maintenance technician|general maintenance technician|data cent(?:er|re) facilities operator|electrical apprentice|mechanical apprentice|facilities technician|facility technician)\b/i;
const excludedTitlePattern = /\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|superintendent|foreman|journeyman|subject matter expert|sme)\b/i;

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
  title = title.replace(/\s*[-–—,:()]?\s*(?:day|night|overnight|weekend)\s+shift(?:\s*\d+)?\s*$/iu, '');
  return normalize(title);
}

const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));

const failures = [];
if (!Array.isArray(snapshot) || snapshot.length === 0) failures.push('T5 snapshot must be a non-empty array.');
if (!Array.isArray(jobs)) failures.push('jobs.json must contain an array.');

const ids = new Set();
const urls = new Set();
const identities = new Set();

for (const job of Array.isArray(snapshot) ? snapshot : []) {
  const id = clean(job?.id);
  const title = clean(job?.title);
  const location = clean(job?.location);
  const sourceUrl = clean(job?.sourceUrl);
  const identity = [COMPANY, title, location].map(normalize).join('|');

  if (clean(job?.company) !== COMPANY) failures.push(`${id || title}: wrong company.`);
  if (job?.active !== true) failures.push(`${id || title}: active must be true.`);
  if (job?.demo !== false) failures.push(`${id || title}: demo must be false.`);
  if (!allowedTypes.has(clean(job?.type))) failures.push(`${id || title}: invalid type ${clean(job?.type)}.`);
  if (!allowedExperience.has(clean(job?.experience))) failures.push(`${id || title}: invalid experience ${clean(job?.experience)}.`);
  if (clean(job?.source) !== 'Employer career site') failures.push(`${id || title}: source must be Employer career site.`);
  if (!sourceUrl.startsWith(BOARD_ROOT)) failures.push(`${id || title}: source URL is not the official T5 Lever board.`);
  if (!missionTitlePattern.test(title)) failures.push(`${id || title}: title is outside the approved mission-fit families.`);
  if (excludedTitlePattern.test(title)) failures.push(`${id || title}: senior/supervisory title leaked into snapshot.`);
  if (!location) failures.push(`${id || title}: location missing.`);

  if (!id) failures.push(`${title || sourceUrl}: id missing.`);
  else if (ids.has(id)) failures.push(`${id}: duplicate id in T5 snapshot.`);
  else ids.add(id);

  if (!sourceUrl) failures.push(`${id || title}: source URL missing.`);
  else if (urls.has(sourceUrl)) failures.push(`${id || title}: duplicate source URL in T5 snapshot.`);
  else urls.add(sourceUrl);

  if (identities.has(identity)) failures.push(`${id || title}: duplicate title/location identity in T5 snapshot.`);
  else identities.add(identity);
}

// The public feed intentionally collapses same-employer/same-title postings,
// even when T5 publishes separate requisitions for different locations or
// shifts. Protect source coverage by unique role title rather than requiring
// every requisition to remain as a separate public card.
const snapshotTitles = new Set((Array.isArray(snapshot) ? snapshot : []).map(canonicalTitle).filter(Boolean));
const publicT5Jobs = (Array.isArray(jobs) ? jobs : []).filter(job => clean(job?.company) === COMPANY);
const publicTitles = new Set(publicT5Jobs.map(canonicalTitle).filter(Boolean));
const missingTitles = [...snapshotTitles].filter(title => !publicTitles.has(title));
if (missingTitles.length) {
  failures.push(`${missingTitles.length}/${snapshotTitles.size} verified unique T5 role title(s) are missing from jobs.json.`);
}
for (const job of publicT5Jobs) {
  if (!clean(job?.sourceUrl).startsWith(BOARD_ROOT)) failures.push(`${clean(job?.id) || clean(job?.title)}: public T5 card is not employer-direct.`);
}

const t5Status = status?.t5DataCenters;
if (!t5Status || t5Status.sourceHealthy !== true) failures.push('collector-status: t5DataCenters.sourceHealthy must be true.');
if (!t5Status || t5Status.listingComplete !== true) failures.push('collector-status: t5DataCenters.listingComplete must be true.');
if (t5Status && Number(t5Status.qualifyingRoles) !== (Array.isArray(snapshot) ? snapshot.length : 0)) {
  failures.push(`collector-status: qualifyingRoles ${t5Status.qualifyingRoles} does not match snapshot ${snapshot.length}.`);
}

if (failures.length) {
  for (const failure of failures) console.error(`T5 validation: ${failure}`);
  process.exit(1);
}

console.log(`T5 validation passed: ${snapshot.length} verified employer-direct requisitions represented by ${publicTitles.size} clean public role title(s).`);
