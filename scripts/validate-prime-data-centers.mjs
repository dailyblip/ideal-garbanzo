import { readFile } from 'node:fs/promises';

const COMPANY = 'Prime Data Centers';
const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/prime-data-centers-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const ALLOWED_TYPES = new Set(['entry-level', 'internship', 'apprenticeship', 'trainee']);
const ALLOWED_EXPERIENCE = new Set(['no-experience', '0-2-years', '2-5-years']);
const SENIOR_TITLE = /\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|superintendent|foreman)\b/i;
const MISSION_TITLE = /\b(?:data cent(?:er|re)|critical operations|critical facilities|critical engineering|technician|operator|project engineer|project coordinator|commissioning|facilit(?:y|ies)|electrical|mechanical|controls|apprentice|trainee|intern)\b/i;

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

const [jobs, snapshot, status] = await Promise.all([
  readJson(JOBS_PATH),
  readJson(SNAPSHOT_PATH),
  readJson(STATUS_PATH)
]);

if (!Array.isArray(jobs)) throw new Error('data/jobs.json must be an array');
if (!Array.isArray(snapshot)) throw new Error('Prime authoritative snapshot must be an array');

const diagnostics = status?.primeDataCenters;
if (!diagnostics || typeof diagnostics !== 'object') throw new Error('collector-status.json is missing primeDataCenters diagnostics');
if (diagnostics.sourceHealthy !== true) throw new Error('Prime source is not marked healthy');
if (diagnostics.listingComplete !== true) throw new Error('Prime listing is not marked complete');
if (diagnostics.authoritativeSnapshot !== true) throw new Error('Prime snapshot is not marked authoritative');
if (!/^https:\/\/primedatacenters\.com\/careers\/?$/i.test(clean(diagnostics.officialCareerPage))) throw new Error('Prime official careers URL is not pinned to primedatacenters.com');
if (!/^https:\/\/ats\.rippling\.com\/prime-data-centers\/jobs\/?$/i.test(clean(diagnostics.officialRipplingBoard))) throw new Error('Prime official Rippling board URL is not pinned to the employer board');
if (!/^https:\/\/api\.rippling\.com\/platform\/api\/ats\/v1\/board\/prime-data-centers\/jobs\/?$/i.test(clean(diagnostics.api))) throw new Error('Prime Rippling API URL is not pinned to the employer board');
if (!Number.isFinite(Date.parse(diagnostics.checkedAt || ''))) throw new Error('Prime diagnostics checkedAt is missing or invalid');
if (!Number.isFinite(Date.parse(diagnostics.lastSuccessfulAt || ''))) throw new Error('Prime diagnostics lastSuccessfulAt is missing or invalid');
if (Number(diagnostics.qualifyingRoles) !== snapshot.length) throw new Error(`Prime qualifyingRoles=${diagnostics.qualifyingRoles} does not match snapshot length=${snapshot.length}`);
if (Number(diagnostics.candidateRoles) > 0 && Number(diagnostics.detailVerified) < Number(diagnostics.qualifyingRoles)) throw new Error('Prime detail verification count is smaller than the published qualifying role count');
if (Number(diagnostics.detailFailures || 0) !== 0) throw new Error('Prime healthy snapshot must not contain detail verification failures');

const ids = new Set();
const urls = new Set();
for (const job of snapshot) {
  if (clean(job?.company) !== COMPANY) throw new Error(`Prime snapshot contains another company: ${clean(job?.company)}`);
  if (job?.active !== true || job?.demo === true) throw new Error(`Prime snapshot contains inactive/demo role: ${clean(job?.id)}`);
  if (!ALLOWED_TYPES.has(clean(job?.type))) throw new Error(`Prime role has unsupported type ${clean(job?.type)}: ${clean(job?.id)}`);
  if (!ALLOWED_EXPERIENCE.has(clean(job?.experience))) throw new Error(`Prime role has unsupported experience ${clean(job?.experience)}: ${clean(job?.id)}`);
  if (!MISSION_TITLE.test(clean(job?.title))) throw new Error(`Prime role lacks mission-fit title evidence: ${clean(job?.title)}`);
  if (SENIOR_TITLE.test(clean(job?.title))) throw new Error(`Prime snapshot contains senior/leadership title: ${clean(job?.title)}`);
  if (!clean(job?.location) || /location not listed|unknown|remote$/i.test(clean(job?.location))) throw new Error(`Prime role has unresolved location: ${clean(job?.id)}`);
  if (!/^https:\/\/ats\.rippling\.com\/prime-data-centers\/jobs\/[A-Za-z0-9_-]+\/?(?:\?.*)?$/i.test(clean(job?.sourceUrl))) {
    throw new Error(`Prime role source is not an exact official Rippling job URL: ${clean(job?.sourceUrl)}`);
  }
  const id = clean(job?.id);
  const url = clean(job?.sourceUrl);
  if (!id) throw new Error('Prime role is missing id');
  if (ids.has(id)) throw new Error(`Duplicate Prime job id: ${id}`);
  if (urls.has(url)) throw new Error(`Duplicate Prime source URL: ${url}`);
  ids.add(id);
  urls.add(url);
}

const feedPrime = jobs.filter(job => clean(job?.company) === COMPANY);
if (feedPrime.length !== snapshot.length) throw new Error(`Public feed has ${feedPrime.length} Prime roles but authoritative snapshot has ${snapshot.length}`);
const feedIds = new Set(feedPrime.map(job => clean(job?.id)));
for (const id of ids) if (!feedIds.has(id)) throw new Error(`Prime snapshot role ${id} is missing from public feed`);

console.log(`Prime Data Centers source validation passed: ${snapshot.length} authoritative U.S. 0–5 year role(s), ${Number(diagnostics.detailVerified || 0)} candidate detail page(s) verified.`);
