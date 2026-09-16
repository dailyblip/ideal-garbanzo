import { readFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const FALLBACK_PATH = 'data/coresite-verified-fallback.json';
const COMPANY = 'CoreSite';
const ALLOWED_TYPES = new Set(['internship', 'apprenticeship', 'trainee', 'entry-level']);
const ALLOWED_EXPERIENCE = new Set(['no-experience', '0-2-years', '2-5-years']);

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const isCoreSite = job => clean(job?.company) === COMPANY || /(^|\.)jobs\.coresite\.com\//i.test(clean(job?.sourceUrl));

function requisitionFromUrl(value) {
  try {
    const url = new URL(clean(value));
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'jobs.coresite.com') return '';
    return url.pathname.match(/^\/jobs\/(\d+)(?:-[^/?#]+)?\/?$/i)?.[1] || '';
  } catch {
    return '';
  }
}

function activeFallback(payload, nowMs = Date.now()) {
  const verifiedAt = Date.parse(clean(payload?.verifiedAt));
  const expiresAt = Date.parse(clean(payload?.expiresAt));
  return Array.isArray(payload?.jobs)
    && payload.jobs.length > 0
    && Number.isFinite(verifiedAt)
    && Number.isFinite(expiresAt)
    && nowMs >= verifiedAt
    && nowMs <= expiresAt;
}

function validateState({ jobs, status, fallback, nowMs = Date.now() }) {
  const violations = [];
  if (!Array.isArray(jobs)) return ['jobs.json must contain an array'];
  if (!status || typeof status !== 'object' || Array.isArray(status)) return ['collector-status.json must contain an object'];

  const coreStatus = status.coreSite;
  if (!coreStatus || typeof coreStatus !== 'object' || Array.isArray(coreStatus)) {
    return ['CoreSite source status is missing from collector-status.json'];
  }

  const publicJobs = jobs.filter(isCoreSite);
  const ids = new Set();
  const urls = new Set();
  const requisitions = new Set();

  for (const job of publicJobs) {
    const id = clean(job?.id);
    const url = clean(job?.sourceUrl);
    const req = requisitionFromUrl(url);
    const expectedId = req ? `coresite-${req}` : '';

    if (clean(job?.company) !== COMPANY) violations.push(`${id || '(missing id)'} is attributed to ${clean(job?.company) || '(missing company)'}`);
    if (!req) violations.push(`${id || clean(job?.title) || '(unknown role)'} does not use a canonical CoreSite requisition URL`);
    if (!id || id !== expectedId) violations.push(`${id || '(missing id)'} does not match CoreSite requisition ${req || '(missing)'}`);
    if (!ALLOWED_TYPES.has(job?.type)) violations.push(`${id || '(missing id)'} has unsupported type ${job?.type || '(missing)'}`);
    if (!ALLOWED_EXPERIENCE.has(job?.experience)) violations.push(`${id || '(missing id)'} has unsupported experience ${job?.experience || '(missing)'}`);
    if (job?.active !== true || job?.demo === true) violations.push(`${id || '(missing id)'} is not an active production role`);
    if (/\b(?:senior|sr\.?|lead|principal|manager|director|vice president|vp|head of|staff|supervisor)\b/i.test(clean(job?.title))) {
      violations.push(`${id || '(missing id)'} is senior/managerial noise: ${clean(job?.title)}`);
    }

    if (id && ids.has(id)) violations.push(`duplicate CoreSite id ${id}`); else if (id) ids.add(id);
    if (url && urls.has(url)) violations.push(`duplicate CoreSite URL ${url}`); else if (url) urls.add(url);
    if (req && requisitions.has(req)) violations.push(`duplicate CoreSite requisition ${req}`); else if (req) requisitions.add(req);
  }

  const diagnostics = coreStatus.diagnostics || {};
  const declaredHealthy = coreStatus.sourceHealthy === true;
  const authoritative = declaredHealthy
    && diagnostics.listingComplete === true
    && Number(diagnostics.listingPagesSucceeded) > 0
    && Number(diagnostics.candidateRows) > 0
    && Number(diagnostics.detailAttempted) === Number(diagnostics.detailSucceeded)
    && Number(diagnostics.preservedOnFailure || 0) === 0;

  if (declaredHealthy && !authoritative) {
    violations.push('CoreSite source is marked healthy without a complete listing, complete detail coverage, and zero stale preservation');
  }

  if (authoritative) {
    const published = Number(coreStatus.qualifyingRoles);
    if (!Number.isInteger(published) || published !== publicJobs.length) {
      violations.push(`authoritative CoreSite status reports ${coreStatus.qualifyingRoles ?? '(missing)'} qualifying roles but ${publicJobs.length} are public`);
    }
    const source = clean(coreStatus.officialSource);
    if (!/^https:\/\/jobs\.coresite\.com\/search\//i.test(source)) violations.push('authoritative CoreSite status does not name an official CoreSite listing URL');
  } else {
    const fallbackIsActive = activeFallback(fallback, nowMs);
    if (!fallbackIsActive && publicJobs.length) {
      violations.push(`${publicJobs.length} CoreSite role(s) are public without an authoritative direct scan or an active verified fallback`);
    }
    if (fallbackIsActive) {
      const fallbackIds = new Set((fallback.jobs || []).map(job => clean(job?.id)).filter(Boolean));
      const unexpected = publicJobs.filter(job => !fallbackIds.has(clean(job?.id)));
      if (unexpected.length) violations.push(`${unexpected.length} public CoreSite role(s) are not backed by the active verified fallback`);
    }
  }

  return violations;
}

function runSelfTest() {
  const nowMs = Date.parse('2026-09-16T10:00:00Z');
  const baseJob = {
    id: 'coresite-12345678',
    title: 'Data Center Operations Technician II',
    company: COMPANY,
    location: 'Reston, VA',
    type: 'entry-level',
    experience: '0-2-years',
    sourceUrl: 'https://jobs.coresite.com/jobs/12345678-data-center-operations-technician-ii',
    active: true,
    demo: false
  };
  const healthyStatus = {
    coreSite: {
      officialSource: 'https://jobs.coresite.com/search/data-center-operations/jobs/in',
      sourceHealthy: true,
      qualifyingRoles: 1,
      diagnostics: {
        listingPagesSucceeded: 2,
        listingComplete: true,
        candidateRows: 12,
        detailAttempted: 12,
        detailSucceeded: 12,
        preservedOnFailure: 0
      }
    }
  };

  const cleanState = validateState({ jobs: [baseJob], status: healthyStatus, fallback: { jobs: [] }, nowMs });
  if (cleanState.length) throw new Error(`CoreSite clean-state regression failed: ${cleanState.join('; ')}`);

  const partial = structuredClone(healthyStatus);
  partial.coreSite.diagnostics.listingComplete = false;
  if (!validateState({ jobs: [baseJob], status: partial, fallback: { jobs: [] }, nowMs }).some(v => v.includes('marked healthy'))) {
    throw new Error('CoreSite partial-listing regression did not fail closed.');
  }

  const detailGap = structuredClone(healthyStatus);
  detailGap.coreSite.diagnostics.detailSucceeded = 11;
  if (!validateState({ jobs: [baseJob], status: detailGap, fallback: { jobs: [] }, nowMs }).some(v => v.includes('marked healthy'))) {
    throw new Error('CoreSite incomplete-detail regression did not fail closed.');
  }

  const badId = { ...baseJob, id: 'coresite-87654321' };
  if (!validateState({ jobs: [badId], status: healthyStatus, fallback: { jobs: [] }, nowMs }).some(v => v.includes('does not match CoreSite requisition'))) {
    throw new Error('CoreSite requisition ID/URL mismatch regression was not detected.');
  }

  const stalePublic = validateState({
    jobs: [baseJob],
    status: { coreSite: { sourceHealthy: false, qualifyingRoles: 0, diagnostics: { listingComplete: false } } },
    fallback: { verifiedAt: '2026-09-01T00:00:00Z', expiresAt: '2026-09-02T00:00:00Z', jobs: [baseJob] },
    nowMs
  });
  if (!stalePublic.some(v => v.includes('without an authoritative direct scan'))) {
    throw new Error('CoreSite stale-publication regression did not fail closed.');
  }

  console.log('CoreSite source-integrity regression tests passed.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

const [jobs, status, fallback] = await Promise.all([
  JSON.parse(await readFile(JOBS_PATH, 'utf8')),
  JSON.parse(await readFile(STATUS_PATH, 'utf8')),
  JSON.parse(await readFile(FALLBACK_PATH, 'utf8'))
]);

const violations = validateState({ jobs, status, fallback });
if (violations.length) {
  for (const violation of violations) console.error(`CoreSite source-integrity violation: ${violation}`);
  throw new Error(`Blocked ${violations.length} CoreSite source-integrity violation(s).`);
}

const publicCount = jobs.filter(isCoreSite).length;
const authoritative = status?.coreSite?.sourceHealthy === true && status?.coreSite?.diagnostics?.listingComplete === true;
console.log(`CoreSite source-integrity guard passed: ${publicCount} public role(s); direct source ${authoritative ? 'authoritative' : 'fail-closed/fallback-gated'}.`);
