import { readFile } from 'node:fs/promises';

const COMPANY = 'CoreWeave';
const SNAPSHOT_PATH = 'data/coreweave-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const allowedExperience = new Set(['no-experience', '0-2-years', '2-5-years']);
const seniorPattern = /\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|head|supervisor)\b/i;
const missionPattern = /\b(?:data center technician|critical facilit(?:y|ies) technician|critical operations technician|data center operator|data center operations technician|command center systems engineer|facilities technician|electrical technician)\b/i;
const normalize = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function canonicalTitle(job) {
  let title = String(job?.title || '').trim();
  const location = normalize(job?.location);
  const locationTokens = new Set(location.split(' ').filter(token => token.length > 1));
  const tailBelongsToLocation = tail => {
    const tokens = normalize(tail).split(' ').filter(token => token.length > 1);
    return tokens.length > 0 && tokens.every(token => locationTokens.has(token));
  };
  title = title.replace(/^\s*\d{2,5}\s*[-–—]\s*/u, '');
  title = title.replace(/\s+[-–—]\s+([^|]+)$/u, (full, tail) => tailBelongsToLocation(tail) ? '' : full);
  title = title.replace(/\s*\(([^)]+)\)\s*$/u, (full, tail) => tailBelongsToLocation(tail) ? '' : full);
  title = title.replace(/\s*[-–—,:()]?\s*(?:day|night|overnight|weekend)\s+shift(?:\s*\d+)?\s*$/iu, '');
  return normalize(title);
}

const opportunityKey = job => [normalize(job?.company), canonicalTitle(job), normalize(job?.location)].join('|');

const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
const status = JSON.parse(await readFile(STATUS_PATH, 'utf8'));
if (!Array.isArray(snapshot)) throw new Error('CoreWeave snapshot must be an array');
if (!Array.isArray(jobs)) throw new Error('jobs.json must be an array');

const violations = [];
for (const job of snapshot) {
  if (String(job?.company || '').trim() !== COMPANY) violations.push(`${job?.id || '(missing id)'} has the wrong company`);
  if (!missionPattern.test(String(job?.title || ''))) violations.push(`${job?.id || '(missing id)'} has an off-mission title: ${job?.title || '(missing)'}`);
  if (seniorPattern.test(String(job?.title || ''))) violations.push(`${job?.id || '(missing id)'} leaks a senior title: ${job?.title}`);
  if (!allowedExperience.has(String(job?.experience || ''))) violations.push(`${job?.id || '(missing id)'} has invalid experience bucket: ${job?.experience || '(missing)'}`);
  if (job?.active !== true || job?.demo === true) violations.push(`${job?.id || '(missing id)'} is inactive or demo data`);
  let url;
  try { url = new URL(String(job?.sourceUrl || '')); } catch {}
  if (!url || url.protocol !== 'https:' || !['coreweave.com', 'www.coreweave.com'].includes(url.hostname.toLowerCase()) || url.pathname !== '/careers' || !url.searchParams.get('gh_jid')) {
    violations.push(`${job?.id || '(missing id)'} does not use the official CoreWeave career route`);
  }
}

const publicJobs = jobs.filter(job => String(job?.company || '').trim() === COMPANY);
const snapshotKeys = new Set(snapshot.map(opportunityKey).filter(Boolean));
const publicKeys = new Set(publicJobs.map(opportunityKey).filter(Boolean));
for (const key of snapshotKeys) if (!publicKeys.has(key)) violations.push(`snapshot opportunity ${key} is missing from public jobs.json`);
for (const key of publicKeys) if (!snapshotKeys.has(key)) violations.push(`public opportunity ${key} is not present in the authoritative CoreWeave snapshot`);

const health = status?.coreWeaveCareers || {};
if (health.sourceHealthy === true) {
  if (!health.boardToken) violations.push('healthy CoreWeave source is missing the selected Greenhouse board token');
  if (Number(health.sourceRoles || 0) < snapshot.length) violations.push('CoreWeave source role count is smaller than the retained snapshot');
  if (Number(health.qualifyingRoles || 0) !== snapshot.length) violations.push(`CoreWeave qualifying count ${health.qualifyingRoles || 0} does not match snapshot ${snapshot.length}`);
}

if (violations.length) {
  console.error('CoreWeave source validation failed:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`CoreWeave validation passed: ${snapshot.length} source role(s), ${snapshotKeys.size} unique 0–5 year data-center opportunities, public-feed opportunity parity.`);
