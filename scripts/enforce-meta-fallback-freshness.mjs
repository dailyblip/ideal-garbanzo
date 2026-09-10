import { readFile, writeFile } from 'node:fs/promises';

const COMPANY = 'Meta';
const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/meta-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const SITEMAP_URL = 'https://www.metacareers.com/jobsearch/sitemap.xml';
const MAX_FALLBACK_AGE_HOURS = 96;
const HEALTH_STAMP_INTERVAL_HOURS = 24;
const MIN_HEALTHY_SITEMAP_JOBS = 50;

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

function canonicalMetaId(value) {
  const raw = clean(value);
  if (!raw) return '';
  const idMatch = raw.match(/^meta-(\d+)$/i);
  if (idMatch) return idMatch[1];
  try {
    const parsed = new URL(raw, 'https://www.metacareers.com/');
    if (!/(^|\.)metacareers\.com$/i.test(parsed.hostname)) return '';
    return parsed.pathname.match(/\/(?:profile\/job_details|jobs)\/(\d+)/i)?.[1] || '';
  } catch {
    return '';
  }
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function parseSitemapIds(xml) {
  const ids = new Set();
  for (const match of String(xml || '').matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)) {
    const id = canonicalMetaId(decodeXml(match[1]));
    if (id) ids.add(id);
  }
  return ids;
}

async function fetchCurrentSitemap() {
  const response = await fetch(SITEMAP_URL, {
    headers: {
      accept: 'application/xml,text/xml,*/*',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': 'facebookexternalhit/1.1 (+https://datacentercareers.us/)'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000)
  });
  if (!response.ok) throw new Error(`${response.status} ${SITEMAP_URL}`);
  const ids = parseSitemapIds(await response.text());
  if (ids.size < MIN_HEALTHY_SITEMAP_JOBS) {
    throw new Error(`Meta sitemap returned only ${ids.size} canonical job URL(s); refusing to treat a potentially partial response as healthy`);
  }
  return ids;
}

function metaRole(job) {
  return clean(job?.company) === COMPANY;
}

function roleIsActive(job, activeIds) {
  const id = canonicalMetaId(job?.id) || canonicalMetaId(job?.sourceUrl);
  return Boolean(id && activeIds.has(id));
}

function pruneMetaRoles(list, activeIds) {
  return list.filter(job => !metaRole(job) || roleIsActive(job, activeIds));
}

function collectorHasHealthySitemapEvidence(status = {}) {
  const meta = status?.metaCareers || {};
  const diagnostics = meta?.diagnostics || {};
  return meta?.sourceHealthy === true && diagnostics?.sitemapFetched === true && Number(diagnostics?.sitemapJobs || 0) >= MIN_HEALTHY_SITEMAP_JOBS;
}

function fallbackDecision({ lastHealthyAt, nowMs, maxAgeHours = MAX_FALLBACK_AGE_HOURS }) {
  const lastHealthyMs = Date.parse(String(lastHealthyAt || ''));
  if (!Number.isFinite(lastHealthyMs)) return { expired: true, ageHours: null };
  const ageHours = Math.max(0, (nowMs - lastHealthyMs) / 36e5);
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

function runSelfTest() {
  const ids = parseSitemapIds(`<?xml version="1.0"?><urlset>
    <url><loc>https://www.metacareers.com/profile/job_details/123456789/</loc></url>
    <url><loc>https://www.metacareers.com/jobs/987654321/?x=1&amp;y=2</loc></url>
    <url><loc>https://example.com/jobs/111111111/</loc></url>
  </urlset>`);
  if (ids.size !== 2 || !ids.has('123456789') || !ids.has('987654321')) {
    throw new Error('Meta sitemap parser did not retain exactly the canonical Meta job IDs');
  }

  const now = Date.parse('2026-09-10T12:00:00Z');
  const fresh = fallbackDecision({ lastHealthyAt: '2026-09-06T12:00:01Z', nowMs: now });
  if (fresh.expired) throw new Error('Meta fallback expired before 96 hours');
  const boundary = fallbackDecision({ lastHealthyAt: '2026-09-06T12:00:00Z', nowMs: now });
  if (!boundary.expired) throw new Error('Meta fallback did not expire at the 96-hour boundary');
  const unknown = fallbackDecision({ lastHealthyAt: '', nowMs: now });
  if (!unknown.expired) throw new Error('Meta fallback without healthy-source evidence did not fail closed');

  const sample = [
    { company: 'Meta', id: 'meta-123456789' },
    { company: 'Meta', id: 'meta-555555555' },
    { company: 'Other', id: 'other-1' }
  ];
  const pruned = pruneMetaRoles(sample, new Set(['123456789']));
  if (pruned.length !== 2 || pruned.some(job => job.id === 'meta-555555555')) {
    throw new Error('Meta sitemap pruning regression');
  }
  console.log('Meta stale-fallback freshness regression tests passed.');
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
const prior = status.metaFallbackFreshness || {};
let activeIds = null;
let sourceError = '';

try {
  activeIds = await fetchCurrentSitemap();
} catch (error) {
  sourceError = clean(error?.message || error);
}

if (activeIds) {
  const nextSnapshot = pruneMetaRoles(snapshot, activeIds);
  const nextJobs = pruneMetaRoles(jobs, activeIds);
  const snapshotRemoved = snapshot.length - nextSnapshot.length;
  const publicRemoved = jobs.filter(metaRole).length - nextJobs.filter(metaRole).length;
  const previousHealthyMs = Date.parse(String(prior.lastHealthyAt || ''));
  const stampAgeHours = Number.isFinite(previousHealthyMs) ? Math.max(0, (nowMs - previousHealthyMs) / 36e5) : null;
  const countRepair = Number(status?.metaCareers?.qualifyingRoles) !== nextSnapshot.length;
  const shouldPersist = !Number.isFinite(previousHealthyMs) || prior.active === true || prior.expired === true || snapshotRemoved > 0 || publicRemoved > 0 || countRepair || stampAgeHours >= HEALTH_STAMP_INTERVAL_HOURS;

  if (!shouldPersist) {
    console.log(`Meta Careers sitemap is healthy with ${activeIds.size} active job URL(s); durable freshness stamp is ${Math.round(stampAgeHours * 10) / 10} hours old.`);
    process.exit(0);
  }

  if (status.metaCareers && typeof status.metaCareers === 'object') {
    status.metaCareers = { ...status.metaCareers, qualifyingRoles: nextSnapshot.length };
  }
  recalcCounts(status, nextJobs);
  status.metaFallbackFreshness = {
    active: false,
    expired: false,
    lastHealthyAt: checkedAt,
    checkedAt,
    maxAgeHours: MAX_FALLBACK_AGE_HOURS,
    healthStampIntervalHours: HEALTH_STAMP_INTERVAL_HOURS,
    sitemapUrl: SITEMAP_URL,
    sitemapJobs: activeIds.size,
    staleSnapshotRolesRemoved: snapshotRemoved,
    stalePublicRolesRemoved: publicRemoved,
    policy: 'Verify Meta role liveness against the official Meta Careers sitemap. If that source cannot be verified, retain the last verified snapshot for at most 96 hours.'
  };

  await writeFile(SNAPSHOT_PATH, JSON.stringify(nextSnapshot, null, 2) + '\n');
  await writeFile(JOBS_PATH, JSON.stringify(nextJobs, null, 2) + '\n');
  await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
  console.log(`Meta Careers sitemap verified ${activeIds.size} active job URL(s); removed ${snapshotRemoved} stale snapshot role(s) and ${publicRemoved} stale public role(s).`);
  process.exit(0);
}

let lastHealthyAt = clean(prior.lastHealthyAt);
if (!lastHealthyAt && collectorHasHealthySitemapEvidence(status)) {
  const candidate = clean(status.updatedAt);
  if (Number.isFinite(Date.parse(candidate))) lastHealthyAt = candidate;
}
const decision = fallbackDecision({ lastHealthyAt, nowMs });
const roundedAgeHours = decision.ageHours === null ? null : Math.round(decision.ageHours * 10) / 10;

if (!decision.expired) {
  const alreadyActive = prior.active === true && prior.expired !== true && clean(prior.lastHealthyAt) === lastHealthyAt && Number(prior.maxAgeHours) === MAX_FALLBACK_AGE_HOURS;
  if (alreadyActive) {
    console.warn(`Meta Careers sitemap remains unavailable; retained fallback is ${roundedAgeHours} hours old and still inside the ${MAX_FALLBACK_AGE_HOURS}-hour window. ${sourceError}`);
    process.exit(0);
  }

  status.metaFallbackFreshness = {
    active: true,
    expired: false,
    lastHealthyAt,
    firstFailureAt: clean(prior.firstFailureAt) || checkedAt,
    checkedAt,
    maxAgeHours: MAX_FALLBACK_AGE_HOURS,
    sitemapUrl: SITEMAP_URL,
    sourceError,
    policy: 'Meta Careers sitemap verification is unavailable. Retain the last verified employer-direct snapshot for at most 96 hours from the last healthy sitemap evidence.'
  };
  await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
  console.warn(`Meta Careers sitemap is unavailable; initialized fallback at ${roundedAgeHours} hours since the last healthy verification. ${sourceError}`);
  process.exit(0);
}

const publicBefore = jobs.filter(metaRole).length;
const snapshotBefore = snapshot.filter(metaRole).length;
const nextJobs = jobs.filter(job => !metaRole(job));
const nextSnapshot = snapshot.filter(job => !metaRole(job));
if (status.metaCareers && typeof status.metaCareers === 'object') {
  status.metaCareers = { ...status.metaCareers, qualifyingRoles: 0 };
}
recalcCounts(status, nextJobs);
status.metaFallbackFreshness = {
  active: false,
  expired: true,
  lastHealthyAt: lastHealthyAt || null,
  checkedAt,
  maxAgeHours: MAX_FALLBACK_AGE_HOURS,
  expiredAgeHours: roundedAgeHours,
  sitemapUrl: SITEMAP_URL,
  sourceError,
  rolesRemoved: Math.max(publicBefore, snapshotBefore),
  policy: 'Meta Careers sitemap could not be verified within 96 hours of the last healthy evidence, so retained Meta roles were removed until employer-direct verification recovers.'
};

await writeFile(JOBS_PATH, JSON.stringify(nextJobs, null, 2) + '\n');
await writeFile(SNAPSHOT_PATH, JSON.stringify(nextSnapshot, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
console.warn(`Expired Meta fallback after ${roundedAgeHours ?? 'unknown'} hours without healthy sitemap verification; removed ${publicBefore} public role(s) and ${snapshotBefore} snapshot role(s). ${sourceError}`);
