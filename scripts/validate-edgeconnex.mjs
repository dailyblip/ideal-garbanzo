import { readFile } from 'node:fs/promises';

const COMPANY = 'EdgeConneX';
const PUBLIC_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/edgeconnex-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const allowedExperiences = new Set(['no-experience', '0-2-years', '2-5-years']);
const missionTitlePattern = /\b(?:data cent(?:er|re) (?:technician|operator|operations|facilities|facility|engineer)|critical facilit(?:y|ies) (?:technician|operator|engineer)|facilit(?:y|ies) (?:technician|operator|engineer)|(?:electrical|mechanical) operations engineer|operations engineer)\b/i;
const seniorTitlePattern = /\b(?:senior|sr\.?|lead|principal|staff|chief|manager|director|vice president|vp|head of|supervisor|superintendent|foreman)\b/i;
const usLocationPattern = /,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/;

const jobs = JSON.parse(await readFile(PUBLIC_PATH, 'utf8'));
let snapshot = [];
try { snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8')); } catch {}
const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
const source = status?.edgeconnexCareers;
const errors = [];
const requireOk = (condition, message) => { if (!condition) errors.push(message); };

requireOk(Array.isArray(jobs), 'jobs.json must contain an array.');
requireOk(Array.isArray(snapshot), 'EdgeConneX snapshot must contain an array.');
requireOk(source && typeof source === 'object', 'EdgeConneX collector status is missing.');

if (source) {
  requireOk(source.officialSource === 'https://www.edgeconnex.com/company/why-join-us/', 'EdgeConneX official careers source changed unexpectedly.');
  requireOk(source.boardUrl === 'https://ats.rippling.com/edgeconnex/jobs', 'EdgeConneX Rippling board changed unexpectedly.');
  requireOk(source.provider === 'rippling', 'EdgeConneX must use its current official Rippling source.');
  requireOk(Number(source.candidateLinks || 0) > 0, 'EdgeConneX collector found no current Rippling job links.');
  if (source.sourceHealthy === true) {
    requireOk(Number(source.detailSucceeded || 0) === Number(source.candidateLinks || 0), 'EdgeConneX healthy source did not fetch every listed detail page.');
    requireOk(Number(source.qualifyingRoles || 0) === snapshot.length, `EdgeConneX qualifying count ${source.qualifyingRoles ?? 0} does not match snapshot count ${snapshot.length}.`);
    requireOk(Number(source.preservedPrevious || 0) === 0, 'EdgeConneX healthy source should not report preserved fallback roles.');
  } else {
    requireOk(snapshot.length > 0, 'EdgeConneX source is unhealthy and there is no verified snapshot to preserve.');
    requireOk(Number(source.preservedPrevious || 0) === snapshot.length, `EdgeConneX preservation count ${source.preservedPrevious ?? 0} does not match snapshot count ${snapshot.length}.`);
  }
}

function validateRole(job, label, requireRegion) {
  const id = String(job?.id || '(missing id)');
  const title = String(job?.title || '');
  requireOk(job?.company === COMPANY, `${label} ${id} has unexpected company ${job?.company || '(blank)'}.`);
  requireOk(Boolean(job?.id), `${label} role is missing an id.`);
  requireOk(missionTitlePattern.test(title), `${label} ${id} is outside hands-on data-center scope: ${title || '(blank)'}.`);
  requireOk(!seniorTitlePattern.test(title), `${label} ${id} leaked a senior title: ${title || '(blank)'}.`);
  requireOk(usLocationPattern.test(String(job?.location || '')), `${label} ${id} is not normalized to a U.S. location: ${job?.location || '(blank)'}.`);
  requireOk(allowedExperiences.has(job?.experience), `${label} ${id} has invalid experience classification: ${job?.experience || '(blank)'}.`);
  requireOk(job?.active === true && job?.demo !== true, `${label} ${id} must be active and non-demo.`);
  requireOk(String(job?.source || '').toLowerCase().includes('official edgeconnex'), `${label} ${id} must identify the official EdgeConneX source.`);
  if (requireRegion) requireOk(Boolean(job?.region), `${label} ${id} is missing a regional classification.`);

  let parsed = null;
  try { parsed = new URL(String(job?.sourceUrl || '')); } catch {}
  const direct = parsed && parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'ats.rippling.com' && /^\/edgeconnex\/jobs\/[0-9a-f-]{36}$/i.test(parsed.pathname);
  requireOk(Boolean(direct), `${label} ${id} is not linked to the official EdgeConneX Rippling job page.`);
}

if (Array.isArray(snapshot)) snapshot.forEach(job => validateRole(job, 'EdgeConneX snapshot', false));
const publicJobs = Array.isArray(jobs) ? jobs.filter(job => job?.company === COMPANY) : [];
publicJobs.forEach(job => validateRole(job, 'Published EdgeConneX', true));

if (Array.isArray(snapshot)) {
  requireOk(publicJobs.length === snapshot.length, `Published EdgeConneX role count ${publicJobs.length} does not match snapshot count ${snapshot.length}.`);
  const snapshotUrls = new Set(snapshot.map(job => String(job?.sourceUrl || '')));
  requireOk(publicJobs.every(job => snapshotUrls.has(String(job?.sourceUrl || ''))), 'Published EdgeConneX feed contains a role outside the verified snapshot.');
}

if (errors.length) {
  console.error('EdgeConneX source validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const mode = source?.sourceHealthy === true ? 'live Rippling source' : 'preserved verified snapshot';
console.log(`EdgeConneX source validation passed: ${publicJobs.length} published employer-direct role(s) match the ${mode}.`);
