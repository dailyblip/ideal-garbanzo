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

const checkedAt = new Date().toISOString();
const priorVerifiedAt = clean(source.lastSuccessfulAt || source.lastHealthyAt);
const sourceHealthy = source.sourceHealthy === true;
const lastSuccessfulAt = sourceHealthy ? checkedAt : (priorVerifiedAt || null);

status.updatedAt = checkedAt;
status[SOURCE_KEY] = {
  ...source,
  checkedAt,
  lastSuccessfulAt,
  lastHealthyAt: lastSuccessfulAt
};

await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
console.log(sourceHealthy
  ? `Stamped H5 successful source verification at ${checkedAt}.`
  : `H5 source check failed; preserved last successful verification at ${lastSuccessfulAt || 'none'}.`);
