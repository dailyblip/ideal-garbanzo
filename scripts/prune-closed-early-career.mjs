import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const TARGET_EXPERIENCE_BANDS = new Set(['no-experience', '0-2-years', '2-5-years']);
const DEFINITIVELY_CLOSED = new Set([404, 410]);
const CONCURRENCY = 5;
const TIMEOUT_MS = 20000;

// These employers are maintained by dedicated authoritative source snapshots or
// provider-specific publication guards. Their refresh workflows own stale-role
// removal so this generic URL checker cannot create public/snapshot drift.
const AUTHORITATIVE_REFRESH_COMPANIES = new Set([
  'Amazon Web Services',
  'Google',
  'Microsoft',
  'Meta',
  'Oracle',
  'Equinix',
  'Digital Realty',
  'Iron Mountain',
  'Cologix',
  'Flexential',
  'T5 Data Centers',
  'Stream Data Centers',
  'Switch',
  'DataBank',
  'TierPoint',
  'Sabey Data Centers',
  'Novva Data Centers',
  'Vantage Data Centers',
  'QTS Data Centers',
  'CyrusOne',
  'STACK Infrastructure',
  'NTT Global Data Centers',
  'Aligned Data Centers'
]);

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

function isWithinEarlyCareerScope(job) {
  if (!job || job.demo === true || job.active === false) return false;
  if (!TARGET_EXPERIENCE_BANDS.has(clean(job.experience))) return false;
  try {
    const url = new URL(clean(job.sourceUrl));
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isAuthoritativeRefreshOwned(job) {
  return AUTHORITATIVE_REFRESH_COMPANIES.has(clean(job?.company));
}

function isCandidate(job) {
  return isWithinEarlyCareerScope(job) && !isAuthoritativeRefreshOwned(job);
}

function classifyResult(result) {
  if (result?.error) return 'transient';
  const status = Number(result?.status);
  if (DEFINITIVELY_CLOSED.has(status)) return 'closed';
  if (status >= 200 && status < 400) return 'open';
  return 'transient';
}

function hasActiveEquinixFallbackVerification(job, status, nowMs = Date.now()) {
  if (clean(job?.company) !== 'Equinix') return false;
  const managed = /^equinix-verified-/i.test(clean(job?.id)) ||
    clean(job?.source) === 'Equinix official careers (verified fallback)';
  if (!managed) return false;

  const fallback = status?.equinixVerifiedFallback;
  if (!fallback || fallback.expired === true) return false;
  const expiresAt = Date.parse(clean(fallback.expiresAt));
  if (!Number.isFinite(expiresAt) || nowMs >= expiresAt) return false;

  const retainedManaged = Number(fallback.retainedManaged || 0);
  const liveChecksPassed = Number(fallback.liveChecksPassed || 0);
  return retainedManaged > 0 && liveChecksPassed >= retainedManaged;
}

function classifyJobResult(job, result, status, nowMs = Date.now()) {
  const outcome = classifyResult(result);
  // Keep this provider-level safeguard for direct regression coverage even
  // though Equinix is normally excluded from the generic stale-prune scope.
  if (outcome === 'closed' && hasActiveEquinixFallbackVerification(job, status, nowMs)) {
    return 'verified-retained';
  }
  return outcome;
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
    const outcome = check?.outcome || (check ? classifyResult(check) : null);
    if (outcome === 'closed') removed.push(job);
    else kept.push(job);
  }
  return { kept, removed };
}

function runSelfTest() {
  const jobs = [
    { id:'gone-404', type:'apprenticeship', experience:'no-experience', sourceUrl:'https://example.com/a', active:true, demo:false },
    { id:'gone-410', type:'internship', experience:'0-2-years', sourceUrl:'https://example.com/b', active:true, demo:false },
    { id:'blocked-403', type:'trainee', experience:'no-experience', sourceUrl:'https://example.com/c', active:true, demo:false },
    { id:'server-503', type:'entry-level', experience:'0-2-years', sourceUrl:'https://example.com/d', active:true, demo:false },
    { id:'timeout', type:'entry-level', experience:'2-5-years', sourceUrl:'https://example.com/e', active:true, demo:false },
    { id:'healthy', type:'entry-level', experience:'2-5-years', sourceUrl:'https://example.com/f', active:true, demo:false },
    { id:'unsupported-experience', type:'entry-level', experience:'6-plus-years', sourceUrl:'https://example.com/g', active:true, demo:false },
    { id:'authoritative-microsoft', company:'Microsoft', type:'entry-level', experience:'0-2-years', sourceUrl:'https://apply.careers.microsoft.com/careers/job/123', active:true, demo:false },
    { id:'equinix-verified-test', company:'Equinix', source:'Equinix official careers (verified fallback)', type:'internship', experience:'no-experience', sourceUrl:'https://careers.equinix.com/jobs/test', active:true, demo:false }
  ];
  const now = Date.parse('2026-09-08T12:00:00Z');
  const providerStatus = {
    equinixVerifiedFallback: {
      expired: false,
      expiresAt: '2026-09-15T00:00:00Z',
      retainedManaged: 1,
      liveChecksPassed: 1
    }
  };
  const rawChecks = [
    { id:'gone-404', status:404 },
    { id:'gone-410', status:410 },
    { id:'blocked-403', status:403 },
    { id:'server-503', status:503 },
    { id:'timeout', error:'AbortError' },
    { id:'healthy', status:200 },
    { id:'equinix-verified-test', status:404 }
  ];
  const checks = rawChecks.map(check => {
    const job = jobs.find(candidate => candidate.id === check.id);
    return { ...check, outcome: classifyJobResult(job, check, providerStatus, now) };
  });
  const { kept, removed } = applyChecks(jobs, checks);
  const removedIds = new Set(removed.map(job => job.id));
  const keptIds = new Set(kept.map(job => job.id));
  if (!removedIds.has('gone-404') || !removedIds.has('gone-410') || removed.length !== 2) {
    throw new Error('404/410 roles were not pruned exactly as expected');
  }
  for (const id of ['blocked-403','server-503','timeout','healthy','unsupported-experience','authoritative-microsoft','equinix-verified-test']) {
    if (!keptIds.has(id)) throw new Error(`non-definitive or source-owned result was incorrectly pruned: ${id}`);
  }
  if (checks.find(check => check.id === 'equinix-verified-test')?.outcome !== 'verified-retained') {
    throw new Error('active Equinix provider verification did not override a generic false 404');
  }
  for (const id of ['gone-404','gone-410','blocked-403','server-503','timeout','healthy']) {
    if (!isCandidate(jobs.find(job => job.id === id))) throw new Error(`supported non-source-owned 0–5-year role was not selected for stale checking: ${id}`);
  }
  if (isCandidate(jobs.find(job => job.id === 'unsupported-experience'))) {
    throw new Error('unsupported experience band became a 0–5-year stale-prune candidate');
  }
  for (const id of ['authoritative-microsoft','equinix-verified-test']) {
    const job = jobs.find(candidate => candidate.id === id);
    if (!isWithinEarlyCareerScope(job) || isCandidate(job)) {
      throw new Error(`authoritative source-owned early-career role was not excluded from generic stale pruning: ${id}`);
    }
  }
  console.log('Published 0–5-year stale-link pruning policy passed regression tests, including authoritative source ownership.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

const jobs = await readJson(JOBS_PATH, []);
const status = await readJson(STATUS_PATH, {});
const sourceOwnedSkipped = jobs.filter(job => isWithinEarlyCareerScope(job) && isAuthoritativeRefreshOwned(job));
const candidates = jobs.filter(isCandidate);
const checkedAt = new Date().toISOString();
const checkedAtMs = Date.parse(checkedAt);

const checks = await mapLimit(candidates, CONCURRENCY, async job => {
  const result = await checkUrl(job.sourceUrl);
  const outcome = classifyJobResult(job, result, status, checkedAtMs);
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
}, { open:0, closed:0, transient:0, 'verified-retained':0 });

const nextStatus = {
  ...status,
  updatedAt: checkedAt,
  jobs: kept.length,
  earlyCareerStalePrune: {
    checkedAt,
    scope: 'published 0-5-year roles not owned by an authoritative source refresh',
    candidates: candidates.length,
    authoritativeSourceOwnedSkipped: sourceOwnedSkipped.length,
    authoritativeSourceOwnedCompanies: [...new Set(sourceOwnedSkipped.map(job => clean(job.company)).filter(Boolean))].sort(),
    open: counts.open,
    definitivelyClosed: counts.closed,
    transientRetained: counts.transient,
    providerVerifiedRetained: counts['verified-retained'],
    removed: removed.map(job => ({
      id: job.id,
      company: clean(job.company),
      title: clean(job.title),
      sourceUrl: clean(job.sourceUrl)
    })),
    policy: 'Recheck published no-experience, 0-2-year and 2-5-year roles that are not controlled by an authoritative source refresh. Remove only URLs returning HTTP 404 or 410; preserve blocks, rate limits, server errors, redirects and network failures. Authoritative snapshot/provider workflows own stale removal for their employers so generic pruning cannot create source/publication drift.'
  }
};

if (removed.length) await writeFile(JOBS_PATH, JSON.stringify(kept, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(nextStatus, null, 2) + '\n');

console.log(`Checked ${candidates.length} published 0–5-year employer URLs: ${counts.open} reachable, ${counts.closed} definitively closed, ${counts.transient} transient/blocked retained, ${counts['verified-retained']} retained by active provider verification; skipped ${sourceOwnedSkipped.length} authoritative source-owned role(s).`);
if (removed.length) console.log(`Removed ${removed.length} definitively closed 0–5-year role(s).`);
