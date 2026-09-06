import { readFile } from 'node:fs/promises';

const SNAPSHOT_PATH = 'data/oracle-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const COMPANY = 'Oracle';
const OFFICIAL_HOST = 'eeho.fa.us2.oraclecloud.com';
const VALID_EXPERIENCE = new Set(['no-experience', '0-2-years', '2-5-years']);
const SENIOR_TITLE = /(^|[^a-z])(senior|sr\.?|lead|principal|manager|director|vice president|vp|head of|chief|supervisor|architect)([^a-z]|$)/i;

async function readArray(path) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(value)) throw new Error(`${path} must contain a JSON array`);
  return value;
}

function sourceUrl(job, context) {
  let parsed;
  try {
    parsed = new URL(String(job?.sourceUrl || ''));
  } catch {
    throw new Error(`${context}: ${job?.id || '(missing id)'} has an invalid source URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== OFFICIAL_HOST) {
    throw new Error(`${context}: ${job?.id || '(missing id)'} is not employer-direct (${parsed.hostname || 'missing host'})`);
  }
  if (!/\/hcmUI\/CandidateExperience\/en\/sites\/[^/]+\/job\/[^/?#]+/i.test(parsed.pathname)) {
    throw new Error(`${context}: ${job?.id || '(missing id)'} does not use an Oracle candidate-experience job detail URL`);
  }
  return parsed.href;
}

const snapshot = await readArray(SNAPSHOT_PATH);
const jobs = await readArray(JOBS_PATH);
const publicOracle = jobs.filter(job => String(job?.company || '').trim() === COMPANY);
const violations = [];

if (snapshot.length < 3) {
  violations.push(`Oracle snapshot unexpectedly contains only ${snapshot.length} role(s)`);
}

const snapshotIds = new Set();
const snapshotUrls = new Set();
for (const job of snapshot) {
  const id = String(job?.id || '').trim();
  if (String(job?.company || '').trim() !== COMPANY) violations.push(`${id || '(missing id)'} belongs to another company`);
  if (!id) violations.push('Oracle snapshot contains a role without an id');
  else if (snapshotIds.has(id)) violations.push(`duplicate Oracle snapshot id: ${id}`);
  else snapshotIds.add(id);

  try {
    const url = sourceUrl(job, 'Oracle snapshot');
    if (snapshotUrls.has(url)) violations.push(`duplicate Oracle snapshot URL: ${url}`);
    snapshotUrls.add(url);
  } catch (error) {
    violations.push(error.message);
  }

  const title = String(job?.title || '').trim();
  if (!title) violations.push(`${id || '(missing id)'} is missing a title`);
  if (SENIOR_TITLE.test(title)) violations.push(`${id || '(missing id)'} has a senior/managerial title: ${title}`);
  if (!VALID_EXPERIENCE.has(String(job?.experience || ''))) {
    violations.push(`${id || '(missing id)'} has unsupported experience classification: ${job?.experience || '(missing)'}`);
  }
  if (!String(job?.location || '').trim()) violations.push(`${id || '(missing id)'} is missing a location`);
  if (job?.active !== true) violations.push(`${id || '(missing id)'} is not marked active`);
  if (job?.demo === true) violations.push(`${id || '(missing id)'} is marked as demo data`);
}

const publicIds = new Set();
const publicUrls = new Set();
for (const job of publicOracle) {
  const id = String(job?.id || '').trim();
  if (!id) violations.push('Public Oracle feed contains a role without an id');
  else if (publicIds.has(id)) violations.push(`duplicate public Oracle id: ${id}`);
  else publicIds.add(id);

  try {
    const url = sourceUrl(job, 'Public Oracle feed');
    if (publicUrls.has(url)) violations.push(`duplicate public Oracle URL: ${url}`);
    publicUrls.add(url);
  } catch (error) {
    violations.push(error.message);
  }
}

if (publicOracle.length !== snapshot.length) {
  violations.push(`Oracle snapshot/public feed count mismatch (${snapshot.length} snapshot vs ${publicOracle.length} public)`);
}

for (const url of snapshotUrls) {
  if (!publicUrls.has(url)) violations.push(`Oracle snapshot role missing from public feed: ${url}`);
}
for (const url of publicUrls) {
  if (!snapshotUrls.has(url)) violations.push(`Public Oracle role is not present in the authoritative snapshot: ${url}`);
}

if (violations.length) {
  for (const violation of violations) console.error(`Oracle snapshot violation: ${violation}`);
  throw new Error(`Blocked ${violations.length} Oracle snapshot integrity violation(s).`);
}

console.log(`Oracle snapshot guard passed: ${snapshot.length} employer-direct roles match the public feed exactly.`);
