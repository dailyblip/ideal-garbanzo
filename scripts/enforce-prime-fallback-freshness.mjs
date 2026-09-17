import { readFile, writeFile } from 'node:fs/promises';

const COMPANY = 'Prime Data Centers';
const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/prime-data-centers-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const BOARD_API = 'https://api.rippling.com/platform/api/ats/v1/board/prime-data-centers/jobs';
const BOARD_ROOT = 'https://ats.rippling.com/prime-data-centers/jobs';
const MAX_FALLBACK_AGE_HOURS = 96;
const HEALTH_STAMP_INTERVAL_HOURS = 24;

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

function extractBoardRows(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['jobs', 'items', 'data', 'results']) {
    if (Array.isArray(payload?.[key])) return payload[key];
    if (Array.isArray(payload?.data?.[key])) return payload.data[key];
  }
  return [];
}

function canonicalPrimeId(value) {
  const raw = clean(value);
  if (!raw) return '';
  const idMatch = raw.match(/^rippling-prime-(.+)$/i);
  if (idMatch) {
    try { return decodeURIComponent(idMatch[1]); }
    catch { return idMatch[1]; }
  }
  try {
    const parsed = new URL(raw, `${BOARD_ROOT}/`);
    if (parsed.hostname.toLowerCase() !== 'ats.rippling.com') return '';
    const match = parsed.pathname.match(/\/prime-data-centers\/jobs\/([^/?#]+)/i);
    if (!match) return '';
    try { return decodeURIComponent(match[1]); }
    catch { return match[1]; }
  } catch {
    return '';
  }
}

function boardRowId(row) {
  for (const value of [row?.uuid, row?.id, row?.jobId, row?.job_id]) {
    const id = clean(value);
    if (id) return id;
  }
  for (const value of [row?.url, row?.jobUrl, row?.job_url]) {
    const id = canonicalPrimeId(value);
    if (id) return id;
  }
  return '';
}

function isPrime(job) {
  return clean(job?.company) === COMPANY;
}

function roleIsActive(job, activeIds) {
  const id = canonicalPrimeId(job?.id) || canonicalPrimeId(job?.sourceUrl);
  return Boolean(id && activeIds.has(id));
}

function prunePrimeRoles(list, activeIds) {
  return list.filter(job => !isPrime(job) || roleIsActive(job, activeIds));
}

function fallbackDecision({ lastHealthyAt, nowMs, maxAgeHours = MAX_FALLBACK_AGE_HOURS }) {
  const healthyMs = Date.parse(String(lastHealthyAt || ''));
  if (!Number.isFinite(healthyMs)) return { expired: true, ageHours: null };
  const ageHours = Math.max(0, (nowMs - healthyMs) / 36e5);
  return { expired: ageHours >= maxAgeHours, ageHours };
}

function recalcCounts(status, jobs) {
  status.jobs = jobs.length;
  status.countsByType = jobs.reduce((acc, job) => {
    const key = clean(job?.type) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  status.countsByExperience = jobs.reduce((acc, job) => {
    const key = clean(job?.experience) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response?.headers?.get?.('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 15000);
  return Math.min(1000 * (2 ** attempt), 8000);
}

async function fetchActiveBoardIds() {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await fetch(BOARD_API, {
        headers: {
          accept: 'application/json',
          'user-agent': 'DataCenterCareersBot/1.1 (+https://datacentercareers.us/)'
        },
        signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) {
        lastError = new Error(`${response.status} ${BOARD_API}`);
        if (![408, 425, 429, 500, 502, 503, 504].includes(response.status) || attempt === 2) break;
        await new Promise(resolve => setTimeout(resolve, retryDelay(response, attempt)));
        continue;
      }
      const rows = extractBoardRows(await response.json());
      if (!rows.length) throw new Error('Prime Rippling board returned no public jobs');
      const ids = new Set(rows.map(boardRowId).filter(Boolean));
      if (!ids.size) throw new Error('Prime Rippling board returned no canonical job IDs');
      return { ids, rowCount: rows.length };
    } catch (error) {
      lastError = error;
      if (attempt === 2) break;
      await new Promise(resolve => setTimeout(resolve, 1000 * (2 ** attempt)));
    }
  }
  throw lastError || new Error('Unable to verify Prime Rippling board');
}

function runSelfTest() {
  if (canonicalPrimeId('rippling-prime-abc-123') !== 'abc-123') throw new Error('Prime ID parser failed public job ID');
  if (canonicalPrimeId('https://ats.rippling.com/prime-data-centers/jobs/xyz-789?source=test') !== 'xyz-789') throw new Error('Prime ID parser failed official job URL');
  if (canonicalPrimeId('https://example.com/prime-data-centers/jobs/xyz-789')) throw new Error('Prime ID parser accepted non-official host');

  const now = Date.parse('2026-09-10T12:00:00Z');
  const fresh = fallbackDecision({ lastHealthyAt: '2026-09-06T12:00:01Z', nowMs: now });
  if (fresh.expired) throw new Error('Prime fallback expired before 96 hours');
  const boundary = fallbackDecision({ lastHealthyAt: '2026-09-06T12:00:00Z', nowMs: now });
  if (!boundary.expired) throw new Error('Prime fallback did not expire at the 96-hour boundary');
  const unknown = fallbackDecision({ lastHealthyAt: '', nowMs: now });
  if (!unknown.expired) throw new Error('Prime fallback without healthy-source evidence did not fail closed');

  const sample = [
    { company: COMPANY, id: 'rippling-prime-abc-123', sourceUrl: `${BOARD_ROOT}/abc-123` },
    { company: COMPANY, id: 'rippling-prime-stale-456', sourceUrl: `${BOARD_ROOT}/stale-456` },
    { company: 'Other', id: 'other-1' }
  ];
  const pruned = prunePrimeRoles(sample, new Set(['abc-123']));
  if (pruned.length !== 2 || pruned.some(job => job.id === 'rippling-prime-stale-456')) throw new Error('Prime liveness pruning regression');
  console.log('Prime stale-fallback freshness regression tests passed.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

const jobs = await readJson(JOBS_PATH, []);
const snapshot = await readJson(SNAPSHOT_PATH, []);
const status = await readJson(STATUS_PATH, {});
if (!Array.isArray(jobs)) throw new Error(`${JOBS_PATH} must contain an array`);
if (!Array.isArray(snapshot)) throw new Error(`${SNAPSHOT_PATH} must contain an array`);
if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error(`${STATUS_PATH} must contain an object`);

const nowMs = Date.now();
const checkedAt = new Date(nowMs).toISOString();
const prior = status.primeFallbackFreshness || {};
const source = status.primeDataCenters || {};
let board = null;
let sourceError = '';

try {
  board = await fetchActiveBoardIds();
} catch (error) {
  sourceError = clean(error?.message || error);
}

if (board) {
  const nextSnapshot = prunePrimeRoles(snapshot, board.ids);
  const nextJobs = prunePrimeRoles(jobs, board.ids);
  const snapshotRemoved = snapshot.length - nextSnapshot.length;
  const publicRemoved = jobs.filter(isPrime).length - nextJobs.filter(isPrime).length;
  const previousHealthyAt = clean(prior.lastHealthyAt) || clean(source.lastSuccessfulAt);
  const previousHealthyMs = Date.parse(previousHealthyAt);
  const stampAgeHours = Number.isFinite(previousHealthyMs) ? Math.max(0, (nowMs - previousHealthyMs) / 36e5) : null;
  const countRepair = Number(source.qualifyingRoles) !== nextSnapshot.length;
  const shouldPersist = !Number.isFinite(previousHealthyMs)
    || prior.active === true
    || prior.expired === true
    || snapshotRemoved > 0
    || publicRemoved > 0
    || countRepair
    || stampAgeHours >= HEALTH_STAMP_INTERVAL_HOURS;

  if (!shouldPersist) {
    console.log(`Prime Rippling board is healthy with ${board.ids.size} canonical job ID(s); durable freshness stamp is ${Math.round(stampAgeHours * 10) / 10} hours old.`);
    process.exit(0);
  }

  status.updatedAt = checkedAt;
  status.primeDataCenters = {
    ...source,
    sourceHealthy: true,
    listingComplete: true,
    authoritativeSnapshot: true,
    qualifyingRoles: nextSnapshot.length
  };
  recalcCounts(status, nextJobs);
  status.primeFallbackFreshness = {
    active: false,
    expired: false,
    lastHealthyAt: checkedAt,
    checkedAt,
    maxAgeHours: MAX_FALLBACK_AGE_HOURS,
    healthStampIntervalHours: HEALTH_STAMP_INTERVAL_HOURS,
    boardUrl: BOARD_API,
    boardRows: board.rowCount,
    canonicalBoardJobs: board.ids.size,
    staleSnapshotRolesRemoved: snapshotRemoved,
    stalePublicRolesRemoved: publicRemoved,
    policy: 'Verify Prime role liveness against the official Rippling board. If that source cannot be verified, retain the last verified employer-direct snapshot for at most 96 hours.'
  };

  await writeFile(SNAPSHOT_PATH, JSON.stringify(nextSnapshot, null, 2) + '\n');
  await writeFile(JOBS_PATH, JSON.stringify(nextJobs, null, 2) + '\n');
  await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
  console.log(`Prime Rippling board verified ${board.ids.size} canonical job ID(s); removed ${snapshotRemoved} stale snapshot role(s) and ${publicRemoved} stale public role(s).`);
  process.exit(0);
}

const lastHealthyAt = clean(prior.lastHealthyAt) || clean(source.lastSuccessfulAt);
const decision = fallbackDecision({ lastHealthyAt, nowMs });
const roundedAgeHours = decision.ageHours === null ? null : Math.round(decision.ageHours * 10) / 10;

if (!decision.expired) {
  const alreadyActive = prior.active === true
    && prior.expired !== true
    && clean(prior.lastHealthyAt) === lastHealthyAt
    && Number(prior.maxAgeHours) === MAX_FALLBACK_AGE_HOURS;
  if (alreadyActive) {
    console.warn(`Prime Rippling board remains unavailable; retained fallback is ${roundedAgeHours} hours old and still inside the ${MAX_FALLBACK_AGE_HOURS}-hour window. ${sourceError}`);
    process.exit(0);
  }

  status.primeFallbackFreshness = {
    active: true,
    expired: false,
    lastHealthyAt,
    firstFailureAt: clean(prior.firstFailureAt) || checkedAt,
    checkedAt,
    maxAgeHours: MAX_FALLBACK_AGE_HOURS,
    boardUrl: BOARD_API,
    sourceError,
    policy: 'Prime Rippling verification is unavailable. Retain the last verified employer-direct snapshot for at most 96 hours from the last healthy source evidence.'
  };
  await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
  console.warn(`Prime Rippling board is unavailable; initialized fallback at ${roundedAgeHours} hours since the last healthy verification. ${sourceError}`);
  process.exit(0);
}

const publicBefore = jobs.filter(isPrime).length;
const snapshotBefore = snapshot.filter(isPrime).length;
const nextJobs = jobs.filter(job => !isPrime(job));
const nextSnapshot = snapshot.filter(job => !isPrime(job));
status.updatedAt = checkedAt;
status.primeDataCenters = {
  ...source,
  sourceHealthy: false,
  listingComplete: false,
  authoritativeSnapshot: true,
  qualifyingRoles: 0
};
recalcCounts(status, nextJobs);
status.primeFallbackFreshness = {
  active: false,
  expired: true,
  lastHealthyAt: lastHealthyAt || null,
  checkedAt,
  maxAgeHours: MAX_FALLBACK_AGE_HOURS,
  expiredAgeHours: roundedAgeHours,
  boardUrl: BOARD_API,
  sourceError,
  rolesRemoved: Math.max(publicBefore, snapshotBefore),
  policy: 'Prime employer-direct verification exceeded 96 hours, so retained Prime roles were removed until the official Rippling source recovers.'
};

await writeFile(JOBS_PATH, JSON.stringify(nextJobs, null, 2) + '\n');
await writeFile(SNAPSHOT_PATH, JSON.stringify(nextSnapshot, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
console.warn(`Expired Prime fallback after ${roundedAgeHours ?? 'unknown'} hours without employer-direct verification; removed ${publicBefore} public role(s) and ${snapshotBefore} snapshot role(s). ${sourceError}`);
