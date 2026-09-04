import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const MAX_AGE_HOURS = Number(process.env.DATA_FRESHNESS_MAX_HOURS || 48);
const MAX_MAJOR_FALLBACK_AGE_HOURS = Number(process.env.MAJOR_FALLBACK_MAX_HOURS || 96);
const MAX_FUTURE_SKEW_MINUTES = 10;
const now = Date.now();

const majorEmployers = [
  'Vantage Data Centers',
  'QTS Data Centers',
  'CyrusOne',
  'STACK Infrastructure',
  'NTT Global Data Centers',
  'Aligned Data Centers'
];

if (!Number.isFinite(MAX_AGE_HOURS) || MAX_AGE_HOURS <= 0) {
  throw new Error('DATA_FRESHNESS_MAX_HOURS must be a positive number.');
}
if (!Number.isFinite(MAX_MAJOR_FALLBACK_AGE_HOURS) || MAX_MAJOR_FALLBACK_AGE_HOURS <= 0) {
  throw new Error('MAJOR_FALLBACK_MAX_HOURS must be a positive number.');
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read ${path}: ${error.message || error}`);
  }
}

function validateTimestamp(label, value) {
  const text = String(value || '').trim();
  const parsed = Date.parse(text);
  if (!text || !Number.isFinite(parsed)) {
    throw new Error(`${label} is missing or invalid.`);
  }

  const ageMs = now - parsed;
  const maxAgeMs = MAX_AGE_HOURS * 60 * 60 * 1000;
  const futureSkewMs = MAX_FUTURE_SKEW_MINUTES * 60 * 1000;

  if (ageMs < -futureSkewMs) {
    throw new Error(`${label} is unexpectedly future-dated: ${text}`);
  }
  if (ageMs > maxAgeMs) {
    const ageHours = Math.floor(ageMs / 3600000);
    throw new Error(`${label} is stale (${ageHours}h old; maximum ${MAX_AGE_HOURS}h). Run a successful job refresh before deployment.`);
  }

  return Math.max(0, ageMs / 3600000);
}

function healthyMajorDiagnostic(diagnostic) {
  return Boolean(
    diagnostic &&
    diagnostic.sourceHealthy !== false &&
    diagnostic.listingComplete !== false &&
    diagnostic.usedPreviousSnapshot !== true
  );
}

async function historicalCollectorStatuses(limit = 60) {
  let commits = [];
  try {
    const { stdout } = await exec('git', ['log', '--format=%H', `-${limit}`, '--', 'data/collector-status.json'], {
      maxBuffer: 1024 * 1024
    });
    commits = stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  } catch {
    return [];
  }

  const statuses = [];
  for (const sha of commits) {
    try {
      const { stdout } = await exec('git', ['show', `${sha}:data/collector-status.json`], {
        maxBuffer: 4 * 1024 * 1024
      });
      const status = JSON.parse(stdout);
      statuses.push({ sha, status });
    } catch {
      // Ignore individual historical parse/read failures and continue farther back.
    }
  }
  return statuses;
}

async function validateMajorFallbackFreshness(status) {
  const diagnostics = status?.majorSources?.employerDiagnostics;
  if (!diagnostics || typeof diagnostics !== 'object') {
    console.log('Major Workday fallback freshness deferred until employer diagnostics are present.');
    return [];
  }

  const fallbackEmployers = majorEmployers.filter(company => !healthyMajorDiagnostic(diagnostics[company]));
  if (!fallbackEmployers.length) return [];

  const history = await historicalCollectorStatuses();
  if (!history.length) {
    throw new Error('Major-employer fallback is active but collector-status history could not be read to establish last verification time.');
  }

  const fallbackAges = [];
  for (const company of fallbackEmployers) {
    let lastVerifiedAt = null;
    let lastVerifiedSha = '';

    for (const entry of history) {
      const historicalDiagnostic = entry.status?.majorSources?.employerDiagnostics?.[company];
      if (!healthyMajorDiagnostic(historicalDiagnostic)) continue;
      const parsed = Date.parse(String(entry.status?.updatedAt || ''));
      if (!Number.isFinite(parsed)) continue;
      lastVerifiedAt = parsed;
      lastVerifiedSha = entry.sha;
      break;
    }

    if (!Number.isFinite(lastVerifiedAt)) {
      throw new Error(`${company} is using a retained Workday snapshot and no prior healthy verification timestamp was found in collector history.`);
    }

    const ageHours = Math.max(0, (now - lastVerifiedAt) / 3600000);
    if (ageHours > MAX_MAJOR_FALLBACK_AGE_HOURS) {
      throw new Error(`${company} retained Workday snapshot is stale (${Math.floor(ageHours)}h since last healthy verification; maximum ${MAX_MAJOR_FALLBACK_AGE_HOURS}h). Block deployment until the employer source verifies again.`);
    }

    fallbackAges.push({ company, ageHours, sha: lastVerifiedSha });
  }

  return fallbackAges;
}

const status = await readJson('data/collector-status.json');
const qaReport = await readJson('data/qa-report.json');
const jobs = await readJson('data/jobs.json');

if (!Array.isArray(jobs) || jobs.length === 0) {
  throw new Error('Published jobs snapshot is empty.');
}

const markers = [
  ['collector-status.updatedAt', status?.updatedAt],
  ['collector-status.postQa.checkedAt', status?.postQa?.checkedAt],
  ['qa-report.checkedAt', qaReport?.checkedAt]
];

const ages = markers.map(([label, value]) => [label, validateTimestamp(label, value)]);
const oldest = ages.reduce((max, [, hours]) => Math.max(max, hours), 0);
const fallbackAges = await validateMajorFallbackFreshness(status);

console.log(`Data freshness passed: ${jobs.length} jobs; oldest refresh/QA marker is ${oldest.toFixed(1)}h old (limit ${MAX_AGE_HOURS}h).`);
for (const fallback of fallbackAges) {
  console.warn(`Major-employer fallback freshness: ${fallback.company} last verified ${fallback.ageHours.toFixed(1)}h ago (limit ${MAX_MAJOR_FALLBACK_AGE_HOURS}h; history ${fallback.sha.slice(0, 8)}).`);
}
