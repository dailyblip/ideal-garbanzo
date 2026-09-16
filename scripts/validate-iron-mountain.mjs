import { readFile } from 'node:fs/promises';

const COMPANY = 'Iron Mountain';
const HOST = 'ironmountain.wd5.myworkdayjobs.com';
const SITE_PREFIX = '/en-US/iron-mountain-jobs/job/';
const MAX_FALLBACK_AGE_HOURS = 96;
const MAX_FALLBACK_AGE_MS = MAX_FALLBACK_AGE_HOURS * 60 * 60 * 1000;
const allowedTypes = new Set(['entry-level', 'apprenticeship', 'internship', 'trainee']);
const allowedExperiences = new Set(['no-experience', '0-2-years', '2-5-years']);
const missionTitlePattern = /\b(?:critical facilit(?:y|ies) technician|data cent(?:er|re)(?: operations)? technician|data cent(?:er|re) operations engineer|data cent(?:er|re) facilities technician)\b/i;
const seniorTitlePattern = /\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|architect)\b/i;
// Downstream display normalization can intentionally turn "Pay not listed" into
// an empty display value, so compensation is not a source-identity parity field.
const parityFields = ['title', 'company', 'location', 'type', 'experience', 'source', 'sourceUrl', 'active', 'demo'];

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalize = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function canonicalIdentity(job = {}) {
  const sourceUrl = clean(job.sourceUrl);
  let url;
  try { url = new URL(sourceUrl); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== HOST) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (!url.pathname.startsWith(SITE_PREFIX)) return null;
  const match = url.pathname.match(/_(J\d+)\/?$/i);
  if (!match) return null;
  const requisition = match[1].toUpperCase();
  const expectedId = `ironmountain-${requisition}`;
  if (clean(job.id).toLowerCase() !== expectedId.toLowerCase()) return null;
  return { requisition, expectedId, sourceUrl };
}

function isIronMountainJob(job = {}) {
  if (clean(job.company) === COMPANY) return true;
  try { return new URL(clean(job.sourceUrl)).hostname.toLowerCase() === HOST; }
  catch { return false; }
}

function legacyAuthoritative(source, snapshotLength) {
  if (!source || typeof source !== 'object') return false;
  const invalidRequisition = Number(source?.drops?.invalidRequisition || 0);
  return source.sourceHealthy === true &&
    source.listingComplete === true &&
    Number(source.detailAttempted || 0) === Number(source.candidateRows || 0) &&
    Number(source.detailSucceeded || 0) === Number(source.detailAttempted || 0) &&
    Number(source?.drops?.fetch || 0) === 0 &&
    invalidRequisition === 0 &&
    Number(source.qualifyingRoles || 0) === snapshotLength;
}

function validateState(snapshot, jobs, status, nowMs = Date.now()) {
  const failures = [];
  const requireOk = (condition, message) => { if (!condition) failures.push(message); };
  requireOk(Array.isArray(snapshot), 'Iron Mountain snapshot must contain an array.');
  requireOk(Array.isArray(jobs), 'jobs.json must contain an array.');

  const authoritative = new Map();
  const urls = new Set();
  const identities = new Set();
  const snapshotJobs = Array.isArray(snapshot) ? snapshot : [];

  for (const job of snapshotJobs) {
    const id = clean(job?.id);
    const title = clean(job?.title);
    const location = clean(job?.location);
    const sourceUrl = clean(job?.sourceUrl);
    const canonical = canonicalIdentity(job);
    const identity = [COMPANY, title, location].map(normalize).join('|');

    requireOk(clean(job?.company) === COMPANY, `${id || title}: wrong company.`);
    requireOk(job?.active === true, `${id || title}: active must be true.`);
    requireOk(job?.demo === false, `${id || title}: demo must be false.`);
    requireOk(allowedTypes.has(clean(job?.type)), `${id || title}: invalid type ${clean(job?.type)}.`);
    requireOk(allowedExperiences.has(clean(job?.experience)), `${id || title}: invalid experience ${clean(job?.experience)}.`);
    requireOk(clean(job?.source) === 'Official Iron Mountain Careers', `${id || title}: source must be Official Iron Mountain Careers.`);
    requireOk(Boolean(canonical), `${id || title || sourceUrl}: id/sourceUrl must identify the same canonical Iron Mountain Workday requisition.`);
    requireOk(missionTitlePattern.test(title), `${id || title}: title is outside the approved technician/operations scope.`);
    requireOk(!seniorTitlePattern.test(title), `${id || title}: senior/supervisory title leaked into snapshot.`);
    requireOk(Boolean(location), `${id || title}: location is missing.`);

    const idKey = id.toLowerCase();
    if (!id) failures.push(`${title || sourceUrl}: id missing.`);
    else if (authoritative.has(idKey)) failures.push(`${id}: duplicate requisition id in snapshot.`);
    else authoritative.set(idKey, job);

    if (!sourceUrl) failures.push(`${id || title}: source URL missing.`);
    else if (urls.has(sourceUrl.toLowerCase())) failures.push(`${id || title}: duplicate source URL in snapshot.`);
    else urls.add(sourceUrl.toLowerCase());

    if (identities.has(identity)) failures.push(`${id || title}: duplicate title/location identity in snapshot.`);
    else identities.add(identity);
  }

  const publicJobs = (Array.isArray(jobs) ? jobs : []).filter(isIronMountainJob);
  const publicIds = new Set();
  for (const job of publicJobs) {
    const id = clean(job?.id);
    const idKey = id.toLowerCase();
    const title = clean(job?.title);
    const canonical = canonicalIdentity(job);

    requireOk(clean(job?.company) === COMPANY, `${id || title}: official Iron Mountain requisition is misattributed to ${clean(job?.company) || 'no company'}.`);
    requireOk(Boolean(canonical), `${id || title}: public card does not use a canonical employer-direct requisition id/URL pair.`);
    requireOk(Boolean(job?.region), `${id || title}: public card is missing a supported U.S. region.`);
    if (!id) failures.push(`${title || clean(job?.sourceUrl)}: public card id missing.`);
    else if (publicIds.has(idKey)) failures.push(`${id}: duplicate public requisition.`);
    else publicIds.add(idKey);

    const sourceJob = authoritative.get(idKey);
    if (!sourceJob) {
      failures.push(`${id || title}: public Iron Mountain requisition is absent from the protected snapshot.`);
      continue;
    }
    for (const field of parityFields) {
      const publicValue = typeof job?.[field] === 'string' ? clean(job[field]) : job?.[field];
      const sourceValue = typeof sourceJob?.[field] === 'string' ? clean(sourceJob[field]) : sourceJob?.[field];
      if (publicValue !== sourceValue) failures.push(`${id}: ${field} drifted from protected snapshot.`);
    }
  }

  const missingIds = [...authoritative.keys()].filter(id => !publicIds.has(id));
  if (missingIds.length) failures.push(`${missingIds.length}/${authoritative.size} protected requisition(s) are missing from jobs.json: ${missingIds.slice(0, 5).join(', ')}${missingIds.length > 5 ? ', ...' : ''}.`);
  if (publicJobs.length !== authoritative.size && missingIds.length === 0) failures.push(`public requisition count ${publicJobs.length} does not match protected snapshot ${authoritative.size}.`);

  const source = status?.ironMountain;
  requireOk(source && typeof source === 'object', 'collector-status: ironMountain diagnostic is missing.');
  if (!source || typeof source !== 'object') return failures;

  const isAuthoritative = source.authoritativeSnapshot === true || legacyAuthoritative(source, snapshotJobs.length);
  const fallback = source.fallbackFreshness && typeof source.fallbackFreshness === 'object' ? source.fallbackFreshness : null;

  if (isAuthoritative) {
    requireOk(source.sourceHealthy === true, 'collector-status: authoritative Iron Mountain state must be sourceHealthy=true.');
    requireOk(source.listingComplete === true, 'collector-status: authoritative Iron Mountain listing must be complete.');
    requireOk(Number(source.detailAttempted || 0) === Number(source.candidateRows || 0), 'collector-status: every candidate must have a detail attempt.');
    requireOk(Number(source.detailSucceeded || 0) === Number(source.detailAttempted || 0), 'collector-status: every Iron Mountain detail request must succeed before publication is authoritative.');
    requireOk(Number(source?.drops?.fetch || 0) === 0, 'collector-status: authoritative Iron Mountain state cannot contain detail fetch failures.');
    requireOk(Number(source?.drops?.invalidRequisition || 0) === 0, 'collector-status: authoritative Iron Mountain state cannot contain invalid requisition identities.');
    requireOk(Number(source.qualifyingRoles || 0) === snapshotJobs.length, `collector-status: qualifyingRoles ${source.qualifyingRoles} does not match snapshot ${snapshotJobs.length}.`);
    requireOk(Number(source.snapshotRoles ?? snapshotJobs.length) === snapshotJobs.length, `collector-status: snapshotRoles ${source.snapshotRoles} does not match snapshot ${snapshotJobs.length}.`);
  } else if (fallback?.active === true) {
    const lastHealthyMs = Date.parse(String(fallback.lastHealthyAt || source.lastHealthyAt || ''));
    const ageMs = Number.isFinite(lastHealthyMs) ? nowMs - lastHealthyMs : Infinity;
    requireOk(source.sourceHealthy === false, 'collector-status: fallback state must be sourceHealthy=false.');
    requireOk(source.usedPreviousSnapshot === true, 'collector-status: active fallback must report usedPreviousSnapshot=true.');
    requireOk(fallback.expired !== true, 'collector-status: active fallback cannot also be expired.');
    requireOk(Number.isFinite(lastHealthyMs), 'collector-status: active fallback is missing lastHealthyAt evidence.');
    requireOk(ageMs >= 0 && ageMs < MAX_FALLBACK_AGE_MS, `collector-status: Iron Mountain fallback exceeds ${MAX_FALLBACK_AGE_HOURS} hours.`);
  } else if (fallback?.expired === true) {
    requireOk(snapshotJobs.length === 0, 'expired Iron Mountain fallback must have an empty protected snapshot.');
    requireOk(publicJobs.length === 0, 'expired Iron Mountain fallback must publish zero roles.');
  } else {
    requireOk(false, 'collector-status: Iron Mountain is neither authoritative, a fresh verified fallback, nor an expired fail-closed state.');
  }

  return failures;
}

if (process.argv.includes('--test')) {
  const now = Date.parse('2026-09-16T12:00:00Z');
  const base = {
    id: 'ironmountain-J0104983',
    title: 'Critical Facility Technician',
    company: COMPANY,
    location: 'Miami, FL',
    type: 'entry-level',
    experience: '0-2-years',
    pay: 'Pay not listed',
    salaryMin: null,
    salaryMax: null,
    salarySortMax: null,
    source: 'Official Iron Mountain Careers',
    sourceUrl: `https://${HOST}/en-US/iron-mountain-jobs/job/US--FL--Miami/Critical-Facility-Technician_J0104983`,
    active: true,
    demo: false
  };
  const publicBase = { ...base, pay: '', region: 'southeast' };
  const healthy = { ironMountain: { sourceHealthy: true, listingComplete: true, authoritativeSnapshot: true, candidateRows: 1, detailAttempted: 1, detailSucceeded: 1, qualifyingRoles: 1, snapshotRoles: 1, drops: { fetch: 0, invalidRequisition: 0 } } };
  const freshFallback = { ironMountain: { sourceHealthy: false, authoritativeSnapshot: false, usedPreviousSnapshot: true, fallbackFreshness: { active: true, expired: false, lastHealthyAt: '2026-09-13T12:00:00Z' } } };
  const expiredEmpty = { ironMountain: { sourceHealthy: false, authoritativeSnapshot: false, fallbackFreshness: { active: false, expired: true, lastHealthyAt: '2026-09-12T11:59:59Z' } } };
  const alternate = { ...base, id: 'ironmountain-J0104987', sourceUrl: `https://${HOST}/en-US/iron-mountain-jobs/job/US--FL--Miami/Critical-Facility-Technician-2_J0104987`, location: 'Phoenix, AZ' };
  const cases = [
    ['canonical pair accepted', [base], [publicBase], healthy, true],
    ['mismatched id/url rejected', [{ ...base, id: 'ironmountain-J0104987' }], [publicBase], healthy, false],
    ['wrong host rejected', [{ ...base, sourceUrl: 'https://example.com/job/Critical-Facility-Technician_J0104983' }], [publicBase], healthy, false],
    ['duplicate snapshot requisition rejected', [base, { ...base }], [publicBase], { ironMountain: { ...healthy.ironMountain, qualifyingRoles: 2, snapshotRoles: 2 } }, false],
    ['missing public requisition rejected', [base], [], healthy, false],
    ['unexpected public requisition rejected', [base], [publicBase, { ...alternate, region: 'southwest' }], healthy, false],
    ['misattributed official URL rejected', [base], [{ ...publicBase, company: 'Example Operator' }], healthy, false],
    ['field drift rejected', [base], [{ ...publicBase, experience: '2-5-years' }], healthy, false],
    ['fresh verified fallback accepted', [base], [publicBase], freshFallback, true],
    ['stale fallback roles rejected', [base], [publicBase], { ironMountain: { ...freshFallback.ironMountain, fallbackFreshness: { active: true, expired: false, lastHealthyAt: '2026-09-12T11:59:59Z' } } }, false],
    ['expired empty fallback accepted', [], [], expiredEmpty, true]
  ];
  const regressions = [];
  for (const [name, snapshot, jobs, status, shouldPass] of cases) {
    const failures = validateState(snapshot, jobs, status, now);
    if ((failures.length === 0) !== shouldPass) regressions.push(`${name}: ${failures.join(' | ') || 'unexpected pass'}`);
  }
  if (regressions.length) {
    for (const failure of regressions) console.error(`Iron Mountain integrity regression: ${failure}`);
    process.exit(1);
  }
  console.log(`Iron Mountain source-integrity validator passed ${cases.length} regression cases.`);
  process.exit(0);
}

const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));
const snapshot = JSON.parse(await readFile('data/iron-mountain-jobs.json', 'utf8'));
const status = JSON.parse(await readFile('data/collector-status.json', 'utf8'));
const failures = validateState(snapshot, jobs, status);

if (failures.length) {
  console.error('Iron Mountain source validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const publicCount = jobs.filter(isIronMountainJob).length;
console.log(`Iron Mountain source validation passed: ${snapshot.length} protected snapshot role(s), ${publicCount} exact-traceable public role(s).`);
