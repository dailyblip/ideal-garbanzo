import { readFile } from 'node:fs/promises';

const COMPANY = 'Digital Realty';
const OFFICIAL_HOST = 'hdep.fa.us2.oraclecloud.com';
const OFFICIAL_PATH_PREFIX = '/hcmUI/CandidateExperience/en/sites/CX/job/';
const VALID_EXPERIENCE = new Set(['no-experience', '0-2-years', '2-5-years']);
const VALID_TYPES = new Set(['entry-level', 'internship', 'apprenticeship', 'trainee']);
const EXECUTIVE_PATTERN = /\b(?:senior|sr\.?|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|superintendent|foreman)\b/i;

const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));
const snapshot = JSON.parse(await readFile('data/digital-realty-jobs.json', 'utf8'));
const status = JSON.parse(await readFile('data/collector-status.json', 'utf8'));
const source = status?.digitalRealty;
const errors = [];
const requireOk = (condition, message) => { if (!condition) errors.push(message); };

requireOk(Array.isArray(jobs), 'Public jobs feed is not an array.');
requireOk(Array.isArray(snapshot), 'Digital Realty dedicated snapshot is not an array.');
requireOk(source && typeof source === 'object', 'Digital Realty collector status is missing.');

const snapshotJobs = Array.isArray(snapshot) ? snapshot : [];
const publicJobs = Array.isArray(jobs) ? jobs.filter(job => job?.company === COMPANY) : [];

function validateOfficialUrl(job, label) {
  let parsed;
  try {
    parsed = new URL(String(job?.sourceUrl || ''));
  } catch {
    requireOk(false, `${label} has an invalid source URL.`);
    return;
  }
  requireOk(parsed.protocol === 'https:', `${label} does not use HTTPS.`);
  requireOk(parsed.hostname.toLowerCase() === OFFICIAL_HOST, `${label} is not employer-direct (${parsed.hostname || 'missing host'}).`);
  requireOk(parsed.pathname.startsWith(OFFICIAL_PATH_PREFIX), `${label} does not point to the Digital Realty Candidate Experience job path.`);
}

function validateJob(job, label, requireRegion = false) {
  requireOk(Boolean(job?.id), `${label} is missing an id.`);
  requireOk(String(job?.id || '').startsWith('oracle-digitalrealty-'), `${label} has an unexpected id namespace.`);
  requireOk(job?.company === COMPANY, `${label} is owned by ${job?.company || '(blank)'} instead of Digital Realty.`);
  requireOk(Boolean(job?.title), `${label} is missing a title.`);
  requireOk(Boolean(job?.location), `${label} is missing a location.`);
  requireOk(VALID_TYPES.has(job?.type), `${label} has invalid role type ${job?.type || '(blank)'}.`);
  requireOk(VALID_EXPERIENCE.has(job?.experience), `${label} has invalid experience classification ${job?.experience || '(blank)'}.`);
  requireOk(!EXECUTIVE_PATTERN.test(String(job?.title || '')), `${label} leaked a senior/executive-heavy title: ${job?.title || '(blank)'}.`);
  requireOk(job?.active !== false && job?.demo !== true, `${label} is not an active production role.`);
  validateOfficialUrl(job, label);
  if (requireRegion) requireOk(Boolean(job?.region), `${label} is missing regional classification.`);
}

for (const job of snapshotJobs) validateJob(job, `Digital Realty snapshot job ${job?.id || '(unknown)'}`);
for (const job of publicJobs) validateJob(job, `Digital Realty public job ${job?.id || '(unknown)'}`, true);

if (source) {
  requireOk(String(source.officialSource || '') === 'https://www.digitalrealty.com/about/careers', 'Digital Realty official source metadata drifted from the employer careers page.');
  requireOk(String(source.boardUrl || '').startsWith(`https://${OFFICIAL_HOST}/hcmUI/CandidateExperience/en/sites/CX`), 'Digital Realty board URL metadata is not the official Oracle Recruiting Cloud board.');
  requireOk(Number(source.qualifyingRoles || 0) === snapshotJobs.length, `Digital Realty status reports ${Number(source.qualifyingRoles || 0)} qualifying role(s) but snapshot contains ${snapshotJobs.length}.`);
  requireOk(Number(source.preservedPrevious || 0) <= Number(source.detailFailures || 0), 'Digital Realty preservedPrevious exceeds reported detail failures.');

  if (source.sourceHealthy === true) {
    requireOk(Number(source.candidateRows || 0) > 0, 'Digital Realty source reported healthy but returned no candidate rows.');
    requireOk(Number(source.detailAttempts || 0) >= snapshotJobs.length, `Digital Realty healthy source attempted only ${Number(source.detailAttempts || 0)} detail page(s) for ${snapshotJobs.length} published snapshot role(s).`);
    requireOk(Number(source.candidateRows || 0) >= snapshotJobs.length, `Digital Realty healthy source has fewer candidates (${Number(source.candidateRows || 0)}) than qualifying snapshot roles (${snapshotJobs.length}).`);
  } else {
    requireOk(Array.isArray(source.errors) && source.errors.length > 0, 'Digital Realty source is unhealthy without a recorded collector error.');
    requireOk(snapshotJobs.length > 0, 'Digital Realty source is unhealthy and no verified snapshot remains to preserve coverage.');
  }
}

requireOk(publicJobs.length === snapshotJobs.length, `Digital Realty snapshot/public feed count mismatch (${snapshotJobs.length} snapshot vs ${publicJobs.length} public).`);
const publicUrls = new Set(publicJobs.map(job => String(job?.sourceUrl || '').trim()).filter(Boolean));
const missingUrls = snapshotJobs.filter(job => !publicUrls.has(String(job?.sourceUrl || '').trim()));
requireOk(missingUrls.length === 0, `Digital Realty public feed is missing ${missingUrls.length}/${snapshotJobs.length} authoritative snapshot URL(s).`);

const snapshotUrls = new Set(snapshotJobs.map(job => String(job?.sourceUrl || '').trim()).filter(Boolean));
const unexpectedUrls = publicJobs.filter(job => !snapshotUrls.has(String(job?.sourceUrl || '').trim()));
requireOk(unexpectedUrls.length === 0, `Digital Realty public feed contains ${unexpectedUrls.length} role URL(s) not present in the authoritative snapshot.`);

if (errors.length) {
  console.error('Digital Realty source validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Digital Realty source validation passed: ${publicJobs.length} published role(s), ${snapshotJobs.length} protected snapshot role(s), source ${source?.sourceHealthy === true ? 'healthy' : 'using preserved snapshot'}.`);
