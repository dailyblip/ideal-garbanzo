import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const BEGINNER_TYPES = new Set(['internship', 'apprenticeship', 'trainee']);
const DEFINITIVELY_CLOSED = new Set([404, 410]);
const CONCURRENCY = 5;
const TIMEOUT_MS = 20000;

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

function isCandidate(job) {
  if (!job || job.demo === true || job.active === false) return false;
  const beginnerPathway = BEGINNER_TYPES.has(clean(job.type)) || clean(job.experience) === 'no-experience';
  if (!beginnerPathway) return false;
  try {
    const url = new URL(clean(job.sourceUrl));
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

function classifyResult(result) {
  if (result?.error) return 'transient';
  const status = Number(result?.status);
  if (DEFINITIVELY_CLOSED.has(status)) return 'closed';
  if (status >= 200 && status < 400) return 'open';
  return 'transient';
}

async function checkUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-cache',
        'user-agent': 'Mozilla/5.0 (compatible; DataCenterCareersBot/1.5; +https://datacentercareers.us/)'
      }
    });
    // Consume only a small prefix so providers are not asked to stream large pages.
    try { await response.body?.cancel(); } catch {}
    return { status: response.status, finalUrl: response.url || url };
  } catch (error) {
    return { error: clean(error?.name || error?.message || 'request failed') };
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function applyChecks(jobs, checks) {
  const byId = new Map(checks.map(check => [check.id, check]));
  const kept = [];
  const removed = [];
  for (const job of jobs) {
    const check = byId.get(job.id);
    if (check && classifyResult(check) === 'closed') removed.push(job);
    else kept.push(job);
  }
  return { kept, removed };
}

function runSelfTest() {
  const jobs = [
    { id:'gone-404', type:'apprenticeship', experience:'no-experience', sourceUrl:'https://example.com/a', active:true, demo:false },
    { id:'gone-410', type:'internship', experience:'0-2-years', sourceUrl:'https://example.com/b', active:true, demo:false },
    { id:'blocked-403', type:'trainee', experience:'no-experience', sourceUrl:'https://example.com/c', active:true, demo:false },
    { id:'server-503', type:'entry-level', experience:'no-experience', sourceUrl:'https://example.com/d', active:true, demo:false },
    { id:'timeout', type:'apprenticeship', experience:'no-experience', sourceUrl:'https://example.com/e', active:true, demo:false },
    { id:'healthy', type:'internship', experience:'0-2-years', sourceUrl:'https://example.com/f', active:true, demo:false },
    { id:'mid-career', type:'entry-level', experience:'2-5-years', sourceUrl:'https://example.com/g', active:true, demo:false }
  ];
  const checks = [
    { id:'gone-404', status:404 },
    { id:'gone-410', status:410 },
    { id:'blocked-403', status:403 },
    { id:'server-503', status:503 },
    { id:'timeout', error:'AbortError' },
    { id:'healthy', status:200 }
  ];
  const { kept, removed } = applyChecks(jobs, checks);
  const removedIds = new Set(removed.map(job => job.id));
  const keptIds = new Set(kept.map(job => job.id));
  if (!removedIds.has('gone-404') || !removedIds.has('gone-410') || removed.length !== 2) {
    throw new Error('404/410 roles were not pruned exactly as expected');
  }
  for (const id of ['blocked-403','server-503','timeout','healthy','mid-career']) {
    if (!keptIds.has(id)) throw new Error(`non-definitive result was incorrectly pruned: ${id}`);
  }
  if (!isCandidate(jobs.find(job => job.id === 'server-503'))) throw new Error('no-experience entry-level role was not selected');
  if (isCandidate(jobs.at(-1))) throw new Error('ordinary 2-5 year role became a beginner-pathway prune candidate');
  console.log('Beginner-pathway stale-link pruning policy passed regression tests.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

const jobs = await readJson(JOBS_PATH, []);
const status = await readJson(STATUS_PATH, {});
const candidates = jobs.filter(isCandidate);
const checkedAt = new Date().toISOString();

const checks = await mapLimit(candidates, CONCURRENCY, async job => {
  const result = await checkUrl(job.sourceUrl);
  const outcome = classifyResult(result);
  return {
    id: job.id,
    company: clean(job.company),
    title: clean(job.title),
    sourceUrl: clean(job.sourceUrl),
    outcome,
    ...result
  };
});

const { kept, removed } = applyChecks(jobs, checks);
const counts = checks.reduce((acc, check) => {
  acc[check.outcome] = (acc[check.outcome] || 0) + 1;
  return acc;
}, { open:0, closed:0, transient:0 });

const nextStatus = {
  ...status,
  updatedAt: checkedAt,
  jobs: kept.length,
  earlyCareerStalePrune: {
    checkedAt,
    candidates: candidates.length,
    open: counts.open,
    definitivelyClosed: counts.closed,
    transientRetained: counts.transient,
    removed: removed.map(job => ({
      id: job.id,
      company: clean(job.company),
      title: clean(job.title),
      sourceUrl: clean(job.sourceUrl)
    })),
    policy: 'Recheck internships, apprenticeships, trainees and no-experience roles. Remove only URLs returning HTTP 404 or 410; preserve blocks, rate limits, server errors, redirects, and network failures.'
  }
};

if (removed.length) await writeFile(JOBS_PATH, JSON.stringify(kept, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(nextStatus, null, 2) + '\n');

console.log(`Checked ${candidates.length} beginner-pathway employer URLs: ${counts.open} reachable, ${counts.closed} definitively closed, ${counts.transient} transient/blocked retained.`);
if (removed.length) console.log(`Removed ${removed.length} definitively closed beginner-pathway role(s).`);
