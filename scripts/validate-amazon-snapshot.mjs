import { readFile } from 'node:fs/promises';

const COMPANY = 'Amazon Web Services';
const SNAPSHOT_PATH = 'data/amazon-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const DEFAULT_MAX_FALLBACK_AGE_HOURS = 96;
const allowedHosts = new Set(['amazon.jobs', 'www.amazon.jobs']);

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function canonicalAmazonJob(value) {
  let parsed;
  try { parsed = new URL(clean(value)); } catch { return null; }
  if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname.toLowerCase())) return null;
  const match = parsed.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?jobs\/(\d+)(?:\/[^?#]*)?\/?$/i);
  if (!match) return null;
  return {
    jobId: match[1],
    canonicalUrl: `https://www.amazon.jobs/en/jobs/${match[1]}`
  };
}

function completeHealthySearch(amazon = {}) {
  const attempted = Number(amazon?.queriesAttempted || 0);
  const succeeded = Number(amazon?.queriesSucceeded || 0);
  return amazon?.sourceHealthy === true && attempted > 0 && succeeded === attempted && Number(amazon?.preservedPreviousRoles || 0) === 0;
}

const violations = [];
let snapshot = [];
let jobs = [];
let status = {};

try { snapshot = await readJson(SNAPSHOT_PATH); } catch (error) { violations.push(`AWS snapshot could not be read: ${error.message}`); }
try { jobs = await readJson(JOBS_PATH); } catch (error) { violations.push(`Public feed could not be read: ${error.message}`); }
try { status = await readJson(STATUS_PATH); } catch (error) { violations.push(`Collector status could not be read: ${error.message}`); }

if (!Array.isArray(snapshot)) { violations.push('AWS snapshot must be an array.'); snapshot = []; }
if (!Array.isArray(jobs)) { violations.push('Public feed must be an array.'); jobs = []; }

const snapshotIds = new Set();
const snapshotJobIds = new Set();
const snapshotUrls = new Set();
for (const job of snapshot) {
  const id = clean(job?.id);
  const company = clean(job?.company);
  const parsedUrl = canonicalAmazonJob(job?.sourceUrl);
  const idMatch = id.match(/^amazon-(\d+)$/i);

  if (company !== COMPANY) violations.push(`${id || '(missing id)'} belongs to ${company || '(missing company)'}, not ${COMPANY}.`);
  if (!idMatch) violations.push(`${id || '(missing id)'} does not use the canonical amazon-<job id> identity.`);
  if (!parsedUrl) violations.push(`${id || '(missing id)'} does not use a canonical employer-direct Amazon Jobs detail URL.`);
  if (idMatch && parsedUrl && idMatch[1] !== parsedUrl.jobId) violations.push(`${id} does not match its Amazon Jobs requisition ${parsedUrl.jobId}.`);
  if (job?.active !== true || job?.demo === true) violations.push(`${id || '(missing id)'} is not an active production role.`);

  if (id) {
    if (snapshotIds.has(id)) violations.push(`AWS snapshot contains duplicate id ${id}.`);
    snapshotIds.add(id);
  }
  if (parsedUrl) {
    if (snapshotJobIds.has(parsedUrl.jobId)) violations.push(`AWS snapshot contains duplicate Amazon requisition ${parsedUrl.jobId}.`);
    if (snapshotUrls.has(parsedUrl.canonicalUrl)) violations.push(`AWS snapshot contains duplicate canonical URL for requisition ${parsedUrl.jobId}.`);
    snapshotJobIds.add(parsedUrl.jobId);
    snapshotUrls.add(parsedUrl.canonicalUrl);
  }
}

const publicAws = jobs.filter(job => clean(job?.company) === COMPANY);
const publicJobIds = new Set();
for (const job of publicAws) {
  const id = clean(job?.id);
  const parsedUrl = canonicalAmazonJob(job?.sourceUrl);
  const idMatch = id.match(/^amazon-(\d+)$/i);
  if (!idMatch) violations.push(`Public AWS role ${id || '(missing id)'} does not use the canonical amazon-<job id> identity.`);
  if (!parsedUrl) violations.push(`Public AWS role ${id || '(missing id)'} does not use a canonical employer-direct Amazon Jobs detail URL.`);
  if (idMatch && parsedUrl && idMatch[1] !== parsedUrl.jobId) violations.push(`Public AWS role ${id} does not match Amazon requisition ${parsedUrl.jobId}.`);
  const requisitionId = parsedUrl?.jobId || idMatch?.[1] || '';
  if (requisitionId) {
    if (publicJobIds.has(requisitionId)) violations.push(`Public feed contains duplicate AWS requisition ${requisitionId}.`);
    publicJobIds.add(requisitionId);
    if (!snapshotJobIds.has(requisitionId)) violations.push(`Public AWS requisition ${requisitionId} is not traceable to the authoritative AWS snapshot.`);
  }
}

const amazonStatus = status?.amazonDatacenter || {};
const sourceHealthy = completeHealthySearch(amazonStatus);
const fallbackFreshness = amazonStatus?.fallbackFreshness || {};
const configuredMaxAge = Number(fallbackFreshness?.maxAgeHours);
const maxFallbackAgeHours = Number.isFinite(configuredMaxAge) && configuredMaxAge > 0
  ? configuredMaxAge
  : DEFAULT_MAX_FALLBACK_AGE_HOURS;
const preservedPreviousRoles = Number(amazonStatus?.preservedPreviousRoles || 0);
const fallbackActive = !sourceHealthy && preservedPreviousRoles > 0;
const lastHealthyMs = Date.parse(String(fallbackFreshness?.lastHealthyAt || ''));
const fallbackAgeHours = Number.isFinite(lastHealthyMs)
  ? Math.max(0, (Date.now() - lastHealthyMs) / 36e5)
  : null;
const fallbackExpired = !sourceHealthy && (fallbackFreshness?.expired === true || (fallbackAgeHours !== null && fallbackAgeHours >= maxFallbackAgeHours));

if (fallbackActive && fallbackFreshness?.lastHealthyAt && !Number.isFinite(lastHealthyMs)) {
  violations.push(`AWS fallback has an invalid lastHealthyAt timestamp: ${fallbackFreshness.lastHealthyAt}.`);
}
if (fallbackFreshness?.active === true && fallbackFreshness?.expired === true) {
  violations.push('AWS fallback cannot be marked active and expired at the same time.');
}
if (fallbackExpired && (snapshot.length > 0 || publicAws.length > 0)) {
  violations.push(`AWS fallback exceeded ${maxFallbackAgeHours} hours but ${snapshot.length} snapshot role(s) and ${publicAws.length} public role(s) remain published.`);
}

// Collector status is updated by several source workflows and can legitimately
// describe a newer or narrower collection pass than the cumulative verified
// AWS snapshot. Protect the durable source-of-truth relationship instead:
// every published AWS requisition must trace to the snapshot, and a current
// snapshot must not collapse to a tiny public subset after downstream filters.
if (!fallbackExpired && snapshotJobIds.size >= 8 && publicJobIds.size < Math.ceil(snapshotJobIds.size * 0.40)) {
  violations.push(`AWS public feed retained only ${publicJobIds.size}/${snapshotJobIds.size} authoritative snapshot requisitions.`);
}

if (violations.length) {
  for (const violation of violations) console.error(`AWS snapshot violation: ${violation}`);
  throw new Error(`Blocked ${violations.length} AWS snapshot integrity violation(s).`);
}

let health;
if (fallbackExpired) {
  health = 'verified fallback expired and no AWS roles remain published';
} else if (fallbackActive && fallbackFreshness?.lastHealthyAt) {
  const ageLabel = fallbackAgeHours === null ? 'unknown' : `${Math.round(fallbackAgeHours * 10) / 10}h`;
  health = `degraded official search; preserved roles are inside the ${maxFallbackAgeHours}h fallback window (${ageLabel} since last healthy verification)`;
} else if (!sourceHealthy) {
  health = 'latest recorded official search was degraded; no expired retained fallback detected';
} else {
  health = 'latest recorded official search is complete and healthy';
}
console.log(`AWS snapshot guard passed: ${snapshot.length} authoritative requisitions, ${publicAws.length} public cards, all public AWS roles trace to the official snapshot; ${health}.`);
