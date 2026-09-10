import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const COMPANY = 'Digital Realty';
const OFFICIAL_HOST = 'hdep.fa.us2.oraclecloud.com';
const OFFICIAL_PATH_PREFIX = '/hcmUI/CandidateExperience/en/sites/CX/job/';
const SNAPSHOT_PATH = 'data/digital-realty-jobs.json';
const MAX_FALLBACK_AGE_HOURS = 96;
const MAX_FALLBACK_AGE_MS = MAX_FALLBACK_AGE_HOURS * 60 * 60 * 1000;
const VALID_EXPERIENCE = new Set(['no-experience', '0-2-years', '2-5-years']);
const VALID_TYPES = new Set(['entry-level', 'internship', 'apprenticeship', 'trainee']);
const EXECUTIVE_PATTERN = /\b(?:senior|sr\.?|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|superintendent|foreman)\b/i;
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalize = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function gitLastChangedAt(path) {
  try {
    const value = execFileSync('git', ['log', '-1', '--format=%cI', '--', path], { encoding: 'utf8' }).trim();
    return Number.isFinite(Date.parse(value)) ? value : null;
  } catch {
    return null;
  }
}

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

const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));
const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
const status = JSON.parse(await readFile('data/collector-status.json', 'utf8'));
const source = status?.digitalRealty;
const errors = [];
const requireOk = (condition, message) => { if (!condition) errors.push(message); };
requireOk(Array.isArray(jobs), 'Public jobs feed is not an array.');
requireOk(Array.isArray(snapshot), 'Digital Realty dedicated snapshot is not an array.');
requireOk(source && typeof source === 'object', 'Digital Realty collector status is missing.');
const snapshotJobs = Array.isArray(snapshot) ? snapshot : [];
const publicJobs = Array.isArray(jobs) ? jobs.filter(job => job?.company === COMPANY) : [];

function validateOfficialUrl(job, label) {
  let parsed;
  try { parsed = new URL(String(job?.sourceUrl || '')); } catch { requireOk(false, `${label} has an invalid source URL.`); return; }
  requireOk(parsed.protocol === 'https:', `${label} does not use HTTPS.`);
  requireOk(parsed.hostname.toLowerCase() === OFFICIAL_HOST, `${label} is not employer-direct (${parsed.hostname || 'missing host'}).`);
  requireOk(parsed.pathname.startsWith(OFFICIAL_PATH_PREFIX), `${label} does not point to the Digital Realty Candidate Experience job path.`);
}

function validateJob(job, label, requireRegion = false) {
  requireOk(Boolean(job?.id), `${label} is missing an id.`);
  requireOk(String(job?.id || '').startsWith('oracle-digitalrealty-'), `${label} has an unexpected id namespace.`);
  requireOk(job?.company === COMPANY, `${label} is owned by ${job?.company || '(blank)'} instead of Digital Realty.`);
  requireOk(Boolean(job?.title), `${label} is missing a title.`);
  requireOk(Boolean(job?.location), `${label} is missing a location.`);
  requireOk(VALID_TYPES.has(job?.type), `${label} has invalid role type ${job?.type || '(blank)'}.`);
  requireOk(VALID_EXPERIENCE.has(job?.experience), `${label} has invalid experience classification ${job?.experience || '(blank)'}.`);
  requireOk(!EXECUTIVE_PATTERN.test(String(job?.title || '')), `${label} leaked a senior/executive-heavy title: ${job?.title || '(blank)'}.`);
  requireOk(job?.active !== false && job?.demo !== true, `${label} is not an active production role.`);
  validateOfficialUrl(job, label);
  if (requireRegion) requireOk(Boolean(job?.region), `${label} is missing regional classification.`);
}
for (const job of snapshotJobs) validateJob(job, `Digital Realty snapshot job ${job?.id || '(unknown)'}`);
for (const job of publicJobs) validateJob(job, `Digital Realty public job ${job?.id || '(unknown)'}`, true);

if (source) {
  requireOk(String(source.officialSource || '') === 'https://www.digitalrealty.com/about/careers', 'Digital Realty official source metadata drifted from the employer careers page.');
  requireOk(String(source.boardUrl || '').startsWith(`https://${OFFICIAL_HOST}/hcmUI/CandidateExperience/en/sites/CX`), 'Digital Realty board URL metadata is not the official Oracle Recruiting Cloud board.');
  requireOk(Number(source.qualifyingRoles || 0) === snapshotJobs.length, `Digital Realty status reports ${Number(source.qualifyingRoles || 0)} qualifying role(s) but snapshot contains ${snapshotJobs.length}.`);
  requireOk(Number(source.preservedPrevious || 0) <= Number(source.detailFailures || 0), 'Digital Realty preservedPrevious exceeds reported detail failures.');

  if (source.snapshotMaxAgeHours !== undefined) {
    requireOk(Number(source.snapshotMaxAgeHours) === MAX_FALLBACK_AGE_HOURS, `Digital Realty fallback window drifted from ${MAX_FALLBACK_AGE_HOURS} hours.`);
  }

  if (source.sourceHealthy === true) {
    requireOk(Number(source.candidateRows || 0) > 0, 'Digital Realty source reported healthy but returned no candidate rows.');
    requireOk(Number(source.detailAttempts || 0) >= snapshotJobs.length, `Digital Realty healthy source attempted only ${Number(source.detailAttempts || 0)} detail page(s) for ${snapshotJobs.length} published snapshot role(s).`);
    requireOk(Number(source.candidateRows || 0) >= snapshotJobs.length, `Digital Realty healthy source has fewer candidates (${Number(source.candidateRows || 0)}) than qualifying snapshot roles (${snapshotJobs.length}).`);
    if (source.fallbackUsed !== undefined) requireOk(source.fallbackUsed === false, 'Digital Realty healthy source must not report fallback usage.');
    if (source.fallbackExpired !== undefined) requireOk(source.fallbackExpired === false, 'Digital Realty healthy source must not report an expired fallback.');
  } else {
    requireOk(Array.isArray(source.errors) && source.errors.length > 0, 'Digital Realty source is unhealthy without a recorded collector error.');

    if (snapshotJobs.length > 0) {
      const verifiedAt = source.lastHealthyAt || source.snapshotVerifiedAt || gitLastChangedAt(SNAPSHOT_PATH);
      const verifiedMs = Date.parse(String(verifiedAt || ''));
      const fallbackAgeMs = Number.isFinite(verifiedMs) ? Date.now() - verifiedMs : Infinity;
      const fallbackAgeHours = fallbackAgeMs / (60 * 60 * 1000);
      requireOk(Number.isFinite(verifiedMs), 'Digital Realty preserved snapshot has no trustworthy verification timestamp.');
      requireOk(fallbackAgeMs <= MAX_FALLBACK_AGE_MS, `Digital Realty preserved snapshot is ${Number.isFinite(fallbackAgeHours) ? fallbackAgeHours.toFixed(1) : 'unknown'} hours old; maximum is ${MAX_FALLBACK_AGE_HOURS} hours.`);
      if (source.fallbackUsed !== undefined) requireOk(source.fallbackUsed === true, 'Digital Realty source is unhealthy with published snapshot roles but fallbackUsed is false.');
      if (source.fallbackFresh !== undefined) requireOk(source.fallbackFresh === true, 'Digital Realty source is unhealthy with published snapshot roles but fallbackFresh is false.');
      if (source.fallbackExpired !== undefined) requireOk(source.fallbackExpired === false, 'Digital Realty source is unhealthy with published snapshot roles but fallbackExpired is true.');
    } else {
      if (source.fallbackUsed !== undefined) requireOk(source.fallbackUsed === false, 'Digital Realty has no published fallback roles but fallbackUsed is true.');
      if (source.fallbackFresh !== undefined) requireOk(source.fallbackFresh === false, 'Digital Realty has no published fallback roles but fallbackFresh is true.');
    }
  }
}

const snapshotTitles = new Set(snapshotJobs.map(canonicalTitle).filter(Boolean));
const publicTitles = new Set(publicJobs.map(canonicalTitle).filter(Boolean));
const missingTitles = [...snapshotTitles].filter(title => !publicTitles.has(title));
const unexpectedTitles = [...publicTitles].filter(title => !snapshotTitles.has(title));
requireOk(missingTitles.length === 0, `Digital Realty public feed is missing ${missingTitles.length}/${snapshotTitles.size} authoritative unique role title(s).`);
requireOk(unexpectedTitles.length === 0, `Digital Realty public feed contains ${unexpectedTitles.length} unique role title(s) not present in the authoritative snapshot.`);

if (errors.length) {
  console.error('Digital Realty source validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
const sourceState = source?.sourceHealthy === true
  ? 'healthy'
  : snapshotJobs.length
    ? 'using a fresh preserved snapshot'
    : 'unavailable with no stale fallback published';
console.log(`Digital Realty source validation passed: ${snapshotJobs.length} protected requisitions represented by ${publicTitles.size} clean public role title(s), source ${sourceState}.`);
