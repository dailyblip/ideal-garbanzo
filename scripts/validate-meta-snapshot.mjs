import { readFile } from 'node:fs/promises';

const COMPANY = 'Meta';
const SNAPSHOT_PATH = 'data/meta-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';

const allowedTypes = new Set(['entry-level', 'internship', 'apprenticeship', 'trainee']);
const allowedExperience = new Set(['no-experience', '0-2-years', '2-5-years']);
const allowedHosts = new Set(['metacareers.com', 'www.metacareers.com']);
const usStateAbbreviations = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI',
  'MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT',
  'VT','VA','WA','WV','WI','WY','DC'
]);
const seniorTitlePattern = /\b(?:senior|sr\.?|lead|principal|chief|manager|mgr\.?|director|vice president|vp|head of|staff engineer|supervisor|architect|program manager|project manager|product manager|capacity manager|partnerships?|strategy|counsel|attorney|recruiter|sales)\b/i;

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function canonicalMetaUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname.toLowerCase())) return null;
  const match = parsed.pathname.match(/^\/profile\/job_details\/(\d+)\/?$/i);
  if (!match) return null;
  return {
    jobId: match[1],
    url: `https://www.metacareers.com/profile/job_details/${match[1]}/`
  };
}

function hasUsLocation(value) {
  const text = String(value || '').trim();
  const match = text.match(/,\s*([A-Z]{2})(?:\b|\s|$)/);
  return Boolean(match && usStateAbbreviations.has(match[1]));
}

const violations = [];
let snapshot = [];
let jobs = [];
let status = {};

try {
  snapshot = await readJson(SNAPSHOT_PATH);
} catch (error) {
  violations.push(`Meta snapshot could not be read: ${error.message}`);
}
try {
  jobs = await readJson(JOBS_PATH);
} catch (error) {
  violations.push(`Public feed could not be read: ${error.message}`);
}
try {
  status = await readJson(STATUS_PATH);
} catch (error) {
  violations.push(`Collector status could not be read: ${error.message}`);
}

if (!Array.isArray(snapshot)) {
  violations.push('Meta snapshot must be an array.');
  snapshot = [];
}
if (!Array.isArray(jobs)) {
  violations.push('Public feed must be an array.');
  jobs = [];
}

const snapshotIds = new Set();
const snapshotUrls = new Set();

for (const job of snapshot) {
  const id = String(job?.id || '').trim();
  const title = String(job?.title || '').trim();
  const company = String(job?.company || '').trim();
  const type = String(job?.type || '').trim();
  const experience = String(job?.experience || '').trim();
  const location = String(job?.location || '').trim();
  const parsedUrl = canonicalMetaUrl(job?.sourceUrl);
  const idMatch = id.match(/^meta-(\d+)$/);

  if (company !== COMPANY) violations.push(`${id || '(missing id)'} belongs to ${company || '(missing company)'}, not Meta.`);
  if (!idMatch) violations.push(`${id || '(missing id)'} does not use the canonical meta-<job id> identity.`);
  if (!parsedUrl) violations.push(`${id || '(missing id)'} does not use a canonical employer-direct Meta Careers detail URL.`);
  if (idMatch && parsedUrl && idMatch[1] !== parsedUrl.jobId) violations.push(`${id} does not match its Meta Careers job ID ${parsedUrl.jobId}.`);
  if (job?.active !== true || job?.demo === true) violations.push(`${id || '(missing id)'} is not an active production role.`);
  if (!allowedTypes.has(type)) violations.push(`${id || '(missing id)'} has unsupported role type ${type || '(missing)'}.`);
  if (!allowedExperience.has(experience)) violations.push(`${id || '(missing id)'} has unsupported experience band ${experience || '(missing)'}.`);
  if (!title) violations.push(`${id || '(missing id)'} has no title.`);
  if (seniorTitlePattern.test(title)) violations.push(`${id || '(missing id)'} has senior/executive title noise: ${title}.`);
  if (!hasUsLocation(location)) violations.push(`${id || '(missing id)'} has an unverified U.S. location: ${location || '(missing)'}.`);

  if (id) {
    if (snapshotIds.has(id)) violations.push(`Meta snapshot contains duplicate id ${id}.`);
    snapshotIds.add(id);
  }
  if (parsedUrl) {
    if (snapshotUrls.has(parsedUrl.url)) violations.push(`Meta snapshot contains duplicate URL ${parsedUrl.url}.`);
    snapshotUrls.add(parsedUrl.url);
  }
}

const publicMeta = jobs.filter(job => String(job?.company || '').trim() === COMPANY);
const publicIds = new Set(publicMeta.map(job => String(job?.id || '').trim()).filter(Boolean));
const publicUrls = new Set();
for (const job of publicMeta) {
  const parsedUrl = canonicalMetaUrl(job?.sourceUrl);
  if (!parsedUrl) {
    violations.push(`Public Meta role ${job?.id || '(missing id)'} does not use a canonical employer-direct Meta Careers detail URL.`);
    continue;
  }
  publicUrls.add(parsedUrl.url);
}

if (publicMeta.length !== snapshot.length) {
  violations.push(`Meta snapshot/public feed count mismatch (${snapshot.length} snapshot vs ${publicMeta.length} public).`);
}
for (const id of snapshotIds) {
  if (!publicIds.has(id)) violations.push(`Meta snapshot role ${id} is missing from the public feed.`);
}
for (const id of publicIds) {
  if (!snapshotIds.has(id)) violations.push(`Public Meta role ${id} is not traceable to the authoritative snapshot.`);
}
for (const url of snapshotUrls) {
  if (!publicUrls.has(url)) violations.push(`Meta snapshot URL ${url} is missing from the public feed.`);
}
for (const url of publicUrls) {
  if (!snapshotUrls.has(url)) violations.push(`Public Meta URL ${url} is not traceable to the authoritative snapshot.`);
}

const reportedQualifying = Number(status?.metaCareers?.qualifyingRoles);
if (Number.isFinite(reportedQualifying) && reportedQualifying !== snapshot.length) {
  violations.push(`Meta collector status reports ${reportedQualifying} qualifying roles but snapshot contains ${snapshot.length}.`);
}

if (violations.length) {
  for (const violation of violations) console.error(`Meta snapshot violation: ${violation}`);
  throw new Error(`Blocked ${violations.length} Meta snapshot integrity violation(s).`);
}

const health = status?.metaCareers?.sourceHealthy === false
  ? 'official source currently degraded; verified snapshot retained'
  : 'official source healthy or no degraded state recorded';
console.log(`Meta snapshot guard passed: ${snapshot.length} authoritative U.S. 0–5 year roles match the public feed exactly; ${health}.`);
