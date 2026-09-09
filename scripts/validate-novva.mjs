import { readFile } from 'node:fs/promises';

const COMPANY = 'Novva Data Centers';
const PUBLIC_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/novva-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const allowedExperiences = new Set(['no-experience', '0-2-years', '2-5-years']);
const missionTitlePattern = /\b(?:command center operator|data cent(?:er|re) (?:technician|operator|operations|facilities|facility|engineer)|critical facilit(?:y|ies) (?:technician|operator|engineer)|facilities technician|facility technician)\b/i;
const seniorTitlePattern = /\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|superintendent|foreman)\b/i;

const jobs = JSON.parse(await readFile(PUBLIC_PATH, 'utf8'));
const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
const source = status?.novvaCareers;
const errors = [];
const requireOk = (condition, message) => { if (!condition) errors.push(message); };

requireOk(Array.isArray(jobs), 'jobs.json must contain an array.');
requireOk(Array.isArray(snapshot), 'Novva snapshot must contain an array.');
requireOk(source && typeof source === 'object', 'Novva collector status is missing.');

if (source) {
  requireOk(String(source.officialSource || '') === 'https://www.novva.com/careers/', 'Novva official careers source changed unexpectedly.');
  requireOk(Number(source.candidateLinks || 0) > 0, 'Novva collector did not retain any candidate job URLs.');

  if (source.sourceHealthy === true) {
    requireOk(Number(source.detailSucceeded || 0) > 0, 'Novva source was marked healthy without a successful detail fetch.');
    requireOk(Number(source.qualifyingRoles || 0) === snapshot.length, `Novva healthy-source qualifying count ${source.qualifyingRoles ?? 0} does not match snapshot count ${snapshot.length}.`);
    requireOk(Number(source.preservedPrevious || 0) === 0, 'Novva healthy source should not report preserved fallback roles.');
  } else {
    requireOk(snapshot.length > 0, 'Novva source is unhealthy and there is no verified snapshot to preserve.');
    requireOk(Number(source.preservedPrevious || 0) === snapshot.length, `Novva unhealthy-source preservation count ${source.preservedPrevious ?? 0} does not match snapshot count ${snapshot.length}.`);
  }
}

function validateRole(job, label, requireRegion) {
  const id = String(job?.id || '(missing id)');
  const title = String(job?.title || '');
  requireOk(job?.company === COMPANY, `${label} ${id} has unexpected company ${job?.company || '(blank)'}.`);
  requireOk(Boolean(job?.id), `${label} role is missing an id.`);
  requireOk(missionTitlePattern.test(title), `${label} ${id} is outside Novva's hands-on data-center scope: ${title || '(blank)'}.`);
  requireOk(!seniorTitlePattern.test(title), `${label} ${id} leaked a senior title: ${title || '(blank)'}.`);
  requireOk(allowedExperiences.has(job?.experience), `${label} ${id} has invalid experience classification: ${job?.experience || '(blank)'}.`);
  requireOk(job?.active === true && job?.demo !== true, `${label} ${id} must be an active, non-demo role.`);
  requireOk(String(job?.source || '').toLowerCase().includes('official novva'), `${label} ${id} must identify the official Novva source.`);
  if (requireRegion) requireOk(Boolean(job?.region), `${label} ${id} is missing a regional classification.`);

  let parsed = null;
  try { parsed = new URL(String(job?.sourceUrl || '')); } catch {}
  const hostname = parsed?.hostname?.toLowerCase() || '';
  const employerDirect = parsed && parsed.protocol === 'https:' && (hostname === 'novva.com' || hostname === 'www.novva.com') && parsed.pathname.toLowerCase().startsWith('/portfolio/');
  requireOk(Boolean(employerDirect), `${label} ${id} is not linked to an official Novva job page.`);
}

if (Array.isArray(snapshot)) snapshot.forEach(job => validateRole(job, 'Novva snapshot', false));
const publicJobs = Array.isArray(jobs) ? jobs.filter(job => job?.company === COMPANY) : [];
publicJobs.forEach(job => validateRole(job, 'Published Novva', true));

if (Array.isArray(snapshot)) {
  requireOk(publicJobs.length === snapshot.length, `Published Novva role count ${publicJobs.length} does not match verified snapshot count ${snapshot.length}.`);
  const snapshotUrls = new Set(snapshot.map(job => String(job?.sourceUrl || '')));
  const missing = publicJobs.filter(job => !snapshotUrls.has(String(job?.sourceUrl || '')));
  requireOk(missing.length === 0, `Published Novva feed contains ${missing.length} role(s) not present in the verified snapshot.`);
}

if (errors.length) {
  console.error('Novva Data Centers source validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const mode = source?.sourceHealthy === true ? 'live source' : 'preserved verified snapshot';
console.log(`Novva Data Centers source validation passed: ${publicJobs.length} published employer-direct role(s) match the ${mode}.`);
