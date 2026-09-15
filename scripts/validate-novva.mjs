import { readFile } from 'node:fs/promises';

const COMPANY = 'Novva Data Centers';
const PUBLIC_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/novva-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const MAX_FALLBACK_AGE_HOURS = 168;
const allowedExperiences = new Set(['no-experience', '0-2-years', '2-5-years']);
const missionTitlePattern = /\b(?:command center operator|data cent(?:er|re) (?:technician|operator|operations|facilities|facility|engineer)|critical facilit(?:y|ies) (?:technician|operator|engineer)|facilities technician|facility technician)\b/i;
const seniorTitlePattern = /\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|superintendent|foreman)\b/i;
const parityFields = [
  'title', 'company', 'location', 'type', 'experience', 'source', 'sourceUrl',
  'active', 'demo', 'pay', 'salaryMin', 'salaryMax', 'salarySortMax'
];

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const jobs = JSON.parse(await readFile(PUBLIC_PATH, 'utf8'));
const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
const source = status?.novvaCareers;
const errors = [];
const requireOk = (condition, message) => { if (!condition) errors.push(message); };

requireOk(Array.isArray(jobs), 'jobs.json must contain an array.');
requireOk(Array.isArray(snapshot), 'Novva snapshot must contain an array.');
requireOk(source && typeof source === 'object', 'Novva collector status is missing.');

const publicJobs = Array.isArray(jobs) ? jobs.filter(job => job?.company === COMPANY) : [];
const freshnessFieldsPresent = Boolean(source && (
  Object.prototype.hasOwnProperty.call(source, 'lastHealthyAt') ||
  Object.prototype.hasOwnProperty.call(source, 'fallbackMaxAgeHours') ||
  Object.prototype.hasOwnProperty.call(source, 'fallbackExpired') ||
  Object.prototype.hasOwnProperty.call(source, 'usedPreviousSnapshot')
));

if (source) {
  requireOk(String(source.officialSource || '') === 'https://www.novva.com/careers/', 'Novva official careers source changed unexpectedly.');
  requireOk(Number(source.candidateLinks || 0) > 0, 'Novva collector did not retain any candidate job URLs.');

  const configuredMaxAge = Number(source.fallbackMaxAgeHours);
  if (Number.isFinite(configuredMaxAge)) {
    requireOk(configuredMaxAge > 0 && configuredMaxAge <= MAX_FALLBACK_AGE_HOURS, `Novva fallbackMaxAgeHours ${configuredMaxAge} exceeds the ${MAX_FALLBACK_AGE_HOURS}-hour publication policy.`);
  }

  if (source.sourceHealthy === true) {
    requireOk(Number(source.detailSucceeded || 0) > 0, 'Novva source was marked healthy without a successful detail fetch.');
    requireOk(Number(source.qualifyingRoles || 0) === snapshot.length, `Novva healthy-source qualifying count ${source.qualifyingRoles ?? 0} does not match snapshot count ${snapshot.length}.`);
    requireOk(Number(source.preservedPrevious || 0) === 0, 'Novva healthy source should not report preserved fallback roles.');
    requireOk(source.usedPreviousSnapshot !== true, 'Novva healthy source cannot report a preserved fallback snapshot.');
    requireOk(source.fallbackExpired !== true, 'Novva healthy source cannot be marked fallback-expired.');

    // Existing healthy status predates the freshness fields. Once the hardened
    // collector runs, the verification anchor becomes mandatory and remains so.
    if (freshnessFieldsPresent) {
      const lastHealthyMs = Date.parse(String(source.lastHealthyAt || ''));
      requireOk(Number.isFinite(lastHealthyMs), 'Novva healthy source is missing a valid lastHealthyAt verification anchor.');
      requireOk(Number(source.fallbackAgeHours || 0) === 0, 'Novva healthy source must record a zero-hour fallback age.');
    }
  } else {
    const fallbackExpired = source.fallbackExpired === true;
    const lastHealthyMs = Date.parse(String(source.lastHealthyAt || ''));
    const maxAgeHours = Number.isFinite(configuredMaxAge) && configuredMaxAge > 0
      ? Math.min(configuredMaxAge, MAX_FALLBACK_AGE_HOURS)
      : MAX_FALLBACK_AGE_HOURS;
    const computedAgeHours = Number.isFinite(lastHealthyMs)
      ? Math.max(0, (Date.now() - lastHealthyMs) / 3_600_000)
      : Infinity;

    if (fallbackExpired) {
      requireOk(snapshot.length === 0, `Novva fallback is expired but ${snapshot.length} snapshot role(s) remain.`);
      requireOk(publicJobs.length === 0, `Novva fallback is expired but ${publicJobs.length} public role(s) remain.`);
      requireOk(Number(source.preservedPrevious || 0) === 0, 'Novva expired fallback must not report preserved roles.');
      requireOk(source.usedPreviousSnapshot !== true, 'Novva expired fallback must not be marked as using the previous snapshot.');
    } else {
      requireOk(Number.isFinite(lastHealthyMs), 'Novva fallback has no valid lastHealthyAt verification anchor.');
      requireOk(computedAgeHours < maxAgeHours, `Novva fallback is ${computedAgeHours.toFixed(1)} hours old, beyond the ${maxAgeHours}-hour publication window.`);
      requireOk(snapshot.length > 0, 'Novva source is unhealthy and there is no verified snapshot to preserve.');
      requireOk(Number(source.preservedPrevious || 0) === snapshot.length, `Novva unhealthy-source preservation count ${source.preservedPrevious ?? 0} does not match snapshot count ${snapshot.length}.`);
      requireOk(source.usedPreviousSnapshot === true, 'Novva active fallback must explicitly report usedPreviousSnapshot=true.');
    }
  }
}

function canonicalNovvaRole(job) {
  let parsed = null;
  try { parsed = new URL(String(job?.sourceUrl || '')); } catch { return null; }
  const hostname = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (parsed.protocol !== 'https:' || !['novva.com', 'www.novva.com'].includes(hostname) || segments[0]?.toLowerCase() !== 'portfolio' || segments.length !== 2) return null;
  const slug = segments[1].toLowerCase();
  return {
    slug,
    id: `novva-${slug.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')}`,
    url: `https://${hostname}/portfolio/${segments[1]}/`
  };
}

function validateRole(job, label, requireRegion) {
  const id = String(job?.id || '(missing id)');
  const title = String(job?.title || '');
  const canonical = canonicalNovvaRole(job);
  requireOk(job?.company === COMPANY, `${label} ${id} has unexpected company ${job?.company || '(blank)'}.`);
  requireOk(Boolean(job?.id), `${label} role is missing an id.`);
  requireOk(missionTitlePattern.test(title), `${label} ${id} is outside Novva's hands-on data-center scope: ${title || '(blank)'}.`);
  requireOk(!seniorTitlePattern.test(title), `${label} ${id} leaked a senior title: ${title || '(blank)'}.`);
  requireOk(allowedExperiences.has(job?.experience), `${label} ${id} has invalid experience classification: ${job?.experience || '(blank)'}.`);
  requireOk(job?.active === true && job?.demo !== true, `${label} ${id} must be an active, non-demo role.`);
  requireOk(String(job?.source || '') === 'Official Novva careers', `${label} ${id} must identify the official Novva source exactly.`);
  if (requireRegion) requireOk(Boolean(job?.region), `${label} ${id} is missing a regional classification.`);
  requireOk(Boolean(canonical), `${label} ${id} is not linked to an official Novva job page.`);
  if (canonical) requireOk(String(job?.id || '') === canonical.id, `${label} ${id} does not match its official Novva job-page slug.`);
}

if (Array.isArray(snapshot)) snapshot.forEach(job => validateRole(job, 'Novva snapshot', false));
publicJobs.forEach(job => validateRole(job, 'Published Novva', true));

if (Array.isArray(snapshot)) {
  const snapshotIds = new Set();
  const snapshotUrls = new Set();
  const snapshotById = new Map();
  for (const job of snapshot) {
    const id = clean(job?.id);
    const url = clean(job?.sourceUrl);
    if (snapshotIds.has(id)) requireOk(false, `Novva snapshot contains duplicate id ${id || '(blank)'}.`);
    if (snapshotUrls.has(url)) requireOk(false, `Novva snapshot contains duplicate source URL ${url || '(blank)'}.`);
    snapshotIds.add(id);
    snapshotUrls.add(url);
    if (id) snapshotById.set(id, job);
  }

  const publicIds = new Set();
  for (const publicJob of publicJobs) {
    const id = clean(publicJob?.id);
    requireOk(!publicIds.has(id), `Public feed contains duplicate Novva id ${id || '(blank)'}.`);
    publicIds.add(id);
    const snapshotJob = snapshotById.get(id);
    requireOk(Boolean(snapshotJob), `Published Novva role ${id || '(blank)'} is not present in the authoritative snapshot.`);
    if (!snapshotJob) continue;

    for (const field of parityFields) {
      const snapshotValue = typeof snapshotJob?.[field] === 'string' ? clean(snapshotJob[field]) : snapshotJob?.[field];
      const publicValue = typeof publicJob?.[field] === 'string' ? clean(publicJob[field]) : publicJob?.[field];
      requireOk(snapshotValue === publicValue, `Published Novva ${id} differs from the authoritative snapshot for ${field}.`);
    }
  }

  for (const id of snapshotIds) {
    requireOk(publicIds.has(id), `Authoritative Novva snapshot role ${id} is missing from the public feed.`);
  }
  requireOk(publicJobs.length === snapshot.length, `Published Novva role count ${publicJobs.length} does not match verified snapshot count ${snapshot.length}.`);
}

if (errors.length) {
  console.error('Novva Data Centers source validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const mode = source?.sourceHealthy === true
  ? 'live source'
  : source?.fallbackExpired === true
    ? 'expired fail-closed state'
    : 'preserved verified snapshot';
console.log(`Novva Data Centers source validation passed: ${publicJobs.length} published employer-direct role(s) match the ${mode}.`);
