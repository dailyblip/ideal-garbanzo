import { readFile, writeFile } from 'node:fs/promises';

const COMPANY = 'Compass Datacenters';
const BOARD_URL = 'https://compass-datacenters.breezy.hr/';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const SOURCE_STATUS_PATH = 'data/compass-status.json';
const SNAPSHOT_PATH = 'data/compass-jobs.json';
const MAX_FALLBACK_AGE_HOURS = 96;

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const clearlyExcludedSlug = /(?:^|-)(?:senior|sr|lead|principal|staff|manager|director|vice-president|vp|chief|head-of|supervisor|architect|security|sales|finance|marketing)(?:-|$)/i;

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

function fallbackState({ sourceHealthy, previousLastHealthyAt, nowMs = Date.now() }) {
  if (sourceHealthy) {
    return {
      lastHealthyAt: new Date(nowMs).toISOString(),
      fallbackAgeHours: 0,
      fallbackExpired: false
    };
  }

  const lastHealthyMs = Date.parse(String(previousLastHealthyAt || ''));
  if (!Number.isFinite(lastHealthyMs)) {
    return {
      lastHealthyAt: null,
      fallbackAgeHours: null,
      fallbackExpired: true
    };
  }

  const ageHours = Math.max(0, (nowMs - lastHealthyMs) / 3_600_000);
  return {
    lastHealthyAt: new Date(lastHealthyMs).toISOString(),
    fallbackAgeHours: Math.round(ageHours * 10) / 10,
    fallbackExpired: ageHours >= MAX_FALLBACK_AGE_HOURS
  };
}

function runFreshnessSelfTest() {
  const nowMs = Date.parse('2026-09-16T09:30:00.000Z');
  const healthy = fallbackState({ sourceHealthy: true, previousLastHealthyAt: null, nowMs });
  if (healthy.fallbackExpired || healthy.fallbackAgeHours !== 0 || healthy.lastHealthyAt !== '2026-09-16T09:30:00.000Z') {
    throw new Error('Compass healthy-source freshness regression failed.');
  }

  const freshFallback = fallbackState({
    sourceHealthy: false,
    previousLastHealthyAt: new Date(nowMs - 95 * 3_600_000).toISOString(),
    nowMs
  });
  if (freshFallback.fallbackExpired || freshFallback.fallbackAgeHours !== 95) {
    throw new Error('Compass verified fallback should remain publishable inside 96 hours.');
  }

  const boundaryFallback = fallbackState({
    sourceHealthy: false,
    previousLastHealthyAt: new Date(nowMs - MAX_FALLBACK_AGE_HOURS * 3_600_000).toISOString(),
    nowMs
  });
  if (!boundaryFallback.fallbackExpired) {
    throw new Error('Compass fallback must fail closed at the 96-hour boundary.');
  }

  const missingAnchor = fallbackState({ sourceHealthy: false, previousLastHealthyAt: null, nowMs });
  if (!missingAnchor.fallbackExpired || missingAnchor.lastHealthyAt !== null) {
    throw new Error('Compass fallback without a healthy-source anchor must fail closed.');
  }

  console.log('Compass fallback freshness regression tests passed.');
}

if (process.argv.includes('--test-freshness')) {
  runFreshnessSelfTest();
  process.exit(0);
}

function isCompassJob(job = {}) {
  if (clean(job?.company) === COMPANY) return true;
  try {
    return new URL(clean(job?.sourceUrl)).hostname.toLowerCase() === 'compass-datacenters.breezy.hr';
  } catch {
    return false;
  }
}

function dedupe(jobs) {
  const ids = new Set();
  const urls = new Set();
  const output = [];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job || typeof job !== 'object') continue;
    const id = clean(job.id);
    const url = clean(job.sourceUrl);
    if ((id && ids.has(id)) || (url && urls.has(url))) continue;
    if (id) ids.add(id);
    if (url) urls.add(url);
    output.push(job);
  }
  return output;
}

function outOfScopeUnstructuredEvidence(source = {}) {
  const errors = Array.isArray(source?.errors) ? source.errors : [];
  const urls = new Set();
  for (const value of errors) {
    const match = clean(value).match(/^structured data missing:\s+(https:\/\/\S+)$/i);
    if (!match) continue;
    try {
      const url = new URL(match[1]);
      if (url.hostname.toLowerCase() !== 'compass-datacenters.breezy.hr') continue;
      const slug = url.pathname.split('/').filter(Boolean).pop() || '';
      if (clearlyExcludedSlug.test(slug)) urls.add(url.toString());
    } catch {}
  }
  return { count: urls.size, urls: [...urls].sort() };
}

function strictSourceHealth(source = {}) {
  const listed = Number(source.listedPositions);
  const attempted = Number(source.detailAttempted);
  const fetched = Number(source.detailFetched);
  const structured = Number(source.structuredDetails);
  const structuredDrops = Number(source?.drops?.structuredData || 0);
  const ignored = outOfScopeUnstructuredEvidence(source);
  return source.sourceHealthy === true
    && source.boardFetched === true
    && source.boardUrl === BOARD_URL
    && Number.isInteger(listed)
    && listed > 0
    && attempted === listed
    && fetched === listed
    && Number.isInteger(structured)
    && Number.isInteger(structuredDrops)
    && ignored.count === structuredDrops
    && structured + ignored.count === fetched;
}

const [aggregate, jobs, previousSourceStatus, previousSnapshot] = await Promise.all([
  readJson(STATUS_PATH, {}),
  readJson(JOBS_PATH, []),
  readJson(SOURCE_STATUS_PATH, {}),
  readJson(SNAPSHOT_PATH, [])
]);

if (!Array.isArray(jobs)) throw new Error('jobs.json must contain an array');
if (!Array.isArray(previousSnapshot)) throw new Error('compass-jobs.json must contain an array');

const source = aggregate?.compass;
if (!source || typeof source !== 'object') {
  throw new Error('Compass collector diagnostics are missing from data/collector-status.json.');
}

const checkedAt = new Date().toISOString();
const ignoredUnstructured = outOfScopeUnstructuredEvidence(source);
const sourceHealthy = strictSourceHealth(source);
const freshness = fallbackState({
  sourceHealthy,
  previousLastHealthyAt: previousSourceStatus?.lastHealthyAt,
  nowMs: Date.parse(checkedAt)
});
const fallbackActive = !sourceHealthy && !freshness.fallbackExpired && previousSnapshot.length > 0;
const freshlyCollected = dedupe(jobs.filter(isCompassJob));
const selected = sourceHealthy ? freshlyCollected : fallbackActive ? dedupe(previousSnapshot) : [];

const withoutCompass = jobs.filter(job => !isCompassJob(job));
const nextJobs = dedupe([...withoutCompass, ...selected]);
const countsByType = nextJobs.reduce((acc, job) => {
  const key = clean(job?.type) || 'unknown';
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {});
const countsByExperience = nextJobs.reduce((acc, job) => {
  const key = clean(job?.experience) || 'unknown';
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {});

const compass = {
  ...source,
  boardUrl: BOARD_URL,
  sourceHealthy,
  checkedAt,
  lastHealthyAt: freshness.lastHealthyAt,
  listingComplete: sourceHealthy,
  authoritativeSnapshot: sourceHealthy,
  fallbackMaxAgeHours: MAX_FALLBACK_AGE_HOURS,
  fallbackAgeHours: freshness.fallbackAgeHours,
  fallbackExpired: freshness.fallbackExpired,
  usedPreviousSnapshot: fallbackActive,
  publishedRoles: selected.length,
  preservedPrevious: fallbackActive ? selected.length : 0,
  removedExpiredFallback: !sourceHealthy && freshness.fallbackExpired ? previousSnapshot.length : 0,
  ignoredUnstructuredOutOfScope: ignoredUnstructured.count,
  ignoredUnstructuredOutOfScopeUrls: ignoredUnstructured.urls,
  fallbackPolicy: `Retain the last fully verified Compass snapshot for at most ${MAX_FALLBACK_AGE_HOURS} hours after official-source failure; then remove Compass roles until fresh verification succeeds.`
};

const nextAggregate = {
  ...aggregate,
  jobs: nextJobs.length,
  countsByType,
  countsByExperience,
  compass
};

await Promise.all([
  writeFile(JOBS_PATH, JSON.stringify(nextJobs, null, 2) + '\n'),
  writeFile(SNAPSHOT_PATH, JSON.stringify(selected, null, 2) + '\n'),
  writeFile(STATUS_PATH, JSON.stringify(nextAggregate, null, 2) + '\n'),
  writeFile(SOURCE_STATUS_PATH, JSON.stringify(compass, null, 2) + '\n')
]);

if (sourceHealthy) {
  console.log(`Persisted fully verified Compass snapshot: ${source.listedPositions || 0} public positions, ${selected.length} mission-fit roles${ignoredUnstructured.count ? `; ${ignoredUnstructured.count} clearly out-of-scope unstructured page(s) excluded` : ''}.`);
} else if (fallbackActive) {
  console.warn(`Compass source incomplete; preserved ${selected.length} previously verified role(s) inside the ${MAX_FALLBACK_AGE_HOURS}-hour freshness window.`);
} else {
  console.warn(`Compass source is not fully verifiable; published 0 Compass roles${freshness.fallbackExpired ? ' because verified fallback evidence is expired or unavailable' : ''}.`);
}
