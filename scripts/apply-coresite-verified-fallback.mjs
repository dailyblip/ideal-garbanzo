import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const FALLBACK_PATH = 'data/coresite-verified-fallback.json';
const COMPANY = 'CoreSite';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalize = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const isCoreSite = job => clean(job?.company) === COMPANY || /(^|\.)jobs\.coresite\.com\//i.test(clean(job?.sourceUrl));

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function dedupe(jobs) {
  const ids = new Set();
  const urls = new Set();
  const identities = new Set();
  const out = [];
  for (const job of jobs) {
    if (!job || typeof job !== 'object') continue;
    const id = clean(job.id);
    const url = clean(job.sourceUrl);
    const identity = [job.company, job.title, job.location].map(normalize).join('|');
    if ((id && ids.has(id)) || (url && urls.has(url)) || identities.has(identity)) continue;
    if (id) ids.add(id);
    if (url) urls.add(url);
    identities.add(identity);
    out.push(job);
  }
  return out;
}

function validateFallback(payload) {
  if (!payload || !Array.isArray(payload.jobs) || !payload.jobs.length) throw new Error('CoreSite fallback must contain at least one job.');
  const verifiedAt = Date.parse(payload.verifiedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  if (!Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt) || expiresAt <= verifiedAt) {
    throw new Error('CoreSite fallback has invalid verification timestamps.');
  }
  for (const job of payload.jobs) {
    if (job.company !== COMPANY) throw new Error(`Unexpected fallback company: ${job.company || '(missing)'}`);
    if (!/^https:\/\/jobs\.coresite\.com\/jobs\/\d+/i.test(clean(job.sourceUrl))) {
      throw new Error(`Fallback role is not an official CoreSite job URL: ${job.sourceUrl || '(missing)'}`);
    }
    if (!['internship', 'apprenticeship', 'trainee', 'entry-level'].includes(job.type)) throw new Error(`Unsupported CoreSite fallback type: ${job.type}`);
    if (!['no-experience', '0-2-years', '2-5-years'].includes(job.experience)) throw new Error(`Unsupported CoreSite fallback experience: ${job.experience}`);
  }
  return { verifiedAt, expiresAt };
}

const jobs = await readJson(JOBS_PATH);
const status = await readJson(STATUS_PATH);
const fallback = await readJson(FALLBACK_PATH);
const { verifiedAt, expiresAt } = validateFallback(fallback);
const now = Date.now();

if (status?.coreSite?.sourceHealthy === true) {
  console.log('CoreSite official collector is healthy; verified fallback not used.');
  process.exit(0);
}

const withoutCoreSite = jobs.filter(job => !isCoreSite(job));
const fallbackActive = now >= verifiedAt && now <= expiresAt;
const fallbackJobs = fallbackActive ? fallback.jobs.map(job => ({ ...job, active: true, demo: false })) : [];
const merged = dedupe([...withoutCoreSite, ...fallbackJobs]);
const countsByType = merged.reduce((acc, job) => { acc[job.type] = (acc[job.type] || 0) + 1; return acc; }, {});
const countsByExperience = merged.reduce((acc, job) => { acc[job.experience] = (acc[job.experience] || 0) + 1; return acc; }, {});

await writeFile(JOBS_PATH, JSON.stringify(merged, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify({
  ...status,
  updatedAt: new Date().toISOString(),
  jobs: merged.length,
  countsByType,
  countsByExperience,
  coreSite: {
    ...(status.coreSite || {}),
    qualifyingRoles: fallbackJobs.length,
    verifiedFallback: {
      active: fallbackActive,
      verifiedAt: fallback.verifiedAt,
      expiresAt: fallback.expiresAt,
      roles: fallbackJobs.length,
      officialSource: fallback.officialSource,
      reason: fallback.reason
    }
  }
}, null, 2) + '\n');

if (fallbackActive) {
  console.log(`CoreSite official collector is blocked; published ${fallbackJobs.length} individually verified roles until ${fallback.expiresAt}.`);
} else {
  console.warn(`CoreSite verified fallback expired at ${fallback.expiresAt}; removed CoreSite fallback roles rather than serving stale jobs.`);
}
