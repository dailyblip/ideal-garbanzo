import { readFile } from 'node:fs/promises';

const SNAPSHOT_PATH = 'data/cologix-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'Cologix';
const BOARD_ROOT = 'https://jobs.lever.co/cologix/';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalize = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const allowedTypes = new Set(['entry-level', 'apprenticeship', 'internship', 'trainee']);
const allowedExperience = new Set(['no-experience', '0-2-years', '2-5-years']);
const missionTitlePattern = /\b(?:data cent(?:er|re) (?:operations? )?technician|data cent(?:er|re) electrician|data cent(?:er|re) hvac technician|critical facilities technician|facilities technician|facility technician)\b/i;
const excludedTitlePattern = /\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|superintendent|foreman|architect|security|sales|account executive)\b/i;
const stateAbbrPattern = /(?:,|\s)\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)(?:\b|$)/i;
const usStateNames = [
  'alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi','missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico','new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota','tennessee','texas','utah','vermont','virginia','washington','west virginia','wisconsin','wyoming','district of columbia'
];

function isUsLocation(value = '') {
  const text = clean(value);
  const lower = text.toLowerCase();
  if (!text) return false;
  if (/\b(?:united states|usa|u\.s\.)\b/i.test(text)) return true;
  if (stateAbbrPattern.test(text)) return true;
  return usStateNames.some(state => lower.includes(state));
}

function canonicalTitle(job = {}) {
  return normalize(clean(job?.title)
    .replace(/\s*[-–—,:()]?\s*(?:day|night|overnight|weekend|1st|2nd|3rd)\s+shift(?:\s*\([^)]*\))?\s*$/iu, '')
    .replace(/\s*\([^)]*(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)[^)]*\)\s*$/iu, ''));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

const snapshot = await readJson(SNAPSHOT_PATH);
const jobs = await readJson(JOBS_PATH);
const status = await readJson(STATUS_PATH);
const failures = [];

if (!Array.isArray(snapshot)) failures.push('Cologix snapshot must contain an array.');
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
  if (!sourceUrl.startsWith(BOARD_ROOT)) failures.push(`${id || title}: source URL is not the official Cologix Lever board.`);
  if (!missionTitlePattern.test(title)) failures.push(`${id || title}: title is outside approved mission-fit families.`);
  if (excludedTitlePattern.test(title)) failures.push(`${id || title}: senior/non-mission title leaked into snapshot.`);
  if (!isUsLocation(location)) failures.push(`${id || title}: U.S. location missing or unrecognized (${location || 'blank'}).`);

  if (!id) failures.push(`${title || sourceUrl}: id missing.`);
  else if (ids.has(id)) failures.push(`${id}: duplicate id in Cologix snapshot.`);
  else ids.add(id);

  if (!sourceUrl) failures.push(`${id || title}: source URL missing.`);
  else if (urls.has(sourceUrl)) failures.push(`${id || title}: duplicate source URL in Cologix snapshot.`);
  else urls.add(sourceUrl);

  if (identities.has(identity)) failures.push(`${id || title}: duplicate title/location identity in Cologix snapshot.`);
  else identities.add(identity);
}

const publicCologixJobs = (Array.isArray(jobs) ? jobs : []).filter(job => clean(job?.company) === COMPANY);
for (const job of publicCologixJobs) {
  if (!clean(job?.sourceUrl).startsWith(BOARD_ROOT)) failures.push(`${clean(job?.id) || clean(job?.title)}: public Cologix card is not employer-direct.`);
  if (!missionTitlePattern.test(clean(job?.title))) failures.push(`${clean(job?.id) || clean(job?.title)}: public Cologix card is outside mission-fit role families.`);
  if (excludedTitlePattern.test(clean(job?.title))) failures.push(`${clean(job?.id) || clean(job?.title)}: public Cologix card is senior/non-mission.`);
}

const snapshotTitles = new Set((Array.isArray(snapshot) ? snapshot : []).map(canonicalTitle).filter(Boolean));
const publicTitles = new Set(publicCologixJobs.map(canonicalTitle).filter(Boolean));
const missingTitles = [...snapshotTitles].filter(title => !publicTitles.has(title));
if (missingTitles.length) failures.push(`${missingTitles.length}/${snapshotTitles.size} verified Cologix role title(s) are missing from jobs.json.`);

const cologixStatus = status?.cologix;
if (!cologixStatus || cologixStatus.sourceHealthy !== true) failures.push('collector-status: cologix.sourceHealthy must be true.');
if (!cologixStatus || cologixStatus.listingComplete !== true) failures.push('collector-status: cologix.listingComplete must be true.');
if (cologixStatus && Number(cologixStatus.qualifyingRoles) !== (Array.isArray(snapshot) ? snapshot.length : 0)) {
  failures.push(`collector-status: qualifyingRoles ${cologixStatus.qualifyingRoles} does not match snapshot ${snapshot.length}.`);
}

if (failures.length) {
  for (const failure of failures) console.error(`Cologix validation: ${failure}`);
  process.exit(1);
}

console.log(`Cologix validation passed: ${(Array.isArray(snapshot) ? snapshot.length : 0)} verified employer-direct requisition(s) represented by ${publicTitles.size} public role title(s).`);
