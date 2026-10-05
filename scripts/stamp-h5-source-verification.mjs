import { readFile, writeFile } from 'node:fs/promises';

const STATUS_PATH = 'data/collector-status.json';
const SOURCE_KEY = 'h5DataCenters';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

const status = await readJson(STATUS_PATH, {});
if (!status || typeof status !== 'object' || Array.isArray(status)) {
  throw new Error(`${STATUS_PATH} must contain an object.`);
}

const source = status[SOURCE_KEY];
if (!source || typeof source !== 'object' || Array.isArray(source)) {
  throw new Error('H5 source status is missing after collection.');
}

const nowMs = Date.now();
function explicitTimestamp(value) {
  const timestamp = clean(value);
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && parsed <= nowMs ? timestamp : null;
}
// This compatibility entry point must never turn the stamp's wall clock into
// source evidence. The collector owns the completed attempt and its diagnostics.
const checkedAt = explicitTimestamp(source.checkedAt);
const fetched = source.listing?.fetched;
const advertised = source.listing?.advertised;
const sourceHealthy = source.sourceHealthy === true && checkedAt !== null
  && source.usedPreviousSnapshot === false
  && source.diagnostics?.listingComplete === true
  && Number.isInteger(fetched) && fetched >= 0
  && Number.isInteger(advertised) && advertised >= 0 && advertised <= fetched
  && source.diagnostics?.detailAttempted === fetched
  && source.diagnostics?.detailSucceeded === fetched
  && source.drops?.missingDetailId === 0 && source.drops?.detailFetch === 0
  && source.drops?.invalidDetail === 0;
const lastSuccessfulAt = sourceHealthy ? checkedAt : explicitTimestamp(source.lastSuccessfulAt);
const lastHealthyAt = sourceHealthy ? checkedAt : explicitTimestamp(source.lastHealthyAt);

status[SOURCE_KEY] = {
  ...source,
  sourceHealthy,
  checkedAt,
  lastSuccessfulAt,
  lastHealthyAt
};

await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
console.log(sourceHealthy
  ? `Retained H5 successful source verification at ${checkedAt}.`
  : `H5 source check is incomplete; preserved last successful verification at ${lastSuccessfulAt || lastHealthyAt || 'none'}.`);
