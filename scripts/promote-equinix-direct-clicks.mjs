import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const FALLBACK_SCRIPT_PATH = 'scripts/apply-equinix-verified-fallback.mjs';
const COMPANY = 'Equinix';
const FALLBACK_SOURCE = 'Equinix official careers (verified fallback)';
const DIRECT_PROBE_TIMEOUT_MS = 15000;

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

function canonicalUrl(value = '') {
  try {
    const parsed = new URL(clean(value));
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return clean(value).replace(/\/$/, '');
  }
}

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

function requisitionFromManagedUrl(sourceUrl, roleUrls) {
  const searchRequisition = requisitionFromSearchUrl(sourceUrl);
  if (searchRequisition) return searchRequisition;

  const current = canonicalUrl(sourceUrl);
  if (!current) return '';
  for (const [requisition, detailUrl] of roleUrls) {
    if (canonicalUrl(detailUrl) === current) return requisition;
  }
  return '';
}

function officialSearchUrl(requisition) {
  return `https://careers.equinix.com/jobs/search?query=${encodeURIComponent(requisition)}`;
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

function stableDirectResponse(status, finalUrl) {
  if (Number(status) !== 200) return false;
  try {
    const parsed = new URL(clean(finalUrl));
    const path = parsed.pathname.replace(/\/$/, '');
    return parsed.protocol === 'https:' &&
      parsed.hostname.toLowerCase() === 'careers.equinix.com' &&
      /^\/jobs\/[^/]+$/i.test(path) &&
      path.toLowerCase() !== '/jobs/search';
  } catch {
    return false;
  }
}

async function probeDirectDetail(requisition, detailUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DIRECT_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(detailUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; DataCenterCareersQA/1.0; +https://datacentercareers.us/)',
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'cache-control': 'no-cache'
      }
    });
    return {
      requisition,
      status: response.status,
      ok: stableDirectResponse(response.status, response.url),
      finalUrl: response.url || detailUrl,
      error: null
    };
  } catch (error) {
    return {
      requisition,
      status: null,
      ok: false,
      finalUrl: detailUrl,
      error: error?.name === 'AbortError' ? 'timeout' : clean(error?.message || error)
    };
  } finally {
    clearTimeout(timer);
  }
}

function stableDirectRequisitions(verifiedRequisitions, probes) {
  return new Set((Array.isArray(probes) ? probes : [])
    .filter(probe => probe?.ok === true && verifiedRequisitions.has(clean(probe.requisition).toUpperCase()))
    .map(probe => clean(probe.requisition).toUpperCase())
    .filter(requisition => /^JR-\d+$/i.test(requisition)));
}

function promoteDirectClicks(jobs, roleUrls, stableRequisitions) {
  let changed = 0;
  let managed = 0;
  let direct = 0;
  let searchFallback = 0;

  const next = jobs.map(job => {
    if (!isManagedFallback(job)) return job;
    managed += 1;

    const current = clean(job.sourceUrl);
    const requisition = requisitionFromManagedUrl(current, roleUrls);
    if (!requisition || !roleUrls.has(requisition)) return job;

    const useDirect = stableRequisitions.has(requisition);
    const desiredUrl = useDirect ? roleUrls.get(requisition) : officialSearchUrl(requisition);
    if (canonicalUrl(current) !== canonicalUrl(desiredUrl)) changed += 1;
    if (useDirect) direct += 1;
    else searchFallback += 1;
    return canonicalUrl(current) === canonicalUrl(desiredUrl) ? job : { ...job, sourceUrl: desiredUrl };
  });

  return { jobs: next, changed, managed, direct, searchFallback };
}

function runSelfTest() {
  const source = `const verifiedRoles = [
    { requisition: 'JR-100001', title: 'Role A', url: 'https://careers.equinix.com/jobs/role-a-dallas-texas-united-states' },
    { requisition: 'JR-100002', title: 'Role B', url: 'https://careers.equinix.com/jobs/role-b-ashburn-virginia-united-states' },
    { requisition: 'JR-100003', title: 'Role C', url: 'https://careers.equinix.com/jobs/role-c-chicago-illinois-united-states' }
  ];`;
  const roleUrls = verifiedRoleUrls(source);
  const status = { equinixVerifiedFallback: { checks: [
    { requisition: 'JR-100001', ok: true, verification: 'detail', detailStatus: 202 },
    { requisition: 'JR-100002', ok: true, verification: 'official-listing', detailStatus: 404 },
    { requisition: 'JR-100003', ok: true, verification: 'detail', detailStatus: 200 }
  ] } };
  const probes = [
    { requisition: 'JR-100001', status: 200, ok: true, finalUrl: roleUrls.get('JR-100001') },
    { requisition: 'JR-100003', status: 404, ok: false, finalUrl: roleUrls.get('JR-100003') }
  ];
  const stable = stableDirectRequisitions(healthyDetailRequisitions(status), probes);
  const input = [
    { id: 'equinix-verified-a', company: COMPANY, source: FALLBACK_SOURCE, sourceUrl: 'https://careers.equinix.com/jobs/search?query=JR-100001' },
    { id: 'equinix-verified-b', company: COMPANY, source: FALLBACK_SOURCE, sourceUrl: roleUrls.get('JR-100002') },
    { id: 'equinix-verified-c', company: COMPANY, source: FALLBACK_SOURCE, sourceUrl: roleUrls.get('JR-100003') }
  ];
  const result = promoteDirectClicks(input, roleUrls, stable);
  if (result.changed !== 3 || result.direct !== 1 || result.searchFallback !== 2) throw new Error('Equinix direct-click routing counts regressed.');
  if (result.jobs[0].sourceUrl !== roleUrls.get('JR-100001')) throw new Error('Stable Equinix detail URL was not promoted.');
  if (!result.jobs[1].sourceUrl.includes('query=JR-100002')) throw new Error('Unverified Equinix detail URL was not demoted to its requisition-targeted search fallback.');
  if (!result.jobs[2].sourceUrl.includes('query=JR-100003')) throw new Error('Dead Equinix detail URL was not demoted to its requisition-targeted search fallback.');
  if (!stableDirectResponse(200, roleUrls.get('JR-100001'))) throw new Error('Stable Equinix 200 detail response was rejected.');
  if (stableDirectResponse(202, roleUrls.get('JR-100001'))) throw new Error('Equinix 202 detail responses must not be treated as click-stable.');
  if (stableDirectResponse(200, 'https://careers.equinix.com/jobs/search?query=JR-100001')) throw new Error('Equinix search page must not be treated as a direct detail response.');
  console.log('Equinix direct-click routing regression tests passed.');
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
const verifiedRequisitions = healthyDetailRequisitions(status);
const probeTargets = [...verifiedRequisitions]
  .filter(requisition => roleUrls.has(requisition))
  .map(requisition => [requisition, roleUrls.get(requisition)]);
const directDetailProbes = await Promise.all(probeTargets.map(([requisition, detailUrl]) => probeDirectDetail(requisition, detailUrl)));
const stableRequisitions = stableDirectRequisitions(verifiedRequisitions, directDetailProbes);
const result = promoteDirectClicks(jobs, roleUrls, stableRequisitions);

if (result.managed > 0 && result.direct + result.searchFallback !== result.managed) {
  throw new Error(`Equinix managed click guard failed: ${result.managed - result.direct - result.searchFallback} role(s) lack a stable direct or requisition-targeted click.`);
}

if (result.changed > 0) await writeFile(JOBS_PATH, `${JSON.stringify(result.jobs, null, 2)}\n`);
status.equinixVerifiedFallback = {
  ...(status.equinixVerifiedFallback || {}),
  directDetailClicksUsed: result.direct,
  searchClickFallbacksUsed: result.searchFallback,
  directDetailProbes
};
await writeFile(STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`);

console.log(`Equinix click routing: ${result.direct} independently verified HTTP 200 direct detail link(s), ${result.searchFallback} requisition-targeted search fallback(s), ${result.changed} route change(s) this run.`);
