import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const FALLBACK_SCRIPT_PATH = 'scripts/apply-equinix-verified-fallback.mjs';
const COMPANY = 'Equinix';
const FALLBACK_SOURCE = 'Equinix official careers (verified fallback)';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function verifiedRoleUrls(source) {
  const urls = new Map();
  const pattern = /requisition:\s*'([^']+)'[\s\S]*?url:\s*'([^']+)'/g;
  for (const match of source.matchAll(pattern)) {
    const requisition = clean(match[1]).toUpperCase();
    const url = clean(match[2]);
    if (!/^JR-\d+$/i.test(requisition)) continue;
    try {
      const parsed = new URL(url);
      const path = parsed.pathname.replace(/\/$/, '');
      if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'careers.equinix.com') continue;
      if (!/^\/jobs\/[^/]+$/i.test(path) || path.toLowerCase() === '/jobs/search') continue;
      urls.set(requisition, url);
    } catch {
      // Ignore malformed seed data; publication remains on the requisition search fallback.
    }
  }
  return urls;
}

function requisitionFromSearchUrl(sourceUrl) {
  try {
    const parsed = new URL(clean(sourceUrl));
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'careers.equinix.com') return '';
    if (parsed.pathname.replace(/\/$/, '') !== '/jobs/search') return '';
    const requisition = clean(parsed.searchParams.get('query')).toUpperCase();
    return /^JR-\d+$/i.test(requisition) ? requisition : '';
  } catch {
    return '';
  }
}

function healthyDetailRequisitions(status) {
  const checks = status?.equinixVerifiedFallback?.checks;
  if (!Array.isArray(checks)) return new Set();
  return new Set(checks
    .filter(check => check?.ok === true && check?.verification === 'detail' && Number(check?.detailStatus) >= 200 && Number(check?.detailStatus) < 300)
    .map(check => clean(check.requisition).toUpperCase())
    .filter(requisition => /^JR-\d+$/i.test(requisition)));
}

function isManagedFallback(job) {
  return clean(job?.company) === COMPANY && (
    /^equinix-verified-/i.test(clean(job?.id)) ||
    clean(job?.source) === FALLBACK_SOURCE
  );
}

function promoteDirectClicks(jobs, roleUrls, healthyRequisitions) {
  let changed = 0;
  let managed = 0;
  let direct = 0;
  let searchFallback = 0;

  const next = jobs.map(job => {
    if (!isManagedFallback(job)) return job;
    managed += 1;

    const current = clean(job.sourceUrl);
    const requisition = requisitionFromSearchUrl(current);
    if (requisition && healthyRequisitions.has(requisition) && roleUrls.has(requisition)) {
      changed += 1;
      direct += 1;
      return { ...job, sourceUrl: roleUrls.get(requisition) };
    }

    try {
      const parsed = new URL(current);
      const path = parsed.pathname.replace(/\/$/, '');
      if (parsed.hostname.toLowerCase() === 'careers.equinix.com' && /^\/jobs\/[^/]+$/i.test(path) && path.toLowerCase() !== '/jobs/search') {
        direct += 1;
      } else if (requisition) {
        searchFallback += 1;
      }
    } catch {
      // Existing validation will fail malformed click targets.
    }
    return job;
  });

  return { jobs: next, changed, managed, direct, searchFallback };
}

function runSelfTest() {
  const source = `const verifiedRoles = [
    { requisition: 'JR-100001', title: 'Role A', url: 'https://careers.equinix.com/jobs/role-a-dallas-texas-united-states' },
    { requisition: 'JR-100002', title: 'Role B', url: 'https://careers.equinix.com/jobs/role-b-ashburn-virginia-united-states' }
  ];`;
  const roleUrls = verifiedRoleUrls(source);
  const status = { equinixVerifiedFallback: { checks: [
    { requisition: 'JR-100001', ok: true, verification: 'detail', detailStatus: 202 },
    { requisition: 'JR-100002', ok: true, verification: 'official-listing', detailStatus: 404 }
  ] } };
  const input = [
    { id: 'equinix-verified-a', company: COMPANY, source: FALLBACK_SOURCE, sourceUrl: 'https://careers.equinix.com/jobs/search?query=JR-100001' },
    { id: 'equinix-verified-b', company: COMPANY, source: FALLBACK_SOURCE, sourceUrl: 'https://careers.equinix.com/jobs/search?query=JR-100002' }
  ];
  const result = promoteDirectClicks(input, roleUrls, healthyDetailRequisitions(status));
  if (result.changed !== 1 || result.direct !== 1 || result.searchFallback !== 1) throw new Error('Equinix direct-click promotion counts regressed.');
  if (result.jobs[0].sourceUrl !== roleUrls.get('JR-100001')) throw new Error('Healthy Equinix detail URL was not promoted.');
  if (!result.jobs[1].sourceUrl.includes('query=JR-100002')) throw new Error('Unhealthy Equinix detail URL lost its targeted search fallback.');
  console.log('Equinix direct-click promotion regression tests passed.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

const [jobs, status, fallbackSource] = await Promise.all([
  readFile(JOBS_PATH, 'utf8').then(JSON.parse),
  readFile(STATUS_PATH, 'utf8').then(JSON.parse),
  readFile(FALLBACK_SCRIPT_PATH, 'utf8')
]);
if (!Array.isArray(jobs)) throw new Error(`${JOBS_PATH} must contain an array.`);

const roleUrls = verifiedRoleUrls(fallbackSource);
const healthyRequisitions = healthyDetailRequisitions(status);
const result = promoteDirectClicks(jobs, roleUrls, healthyRequisitions);

if (result.managed > 0 && result.direct + result.searchFallback !== result.managed) {
  throw new Error(`Equinix managed click guard failed: ${result.managed - result.direct - result.searchFallback} role(s) lack a stable direct or requisition-targeted click.`);
}

if (result.changed > 0) await writeFile(JOBS_PATH, `${JSON.stringify(result.jobs, null, 2)}\n`);
status.equinixVerifiedFallback = {
  ...(status.equinixVerifiedFallback || {}),
  directDetailClicksUsed: result.direct,
  searchClickFallbacksUsed: result.searchFallback
};
await writeFile(STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`);

console.log(`Equinix click routing: ${result.direct} verified direct detail link(s), ${result.searchFallback} requisition-targeted search fallback(s), ${result.changed} promoted this run.`);
