import { readFile } from 'node:fs/promises';

const COMPANY = 'EdgeConneX';
const PUBLIC_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/edgeconnex-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const EVIDENCE_PATH = 'data/edgeconnex-source-evidence.json';
const MAX_FALLBACK_AGE_HOURS = 96;
const MAX_HEALTHY_EVIDENCE_AGE_HOURS = 30;
const allowedExperiences = new Set(['no-experience', '0-2-years', '2-5-years']);
const allowedTypes = new Set(['entry-level', 'internship', 'apprenticeship', 'trainee']);
const missionTitlePattern = /\b(?:data cent(?:er|re) (?:technician|operator|operations|facilities|facility|engineer)|critical facilit(?:y|ies) (?:technician|operator|engineer)|facilit(?:y|ies) (?:technician|operator|engineer)|(?:electrical|mechanical) operations engineer|operations engineer)\b/i;
const seniorTitlePattern = /\b(?:senior|sr\.?|lead|principal|staff|chief|manager|director|vice president|vp|head of|supervisor|superintendent|foreman)\b/i;
const usLocationPattern = /^[A-Za-z][A-Za-z .'-]{1,60},\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)$/;
const parityFields = ['title', 'company', 'location', 'type', 'experience', 'source', 'sourceUrl', 'active', 'demo'];

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const jobs = JSON.parse(await readFile(PUBLIC_PATH, 'utf8'));
let snapshot = [];
let evidence = {};
try { snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8')); } catch {}
try { evidence = JSON.parse(await readFile(EVIDENCE_PATH, 'utf8')); } catch {}
const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
const source = status?.edgeconnexCareers;
const errors = [];
const requireOk = (condition, message) => { if (!condition) errors.push(message); };

function canonicalRole(value) {
  let parsed;
  try { parsed = new URL(clean(value)); } catch { return null; }
  const match = parsed.pathname.match(/^\/edgeconnex\/jobs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i);
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'ats.rippling.com' || !match) return null;
  const requisitionId = match[1].toLowerCase();
  return {
    requisitionId,
    id: `edgeconnex-${requisitionId}`,
    url: `https://ats.rippling.com/edgeconnex/jobs/${requisitionId}`
  };
}

function roleKey(job) {
  return canonicalRole(job?.sourceUrl)?.url || clean(job?.sourceUrl);
}

function runSelfTest() {
  const canonical = canonicalRole('https://ats.rippling.com/edgeconnex/jobs/2302b6e9-fd8f-4ede-b107-eb76a1a24af5');
  if (!canonical || canonical.id !== 'edgeconnex-2302b6e9-fd8f-4ede-b107-eb76a1a24af5') throw new Error('EdgeConneX canonical requisition regression failed.');
  if (canonicalRole('https://example.com/edgeconnex/jobs/2302b6e9-fd8f-4ede-b107-eb76a1a24af5')) throw new Error('EdgeConneX non-official host was accepted.');
  if (canonicalRole('https://ats.rippling.com/other/jobs/2302b6e9-fd8f-4ede-b107-eb76a1a24af5')) throw new Error('EdgeConneX cross-tenant Rippling URL was accepted.');
  console.log('EdgeConneX source identity regression tests passed.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

requireOk(Array.isArray(jobs), 'jobs.json must contain an array.');
requireOk(Array.isArray(snapshot), 'EdgeConneX snapshot must contain an array.');
requireOk(source && typeof source === 'object', 'EdgeConneX collector status is missing.');

const publicJobs = Array.isArray(jobs) ? jobs.filter(job => clean(job?.company) === COMPANY || canonicalRole(job?.sourceUrl)) : [];
const nowMs = Date.now();
const lastHealthyMs = Date.parse(String(evidence?.lastHealthyAt || source?.lastHealthyAt || ''));
const evidenceAgeHours = Number.isFinite(lastHealthyMs) ? Math.max(0, (nowMs - lastHealthyMs) / 36e5) : null;
const fallbackExpiredByTime = snapshot.length > 0 && (!Number.isFinite(lastHealthyMs) || evidenceAgeHours >= MAX_FALLBACK_AGE_HOURS);

if (source) {
  requireOk(source.officialSource === 'https://www.edgeconnex.com/company/why-join-us/', 'EdgeConneX official careers source changed unexpectedly.');
  requireOk(source.boardUrl === 'https://ats.rippling.com/edgeconnex/jobs', 'EdgeConneX Rippling board changed unexpectedly.');
  requireOk(source.provider === 'rippling', 'EdgeConneX must use its current official Rippling source.');

  if (source.sourceHealthy === true) {
    requireOk(Number(source.candidateLinks || 0) > 0, 'EdgeConneX healthy source found no current Rippling job links.');
    requireOk(Number(source.detailSucceeded || 0) === Number(source.candidateLinks || 0), 'EdgeConneX healthy source did not fetch every listed detail page.');
    requireOk(Number(source.qualifyingRoles || 0) === snapshot.length, `EdgeConneX qualifying count ${source.qualifyingRoles ?? 0} does not match snapshot count ${snapshot.length}.`);
    requireOk(Number(source.preservedPrevious || 0) === 0, 'EdgeConneX healthy source should not report preserved fallback roles.');
    requireOk(Number.isFinite(lastHealthyMs), 'EdgeConneX healthy source is missing a verification timestamp.');
    requireOk(evidenceAgeHours == null || evidenceAgeHours < MAX_HEALTHY_EVIDENCE_AGE_HOURS, `EdgeConneX healthy source evidence is ${evidenceAgeHours?.toFixed?.(1) ?? 'unknown'} hours old.`);
  } else if (source.fallbackExpired === true || fallbackExpiredByTime) {
    requireOk(snapshot.length === 0, `Expired EdgeConneX fallback still contains ${snapshot.length} snapshot role(s).`);
    requireOk(publicJobs.length === 0, `Expired EdgeConneX fallback still publishes ${publicJobs.length} role(s).`);
    requireOk(Number(source.preservedPrevious || 0) === 0, 'Expired EdgeConneX fallback still reports preserved roles.');
  } else {
    requireOk(snapshot.length > 0, 'EdgeConneX source is unhealthy and there is no verified snapshot to preserve.');
    requireOk(Number.isFinite(lastHealthyMs), 'EdgeConneX fallback has no valid lastHealthyAt verification anchor.');
    requireOk(evidenceAgeHours != null && evidenceAgeHours < MAX_FALLBACK_AGE_HOURS, `EdgeConneX fallback exceeds the ${MAX_FALLBACK_AGE_HOURS}-hour verified window.`);
    requireOk(Number(source.preservedPrevious || 0) === snapshot.length, `EdgeConneX preservation count ${source.preservedPrevious ?? 0} does not match snapshot count ${snapshot.length}.`);
  }
}

function validateRole(job, label, requireRegion) {
  const id = clean(job?.id) || '(missing id)';
  const title = clean(job?.title);
  const location = clean(job?.location);
  const canonical = canonicalRole(job?.sourceUrl);
  requireOk(clean(job?.company) === COMPANY, `${label} ${id} has unexpected company ${job?.company || '(blank)'}.`);
  requireOk(Boolean(job?.id), `${label} role is missing an id.`);
  requireOk(Boolean(canonical), `${label} ${id} is not linked to the official EdgeConneX Rippling job page.`);
  if (canonical) {
    requireOk(id.toLowerCase() === canonical.id, `${label} ${id} does not match Rippling requisition ${canonical.requisitionId}.`);
    requireOk(clean(job?.sourceUrl).replace(/\/$/, '').toLowerCase() === canonical.url, `${label} ${id} does not use the canonical Rippling requisition URL.`);
  }
  requireOk(missionTitlePattern.test(title), `${label} ${id} is outside hands-on data-center scope: ${title || '(blank)'}.`);
  requireOk(!seniorTitlePattern.test(title), `${label} ${id} leaked a senior title: ${title || '(blank)'}.`);
  requireOk(usLocationPattern.test(location) && !/apply now|data center operations/i.test(location), `${label} ${id} is not normalized to a clean U.S. city/state location: ${location || '(blank)'}.`);
  requireOk(allowedTypes.has(job?.type), `${label} ${id} has invalid role type: ${job?.type || '(blank)'}.`);
  requireOk(allowedExperiences.has(job?.experience), `${label} ${id} has invalid experience classification: ${job?.experience || '(blank)'}.`);
  requireOk(job?.active === true && job?.demo !== true, `${label} ${id} must be active and non-demo.`);
  requireOk(clean(job?.source).toLowerCase().includes('official edgeconnex'), `${label} ${id} must identify the official EdgeConneX source.`);
  if (requireRegion) requireOk(Boolean(job?.region), `${label} ${id} is missing a regional classification.`);
}

const snapshotIds = new Set();
const snapshotUrls = new Set();
if (Array.isArray(snapshot)) {
  for (const job of snapshot) {
    validateRole(job, 'EdgeConneX snapshot', false);
    const id = clean(job?.id).toLowerCase();
    const url = roleKey(job).toLowerCase();
    requireOk(!snapshotIds.has(id), `EdgeConneX snapshot contains duplicate id ${id}.`);
    requireOk(!snapshotUrls.has(url), `EdgeConneX snapshot contains duplicate URL ${url}.`);
    snapshotIds.add(id);
    snapshotUrls.add(url);
  }
}

const publicIds = new Set();
const publicUrls = new Set();
for (const job of publicJobs) {
  validateRole(job, 'Published EdgeConneX', true);
  const id = clean(job?.id).toLowerCase();
  const url = roleKey(job).toLowerCase();
  requireOk(!publicIds.has(id), `Published EdgeConneX feed contains duplicate id ${id}.`);
  requireOk(!publicUrls.has(url), `Published EdgeConneX feed contains duplicate URL ${url}.`);
  publicIds.add(id);
  publicUrls.add(url);
}

if (Array.isArray(snapshot)) {
  requireOk(publicJobs.length === snapshot.length, `Published EdgeConneX role count ${publicJobs.length} does not match snapshot count ${snapshot.length}.`);
  const snapshotByUrl = new Map(snapshot.map(job => [roleKey(job), job]));
  for (const publicJob of publicJobs) {
    const snapshotJob = snapshotByUrl.get(roleKey(publicJob));
    requireOk(Boolean(snapshotJob), `Published EdgeConneX role ${publicJob?.id || '(missing id)'} is outside the verified snapshot.`);
    if (!snapshotJob) continue;
    for (const field of parityFields) {
      const expected = typeof snapshotJob?.[field] === 'string' ? clean(snapshotJob[field]) : snapshotJob?.[field];
      const actual = typeof publicJob?.[field] === 'string' ? clean(publicJob[field]) : publicJob?.[field];
      requireOk(expected === actual, `Published EdgeConneX ${publicJob.id} differs from the verified snapshot for ${field}.`);
    }
  }
}

if (errors.length) {
  console.error('EdgeConneX source validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const mode = source?.sourceHealthy === true ? 'fresh verified Rippling source' : source?.fallbackExpired === true ? 'expired fail-closed state' : 'time-bounded verified fallback';
console.log(`EdgeConneX source validation passed: ${publicJobs.length} published employer-direct role(s) match the ${mode}.`);
