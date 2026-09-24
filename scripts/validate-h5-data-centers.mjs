import { readFile } from 'node:fs/promises';

const COMPANY = 'H5 Data Centers';
const SNAPSHOT = 'data/h5-data-centers-jobs.json';
const JOBS = 'data/jobs.json';
const COLLECTOR = 'scripts/collect-h5-data-centers.mjs';
const staticOnly = process.argv.includes('--static-only');
const failures = [];

const collector = await readFile(COLLECTOR, 'utf8');
const requiredCollectorMarkers = [
  "const COMPANY = 'H5 Data Centers'",
  'workforcenow.adp.com',
  '/careercenter/public/events/staffing/v1/job-requisitions',
  "officialSource: 'https://h5datacenters.com/data-center-careers.html'",
  'previous.length',
  'if (years.some(year => year > 5)) return null',
  'classifierCases',
  "source: 'Employer career site'"
];
for (const marker of requiredCollectorMarkers) {
  if (!collector.includes(marker)) failures.push(`collector contract missing ${marker}`);
}
if (!collector.includes("base.filter(job => clean(job?.company) !== COMPANY)")) {
  failures.push('collector must replace only H5 Data Centers rows in the shared feed');
}
if (!collector.includes("detail identity mismatch")) failures.push('collector must fail on ADP listing/detail identity drift');
if (!collector.includes('listing parity mismatch')) failures.push('collector must verify ADP listing parity');

if (!staticOnly) {
  const snapshot = JSON.parse(await readFile(SNAPSHOT, 'utf8'));
  const jobs = JSON.parse(await readFile(JOBS, 'utf8'));
  if (!Array.isArray(snapshot)) failures.push('H5 snapshot must be an array');
  if (!Array.isArray(jobs)) failures.push('public jobs feed must be an array');

  const seenIds = new Set();
  const seenUrls = new Set();
  for (const [index, job] of (Array.isArray(snapshot) ? snapshot : []).entries()) {
    const where = `snapshot[${index}]`;
    if (job.company !== COMPANY) failures.push(`${where}: wrong company ${job.company}`);
    if (!/^adp-h5-/.test(String(job.id || ''))) failures.push(`${where}: id is not H5 ADP-scoped`);
    if (!job.title || !job.location) failures.push(`${where}: missing title/location`);
    if (job.type !== 'entry-level') failures.push(`${where}: type must be entry-level`);
    if (!['no-experience', '0-2-years', '2-5-years'].includes(job.experience)) failures.push(`${where}: invalid experience ${job.experience}`);
    if (/\b(?:senior|sr\.?|lead|principal|manager|director|vice president|vp|head of|chief|supervisor)\b/i.test(String(job.title || ''))) failures.push(`${where}: senior title leaked into early-career snapshot`);
    if (!/(?:data\s*center|critical facilities?|facilities?|facility|operations?|noc)/i.test(String(job.title || ''))) failures.push(`${where}: title is outside data-center operations mission`);
    if (job.source !== 'Employer career site') failures.push(`${where}: source is not employer-direct`);
    let url;
    try { url = new URL(job.sourceUrl); } catch { failures.push(`${where}: invalid sourceUrl`); }
    if (url) {
      if (url.hostname !== 'workforcenow.adp.com') failures.push(`${where}: sourceUrl is not official ADP host`);
      if (!url.pathname.endsWith('/mdf/recruitment/recruitment.html')) failures.push(`${where}: sourceUrl is not the official H5 recruitment portal`);
      if (url.searchParams.get('cid') !== '82492f85-be81-40ce-8d7b-b3a16956630b') failures.push(`${where}: sourceUrl has wrong H5 tenant id`);
      if (url.searchParams.get('ccId') !== '19000101_000001') failures.push(`${where}: sourceUrl has wrong career center id`);
      if (!url.searchParams.get('jobId')) failures.push(`${where}: sourceUrl is not a direct role landing`);
    }
    if (seenIds.has(job.id)) failures.push(`${where}: duplicate id ${job.id}`);
    if (seenUrls.has(job.sourceUrl)) failures.push(`${where}: duplicate sourceUrl ${job.sourceUrl}`);
    seenIds.add(job.id);
    seenUrls.add(job.sourceUrl);
  }

  const published = (Array.isArray(jobs) ? jobs : []).filter(job => job?.company === COMPANY);
  const snapshotIds = new Set((Array.isArray(snapshot) ? snapshot : []).map(job => job.id));
  const publishedIds = new Set(published.map(job => job.id));
  for (const id of snapshotIds) if (!publishedIds.has(id)) failures.push(`snapshot role ${id} missing from public feed`);
  for (const id of publishedIds) if (!snapshotIds.has(id)) failures.push(`public H5 role ${id} is outside the verified H5 snapshot`);
}

if (failures.length) {
  for (const failure of failures) console.error(`H5 source integrity violation: ${failure}`);
  throw new Error(`Blocked ${failures.length} H5 source integrity regression(s).`);
}
console.log(staticOnly ? 'H5 collector static integrity contract passed.' : 'H5 employer-direct snapshot and publication parity passed.');
