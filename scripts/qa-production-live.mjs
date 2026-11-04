import { readFile, writeFile } from 'node:fs/promises';

// Non-destructive public-production audit. Never prune a repository job from
// a production-only failure: deployment can lag verified source snapshots.
const BASE = (process.env.QA_LIVE_BASE || 'https://datacentercareers.us').replace(/\/$/, '');
const REPORT_PATH = '/tmp/production-qa-report.json';
const TIMEOUT_MS = 14000;
const CONCURRENCY = 16;
const compact = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalized = value => compact(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const slug = value => compact(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'job';
const jobDetailPath = job => '/jobs/' + slug(job.title) + '-' + slug(job.company).slice(0, 32) + '-' + String(job.id).replace(/[^a-zA-Z0-9]/g, '').slice(-10) + '/';

async function getJson(path) {
  const url = BASE + path;
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000), headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'DataCenterCareersProductionQA/1.0' } });
  if (!response.ok) throw new Error('Production inventory fetch failed: HTTP ' + response.status + ' ' + url);
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error('Production inventory is not an array: ' + url);
  return payload;
}

function requisitionId(url) {
  const value = String(url || '');
  const patterns = [
    /[?&](?:gh_jid|jobid|jobId|jid)=([A-Za-z0-9_-]+)/i,
    /\/jobs?\/(\d{6,})\b/i,
    /\b(R\d{4}-\d{3,})\b/i,
    /\b(JLL\d{5,})\b/i,
    /\b(JR\d{5,})\b/i,
    /\b([A-Z]\d{5,})\b/
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return match[1].toLowerCase();
  }
  return '';
}

function genericRedirect(source, final) {
  if (!final || source === final) return false;
  try {
    const a = new URL(source), b = new URL(final);
    if (a.hostname.replace(/^www\./, '') !== b.hostname.replace(/^www\./, '')) return false;
    const req = requisitionId(source);
    if (!req || final.toLowerCase().includes(req)) return false;
    const p = b.pathname.replace(/\/+$/, '') || '/';
    if (b.hostname.endsWith('.myworkdayjobs.com')) return !/\/job\//i.test(p);
    const parts = p.split('/').filter(Boolean);
    return parts.length === 0 || (parts.length <= 2 && /(?:careers?|jobs?|search|openings|opportunities)/i.test(p));
  } catch { return false; }
}

async function check(link) {
  try {
    const response = await fetch(link.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DataCenterCareersProductionQA/1.0; +https://datacentercareers.us/)',
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8'
      }
    });
    const status = response.status, finalUrl = response.url;
    await response.body?.cancel().catch(() => {});
    if (status === 404 || status === 410) return { ...link, state: 'dead', status, finalUrl };
    if ([401, 403, 405, 429].includes(status)) return { ...link, state: 'blocked', status, finalUrl };
    if (status >= 500) return { ...link, state: 'transient', status, finalUrl };
    if (status >= 200 && status < 400) {
      if (link.kind === 'apply' && genericRedirect(link.url, finalUrl)) return { ...link, state: 'broken-redirect', status, finalUrl };
      return { ...link, state: 'ok', status, finalUrl };
    }
    return { ...link, state: 'warning', status, finalUrl };
  } catch (error) {
    return { ...link, state: 'transient', status: null, reason: error.name === 'TimeoutError' ? 'timeout' : String(error.message || error) };
  }
}

async function mapLimit(values, limit, worker) {
  const output = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(limit, values.length || 1)}, async () => {
    while (true) {
      const index = next++;
      if (index >= values.length) break;
      output[index] = await worker(values[index]);
    }
  }));
  return output;
}

const [liveJobs, liveEvents, repoJobs] = await Promise.all([
  getJson('/data/jobs.json'),
  getJson('/data/career-events.json'),
  readFile('data/jobs.json', 'utf8').then(JSON.parse)
]);

const today = new Date().toISOString().slice(0, 10);
const repoIds = new Set(repoJobs.map(job => String(job.id)));
const productionOnly = liveJobs.filter(job => !repoIds.has(String(job.id)));
const expiredEvents = liveEvents.filter(event => compact(event.date) && compact(event.date) < today);
const missingEventDates = liveEvents.filter(event => !/^\d{4}-\d{2}-\d{2}$/.test(compact(event.date)));
const invalidJobs = liveJobs.filter(job => !/^https:\/\//.test(compact(job.sourceUrl)) || !compact(job.id));
const demoJobs = liveJobs.filter(job => job.demo === true);
const identityMap = new Map();
const nearDuplicates = [];
for (const job of liveJobs) {
  const key = [normalized(job.company), normalized(job.title), normalized(job.location)].join('|');
  const prior = identityMap.get(key);
  if (prior && prior.id !== job.id) nearDuplicates.push({firstId: prior.id, secondId: job.id, company: job.company, title: job.title, location: job.location});
  else identityMap.set(key, job);
}
const links = [];
for (const job of liveJobs) {
  const id = String(job.id ?? '');
  if (/^https:\/\//i.test(compact(job.sourceUrl))) links.push({ kind:'apply', id, company:job.company, title:job.title, url:compact(job.sourceUrl) });
  if (id && compact(job.title) && compact(job.company)) links.push({ kind:'detail', id, company:job.company, title:job.title, url:BASE + jobDetailPath(job) });
}
for (const event of liveEvents) {
  if (/^https:\/\//i.test(compact(event.url))) links.push({kind:'event', id:String(event.id ?? ''), title:event.name, url:compact(event.url)});
}
const dedupedLinks = [...new Map(links.map(link => [link.kind + '|' + link.url, link])).values()];
const checked = await mapLimit(dedupedLinks, CONCURRENCY, check);

const byState = {};
for (const check of checked) {
  if (check.state === 'ok') continue;
  const key = check.kind + ':' + check.state;
  (byState[key] ||= []).push(check);
}
const report = {
  checkedAt: new Date().toISOString(),
  productionJobs: liveJobs.length,
  repositoryJobs: repoJobs.length,
  productionOnlyJobs: productionOnly.length,
  productionOnlySamples: productionOnly.slice(0, 20).map(job => ({id:job.id,company:job.company,title:job.title})),
  productionEvents: liveEvents.length,
  expiredEvents: expiredEvents.map(event => ({id:event.id,date:event.date,name:event.name,url:event.url})),
  missingEventDates,
  invalidJobs,
  demoJobs: demoJobs.map(job => ({id:job.id,title:job.title})),
  potentialNearDuplicates: nearDuplicates,
  linksChecked: checked.length,
  linkResultsByState: Object.fromEntries(Object.entries(byState).map(([key, list]) => [key, {count:list.length, items:list.slice(0, 60)}]))
};
await writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
console.log('Production QA: ' + liveJobs.length + ' live jobs vs ' + repoJobs.length + ' repository; ' +
  liveEvents.length + ' events, ' + expiredEvents.length + ' expired; ' +
  dedupedLinks.length + ' job detail/apply/event URLs checked.');
console.log('Production-only IDs: ' + productionOnly.length + '; demo jobs: ' + demoJobs.length +
  '; exact company-title-location collisions: ' + nearDuplicates.length + '; invalid jobs: ' + invalidJobs.length);
for (const [key, list] of Object.entries(byState)) {
  console.log(key + ': ' + list.length);
  for (const bad of list.slice(0, 20)) console.log('  ' + bad.id + ' ' + (bad.status ?? bad.reason) + ' ' + bad.url + (bad.finalUrl && bad.finalUrl !== bad.url ? ' -> ' + bad.finalUrl : ''));
}
console.log('Full non-destructive evidence: ' + REPORT_PATH);
