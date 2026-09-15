import { readFile } from 'node:fs/promises';

const COMPANY = 'Amazon Web Services';
const SNAPSHOT_PATH = 'data/amazon-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const DEFAULT_MAX_FALLBACK_AGE_HOURS = 96;
const allowedHosts = new Set(['amazon.jobs', 'www.amazon.jobs']);
const allowedTypes = new Set(['entry-level', 'internship', 'apprenticeship', 'trainee']);
const allowedExperience = new Set(['no-experience', '0-2-years', '2-5-years']);
const parityFields = ['title', 'company', 'location', 'type', 'experience', 'source', 'active', 'demo'];

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

function parityValue(job, field) {
  const value = job?.[field];
  return typeof value === 'string' ? clean(value) : value;
}

function compareSnapshotParity(snapshotJob, publicJob) {
  const differences = [];
  for (const field of parityFields) {
    if (parityValue(snapshotJob, field) !== parityValue(publicJob, field)) differences.push(field);
  }
  return differences;
}

function runSelfTest() {
  const snapshotJob = {
    id: 'amazon-12345678',
    title: 'Data Center Operations Technician',
    company: COMPANY,
    location: 'Sterling, VA',
    type: 'entry-level',
    experience: '0-2-years',
    source: 'Official Amazon Jobs',
    sourceUrl: 'https://www.amazon.jobs/en/jobs/12345678/data-center-operations-technician',
    active: true,
    demo: false
  };
  const exactPublic = { ...snapshotJob, sourceUrl: 'https://www.amazon.jobs/en/jobs/12345678/updated-title-slug' };
  if (compareSnapshotParity(snapshotJob, exactPublic).length) {
    throw new Error('AWS snapshot/public parity regression rejected an exact public card.');
  }
  const canonicalSnapshot = canonicalAmazonJob(snapshotJob.sourceUrl);
  const canonicalPublic = canonicalAmazonJob(exactPublic.sourceUrl);
  if (!canonicalSnapshot || !canonicalPublic || canonicalSnapshot.jobId !== canonicalPublic.jobId) {
    throw new Error('AWS canonical requisition identity regression rejected equivalent Amazon Jobs slugs.');
  }
  const drifted = { ...exactPublic, experience: '2-5-years' };
  const differences = compareSnapshotParity(snapshotJob, drifted);
  if (differences.length !== 1 || differences[0] !== 'experience') {
    throw new Error('AWS snapshot/public parity regression failed to detect experience-band drift.');
  }
  if (allowedTypes.has('manager') || allowedExperience.has('5-plus-years')) {
    throw new Error('AWS mission-fit allowlists unexpectedly admit senior-role classifications.');
  }
  console.log('AWS snapshot/public parity regression tests passed.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
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
const snapshotByJobId = new Map();
for (const job of snapshot) {
  const id = clean(job?.id);
  const company = clean(job?.company);
  const type = clean(job?.type);
  const experience = clean(job?.experience);
  const parsedUrl = canonicalAmazonJob(job?.sourceUrl);
  const idMatch = id.match(/^amazon-(\d+)$/i);

  if (company !== COMPANY) violations.push(`${id || '(missing id)'} belongs to ${company || '(missing company)'}, not ${COMPANY}.`);
  if (!idMatch) violations.push(`${id || '(missing id)'} does not use the canonical amazon-<job id> identity.`);
  if (!parsedUrl) violations.push(`${id || '(missing id)'} does not use a canonical employer-direct Amazon Jobs detail URL.`);
  if (idMatch && parsedUrl && idMatch[1] !== parsedUrl.jobId) violations.push(`${id} does not match its Amazon Jobs requisition ${parsedUrl.jobId}.`);
  if (clean(job?.source) !== 'Official Amazon Jobs') violations.push(`${id || '(missing id)'} has unexpected source label ${clean(job?.source) || '(missing)'}.`);
  if (!allowedTypes.has(type)) violations.push(`${id || '(missing id)'} has unsupported role type ${type || '(missing)'}.`);
  if (!allowedExperience.has(experience)) violations.push(`${id || '(missing id)'} has unsupported experience band ${experience || '(missing)'}.`);
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
    snapshotByJobId.set(parsedUrl.jobId, job);
  }
}

const publicAws = jobs.filter(job => clean(job?.company) === COMPANY);
const publicJobIds = new Set();
for (const job of publicAws) {
  const id = clean(job?.id);
  const type = clean(job?.type);
  const experience = clean(job?.experience);
  const parsedUrl = canonicalAmazonJob(job?.sourceUrl);
  const idMatch = id.match(/^amazon-(\d+)$/i);
  if (!idMatch) violations.push(`Public AWS role ${id || '(missing id)'} does not use the canonical amazon-<job id> identity.`);
  if (!parsedUrl) violations.push(`Public AWS role ${id || '(missing id)'} does not use a canonical employer-direct Amazon Jobs detail URL.`);
  if (idMatch && parsedUrl && idMatch[1] !== parsedUrl.jobId) violations.push(`Public AWS role ${id} does not match Amazon requisition ${parsedUrl.jobId}.`);
  if (clean(job?.source) !== 'Official Amazon Jobs') violations.push(`Public AWS role ${id || '(missing id)'} has unexpected source label ${clean(job?.source) || '(missing)'}.`);
  if (!allowedTypes.has(type)) violations.push(`Public AWS role ${id || '(missing id)'} has unsupported role type ${type || '(missing)'}.`);
  if (!allowedExperience.has(experience)) violations.push(`Public AWS role ${id || '(missing id)'} has unsupported experience band ${experience || '(missing)'}.`);
  if (job?.active !== true || job?.demo === true) violations.push(`Public AWS role ${id || '(missing id)'} is not an active production role.`);
  const requisitionId = parsedUrl?.jobId || idMatch?.[1] || '';
  if (requisitionId) {
    if (publicJobIds.has(requisitionId)) violations.push(`Public feed contains duplicate AWS requisition ${requisitionId}.`);
    publicJobIds.add(requisitionId);
    const snapshotJob = snapshotByJobId.get(requisitionId);
    if (!snapshotJob) {
      violations.push(`Public AWS requisition ${requisitionId} is not traceable to the authoritative AWS snapshot.`);
    } else {
      const differences = compareSnapshotParity(snapshotJob, job);
      for (const field of differences) {
        violations.push(`Public AWS requisition ${requisitionId} differs from the authoritative snapshot for ${field}.`);
      }
    }
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
// every published AWS requisition must trace to the snapshot with its immutable
// classification/source fields intact, and a current snapshot must not collapse
// to a tiny public subset after downstream filters or intentional dedupe.
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
console.log(`AWS snapshot guard passed: ${snapshot.length} authoritative requisitions, ${publicAws.length} public cards, all public AWS roles retain authoritative classification/source parity and trace to the official snapshot; ${health}.`);
