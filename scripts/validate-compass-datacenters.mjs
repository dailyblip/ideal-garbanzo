import { readFile } from 'node:fs/promises';

const COMPANY = 'Compass Datacenters';
const BOARD_URL = 'https://compass-datacenters.breezy.hr/';
const BOARD_HOST = 'compass-datacenters.breezy.hr';
const SNAPSHOT_PATH = 'data/compass-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/compass-status.json';
const EXPECTED_SOURCE = 'Official Compass Datacenters Careers';
const MAX_FALLBACK_AGE_HOURS = 96;
const MAX_HEALTHY_EVIDENCE_AGE_HOURS = 30;
const allowedTypes = new Set(['internship', 'apprenticeship', 'trainee', 'entry-level']);
const allowedExperience = new Set(['no-experience', '0-2-years', '2-5-years']);
const bannedSenior = /\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|architect)\b/i;
const clearlyExcludedSlug = /(?:^|-)(?:senior|sr|lead|principal|staff|manager|director|vice-president|vp|chief|head-of|supervisor|architect|security|sales|finance|marketing|front-office)(?:-|$)/i;
const parityFields = ['type', 'experience', 'source', 'sourceUrl', 'active', 'demo'];

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalize = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function stableIdFromUrl(sourceUrl = '') {
  const prefixMatch = String(sourceUrl).match(/\/p\/([a-z0-9]+)-/i);
  return prefixMatch?.[1] || String(sourceUrl).replace(/[^a-z0-9]/gi, '').slice(-16);
}

function canonicalBreezyIdentity(job = {}) {
  const sourceUrl = clean(job?.sourceUrl);
  let url;
  try { url = new URL(sourceUrl); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== BOARD_HOST) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const match = url.pathname.match(/^\/p\/([a-z0-9-]+)$/i);
  if (!match) return null;
  const canonicalUrl = `https://${BOARD_HOST}${url.pathname}`;
  if (sourceUrl !== canonicalUrl) return null;
  const requisitionKey = stableIdFromUrl(canonicalUrl);
  if (!requisitionKey || clean(job?.id) !== `compass-${requisitionKey}`) return null;
  return { requisitionKey, canonicalUrl };
}

function isCompassJob(job = {}) {
  if (clean(job?.company) === COMPANY) return true;
  try { return new URL(clean(job?.sourceUrl)).hostname.toLowerCase() === BOARD_HOST; }
  catch { return false; }
}

function outOfScopeUnstructuredEvidence(compass = {}) {
  const errors = Array.isArray(compass?.errors) ? compass.errors : [];
  const urls = new Set();
  for (const value of errors) {
    const match = clean(value).match(/^structured data missing:\s+(https:\/\/\S+)$/i);
    if (!match) continue;
    try {
      const url = new URL(match[1]);
      if (url.hostname.toLowerCase() !== BOARD_HOST) continue;
      const slug = url.pathname.split('/').filter(Boolean).pop() || '';
      if (clearlyExcludedSlug.test(slug)) urls.add(url.toString());
    } catch {}
  }
  return { count: urls.size, urls: [...urls].sort() };
}

function validateRole(job, context, violations) {
  const id = clean(job?.id) || '(missing id)';
  const prefix = `${context} ${id}`;
  if (clean(job?.company) !== COMPANY) violations.push(`${prefix}: wrong company`);
  if (!clean(job?.title)) violations.push(`${prefix}: blank title`);
  if (!clean(job?.location)) violations.push(`${prefix}: blank location`);
  if (!allowedTypes.has(clean(job?.type))) violations.push(`${prefix}: invalid type ${job?.type}`);
  if (!allowedExperience.has(clean(job?.experience))) violations.push(`${prefix}: invalid experience ${job?.experience}`);
  if (bannedSenior.test(clean(job?.title))) violations.push(`${prefix}: senior/leadership title leaked: ${job?.title}`);
  if (clean(job?.source) !== EXPECTED_SOURCE) violations.push(`${prefix}: source must be ${EXPECTED_SOURCE}`);
  if (!canonicalBreezyIdentity(job)) violations.push(`${prefix}: id/sourceUrl are not the same canonical Compass Breezy requisition`);
  if (job?.active !== true || job?.demo === true) violations.push(`${prefix}: role must be active and non-demo`);
}

function validateState(snapshot, jobs, compass, { nowMs = Date.now() } = {}) {
  const violations = [];
  const sourceHealthy = compass?.sourceHealthy === true;
  const fallbackExpired = compass?.fallbackExpired === true;

  if (!compass || typeof compass !== 'object') violations.push('compass-status.json is missing source diagnostics');
  if (!Array.isArray(snapshot)) violations.push('compass-jobs.json is not a JSON array');
  if (!Array.isArray(jobs)) violations.push('jobs.json is not a JSON array');

  if (compass && typeof compass === 'object') {
    if (compass.boardUrl !== BOARD_URL) violations.push(`unexpected Compass board URL: ${compass.boardUrl || '(missing)'}`);
    if (!Number.isInteger(compass.listedPositions) || compass.listedPositions < 1) violations.push('Compass board returned no public positions');
    if (!Number.isInteger(compass.detailFetched) || compass.detailFetched < 1) violations.push('Compass detail fetch coverage is empty');

    if (sourceHealthy) {
      const checkedAtMs = Date.parse(String(compass.checkedAt || ''));
      if (!Number.isFinite(checkedAtMs)) {
        violations.push('healthy Compass source is missing checkedAt verification evidence');
      } else {
        const evidenceAgeHours = Math.max(0, (nowMs - checkedAtMs) / 3_600_000);
        if (evidenceAgeHours >= MAX_HEALTHY_EVIDENCE_AGE_HOURS) {
          violations.push(`healthy Compass verification evidence is ${Math.round(evidenceAgeHours * 10) / 10} hours old; must be under ${MAX_HEALTHY_EVIDENCE_AGE_HOURS} hours`);
        }
      }
      if (compass.boardFetched !== true) violations.push('healthy Compass source is missing board fetch evidence');
      if (Number(compass.detailAttempted) !== Number(compass.listedPositions)) violations.push('healthy Compass source did not attempt every listed position');
      if (Number(compass.detailFetched) !== Number(compass.listedPositions)) violations.push('healthy Compass source did not fetch every listed position');

      const fetched = Number(compass.detailFetched);
      const structured = Number(compass.structuredDetails);
      const structuredDrops = Number(compass?.drops?.structuredData || 0);
      const declaredIgnored = Number(compass.ignoredUnstructuredOutOfScope || 0);
      const evidence = outOfScopeUnstructuredEvidence(compass);
      const declaredUrls = Array.isArray(compass.ignoredUnstructuredOutOfScopeUrls)
        ? [...new Set(compass.ignoredUnstructuredOutOfScopeUrls.map(clean).filter(Boolean))].sort()
        : [];

      if (!Number.isInteger(declaredIgnored) || declaredIgnored < 0) violations.push('healthy Compass source has an invalid ignored-unstructured count');
      if (declaredIgnored !== evidence.count) violations.push('healthy Compass source ignored-unstructured count is not backed by clearly out-of-scope Breezy URLs');
      if (declaredUrls.join('|') !== evidence.urls.join('|')) violations.push('healthy Compass source ignored-unstructured URL evidence drifted from collector errors');
      if (declaredIgnored !== structuredDrops) violations.push('healthy Compass source has unverified structured-data drops');
      if (structured + declaredIgnored !== fetched) violations.push('healthy Compass source did not account for every fetched position with structured data or a clearly out-of-scope exclusion');

      if (compass.listingComplete === false) violations.push('healthy Compass source is marked listing-incomplete');
      if (compass.authoritativeSnapshot === false) violations.push('healthy Compass source is marked non-authoritative');
    } else {
      const lastHealthyMs = Date.parse(String(compass.lastHealthyAt || ''));
      const fallbackActive = compass.usedPreviousSnapshot === true;
      if (fallbackActive && (!Number.isFinite(lastHealthyMs) || fallbackExpired)) {
        violations.push('Compass fallback is marked active without fresh verified evidence');
      }
      if (fallbackActive && Number(compass.fallbackAgeHours) >= MAX_FALLBACK_AGE_HOURS) {
        violations.push('Compass fallback exceeds the 96-hour freshness limit');
      }
    }
  }

  const sourceJobs = Array.isArray(snapshot) ? snapshot : [];
  const publicJobs = Array.isArray(jobs) ? jobs.filter(isCompassJob) : [];

  if (fallbackExpired && (sourceJobs.length || publicJobs.length)) {
    violations.push('expired Compass fallback must publish zero snapshot/public roles');
  }
  if (Number.isFinite(Number(compass?.publishedRoles)) && Number(compass.publishedRoles) !== sourceJobs.length) {
    violations.push(`Compass status publishedRoles mismatch: ${compass.publishedRoles} vs ${sourceJobs.length}`);
  }

  const authoritative = new Map();
  const snapshotUrls = new Set();
  for (const job of sourceJobs) {
    validateRole(job, 'snapshot', violations);
    const id = clean(job?.id);
    const sourceUrl = clean(job?.sourceUrl);
    if (!id) continue;
    if (authoritative.has(id)) violations.push(`snapshot duplicate id: ${id}`);
    else authoritative.set(id, job);
    if (sourceUrl && snapshotUrls.has(sourceUrl)) violations.push(`snapshot duplicate source URL: ${sourceUrl}`);
    else if (sourceUrl) snapshotUrls.add(sourceUrl);
  }

  const publicById = new Map();
  const publicUrls = new Set();
  for (const job of publicJobs) {
    validateRole(job, 'public', violations);
    const id = clean(job?.id);
    const sourceUrl = clean(job?.sourceUrl);
    if (!id) continue;
    if (publicById.has(id)) violations.push(`public duplicate id: ${id}`);
    else publicById.set(id, job);
    if (sourceUrl && publicUrls.has(sourceUrl)) violations.push(`public duplicate source URL: ${sourceUrl}`);
    else if (sourceUrl) publicUrls.add(sourceUrl);
  }

  for (const [id, sourceJob] of authoritative) {
    const publicJob = publicById.get(id);
    if (!publicJob) {
      violations.push(`authoritative Compass role missing from public feed: ${id} | ${sourceJob.title} | ${sourceJob.location}`);
      continue;
    }
    if (normalize(publicJob.title) !== normalize(sourceJob.title)) violations.push(`${id}: public title drifted from authoritative snapshot`);
    if (normalize(publicJob.location) !== normalize(sourceJob.location)) violations.push(`${id}: public location drifted from authoritative snapshot`);
    for (const field of parityFields) {
      if (publicJob?.[field] !== sourceJob?.[field]) violations.push(`${id}: public ${field} drifted from authoritative snapshot`);
    }
  }

  for (const [id, publicJob] of publicById) {
    if (!authoritative.has(id)) violations.push(`unexpected public Compass requisition: ${id} | ${publicJob.title} | ${publicJob.location}`);
  }

  return violations;
}

function runSelfTest() {
  const nowMs = Date.parse('2026-09-17T02:00:00.000Z');
  const role = {
    id: 'compass-abc123',
    title: 'Critical Facilities Technician',
    company: COMPANY,
    location: 'Dallas, TX',
    type: 'entry-level',
    experience: '0-2-years',
    source: EXPECTED_SOURCE,
    sourceUrl: 'https://compass-datacenters.breezy.hr/p/abc123-critical-facilities-technician',
    active: true,
    demo: false
  };
  const healthyStatus = {
    boardUrl: BOARD_URL,
    sourceHealthy: true,
    boardFetched: true,
    listedPositions: 1,
    detailAttempted: 1,
    detailFetched: 1,
    structuredDetails: 1,
    listingComplete: true,
    authoritativeSnapshot: true,
    publishedRoles: 1,
    fallbackExpired: false,
    checkedAt: new Date(nowMs - 29 * 3_600_000).toISOString()
  };

  const baseline = validateState([role], [role], healthyStatus, { nowMs });
  if (baseline.length) throw new Error(`Compass parity baseline failed: ${baseline.join(' | ')}`);

  const staleHealthy = validateState([role], [role], {
    ...healthyStatus,
    checkedAt: new Date(nowMs - MAX_HEALTHY_EVIDENCE_AGE_HOURS * 3_600_000).toISOString()
  }, { nowMs });
  if (!staleHealthy.some(value => value.includes('verification evidence'))) {
    throw new Error('Compass stale healthy-source evidence regression was not detected.');
  }

  const drift = validateState([role], [{ ...role, title: 'Critical Facilities Engineer' }], healthyStatus, { nowMs });
  if (!drift.some(value => value.includes('title drifted'))) throw new Error('Compass title-drift regression was not detected.');

  const duplicate = validateState([role], [role, { ...role }], healthyStatus, { nowMs });
  if (!duplicate.some(value => value.includes('public duplicate id'))) throw new Error('Compass duplicate-requisition regression was not detected.');

  const badIdentity = validateState([{ ...role, id: 'compass-wrong' }], [{ ...role, id: 'compass-wrong' }], healthyStatus, { nowMs });
  if (!badIdentity.some(value => value.includes('canonical Compass Breezy requisition'))) throw new Error('Compass canonical ID/URL regression was not detected.');

  const unexpected = validateState([], [role], { ...healthyStatus, publishedRoles: 0 }, { nowMs });
  if (!unexpected.some(value => value.includes('unexpected public Compass requisition'))) throw new Error('Compass unexpected-public-role regression was not detected.');

  const directorUrl = 'https://compass-datacenters.breezy.hr/p/5ea9b2e30946-operations-resilience-director';
  const safeUnstructured = validateState([role], [role], {
    ...healthyStatus,
    listedPositions: 2,
    detailAttempted: 2,
    detailFetched: 2,
    structuredDetails: 1,
    drops: { structuredData: 1 },
    errors: [`structured data missing: ${directorUrl}`],
    ignoredUnstructuredOutOfScope: 1,
    ignoredUnstructuredOutOfScopeUrls: [directorUrl]
  }, { nowMs });
  if (safeUnstructured.length) throw new Error(`Compass clearly out-of-scope unstructured exclusion failed: ${safeUnstructured.join(' | ')}`);

  const relevantUrl = 'https://compass-datacenters.breezy.hr/p/abc999-critical-facilities-technician';
  const unsafeUnstructured = validateState([role], [role], {
    ...healthyStatus,
    listedPositions: 2,
    detailAttempted: 2,
    detailFetched: 2,
    structuredDetails: 1,
    drops: { structuredData: 1 },
    errors: [`structured data missing: ${relevantUrl}`],
    ignoredUnstructuredOutOfScope: 0,
    ignoredUnstructuredOutOfScopeUrls: []
  }, { nowMs });
  if (!unsafeUnstructured.some(value => value.includes('unverified structured-data drops'))) {
    throw new Error('Compass relevant-role structured-data gap was not rejected.');
  }

  const expired = validateState([role], [role], {
    ...healthyStatus,
    sourceHealthy: false,
    usedPreviousSnapshot: false,
    fallbackExpired: true,
    fallbackAgeHours: 96,
    lastHealthyAt: '2026-09-13T02:00:00.000Z'
  }, { nowMs });
  if (!expired.some(value => value.includes('expired Compass fallback'))) throw new Error('Compass expired-fallback regression was not detected.');

  console.log('Compass source-integrity regression tests passed.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

const [snapshot, jobs, compass] = await Promise.all([
  readFile(SNAPSHOT_PATH, 'utf8').then(JSON.parse),
  readFile(JOBS_PATH, 'utf8').then(JSON.parse),
  readFile(STATUS_PATH, 'utf8').then(JSON.parse)
]);

const violations = validateState(snapshot, jobs, compass);
if (violations.length) {
  for (const violation of violations) console.error(`Compass validation: ${violation}`);
  throw new Error(`Compass source validation failed with ${violations.length} violation(s).`);
}

const publicCount = Array.isArray(jobs) ? jobs.filter(isCompassJob).length : 0;
const mode = compass.sourceHealthy === true ? 'fresh authoritative source' : compass.usedPreviousSnapshot === true ? 'bounded verified fallback' : 'fail-closed empty state';
console.log(`Compass source validation passed: ${compass.listedPositions} public positions scanned, ${publicCount} mission-fit roles published (${mode}).`);
