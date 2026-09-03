import { readFile } from 'node:fs/promises';

const MAX_AGE_HOURS = Number(process.env.DATA_FRESHNESS_MAX_HOURS || 48);
const MAX_FUTURE_SKEW_MINUTES = 10;
const now = Date.now();

if (!Number.isFinite(MAX_AGE_HOURS) || MAX_AGE_HOURS <= 0) {
  throw new Error('DATA_FRESHNESS_MAX_HOURS must be a positive number.');
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

console.log(`Data freshness passed: ${jobs.length} jobs; oldest refresh/QA marker is ${oldest.toFixed(1)}h old (limit ${MAX_AGE_HOURS}h).`);
