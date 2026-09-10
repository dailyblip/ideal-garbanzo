import { readFile } from 'node:fs/promises';

const COMPANY = 'Meta';
const SNAPSHOT_PATH = 'data/meta-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const DEFAULT_MAX_FALLBACK_AGE_HOURS = 96;
const MIN_HEALTHY_SITEMAP_JOBS = 50;

const allowedTypes = new Set(['entry-level', 'internship', 'apprenticeship', 'trainee']);
const allowedExperience = new Set(['no-experience', '0-2-years', '2-5-years']);
const allowedHosts = new Set(['metacareers.com', 'www.metacareers.com']);
const usStateAbbreviations = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI',
  'MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT',
  'VT','VA','WA','WV','WI','WY','DC'
]);
const seniorTitlePattern = /\b(?:senior|sr\.?|lead|principal|chief|manager|mgr\.?|director|vice president|vp|head of|staff engineer|supervisor|architect|program manager|project manager|product manager|capacity manager|partnerships?|strategy|counsel|attorney|recruiter|sales)\b/i;
const retainedFallbackPattern = /Retained previous Meta snapshot because/i;
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalize = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

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

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function canonicalMetaUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); } catch { return null; }
  if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname.toLowerCase())) return null;
  const match = parsed.pathname.match(/^\/profile\/job_details\/(\d+)\/?$/i);
  if (!match) return null;
  return { jobId: match[1], url: `https://www.metacareers.com/profile/job_details/${match[1]}/` };
}

function hasUsLocation(value) {
  const text = String(value || '').trim();
  const match = text.match(/,\s*([A-Z]{2})(?:\b|\s|$)/);
  return Boolean(match && usStateAbbreviations.has(match[1]));
}

function retainedFallback(metaStatus = {}) {
  return Array.isArray(metaStatus?.errors) && metaStatus.errors.some(error => retainedFallbackPattern.test(String(error || '')));
}

function currentCollectorVerified(metaStatus = {}) {
  const diagnostics = metaStatus?.diagnostics || {};
  if (metaStatus?.sourceHealthy !== true || retainedFallback(metaStatus)) return false;
  if (diagnostics?.sitemapFetched === true) {
    return Number(diagnostics?.sitemapJobs || 0) >= MIN_HEALTHY_SITEMAP_JOBS;
  }
  return Number(diagnostics?.detailSucceeded || 0) > 0 && Number(diagnostics?.verified || 0) > 0;
}

const violations = [];
let snapshot = [];
let jobs = [];
let status = {};
try { snapshot = await readJson(SNAPSHOT_PATH); } catch (error) { violations.push(`Meta snapshot could not be read: ${error.message}`); }
try { jobs = await readJson(JOBS_PATH); } catch (error) { violations.push(`Public feed could not be read: ${error.message}`); }
try { status = await readJson(STATUS_PATH); } catch (error) { violations.push(`Collector status could not be read: ${error.message}`); }
if (!Array.isArray(snapshot)) { violations.push('Meta snapshot must be an array.'); snapshot = []; }
if (!Array.isArray(jobs)) { violations.push('Public feed must be an array.'); jobs = []; }

const publicMeta = jobs.filter(job => clean(job?.company) === COMPANY);
const metaStatus = status?.metaCareers || {};
const freshness = status?.metaFallbackFreshness || {};
const collectorVerified = currentCollectorVerified(metaStatus);
const fallbackActive = !collectorVerified && (metaStatus?.sourceHealthy === false || retainedFallback(metaStatus) || freshness?.active === true || freshness?.expired === true);
const configuredMaxAge = Number(freshness?.maxAgeHours);
const maxFallbackAgeHours = Number.isFinite(configuredMaxAge) && configuredMaxAge > 0 ? configuredMaxAge : DEFAULT_MAX_FALLBACK_AGE_HOURS;
const lastHealthyMs = Date.parse(String(freshness?.lastHealthyAt || ''));
const fallbackAgeHours = Number.isFinite(lastHealthyMs) ? Math.max(0, (Date.now() - lastHealthyMs) / 36e5) : null;
const computedExpired = fallbackActive && fallbackAgeHours !== null && fallbackAgeHours >= maxFallbackAgeHours;
const fallbackExpired = !collectorVerified && (freshness?.expired === true || computedExpired);

if (fallbackActive && freshness?.lastHealthyAt && !Number.isFinite(lastHealthyMs)) {
  violations.push(`Meta fallback has an invalid lastHealthyAt timestamp: ${freshness.lastHealthyAt}`);
}
if (fallbackActive && !clean(freshness?.lastHealthyAt) && freshness?.expired !== true) {
  violations.push('Meta fallback has no durable lastHealthyAt evidence; publication must fail closed until the watchdog verifies the official sitemap.');
}
if (freshness?.active === true && freshness?.expired === true) {
  violations.push('Meta fallback cannot be marked active and expired at the same time.');
}
if (fallbackExpired) {
  if (snapshot.length !== 0) violations.push(`Meta fallback exceeded ${maxFallbackAgeHours} hours but ${snapshot.length} snapshot role(s) remain published.`);
  if (publicMeta.length !== 0) violations.push(`Meta fallback exceeded ${maxFallbackAgeHours} hours but ${publicMeta.length} public role(s) remain published.`);
}

const snapshotIds = new Set();
const snapshotUrls = new Set();
for (const job of snapshot) {
  const id = clean(job?.id), title = clean(job?.title), company = clean(job?.company), type = clean(job?.type), experience = clean(job?.experience), location = clean(job?.location);
  const parsedUrl = canonicalMetaUrl(job?.sourceUrl);
  const idMatch = id.match(/^meta-(\d+)$/);
  if (company !== COMPANY) violations.push(`${id || '(missing id)'} belongs to ${company || '(missing company)'}, not Meta.`);
  if (!idMatch) violations.push(`${id || '(missing id)'} does not use the canonical meta-<job id> identity.`);
  if (!parsedUrl) violations.push(`${id || '(missing id)'} does not use a canonical employer-direct Meta Careers detail URL.`);
  if (idMatch && parsedUrl && idMatch[1] !== parsedUrl.jobId) violations.push(`${id} does not match its Meta Careers job ID ${parsedUrl.jobId}.`);
  if (job?.active !== true || job?.demo === true) violations.push(`${id || '(missing id)'} is not an active production role.`);
  if (!allowedTypes.has(type)) violations.push(`${id || '(missing id)'} has unsupported role type ${type || '(missing)'}.`);
  if (!allowedExperience.has(experience)) violations.push(`${id || '(missing id)'} has unsupported experience band ${experience || '(missing)'}.`);
  if (!title) violations.push(`${id || '(missing id)'} has no title.`);
  if (seniorTitlePattern.test(title)) violations.push(`${id || '(missing id)'} has senior/executive title noise: ${title}.`);
  if (!hasUsLocation(location)) violations.push(`${id || '(missing id)'} has an unverified U.S. location: ${location || '(missing)'}.`);
  if (id) { if (snapshotIds.has(id)) violations.push(`Meta snapshot contains duplicate id ${id}.`); snapshotIds.add(id); }
  if (parsedUrl) { if (snapshotUrls.has(parsedUrl.url)) violations.push(`Meta snapshot contains duplicate URL ${parsedUrl.url}.`); snapshotUrls.add(parsedUrl.url); }
}

for (const job of publicMeta) {
  if (!canonicalMetaUrl(job?.sourceUrl)) violations.push(`Public Meta role ${job?.id || '(missing id)'} does not use a canonical employer-direct Meta Careers detail URL.`);
}
const snapshotTitles = new Set(snapshot.map(canonicalTitle).filter(Boolean));
const publicTitles = new Set(publicMeta.map(canonicalTitle).filter(Boolean));
const missingTitles = [...snapshotTitles].filter(title => !publicTitles.has(title));
const unexpectedTitles = [...publicTitles].filter(title => !snapshotTitles.has(title));
if (missingTitles.length) violations.push(`Meta public feed is missing ${missingTitles.length}/${snapshotTitles.size} authoritative unique role title(s).`);
if (unexpectedTitles.length) violations.push(`Meta public feed contains ${unexpectedTitles.length} unique role title(s) not traceable to the authoritative snapshot.`);

const reportedQualifying = Number(metaStatus?.qualifyingRoles);
if (Number.isFinite(reportedQualifying) && reportedQualifying !== snapshot.length) violations.push(`Meta collector status reports ${reportedQualifying} qualifying roles but snapshot contains ${snapshot.length}.`);

if (violations.length) {
  for (const violation of violations) console.error(`Meta snapshot violation: ${violation}`);
  throw new Error(`Blocked ${violations.length} Meta snapshot integrity violation(s).`);
}

if (fallbackExpired) {
  console.log('Meta snapshot guard passed: employer-direct fallback is expired and no Meta roles remain published pending fresh verification.');
} else if (fallbackActive) {
  const ageLabel = fallbackAgeHours === null ? 'unknown' : `${Math.round(fallbackAgeHours * 10) / 10} hours`;
  console.log(`Meta snapshot guard passed: ${snapshot.length} authoritative role(s) remain inside the ${maxFallbackAgeHours}-hour fallback window (${ageLabel} since last healthy verification).`);
} else if (freshness?.lastHealthyAt) {
  console.log(`Meta snapshot guard passed: ${snapshot.length} authoritative requisitions represented by ${publicTitles.size} clean public role title(s); official sitemap liveness is durably verified.`);
} else {
  console.log(`Meta snapshot guard passed: ${snapshot.length} authoritative requisitions represented by ${publicTitles.size} clean public role title(s); official source healthy or no degraded state recorded.`);
}
