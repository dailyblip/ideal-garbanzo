import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const FALLBACK_SCRIPT_PATH = 'scripts/apply-equinix-verified-fallback.mjs';
const COMPANY = 'Equinix';
const VERIFIED_SOURCE = 'Equinix official careers (verified fallback)';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function canonicalUrl(value = '') {
  const raw = clean(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return raw.replace(/\/$/, '');
  }
}

function verifiedRoleUrls(source) {
  const urls = new Map();
  const pattern = /requisition:\s*'([^']+)'[\s\S]*?url:\s*'([^']+)'/g;
  for (const match of source.matchAll(pattern)) {
    const requisition = clean(match[1]).toUpperCase();
    const url = clean(match[2]);
    if (!/^JR-\d+$/i.test(requisition)) continue;
    try {
      const parsed = new URL(url);
      const path = parsed.pathname.replace(/\/$/, '');
      if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'careers.equinix.com') continue;
      if (!/^\/jobs\/[^/]+$/i.test(path) || path.toLowerCase() === '/jobs/search') continue;
      urls.set(requisition, canonicalUrl(url));
    } catch {
      // Ignore malformed seed data. A managed role without a known seed URL
      // cannot satisfy the exact-evidence policy below.
    }
  }
  return urls;
}

function requisitionFromSearchUrl(sourceUrl) {
  try {
    const parsed = new URL(clean(sourceUrl));
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'careers.equinix.com') return '';
    if (parsed.pathname.replace(/\/$/, '') !== '/jobs/search') return '';
    const requisition = clean(parsed.searchParams.get('query')).toUpperCase();
    return /^JR-\d+$/i.test(requisition) ? requisition : '';
  } catch {
    return '';
  }
}

function requisitionFromManagedUrl(sourceUrl, roleUrls) {
  const searchRequisition = requisitionFromSearchUrl(sourceUrl);
  if (searchRequisition) return searchRequisition;

  const current = canonicalUrl(sourceUrl);
  if (!current) return '';
  for (const [requisition, detailUrl] of roleUrls) {
    if (detailUrl === current) return requisition;
  }
  return '';
}

function officialSearchUrl(requisition) {
  return `https://careers.equinix.com/jobs/search?query=${encodeURIComponent(requisition)}`;
}

function isManaged(job) {
  return clean(job?.company) === COMPANY && (
    /^equinix-verified-/i.test(clean(job?.id)) ||
    clean(job?.source) === VERIFIED_SOURCE
  );
}

function fallbackWindowActive(fallback, nowMs = Date.now()) {
  if (!fallback || typeof fallback !== 'object' || fallback.expired === true) return false;
  const expiresAt = Date.parse(clean(fallback.expiresAt));
  return Number.isFinite(expiresAt) && nowMs < expiresAt;
}

function fallbackWindowExpired(fallback, nowMs = Date.now()) {
  if (!fallback || typeof fallback !== 'object') return false;
  if (fallback.expired === true) return true;
  const expiresAt = Date.parse(clean(fallback.expiresAt));
  return Number.isFinite(expiresAt) && nowMs >= expiresAt;
}

function expireDependentEarlyCareerStatus(status, checkedAt) {
  const early = status?.priorityEmployerExpansion?.EquinixEarlyCareer;
  if (!early || typeof early !== 'object') return 0;

  const fallbackUsed = Math.max(0, Number(early.verifiedFallbackUsed || 0));
  if (!fallbackUsed) return 0;

  const qualifyingRoles = Math.max(0, Number(early.qualifyingRoles || 0));
  const retainedIndependent = Math.max(0, qualifyingRoles - fallbackUsed);
  status.priorityEmployerExpansion.EquinixEarlyCareer = {
    ...early,
    qualifyingRoles: retainedIndependent,
    verifiedFallbackUsed: 0,
    expiredVerifiedFallbackRoles: fallbackUsed,
    verifiedFallbackExpiredAt: checkedAt
  };
  return fallbackUsed;
}

function hasExactEvidence(job, fallback, roleUrls) {
  if (!fallbackWindowActive(fallback)) return false;
  if (!Array.isArray(fallback.checks)) return false;

  const jobUrl = canonicalUrl(job?.sourceUrl);
  const requisition = requisitionFromManagedUrl(jobUrl, roleUrls);
  if (!jobUrl || !requisition) return false;

  const check = fallback.checks.find(item =>
    item?.ok === true &&
    clean(item?.requisition).toUpperCase() === requisition &&
    requisitionFromSearchUrl(item?.sourceUrl) === requisition
  );
  if (!check) return false;

  const searchUrl = canonicalUrl(officialSearchUrl(requisition));
  if (jobUrl === searchUrl) return true;

  const directUrl = roleUrls.get(requisition);
  return Boolean(
    directUrl &&
    jobUrl === directUrl &&
    check?.verification === 'detail' &&
    Number(check?.detailStatus) >= 200 &&
    Number(check?.detailStatus) < 300
  );
}

function clickKind(job, roleUrls) {
  const requisition = requisitionFromManagedUrl(job?.sourceUrl, roleUrls);
  if (!requisition) return '';
  const current = canonicalUrl(job?.sourceUrl);
  if (current === canonicalUrl(officialSearchUrl(requisition))) return 'search';
  if (current === roleUrls.get(requisition)) return 'direct';
  return '';
}

function runSelfTest() {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 60 * 1000).toISOString();
  const source = `const verifiedRoles = [
    { requisition: 'JR-123456', title: 'Role A', url: 'https://careers.equinix.com/jobs/role-a-dallas-texas-united-states' },
    { requisition: 'JR-654321', title: 'Role B', url: 'https://careers.equinix.com/jobs/role-b-ashburn-virginia-united-states' }
  ];`;
  const roleUrls = verifiedRoleUrls(source);
  const searchJob = {
    id: 'equinix-verified-search',
    company: COMPANY,
    source: VERIFIED_SOURCE,
    sourceUrl: officialSearchUrl('JR-123456')
  };
  const directJob = {
    id: 'equinix-verified-direct',
    company: COMPANY,
    source: VERIFIED_SOURCE,
    sourceUrl: roleUrls.get('JR-123456')
  };
  const valid = {
    expired: false,
    expiresAt: future,
    retainedManaged: 2,
    liveChecksPassed: 2,
    checks: [
      {
        requisition: 'JR-123456',
        ok: true,
        verification: 'detail',
        detailStatus: 200,
        sourceUrl: officialSearchUrl('JR-123456')
      },
      {
        requisition: 'JR-654321',
        ok: true,
        verification: 'official-listing',
        detailStatus: 404,
        sourceUrl: officialSearchUrl('JR-654321')
      }
    ]
  };

  if (!hasExactEvidence(searchJob, valid, roleUrls)) {
    throw new Error('Exact Equinix requisition-search evidence was not accepted.');
  }
  if (!hasExactEvidence(directJob, valid, roleUrls)) {
    throw new Error('Verified live Equinix direct-detail evidence was not accepted.');
  }

  const listingOnlyDirect = {
    ...directJob,
    sourceUrl: roleUrls.get('JR-654321')
  };
  if (hasExactEvidence(listingOnlyDirect, valid, roleUrls)) {
    throw new Error('Equinix direct detail URL was accepted without a successful live detail check.');
  }

  const unrelated = {
    ...valid,
    checks: [{
      requisition: 'JR-654321',
      ok: true,
      verification: 'detail',
      detailStatus: 200,
      sourceUrl: officialSearchUrl('JR-654321')
    }]
  };
  if (hasExactEvidence(searchJob, unrelated, roleUrls)) {
    throw new Error('Aggregate Equinix verification incorrectly protected a role without exact requisition evidence.');
  }

  const unknownDirect = {
    ...directJob,
    sourceUrl: 'https://careers.equinix.com/jobs/untracked-role-dallas-texas-united-states'
  };
  if (hasExactEvidence(unknownDirect, valid, roleUrls)) {
    throw new Error('Untracked Equinix direct URL incorrectly inherited verified-role evidence.');
  }
  if (hasExactEvidence(searchJob, { ...valid, expiresAt: past }, roleUrls)) {
    throw new Error('Expired Equinix evidence window was incorrectly accepted.');
  }
  if (!fallbackWindowExpired({ ...valid, expiresAt: past })) {
    throw new Error('Expired Equinix evidence window was not recognized as expired.');
  }
  if (fallbackWindowExpired(valid)) {
    throw new Error('Active Equinix evidence window was incorrectly recognized as expired.');
  }

  const earlyStatus = {
    priorityEmployerExpansion: {
      EquinixEarlyCareer: {
        qualifyingRoles: 5,
        verifiedFallbackUsed: 3
      }
    }
  };
  const expiredEarly = expireDependentEarlyCareerStatus(earlyStatus, '2026-09-15T00:00:00.000Z');
  if (expiredEarly !== 3 || earlyStatus.priorityEmployerExpansion.EquinixEarlyCareer.qualifyingRoles !== 2 || earlyStatus.priorityEmployerExpansion.EquinixEarlyCareer.verifiedFallbackUsed !== 0) {
    throw new Error('Expired Equinix fallback roles were not removed from early-career recovery diagnostics.');
  }

  if (hasExactEvidence(searchJob, { ...valid, checks: [] }, roleUrls)) {
    throw new Error('Missing Equinix role checks were incorrectly accepted.');
  }
  console.log('Equinix verified-fallback evidence regression tests passed for search, promoted direct, expiry, and early-career diagnostic routes.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

const [jobs, status, fallbackSource] = await Promise.all([
  readFile(JOBS_PATH, 'utf8').then(JSON.parse),
  readFile(STATUS_PATH, 'utf8').then(JSON.parse),
  readFile(FALLBACK_SCRIPT_PATH, 'utf8')
]);
if (!Array.isArray(jobs)) throw new Error(`${JOBS_PATH} must contain an array.`);
if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error(`${STATUS_PATH} must contain an object.`);

const roleUrls = verifiedRoleUrls(fallbackSource);
const fallback = status.equinixVerifiedFallback;
const managed = jobs.filter(isManaged);
const expiredByClock = fallbackWindowExpired(fallback);

if (!managed.length) {
  if (!expiredByClock) {
    console.log('No managed Equinix verified-fallback roles are published.');
    process.exit(0);
  }

  const earlyFallbackUsed = Math.max(0, Number(status?.priorityEmployerExpansion?.EquinixEarlyCareer?.verifiedFallbackUsed || 0));
  const needsNormalization = fallback?.expired !== true ||
    Number(fallback?.retainedManaged || 0) !== 0 ||
    Number(fallback?.directDetailClicksUsed || 0) !== 0 ||
    Number(fallback?.searchClickFallbacksUsed || 0) !== 0 ||
    earlyFallbackUsed > 0;
  if (!needsNormalization) {
    console.log('No managed Equinix verified-fallback roles are published and the expired fallback state is already normalized.');
    process.exit(0);
  }

  const checkedAt = new Date().toISOString();
  const expiredEarlyRoles = expireDependentEarlyCareerStatus(status, checkedAt);
  status.updatedAt = checkedAt;
  status.equinixVerifiedFallback = {
    ...(fallback || {}),
    expired: true,
    retainedManaged: 0,
    directDetailClicksUsed: 0,
    searchClickFallbacksUsed: 0
  };
  status.equinixVerifiedEvidenceGuard = {
    checkedAt,
    managedBefore: 0,
    removed: 0,
    retained: 0,
    expiredEarlyCareerFallbackRoles: expiredEarlyRoles,
    policy: 'A managed Equinix verified-fallback role must have its own successful official-source requisition check. A published direct-detail route additionally requires that exact seeded detail URL to have a live successful detail check; otherwise only the requisition-targeted official search route is eligible.',
    removedRoles: []
  };
  await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
  console.warn(`Marked the Equinix verified-fallback window expired at ${clean(fallback?.expiresAt)}; no managed roles were published.${expiredEarlyRoles ? ` Cleared ${expiredEarlyRoles} fallback-dependent early-career diagnostic role(s).` : ''}`);
  process.exit(0);
}

const invalid = managed.filter(job => !hasExactEvidence(job, fallback, roleUrls));
if (!invalid.length) {
  console.log(`All ${managed.length} managed Equinix fallback role(s) have exact active per-role verification evidence for their published search or direct route.`);
  process.exit(0);
}

const invalidIds = new Set(invalid.map(job => clean(job.id)));
const nextJobs = jobs.filter(job => !invalidIds.has(clean(job.id)));
const retainedManagedJobs = nextJobs.filter(isManaged);
const retainedDirect = retainedManagedJobs.filter(job => clickKind(job, roleUrls) === 'direct').length;
const retainedSearch = retainedManagedJobs.filter(job => clickKind(job, roleUrls) === 'search').length;
const countBy = key => nextJobs.reduce((counts, job) => {
  const value = clean(job?.[key]) || 'unknown';
  counts[value] = (counts[value] || 0) + 1;
  return counts;
}, {});
const checkedAt = new Date().toISOString();
const expiredEarlyRoles = expiredByClock ? expireDependentEarlyCareerStatus(status, checkedAt) : 0;

status.updatedAt = checkedAt;
status.jobs = nextJobs.length;
status.countsByType = countBy('type');
status.countsByExperience = countBy('experience');
status.equinixVerifiedFallback = {
  ...(fallback || {}),
  expired: expiredByClock || fallback?.expired === true,
  retainedManaged: retainedManagedJobs.length,
  directDetailClicksUsed: retainedDirect,
  searchClickFallbacksUsed: retainedSearch
};
status.equinixVerifiedEvidenceGuard = {
  checkedAt,
  managedBefore: managed.length,
  removed: invalid.length,
  retained: retainedManagedJobs.length,
  expiredEarlyCareerFallbackRoles: expiredEarlyRoles,
  policy: 'A managed Equinix verified-fallback role must have its own successful official-source requisition check. A published direct-detail route additionally requires that exact seeded detail URL to have a live successful detail check; otherwise only the requisition-targeted official search route is eligible.',
  removedRoles: invalid.map(job => ({
    id: clean(job.id),
    title: clean(job.title),
    sourceUrl: clean(job.sourceUrl)
  }))
};

await writeFile(JOBS_PATH, JSON.stringify(nextJobs, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
console.warn(`Removed ${invalid.length} Equinix verified-fallback role(s) without exact active per-role evidence; retained ${retainedManagedJobs.length} (${retainedDirect} direct, ${retainedSearch} requisition-search fallback).${expiredByClock ? ` The fallback evidence window is now expired; cleared ${expiredEarlyRoles} fallback-dependent early-career diagnostic role(s).` : ''}`);
