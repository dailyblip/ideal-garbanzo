import { readFile, writeFile } from 'node:fs/promises';

const STATUS_PATH = 'data/collector-status.json';
const MAX_FALLBACK_AGE_HOURS = 96;

const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
if (!status || typeof status !== 'object' || Array.isArray(status)) {
  throw new Error(`${STATUS_PATH} must contain an object.`);
}

const amazon = status.amazonDatacenter;
if (!amazon || typeof amazon !== 'object' || Array.isArray(amazon)) {
  throw new Error('AWS source diagnostic is missing.');
}

const attempted = Number(amazon.queriesAttempted || 0);
const succeeded = Number(amazon.queriesSucceeded || 0);
const healthy = amazon.sourceHealthy === true &&
  attempted > 0 &&
  succeeded === attempted &&
  Number(amazon.preservedPreviousRoles || 0) === 0;

if (!healthy) {
  console.log('AWS source is not fully healthy; preserving existing fallback verification evidence.');
  process.exit(0);
}

const checkedAt = new Date().toISOString();
status.amazonDatacenter = {
  ...amazon,
  checkedAt,
  lastHealthyAt: checkedAt,
  fallbackMaxAgeHours: MAX_FALLBACK_AGE_HOURS,
  fallbackFreshness: {
    ...(amazon.fallbackFreshness || {}),
    active: false,
    expired: false,
    lastHealthyAt: checkedAt,
    checkedAt,
    maxAgeHours: MAX_FALLBACK_AGE_HOURS,
    policy: 'Retain previously verified AWS employer-direct roles for at most 96 hours after the last evidenced complete official Amazon Jobs search.'
  }
};

await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
console.log(`Stamped healthy AWS source verification at ${checkedAt}.`);
