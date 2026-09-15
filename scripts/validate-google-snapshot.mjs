import { readFile } from 'node:fs/promises';

const COMPANY = 'Google';
const SNAPSHOT_PATH = 'data/google-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const MAX_FALLBACK_AGE_HOURS = 96;

const allowedTypes = new Set(['entry-level', 'internship', 'apprenticeship', 'trainee']);
const allowedExperience = new Set(['no-experience', '0-2-years', '2-5-years']);
const relevantTitlePattern = /(?:data center|data centre).*(?:technician|facilities|operations|engineer)|(?:facilities technician developmental program)/i;
const seniorTitlePattern = /\b(?:senior|sr\.?|lead|principal|chief|manager|mgr\.?|director|vice president|vp|head of|staff engineer|supervisor|architect|program manager|product manager|security manager)\b/i;
const usStateAbbreviations = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI',
  'MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT',
  'VT','VA','WA','WV','WI','WY','DC'
]);
const parityFields = ['title', 'company', 'location', 'type', 'experience', 'source', 'sourceUrl', 'active', 'demo'];

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalize = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function canonicalGoogleUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'www.google.com') return null;
  const match = parsed.pathname.match(/^\/about\/careers\/applications\/jobs\/results\/(\d+)-([^/?#]+)\/?$/i);
  if (!match) return null;
  return {
    jobId: match[1],
    url: `https://www.google.com/about/careers/applications/jobs/results/${match[1]}-${match[2]}`
  };
}

function hasUsLocation(value) {
  const text = clean(value);
  const match = text.match(/,\s*([A-Z]{2})(?:\b|\s|$)/);
  return Boolean(match && usStateAbbreviations.has(match[1]));
}

function rawIdentity(job) {
  return [job?.company, job?.title, job?.location].map(normalize).join('|');
}

// Keep this aligned with the shared publication deduper. Google may publish
// separate shift requisitions whose public cards intentionally collapse to one
// representative at the same site. Every public representative still has to be
// an exact Google snapshot requisition; an unpublished source requisition is
// allowed only when its normalized publication identity is represented.
function canonicalPublicationTitle(job) {
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

function publicationIdentity(job) {
  return [normalize(job?.company), canonicalPublicationTitle(job), normalize(job?.location)].join('|');
}

function isGoogleRole(job) {
  return clean(job?.company) === COMPANY || Boolean(canonicalGoogleUrl(job?.sourceUrl));
}

function validateCanonicalCase({ id, sourceUrl, expectedId, expectedCanonical }) {
  const parsed = canonicalGoogleUrl(sourceUrl);
  if (!parsed) return false;
  return id === `google-${parsed.jobId}`
    && (!expectedId || parsed.jobId === expectedId)
    && (!expectedCanonical || parsed.url === expectedCanonical);
}

function runSelfTest() {
  const good = validateCanonicalCase({
    id: 'google-123456789',
    sourceUrl: 'https://www.google.com/about/careers/applications/jobs/results/123456789-data-center-technician',
    expectedId: '123456789',
    expectedCanonical: 'https://www.google.com/about/careers/applications/jobs/results/123456789-data-center-technician'
  });
  if (!good) throw new Error('Canonical Google Careers detail URL regression failed.');

  const wrongHost = canonicalGoogleUrl('https://careers.google.com/jobs/results/123456789-data-center-technician');
  if (wrongHost) throw new Error('Non-canonical Google Careers host was accepted.');

  const wrongId = validateCanonicalCase({
    id: 'google-987654321',
    sourceUrl: 'https://www.google.com/about/careers/applications/jobs/results/123456789-data-center-technician'
  });
  if (wrongId) throw new Error('Mismatched Google job ID and detail URL were accepted.');

  const base = { company: COMPANY, location: 'Haskell, TX' };
  const genericIdentity = publicationIdentity({ ...base, title: 'Data Center Technician' });
  const shiftIdentity = publicationIdentity({ ...base, title: 'Data Center Technician, Night Shift' });
  if (genericIdentity !== shiftIdentity) throw new Error('Google shift-equivalent publication identity regression failed.');

  console.log('Google snapshot identity regression tests passed.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

const violations = [];
let snapshot = [];
let jobs = [];
let status = {};
try { snapshot = await readJson(SNAPSHOT_PATH); } catch (error) { violations.push(`Google snapshot could not be read: ${error.message}`); }
try { jobs = await readJson(JOBS_PATH); } catch (error) { violations.push(`Public feed could not be read: ${error.message}`); }
try { status = await readJson(STATUS_PATH); } catch (error) { violations.push(`Collector status could not be read: ${error.message}`); }
if (!Array.isArray(snapshot)) { violations.push('Google snapshot must be an array.'); snapshot = []; }
if (!Array.isArray(jobs)) { violations.push('Public feed must be an array.'); jobs = []; }

const publicGoogle = jobs.filter(isGoogleRole);
const googleStatus = status?.googleCareers || {};
const fallbackExpired = googleStatus?.fallbackExpired === true;
const sourceHealthy = googleStatus?.sourceHealthy === true;
const lastHealthyMs = Date.parse(String(googleStatus?.lastHealthyAt || ''));
const configuredMaxAge = Number(googleStatus?.fallbackMaxAgeHours);

if (Number.isFinite(configuredMaxAge) && configuredMaxAge > MAX_FALLBACK_AGE_HOURS) {
  violations.push(`Google fallbackMaxAgeHours is ${configuredMaxAge}, above the ${MAX_FALLBACK_AGE_HOURS}-hour publication policy.`);
}
if ((snapshot.length || publicGoogle.length) && !Number.isFinite(lastHealthyMs)) {
  violations.push('Published Google roles have no valid lastHealthyAt verification anchor.');
}
if (fallbackExpired && (snapshot.length || publicGoogle.length)) {
  violations.push(`Google fallback is expired but ${snapshot.length} snapshot / ${publicGoogle.length} public role(s) remain.`);
}
if (googleStatus?.usedPreviousSnapshot === true && (sourceHealthy || fallbackExpired)) {
  violations.push('Google usedPreviousSnapshot is inconsistent with sourceHealthy/fallbackExpired state.');
}
if (sourceHealthy) {
  if (googleStatus?.listingComplete !== true) violations.push('Google source is marked healthy without a complete listing scan.');
  const attempted = Number(googleStatus?.pagesAttempted);
  const succeeded = Number(googleStatus?.pagesSucceeded);
  if (!Number.isFinite(attempted) || attempted <= 0 || succeeded !== attempted) {
    violations.push(`Google healthy source has incomplete page evidence (${succeeded || 0}/${attempted || 0}).`);
  }
  const verified = Number(googleStatus?.diagnostics?.detailVerified || 0);
  if (verified <= 0) violations.push('Google source is marked healthy without any freshly verified detail page.');
}

const snapshotIds = new Set();
const snapshotUrls = new Set();
const snapshotIdentities = new Set();
for (const job of snapshot) {
  const id = clean(job?.id);
  const title = clean(job?.title);
  const company = clean(job?.company);
  const type = clean(job?.type);
  const experience = clean(job?.experience);
  const location = clean(job?.location);
  const parsedUrl = canonicalGoogleUrl(job?.sourceUrl);
  const idMatch = id.match(/^google-(\d+)$/i);

  if (company !== COMPANY) violations.push(`${id || '(missing id)'} belongs to ${company || '(missing company)'}, not Google.`);
  if (!idMatch) violations.push(`${id || '(missing id)'} does not use canonical google-<job id> identity.`);
  if (!parsedUrl) violations.push(`${id || '(missing id)'} does not use a canonical employer-direct Google Careers detail URL.`);
  if (idMatch && parsedUrl && idMatch[1] !== parsedUrl.jobId) violations.push(`${id} does not match Google Careers job ID ${parsedUrl.jobId}.`);
  if (clean(job?.source) !== 'Google Careers') violations.push(`${id || '(missing id)'} has unexpected source label ${clean(job?.source) || '(missing)'}.`);
  if (job?.active !== true || job?.demo === true) violations.push(`${id || '(missing id)'} is not an active production role.`);
  if (!allowedTypes.has(type)) violations.push(`${id || '(missing id)'} has unsupported role type ${type || '(missing)'}.`);
  if (!allowedExperience.has(experience)) violations.push(`${id || '(missing id)'} has unsupported experience band ${experience || '(missing)'}.`);
  if (!title) violations.push(`${id || '(missing id)'} has no title.`);
  if (title && !relevantTitlePattern.test(title)) violations.push(`${id || '(missing id)'} is outside the approved data-center role families: ${title}.`);
  if (seniorTitlePattern.test(title)) violations.push(`${id || '(missing id)'} has senior/executive title noise: ${title}.`);
  if (!hasUsLocation(location)) violations.push(`${id || '(missing id)'} has an unverified U.S. location: ${location || '(missing)'}.`);

  if (id) {
    if (snapshotIds.has(id)) violations.push(`Google snapshot contains duplicate id ${id}.`);
    snapshotIds.add(id);
  }
  if (parsedUrl) {
    if (snapshotUrls.has(parsedUrl.url)) violations.push(`Google snapshot contains duplicate URL ${parsedUrl.url}.`);
    snapshotUrls.add(parsedUrl.url);
  }
  const key = rawIdentity(job);
  if (key && key !== '||') {
    if (snapshotIdentities.has(key)) violations.push(`Google snapshot contains duplicate normalized role identity ${key}.`);
    snapshotIdentities.add(key);
  }
}

const publicById = new Map();
const publicPublicationIdentities = new Set();
for (const job of publicGoogle) {
  const id = clean(job?.id);
  const parsedUrl = canonicalGoogleUrl(job?.sourceUrl);
  const idMatch = id.match(/^google-(\d+)$/i);
  if (clean(job?.company) !== COMPANY) violations.push(`Public Google Careers URL ${id || '(missing id)'} is attributed to ${clean(job?.company) || '(missing company)'}.`);
  if (!idMatch) violations.push(`Public Google role ${id || '(missing id)'} does not use canonical google-<job id> identity.`);
  if (!parsedUrl) violations.push(`Public Google role ${id || '(missing id)'} does not use a canonical employer-direct Google Careers detail URL.`);
  if (idMatch && parsedUrl && idMatch[1] !== parsedUrl.jobId) violations.push(`Public Google role ${id} does not match its Google Careers job ID ${parsedUrl.jobId}.`);
  if (id) {
    if (publicById.has(id)) violations.push(`Public feed contains duplicate Google id ${id}.`);
    publicById.set(id, job);
  }
  publicPublicationIdentities.add(publicationIdentity(job));
}

const snapshotById = new Map(snapshot.map(job => [clean(job?.id), job]).filter(([id]) => id));
const unexpectedIds = [...publicById.keys()].filter(id => !snapshotById.has(id));
if (unexpectedIds.length) violations.push(`Google public feed contains ${unexpectedIds.length} role(s) not traceable to the authoritative snapshot: ${unexpectedIds.slice(0, 5).join(', ')}${unexpectedIds.length > 5 ? ', ...' : ''}`);

const unrepresentedSnapshotIds = [];
let dedupedSnapshotRoles = 0;
for (const [id, snapshotJob] of snapshotById) {
  const publicJob = publicById.get(id);
  if (!publicJob) {
    if (publicPublicationIdentities.has(publicationIdentity(snapshotJob))) dedupedSnapshotRoles += 1;
    else unrepresentedSnapshotIds.push(id);
    continue;
  }
  for (const field of parityFields) {
    const snapshotValue = typeof snapshotJob?.[field] === 'string' ? clean(snapshotJob[field]) : snapshotJob?.[field];
    const publicValue = typeof publicJob?.[field] === 'string' ? clean(publicJob[field]) : publicJob?.[field];
    if (snapshotValue !== publicValue) {
      violations.push(`Google ${id} differs between snapshot and public feed for ${field}.`);
    }
  }
}
if (unrepresentedSnapshotIds.length) {
  violations.push(`Google public feed leaves ${unrepresentedSnapshotIds.length}/${snapshotById.size} authoritative snapshot role(s) without an exact or normalized dedupe representative: ${unrepresentedSnapshotIds.slice(0, 5).join(', ')}${unrepresentedSnapshotIds.length > 5 ? ', ...' : ''}`);
}

const reportedQualifying = Number(googleStatus?.qualifyingRoles);
if (Number.isFinite(reportedQualifying) && reportedQualifying !== snapshot.length) {
  violations.push(`Google collector status reports ${reportedQualifying} qualifying role(s) but snapshot contains ${snapshot.length}.`);
}

if (violations.length) {
  for (const violation of violations) console.error(`Google snapshot violation: ${violation}`);
  throw new Error(`Blocked ${violations.length} Google snapshot integrity violation(s).`);
}

if (fallbackExpired) {
  console.log('Google snapshot guard passed: fallback is expired and no Google roles remain published pending fresh verification.');
} else if (!sourceHealthy) {
  console.log(`Google snapshot guard passed: ${snapshot.length} employer-direct role(s) remain source-traceable while the official source is inside its verified fallback window; ${dedupedSnapshotRoles} source role(s) collapse to normalized public representatives.`);
} else {
  console.log(`Google snapshot guard passed: ${snapshot.length} employer-direct role(s) are represented by ${publicGoogle.length} public role(s) with healthy official-source evidence; ${dedupedSnapshotRoles} source role(s) collapse through normalized dedupe.`);
}
