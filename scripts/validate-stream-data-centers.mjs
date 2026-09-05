import { readFile } from 'node:fs/promises';

const COMPANY = 'Stream Data Centers';
const PUBLIC_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/stream-data-centers-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const allowedExperiences = new Set(['no-experience', '0-2-years', '2-5-years']);
const missionTitlePattern = /\b(?:critical engineering technician|critical operations technician|critical facilities technician|data cent(?:er|re) technician|data cent(?:er|re) operations technician|facilities technician|facility technician)\b/i;
const seniorTitlePattern = /\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|superintendent|foreman)\b/i;

const jobs = JSON.parse(await readFile(PUBLIC_PATH, 'utf8'));
const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
const source = status?.streamDataCenters;
const errors = [];
const requireOk = (condition, message) => { if (!condition) errors.push(message); };

requireOk(Array.isArray(jobs), 'jobs.json must contain an array.');
requireOk(Array.isArray(snapshot), 'Stream snapshot must contain an array.');
requireOk(source && typeof source === 'object', 'Stream collector status is missing.');
if (source) {
  requireOk(source.sourceHealthy === true, 'Stream official Workable source did not report healthy.');
  requireOk(source.listingComplete === true, 'Stream Workable listing was not authoritative/complete.');
  requireOk(Number(source.listedJobs || 0) > 0, 'Stream Workable source returned no public jobs.');
  requireOk(source.authoritativeSnapshot === true, 'Stream collector did not mark its snapshot authoritative.');
}

function validateRole(job, label, requireRegion) {
  const id = String(job?.id || '(missing id)');
  const title = String(job?.title || '');
  requireOk(job?.company === COMPANY, `${label} ${id} has unexpected company ${job?.company || '(blank)'}.`);
  requireOk(Boolean(job?.id), `${label} role is missing an id.`);
  requireOk(missionTitlePattern.test(title), `${label} ${id} is outside Stream's hands-on technician scope: ${title || '(blank)'}.`);
  requireOk(!seniorTitlePattern.test(title), `${label} ${id} leaked a senior title: ${title || '(blank)'}.`);
  requireOk(allowedExperiences.has(job?.experience), `${label} ${id} has invalid experience classification: ${job?.experience || '(blank)'}.`);
  requireOk(job?.active === true && job?.demo !== true, `${label} ${id} must be an active, non-demo role.`);
  if (requireRegion) requireOk(Boolean(job?.region), `${label} ${id} is missing a regional classification.`);

  let parsed = null;
  try { parsed = new URL(String(job?.sourceUrl || '')); } catch {}
  const employerDirect = parsed && parsed.protocol === 'https:' && parsed.hostname === 'apply.workable.com' && parsed.pathname.toLowerCase().startsWith('/stream-dc/j/');
  requireOk(Boolean(employerDirect), `${label} ${id} is not linked to Stream's official Workable job board.`);
}

if (Array.isArray(snapshot)) snapshot.forEach(job => validateRole(job, 'Stream snapshot', false));
const publicJobs = Array.isArray(jobs) ? jobs.filter(job => job?.company === COMPANY) : [];
publicJobs.forEach(job => validateRole(job, 'Published Stream', true));

const expected = Number(source?.qualifyingRoles || 0);
if (source?.sourceHealthy === true) {
  requireOk(snapshot.length === expected, `Stream snapshot count ${snapshot.length} does not match collector qualifying count ${expected}.`);
  requireOk(publicJobs.length === snapshot.length, `Published Stream role count ${publicJobs.length} does not match authoritative snapshot count ${snapshot.length}.`);
  const snapshotUrls = new Set(snapshot.map(job => String(job?.sourceUrl || '')));
  const missing = publicJobs.filter(job => !snapshotUrls.has(String(job?.sourceUrl || '')));
  requireOk(missing.length === 0, `Published Stream feed contains ${missing.length} role(s) not present in the authoritative snapshot.`);
}

if (errors.length) {
  console.error('Stream Data Centers source validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Stream Data Centers source validation passed: ${publicJobs.length} published employer-direct role(s) match the authoritative Workable snapshot.`);
