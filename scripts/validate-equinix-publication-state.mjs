import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const FALLBACK_SCRIPT_PATH = 'scripts/apply-equinix-verified-fallback.mjs';
const COMPANY = 'Equinix';
const BROAD_SOURCE = 'Equinix official careers';
const VERIFIED_SOURCE = 'Equinix official careers (verified fallback)';
const MAX_FALLBACK_AGE_HOURS = Number(process.env.EQUINIX_FALLBACK_MAX_HOURS || 96);

if (!Number.isFinite(MAX_FALLBACK_AGE_HOURS) || MAX_FALLBACK_AGE_HOURS <= 0) {
  throw new Error('EQUINIX_FALLBACK_MAX_HOURS must be a positive number.');
}

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const canonicalUrl = value => {
  const raw = clean(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return raw.replace(/\/$/, '');
  }
};

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

function sourceIsAuthoritative(diagnostic) {
  if (!diagnostic || typeof diagnostic !== 'object') return false;
  const attempted = Number(diagnostic.listingPagesAttempted || 0);
  const succeeded = Number(diagnostic.listingPagesSucceeded || 0);
  return diagnostic.authoritative === true && diagnostic.listingComplete === true && attempted > 0 && succeeded === attempted;
}

function broadFallbackIsActive(diagnostic) {
  if (!diagnostic || sourceIsAuthoritative(diagnostic)) return false;
  return Number(diagnostic.fallbackRetained || 0) > 0 || Number(diagnostic.preservedOnFailure || 0) > 0;
}

async function historicalCollectorStatuses(limit = 80) {
  let commits = [];
  try {
    const { stdout } = await exec('git', ['log', '--format=%H%x09%cI', `-${limit}`, '--', STATUS_PATH], { maxBuffer: 1024 * 1024 });
    commits = stdout.split(/\r?\n/).map(line => {
      const [sha, committedAt] = line.trim().split('\t');
      return { sha, committedAt };
    }).filter(entry => entry.sha);
  } catch {
    return [];
  }

  const statuses = [];
  for (const { sha, committedAt } of commits) {
    try {
      const { stdout } = await exec('git', ['show', `${sha}:${STATUS_PATH}`], { maxBuffer: 8 * 1024 * 1024 });
      statuses.push({ sha, committedAt, status: JSON.parse(stdout) });
    } catch {
      // Keep walking history when an individual historic status file is unreadable.
    }
  }
  return statuses;
}

async function lastAuthoritativeVerification(history) {
  for (const entry of history) {
    const diagnostic = entry.status?.priorityEmployerExpansion?.Equinix;
    if (!sourceIsAuthoritative(diagnostic)) continue;
    const timestamp = diagnostic?.checkedAt || entry.committedAt || entry.status?.updatedAt;
    const parsed = Date.parse(String(timestamp || ''));
    if (Number.isFinite(parsed)) return { at: parsed, sha: entry.sha };
  }
  return null;
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
      // A managed role without a known exact seed URL cannot inherit direct-detail evidence.
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

function hasExactEvidence(job, fallback, roleUrls, nowMs = Date.now()) {
  if (!fallbackWindowActive(fallback, nowMs) || !Array.isArray(fallback.checks)) return false;

  const jobUrl = canonicalUrl(job?.sourceUrl);
  const requisition = requisitionFromManagedUrl(jobUrl, roleUrls);
  if (!jobUrl || !requisition) return false;

  const check = fallback.checks.find(item =>
    item?.ok === true &&
    clean(item?.requisition).toUpperCase() === requisition &&
    requisitionFromSearchUrl(item?.sourceUrl) === requisition
  );
  if (!check) return false;

  if (jobUrl === canonicalUrl(officialSearchUrl(requisition))) return true;
  const directUrl = roleUrls.get(requisition);
  return Boolean(
    directUrl &&
    jobUrl === directUrl &&
    check?.verification === 'detail' &&
    Number(check?.detailStatus) >= 200 &&
    Number(check?.detailStatus) < 300
  );
}

function runSelfTest() {
  const now = Date.parse('2026-09-10T12:00:00Z');
  const broad = { authoritative: false, listingComplete: false, listingPagesAttempted: 2, listingPagesSucceeded: 0, fallbackRetained: 3 };
  if (!broadFallbackIsActive(broad)) throw new Error('Equinix retained broad fallback was not recognized as active.');
  if (!sourceIsAuthoritative({ authoritative: true, listingComplete: true, listingPagesAttempted: 2, listingPagesSucceeded: 2 })) {
    throw new Error('Equinix authoritative broad-source diagnostic was not recognized.');
  }

  const roleUrls = verifiedRoleUrls("const verifiedRoles=[{ requisition: 'JR-123456', url: 'https://careers.equinix.com/jobs/role-a-dallas-texas-united-states' }];");
  const fallback = {
    expired: false,
    expiresAt: new Date(now + 36e5).toISOString(),
    checks: [{ requisition: 'JR-123456', ok: true, verification: 'detail', detailStatus: 200, sourceUrl: officialSearchUrl('JR-123456') }]
  };
  const searchJob = { id: 'equinix-verified-a', company: COMPANY, source: VERIFIED_SOURCE, sourceUrl: officialSearchUrl('JR-123456') };
  const directJob = { ...searchJob, sourceUrl: roleUrls.get('JR-123456') };
  if (!hasExactEvidence(searchJob, fallback, roleUrls, now)) throw new Error('Exact Equinix requisition-search evidence was rejected.');
  if (!hasExactEvidence(directJob, fallback, roleUrls, now)) throw new Error('Exact Equinix direct-detail evidence was rejected.');
  if (hasExactEvidence(searchJob, { ...fallback, expiresAt: new Date(now - 1).toISOString() }, roleUrls, now)) {
    throw new Error('Expired Equinix verified-fallback evidence was accepted.');
  }
  console.log('Equinix publication-state regression tests passed.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

const [jobs, status, fallbackSource] = await Promise.all([
  readJson(JOBS_PATH, []),
  readJson(STATUS_PATH, {}),
  readFile(FALLBACK_SCRIPT_PATH, 'utf8')
]);
if (!Array.isArray(jobs)) throw new Error(`${JOBS_PATH} must contain an array.`);
if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error(`${STATUS_PATH} must contain an object.`);

const violations = [];
const nowMs = Date.now();
const broadDiagnostic = status?.priorityEmployerExpansion?.Equinix;
if (broadFallbackIsActive(broadDiagnostic)) {
  const history = await historicalCollectorStatuses();
  const lastVerified = await lastAuthoritativeVerification(history);
  const verifiedAt = lastVerified?.at ?? NaN;
  const ageHours = Number.isFinite(verifiedAt) ? Math.max(0, (nowMs - verifiedAt) / 36e5) : null;
  if (ageHours === null || ageHours >= MAX_FALLBACK_AGE_HOURS) {
    violations.push(`broad-source fallback is ${ageHours === null ? 'missing authoritative history' : `${Math.round(ageHours * 10) / 10} hours old`} and exceeds the ${MAX_FALLBACK_AGE_HOURS}-hour publication window`);
  }
}

const fallback = status?.equinixVerifiedFallback;
const managed = jobs.filter(isManaged);
const roleUrls = verifiedRoleUrls(fallbackSource);
const expiredByClock = fallbackWindowExpired(fallback, nowMs);

if (managed.length) {
  const invalid = managed.filter(job => !hasExactEvidence(job, fallback, roleUrls, nowMs));
  if (invalid.length) {
    violations.push(`${invalid.length}/${managed.length} verified-fallback role(s) lack exact active requisition evidence: ${invalid.map(job => clean(job.id) || '(missing id)').join(', ')}`);
  }
} else if (expiredByClock) {
  const earlyFallbackUsed = Math.max(0, Number(status?.priorityEmployerExpansion?.EquinixEarlyCareer?.verifiedFallbackUsed || 0));
  const needsNormalization = fallback?.expired !== true ||
    Number(fallback?.retainedManaged || 0) !== 0 ||
    Number(fallback?.directDetailClicksUsed || 0) !== 0 ||
    Number(fallback?.searchClickFallbacksUsed || 0) !== 0 ||
    earlyFallbackUsed > 0;
  if (needsNormalization) {
    violations.push('expired verified-fallback state still reports retained/published roles or fallback-dependent early-career coverage');
  }
}

if (violations.length) {
  violations.forEach(violation => console.error(`Equinix publication-state guard: ${violation}`));
  throw new Error(`Blocked ${violations.length} Equinix publication-state regression(s).`);
}

const broadState = sourceIsAuthoritative(broadDiagnostic) ? 'authoritative' : (broadFallbackIsActive(broadDiagnostic) ? 'bounded-fallback' : 'no-broad-fallback');
console.log(`Equinix publication-state guard passed (${broadState}; managed verified fallback=${managed.length}).`);
