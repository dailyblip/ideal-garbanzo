import { readFile } from 'node:fs/promises';

const SNAPSHOT_PATH = 'data/oracle-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'Oracle';
const OFFICIAL_HOST = 'eeho.fa.us2.oraclecloud.com';
const DEFAULT_MAX_FALLBACK_AGE_HOURS = 96;
const VALID_EXPERIENCE = new Set(['no-experience', '0-2-years', '2-5-years']);
const SENIOR_TITLE = /(^|[^a-z])(senior|sr\.?|lead|principal|manager|director|vice president|vp|head of|chief|supervisor|architect)([^a-z]|$)/i;
const STRONG_DATA_CENTER_TITLE = /\b(data\s*center|data\s*centre|datacenter|critical facilities?|critical environments?)\b/i;
const CLEARLY_NON_OPERATIONAL_TITLE = /\b(business analyst|business operations|cost management|cost estimator|cost analyst|cost controls|procurement|purchasing|finance|financial|security operations|cybersecurity|information security|software|application|frontend|backend|full[ -]?stack|database|product|ux|ui|machine learning|data scientist)\b/i;

async function readArray(path) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(value)) throw new Error(`${path} must contain a JSON array`);
  return value;
}

async function readObject(path) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must contain a JSON object`);
  return value;
}

function sourceUrl(job, context) {
  let parsed;
  try {
    parsed = new URL(String(job?.sourceUrl || ''));
  } catch {
    throw new Error(`${context}: ${job?.id || '(missing id)'} has an invalid source URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== OFFICIAL_HOST) {
    throw new Error(`${context}: ${job?.id || '(missing id)'} is not employer-direct (${parsed.hostname || 'missing host'})`);
  }
  if (!/\/hcmUI\/CandidateExperience\/en\/sites\/[^/]+\/job\/[^/?#]+/i.test(parsed.pathname)) {
    throw new Error(`${context}: ${job?.id || '(missing id)'} does not use an Oracle candidate-experience job detail URL`);
  }
  return parsed.href;
}

function parityProtected(job) {
  const title = String(job?.title || '').trim();
  if (CLEARLY_NON_OPERATIONAL_TITLE.test(title)) return false;
  if (STRONG_DATA_CENTER_TITLE.test(title)) return true;
  return true;
}

const parityRegressionCases = [
  { title: 'Data Center Business Operations Business Analyst', protected: false },
  { title: 'Data Center Development Cost Management', protected: false },
  { title: 'Data Center Technician 2', protected: true },
  { title: 'Critical Facilities Engineer', protected: true },
  { title: 'Mechanical Engineer 2', protected: true }
];
for (const testCase of parityRegressionCases) {
  const actual = parityProtected({ title: testCase.title });
  if (actual !== testCase.protected) {
    throw new Error(`Oracle role-family regression for ${testCase.title}: expected protected=${testCase.protected}, got ${actual}`);
  }
}

const snapshot = await readArray(SNAPSHOT_PATH);
const jobs = await readArray(JOBS_PATH);
const collectorStatus = await readObject(STATUS_PATH);
const publicOracle = jobs.filter(job => String(job?.company || '').trim() === COMPANY);
const protectedSnapshot = snapshot.filter(parityProtected);
const violations = [];

const oracleStatus = collectorStatus?.oracleCareers || {};
const sourceHealthy = oracleStatus?.sourceHealthy === true && oracleStatus?.listingComplete === true;
const fallbackFreshness = oracleStatus?.fallbackFreshness || {};
const configuredMaxAge = Number(fallbackFreshness?.maxAgeHours);
const maxFallbackAgeHours = Number.isFinite(configuredMaxAge) && configuredMaxAge > 0
  ? configuredMaxAge
  : DEFAULT_MAX_FALLBACK_AGE_HOURS;
const lastHealthyMs = Date.parse(String(fallbackFreshness?.lastHealthyAt || ''));
const fallbackAgeHours = Number.isFinite(lastHealthyMs)
  ? Math.max(0, (Date.now() - lastHealthyMs) / 36e5)
  : null;
const computedExpired = !sourceHealthy && fallbackAgeHours !== null && fallbackAgeHours >= maxFallbackAgeHours;
const fallbackExpired = !sourceHealthy && (fallbackFreshness?.expired === true || computedExpired);

if (!sourceHealthy && fallbackFreshness?.lastHealthyAt && !Number.isFinite(lastHealthyMs)) {
  violations.push(`Oracle fallback has an invalid lastHealthyAt timestamp: ${fallbackFreshness.lastHealthyAt}`);
}
if (!sourceHealthy && fallbackFreshness?.active === true && fallbackFreshness?.expired === true) {
  violations.push('Oracle fallback cannot be marked active and expired at the same time');
}

if (fallbackExpired) {
  if (snapshot.length !== 0) {
    violations.push(`Oracle fallback exceeded ${maxFallbackAgeHours} hours but ${snapshot.length} snapshot role(s) remain published`);
  }
  if (publicOracle.length !== 0) {
    violations.push(`Oracle fallback exceeded ${maxFallbackAgeHours} hours but ${publicOracle.length} public role(s) remain published`);
  }
} else if (snapshot.length < 3) {
  violations.push(`Oracle snapshot unexpectedly contains only ${snapshot.length} role(s)`);
}

const snapshotIds = new Set();
const snapshotUrls = new Set();
const protectedUrls = new Set();
for (const job of snapshot) {
  const id = String(job?.id || '').trim();
  if (String(job?.company || '').trim() !== COMPANY) violations.push(`${id || '(missing id)'} belongs to another company`);
  if (!id) violations.push('Oracle snapshot contains a role without an id');
  else if (snapshotIds.has(id)) violations.push(`duplicate Oracle snapshot id: ${id}`);
  else snapshotIds.add(id);

  try {
    const url = sourceUrl(job, 'Oracle snapshot');
    if (snapshotUrls.has(url)) violations.push(`duplicate Oracle snapshot URL: ${url}`);
    snapshotUrls.add(url);
    if (parityProtected(job)) protectedUrls.add(url);
  } catch (error) {
    violations.push(error.message);
  }

  const title = String(job?.title || '').trim();
  if (!title) violations.push(`${id || '(missing id)'} is missing a title`);
  if (SENIOR_TITLE.test(title)) violations.push(`${id || '(missing id)'} has a senior/managerial title: ${title}`);
  if (!VALID_EXPERIENCE.has(String(job?.experience || ''))) {
    violations.push(`${id || '(missing id)'} has unsupported experience classification: ${job?.experience || '(missing)'}`);
  }
  if (!String(job?.location || '').trim()) violations.push(`${id || '(missing id)'} is missing a location`);
  if (job?.active !== true) violations.push(`${id || '(missing id)'} is not marked active`);
  if (job?.demo === true) violations.push(`${id || '(missing id)'} is marked as demo data`);
}

const publicIds = new Set();
const publicUrls = new Set();
for (const job of publicOracle) {
  const id = String(job?.id || '').trim();
  if (!id) violations.push('Public Oracle feed contains a role without an id');
  else if (publicIds.has(id)) violations.push(`duplicate public Oracle id: ${id}`);
  else publicIds.add(id);

  try {
    const url = sourceUrl(job, 'Public Oracle feed');
    if (publicUrls.has(url)) violations.push(`duplicate public Oracle URL: ${url}`);
    publicUrls.add(url);
  } catch (error) {
    violations.push(error.message);
  }
}

if (!fallbackExpired && publicOracle.length !== protectedSnapshot.length) {
  violations.push(`Oracle mission-fit snapshot/public feed count mismatch (${protectedSnapshot.length} protected snapshot vs ${publicOracle.length} public)`);
}

if (!fallbackExpired) {
  for (const url of protectedUrls) {
    if (!publicUrls.has(url)) violations.push(`Mission-fit Oracle snapshot role missing from public feed: ${url}`);
  }
  for (const url of publicUrls) {
    if (!protectedUrls.has(url)) violations.push(`Public Oracle role is not present in the mission-fit authoritative snapshot: ${url}`);
  }
}

if (violations.length) {
  for (const violation of violations) console.error(`Oracle snapshot violation: ${violation}`);
  throw new Error(`Blocked ${violations.length} Oracle snapshot integrity violation(s).`);
}

if (fallbackExpired) {
  console.log(`Oracle snapshot guard passed: fallback is expired and no Oracle roles remain published pending a healthy official-source refresh.`);
} else if (!sourceHealthy && fallbackFreshness?.lastHealthyAt) {
  const ageLabel = fallbackAgeHours === null ? 'unknown' : `${Math.round(fallbackAgeHours * 10) / 10} hours`;
  console.log(`Oracle snapshot guard passed: ${publicOracle.length} employer-direct roles remain inside the ${maxFallbackAgeHours}-hour fallback window (${ageLabel} since last healthy check).`);
} else {
  console.log(`Oracle snapshot guard passed: ${publicOracle.length} mission-fit employer-direct roles match the protected snapshot exactly; ${snapshot.length - protectedSnapshot.length} clearly non-operational candidate role(s) remain excluded.`);
}
