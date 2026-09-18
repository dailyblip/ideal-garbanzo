import { readFile, writeFile } from 'node:fs/promises';

const FALLBACK_PATH = 'data/coresite-verified-fallback.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'CoreSite';
const MAX_AGE_HOURS = 96;
const MIN_REFRESH_RATIO = 0.60;
const REQUEST_TIMEOUT_MS = 12_000;
const BATCH_SIZE = 4;

const clean = value => String(value ?? '')
  .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&ndash;|&#8211;/gi, '–')
  .replace(/&mdash;|&#8212;/gi, '—')
  .replace(/\s+/g, ' ')
  .trim();
const normalize = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const browserHeaders = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'cache-control': 'no-cache',
  pragma: 'no-cache',
  'upgrade-insecure-requests': '1',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
};

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function headingFrom(html = '') {
  return clean(String(html).match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');
}

function canonicalTitle(value = '') {
  return normalize(value)
    .replace(/\b(?:day|night|overnight|weekend)\s+shift(?:\s+\d+)?\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleMatches(expected = '', actual = '') {
  const a = canonicalTitle(expected);
  const b = canonicalTitle(actual);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function requiredExperienceText(text = '') {
  const value = clean(text);
  const preferred = value.search(/\b(?:preferred qualifications?|preferred experience|preferred skills?|nice to have|bonus qualifications?)\b/i);
  return preferred >= 0 ? value.slice(0, preferred) : value;
}

function statedExperienceYears(text = '') {
  const normalized = clean(text).toLowerCase()
    .replace(/\bzero\b/g, '0').replace(/\bone\b/g, '1').replace(/\btwo\b/g, '2')
    .replace(/\bthree\b/g, '3').replace(/\bfour\b/g, '4').replace(/\bfive\b/g, '5')
    .replace(/\bsix\b/g, '6').replace(/\bseven\b/g, '7').replace(/\beight\b/g, '8')
    .replace(/\bnine\b/g, '9').replace(/\bten\b/g, '10');
  const years = [];
  const patterns = [
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\s+years?(?:\s+of)?(?:\s+[a-z/&+().,'’\-]+){0,8}\s+experience\b/gi,
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?(?:\s+of)?(?:\s+[a-z/&+().,'’\-]+){0,8}\s+experience\b/gi,
    /(?:experience|related experience)(?:\s+of)?\s+(?:at least\s+|minimum(?: of)?\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?\b/gi
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      years.push(Number(match[1]));
      if (match[2]) years.push(Number(match[2]));
    }
  }
  return years.filter(value => Number.isFinite(value) && value >= 0 && value <= 50);
}

function inactivePage(text = '') {
  return /\b(?:job|position|opportunity)\s+(?:is\s+)?(?:no longer available|closed|filled)\b|\bjob not found\b|\bthis job has expired\b/i.test(clean(text));
}

function missionFitEvidence(job, html) {
  const heading = headingFrom(html);
  const text = clean(html);
  if (!heading || !titleMatches(job?.title, heading)) return { ok: false, reason: `title mismatch (${heading || 'missing h1'})` };
  if (inactivePage(text)) return { ok: false, reason: 'official page is inactive' };

  const required = requiredExperienceText(text);
  const years = statedExperienceYears(required);
  const explicitProgram = /\b(?:intern(?:ship)?|skillbridge|apprentice(?:ship)?|trainee)\b/i.test(`${job?.title || ''} ${heading}`);
  if (years.some(year => year > 5)) return { ok: false, reason: `required experience exceeds five years (${Math.max(...years)})` };
  if (!explicitProgram && !years.length) return { ok: false, reason: 'required experience could not be re-verified' };
  return { ok: true, heading, years };
}

function officialDetailUrl(value = '') {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'jobs.coresite.com'
      && /^\/jobs\/\d+(?:-[^/?#]+)?\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

async function fetchDetail(url) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: attempt === 1 ? browserHeaders : { ...browserHeaders, referer: 'https://jobs.coresite.com/' },
        redirect: 'follow',
        signal: controller.signal
      });
      if (!response.ok) {
        const error = new Error(`${response.status} ${url}`);
        error.status = response.status;
        throw error;
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      const retryable = error?.name === 'AbortError' || error?.status === 429 || Number(error?.status) >= 500;
      if (!retryable || attempt === 2) break;
      await sleep(1200 * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error(`Unable to fetch ${url}`);
}

async function verifyJob(job) {
  if (!job || job.company !== COMPANY || !officialDetailUrl(job.sourceUrl)) {
    return { job, ok: false, reason: 'invalid employer-direct CoreSite record' };
  }
  try {
    const html = await fetchDetail(job.sourceUrl);
    const evidence = missionFitEvidence(job, html);
    return { job, ...evidence };
  } catch (error) {
    return { job, ok: false, reason: error?.name === 'AbortError' ? 'request timed out' : error.message };
  }
}

function shouldRefresh(total, successes) {
  if (!total || !successes) return false;
  return successes / total >= MIN_REFRESH_RATIO;
}

function runSelfTest() {
  const job = {
    title: 'Critical Operations Engineer I (Night)',
    company: COMPANY,
    sourceUrl: 'https://jobs.coresite.com/jobs/12345-critical-operations-engineer-i-night'
  };
  const good = '<html><h1>Critical Operations Engineer I (Night)</h1><p>Minimum of 3 years of related experience.</p><h2>Preferred Qualifications</h2><p>7 years of experience preferred.</p></html>';
  const tooSenior = '<html><h1>Critical Operations Engineer I (Night)</h1><p>Minimum of 7 years of related experience.</p></html>';
  const closed = '<html><h1>Critical Operations Engineer I (Night)</h1><p>This job is no longer available.</p><p>3 years of related experience.</p></html>';
  const wrong = '<html><h1>Senior Facility Manager</h1><p>3 years of related experience.</p></html>';
  const skillbridge = '<html><h1>SkillBridge Data Center Operations Technician Internship</h1><p>Active-duty military transition program.</p></html>';

  if (!missionFitEvidence(job, good).ok) throw new Error('Expected valid <=5-year CoreSite role to pass direct-detail verification.');
  if (missionFitEvidence(job, tooSenior).ok) throw new Error('Expected >5-year CoreSite role to fail direct-detail verification.');
  if (missionFitEvidence(job, closed).ok) throw new Error('Expected closed CoreSite role to fail direct-detail verification.');
  if (missionFitEvidence(job, wrong).ok) throw new Error('Expected title mismatch to fail direct-detail verification.');
  if (!missionFitEvidence({ ...job, title: 'SkillBridge Data Center Operations Technician Internship' }, skillbridge).ok) {
    throw new Error('Expected explicit SkillBridge program to remain eligible without a numeric experience statement.');
  }
  if (!shouldRefresh(10, 6) || shouldRefresh(10, 5) || shouldRefresh(10, 0)) throw new Error('CoreSite refresh quorum regression failed.');
  if (!officialDetailUrl(job.sourceUrl) || officialDetailUrl('https://example.com/jobs/12345')) throw new Error('CoreSite official-detail URL regression failed.');
  console.log('CoreSite direct-detail re-verification regression tests passed.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

const [fallback, status] = await Promise.all([readJson(FALLBACK_PATH), readJson(STATUS_PATH)]);
if (!fallback || !Array.isArray(fallback.jobs) || !fallback.jobs.length) throw new Error('CoreSite verified fallback must contain at least one role.');
if (status?.coreSite?.sourceHealthy === true) {
  console.log('CoreSite direct listing source is healthy; fallback re-verification is not needed.');
  process.exit(0);
}

const results = [];
for (let index = 0; index < fallback.jobs.length; index += BATCH_SIZE) {
  const batch = fallback.jobs.slice(index, index + BATCH_SIZE);
  results.push(...await Promise.all(batch.map(verifyJob)));
}

const verified = results.filter(result => result.ok).map(result => result.job);
const failed = results.filter(result => !result.ok);
const ratio = fallback.jobs.length ? verified.length / fallback.jobs.length : 0;
for (const result of failed.slice(0, 12)) {
  console.warn(`CoreSite re-verification skipped ${result.job?.id || result.job?.title || '(unknown role)'}: ${result.reason}`);
}

if (!shouldRefresh(fallback.jobs.length, verified.length)) {
  console.warn(`CoreSite direct-detail re-verification reached only ${verified.length}/${fallback.jobs.length} roles (${Math.round(ratio * 100)}%); required ${Math.round(MIN_REFRESH_RATIO * 100)}%. Existing fallback timestamps were not renewed.`);
  process.exit(0);
}

const verifiedAt = new Date();
const expiresAt = new Date(verifiedAt.getTime() + MAX_AGE_HOURS * 60 * 60 * 1000);
const next = {
  ...fallback,
  verifiedAt: verifiedAt.toISOString(),
  expiresAt: expiresAt.toISOString(),
  officialSource: 'https://jobs.coresite.com/search/data-center-operations/jobs/in',
  reason: 'CoreSite listing access is blocked from GitHub-hosted collectors; retained roles were individually re-verified against their official CoreSite job-detail pages.',
  jobs: verified,
  reverification: {
    method: 'official-detail-pages',
    checkedAt: verifiedAt.toISOString(),
    attempted: fallback.jobs.length,
    verified: verified.length,
    rejectedOrUnreachable: failed.length,
    minimumRefreshRatio: MIN_REFRESH_RATIO,
    expiresAfterHours: MAX_AGE_HOURS
  }
};
await writeFile(FALLBACK_PATH, JSON.stringify(next, null, 2) + '\n');
console.log(`CoreSite fallback re-verified ${verified.length}/${fallback.jobs.length} employer-direct roles; verification valid through ${next.expiresAt}.`);
