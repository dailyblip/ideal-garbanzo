import { readFile } from 'node:fs/promises';

const COMPANY = 'Switch';
const PUBLIC_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/switch-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const allowedExperiences = new Set(['no-experience', '0-2-years', '2-5-years']);
const missionTitlePattern = /\b(?:client support technician i|cross connect specialist|data center (?:network )?cabling technician(?: i)?|data center structured cabling technician|dco facilities technician (?:i|ii|iii)|mission control (?:power\/environmental )?technician(?: i)?|network infrastructure technician i|network operations center technician i|telecom network operations center technician i|rig electrical apprentice i|rig electrical journeyman)\b/i;
const seniorTitlePattern = /\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|superintendent|foreman)\b/i;

const jobs = JSON.parse(await readFile(PUBLIC_PATH, 'utf8'));
const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
const source = status?.switchCareers;
const errors = [];
const requireOk = (condition, message) => { if (!condition) errors.push(message); };

requireOk(Array.isArray(jobs), 'jobs.json must contain an array.');
requireOk(Array.isArray(snapshot), 'Switch snapshot must contain an array.');
requireOk(source && typeof source === 'object', 'Switch collector status is missing.');
if (source) {
  requireOk(source.sourceHealthy === true, 'Switch official career source did not report healthy.');
  requireOk(source.listingComplete === true, 'Switch official job listing was not authoritative/complete.');
  requireOk(Number(source.listedJobs || 0) > 0, 'Switch official source returned no public jobs.');
  requireOk(source.authoritativeSnapshot === true, 'Switch collector did not mark its snapshot authoritative.');
  requireOk(Array.isArray(source.detailErrors) && source.detailErrors.length === 0, 'Switch source had unresolved candidate detail errors.');
}

function validateRole(job, label, requireRegion) {
  const id = String(job?.id || '(missing id)');
  const title = String(job?.title || '');
  requireOk(job?.company === COMPANY, `${label} ${id} has unexpected company ${job?.company || '(blank)'}.`);
  requireOk(Boolean(job?.id), `${label} role is missing an id.`);
  requireOk(missionTitlePattern.test(title), `${label} ${id} is outside Switch's hands-on data-center scope: ${title || '(blank)'}.`);
  requireOk(!seniorTitlePattern.test(title), `${label} ${id} leaked a senior title: ${title || '(blank)'}.`);
  requireOk(allowedExperiences.has(job?.experience), `${label} ${id} has invalid experience classification: ${job?.experience || '(blank)'}.`);
  requireOk(job?.active === true && job?.demo !== true, `${label} ${id} must be an active, non-demo role.`);
  if (requireRegion) requireOk(Boolean(job?.region), `${label} ${id} is missing a regional classification.`);

  let parsed = null;
  try { parsed = new URL(String(job?.sourceUrl || '')); } catch {}
  const employerDirect = parsed
    && parsed.protocol === 'https:'
    && parsed.hostname === 'switchltd.hrmdirect.com'
    && parsed.pathname === '/employment/job-opening.php'
    && Boolean(parsed.searchParams.get('req'));
  requireOk(Boolean(employerDirect), `${label} ${id} is not linked to Switch's official HRMDirect/ClearCompany job board.`);
}

if (Array.isArray(snapshot)) snapshot.forEach(job => validateRole(job, 'Switch snapshot', false));
const publicJobs = Array.isArray(jobs) ? jobs.filter(job => job?.company === COMPANY) : [];
publicJobs.forEach(job => validateRole(job, 'Published Switch', true));

const expected = Number(source?.qualifyingRoles || 0);
if (source?.sourceHealthy === true) {
  requireOk(snapshot.length === expected, `Switch snapshot count ${snapshot.length} does not match collector qualifying count ${expected}.`);
  requireOk(publicJobs.length === snapshot.length, `Published Switch role count ${publicJobs.length} does not match authoritative snapshot count ${snapshot.length}.`);
  const snapshotUrls = new Set(snapshot.map(job => String(job?.sourceUrl || '')));
  const missing = publicJobs.filter(job => !snapshotUrls.has(String(job?.sourceUrl || '')));
  requireOk(missing.length === 0, `Published Switch feed contains ${missing.length} role(s) not present in the authoritative snapshot.`);
}

if (errors.length) {
  console.error('Switch employer-direct source validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Switch source validation passed: ${publicJobs.length} published employer-direct role(s) match the authoritative current-openings snapshot.`);
