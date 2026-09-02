import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const COMPANY = 'CoreSite';
const ORIGIN = 'https://jobs.coresite.com';
const LISTING_PATH = '/search/data-center-operations/jobs/in';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const MAX_PAGES = 5;
const BATCH_SIZE = 6;

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
const lower = value => clean(value).toLowerCase();
const normalize = value => lower(value).replace(/[^a-z0-9]+/g, ' ').trim();
const allowedTitle = /\b(?:data center(?: operations)? technician|critical operations engineer)\b/i;
const excludedTitle = /\b(?:senior|sr\.?|lead|principal|manager|director|vice president|vp|head of|staff|supervisor|program manager|project manager|architect)\b/i;

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

async function committedJobs() {
  try {
    const { stdout } = await exec('git', ['show', `HEAD:${JOBS_PATH}`], { maxBuffer: 30 * 1024 * 1024 });
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

const browserHeaders = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'cache-control': 'no-cache',
  pragma: 'no-cache',
  'upgrade-insecure-requests': '1',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
};

async function fetchText(url) {
  const attempts = [
    browserHeaders,
    { ...browserHeaders, referer: `${ORIGIN}/`, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
  ];
  let lastError = null;
  for (const headers of attempts) {
    try {
      const response = await fetch(url, { headers, redirect: 'follow' });
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      return await response.text();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`Unable to fetch ${url}`);
}

function canonicalUrl(value) {
  try {
    const parsed = new URL(String(value || ''), ORIGIN);
    if (parsed.hostname.toLowerCase() !== 'jobs.coresite.com') return '';
    const match = parsed.pathname.match(/^\/jobs\/(\d+)(?:-[^/?#]+)?\/?$/i);
    if (!match) return '';
    return `${ORIGIN}${parsed.pathname.replace(/\/$/, '')}`;
  } catch { return ''; }
}

function listingRows(html) {
  const rows = [];
  const seen = new Set();
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']*\/jobs\/(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = canonicalUrl(match[1]);
    const id = match[2];
    const title = clean(match[3]).replace(/\s+NEW\s*$/i, '').trim();
    if (!url || !id || !title || seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, title, url });
  }
  return rows;
}

function listingTotal(html) {
  const text = clean(html);
  const match = text.match(/Showing\s+\d+\s*-\s*\d+\s+of\s+(\d+)\s+results?/i)
    || text.match(/Showing\s+\d+\s+of\s+(\d+)\s+results?/i);
  return match ? Number(match[1]) : null;
}

function pageHeading(html) {
  return clean(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');
}

function locationFrom(text) {
  const value = clean(text);
  const match = value.match(/\bLocation:\s*(.+?)(?=\s+(?:Salary Range:|Anticipated Close Date:|Work Schedule:|Shift:|Description\b))/i);
  return clean(match?.[1] || '').replace(/,?\s*United States\s*$/i, '').trim();
}

function yearsFrom(text) {
  const values = [];
  const patterns = [
    /\b(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\s+years?(?:\s+of)?(?:\s+[A-Za-z/&+().,'’\-]+){0,8}\s+experience\b/gi,
    /\b(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\+?\s+years?(?:\s+of)?(?:\s+[A-Za-z/&+().,'’\-]+){0,8}\s+experience\b/gi,
    /\b(?:experience|related experience)(?:\s+of)?\s+(?:at least\s+|minimum(?: of)?\s+)?(\d{1,2})\+?\s+years?\b/gi
  ];
  for (const pattern of patterns) {
    for (const match of String(text || '').matchAll(pattern)) {
      values.push(Number(match[1]));
      if (match[2]) values.push(Number(match[2]));
    }
  }
  const years = values.filter(value => Number.isFinite(value) && value >= 0);
  return years.length ? { min: Math.min(...years), max: Math.max(...years) } : null;
}

function classify(title, text) {
  if (!allowedTitle.test(title) || excludedTitle.test(title)) return { cls: null, reason: 'title' };
  const years = yearsFrom(text);
  if (!years) return { cls: null, reason: 'experience-unknown' };
  if (years.min > 5 || years.max > 5) return { cls: null, reason: 'experience-over-5' };

  let type = 'entry-level';
  if (/intern(?:ship)?/i.test(title)) type = 'internship';
  else if (/apprentice/i.test(title)) type = 'apprenticeship';
  else if (/trainee|skillbridge/i.test(title)) type = 'trainee';
  return { cls: { type, experience: years.min >= 3 ? '2-5-years' : '0-2-years' }, reason: '' };
}

function payFrom(text) {
  const value = clean(text);
  const match = value.match(/Salary Range:\s*\$([\d,.]+)\s*(?:-|–|—|to)\s*\$?([\d,.]+)/i);
  if (!match) return { pay: 'Pay not listed', salaryMin: null, salaryMax: null, salarySortMax: null };
  const min = Number(match[1].replace(/,/g, ''));
  const max = Number(match[2].replace(/,/g, ''));
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { pay: 'Pay not listed', salaryMin: null, salaryMax: null, salarySortMax: null };
  const hourly = max < 1000;
  return {
    pay: `$${min.toLocaleString('en-US')}–$${max.toLocaleString('en-US')} / ${hourly ? 'hr' : 'year'}`,
    salaryMin: min,
    salaryMax: max,
    salarySortMax: hourly ? Math.round(max * 2080) : max
  };
}

function tagsFor(title, cls, text) {
  const value = lower(`${title} ${text}`);
  const tags = [];
  if (cls.type === 'internship') tags.push('Internship');
  if (cls.type === 'apprenticeship') tags.push('Apprenticeship');
  if (cls.type === 'trainee') tags.push('Trainee');
  tags.push(cls.experience === '2-5-years' ? '2–5 Years' : '0–2 Years');
  if (/skillbridge|qualification program|training|mentoring/.test(value)) tags.push('Training / Mentorship');
  if (/electrical|ups|generator|switchgear|pdu/.test(value)) tags.push('Electrical');
  if (/mechanical|hvac|cooling|chiller|critical operations|critical facilit/.test(value)) tags.push('Critical Facilities');
  if (/rack and stack|fiber|copper cabling|remote hands|data center operations/.test(value)) tags.push('Data Center Operations');
  return [...new Set(tags)].slice(0, 5);
}

function parseDetail(html, seed) {
  const text = clean(html);
  const title = pageHeading(html) || seed.title;
  const location = locationFrom(text);
  if (!location) return { job: null, reason: 'location' };
  const { cls, reason } = classify(title, text);
  if (!cls) return { job: null, reason };
  return {
    job: {
      id: `coresite-${seed.id}`,
      title: clean(title),
      company: COMPANY,
      location,
      type: cls.type,
      experience: cls.experience,
      tags: tagsFor(title, cls, text),
      ...payFrom(text),
      postedAt: null,
      postedHours: 9999,
      source: 'CoreSite Careers',
      sourceUrl: seed.url,
      active: true,
      demo: false
    },
    reason: ''
  };
}

function dedupe(jobs) {
  const ids = new Set();
  const urls = new Set();
  const identities = new Set();
  const out = [];
  for (const job of jobs) {
    if (!job || typeof job !== 'object') continue;
    const id = String(job.id || '');
    const url = String(job.sourceUrl || '');
    const identity = [job.company, job.title, job.location].map(normalize).join('|');
    if ((id && ids.has(id)) || (url && urls.has(url)) || identities.has(identity)) continue;
    if (id) ids.add(id);
    if (url) urls.add(url);
    identities.add(identity);
    out.push(job);
  }
  return out;
}

const currentJobs = await readJson(JOBS_PATH, []);
const previousJobs = await committedJobs();
const previousSnapshot = previousJobs.filter(job => job.company === COMPANY || /(^|\.)jobs\.coresite\.com\//i.test(String(job.sourceUrl || '')));
const previousById = new Map(previousSnapshot.map(job => [String(job.id || '').replace(/^coresite-/, ''), job]));
const status = await readJson(STATUS_PATH, {});
const errors = [];
const diagnostics = {
  listingPagesAttempted: 0,
  listingPagesSucceeded: 0,
  listingComplete: false,
  listedTotal: null,
  candidateRows: 0,
  detailAttempted: 0,
  detailSucceeded: 0,
  preservedOnFailure: 0,
  drops: { title: 0, location: 0, experienceUnknown: 0, experienceOver5: 0, fetch: 0 }
};

const seeds = new Map();
let listingFailed = false;
let reachedEnd = false;
for (let page = 1; page <= MAX_PAGES; page += 1) {
  diagnostics.listingPagesAttempted += 1;
  const url = `${ORIGIN}${LISTING_PATH}${page === 1 ? '' : `?page=${page}`}`;
  try {
    const html = await fetchText(url);
    diagnostics.listingPagesSucceeded += 1;
    const total = listingTotal(html);
    if (Number.isFinite(total)) diagnostics.listedTotal = total;
    const rows = listingRows(html);
    let added = 0;
    for (const row of rows) {
      if (!seeds.has(row.id)) { seeds.set(row.id, row); added += 1; }
    }
    if (diagnostics.listedTotal && seeds.size >= diagnostics.listedTotal) { reachedEnd = true; break; }
    if (page > 1 && added === 0) { reachedEnd = true; break; }
  } catch (error) {
    listingFailed = true;
    errors.push(`listing page ${page}: ${error.message}`);
    break;
  }
}

diagnostics.candidateRows = seeds.size;
diagnostics.listingComplete = !listingFailed && reachedEnd && seeds.size > 0;
const sourceHealthy = diagnostics.listingPagesSucceeded > 0 && seeds.size > 0;
const verified = [];

const detailSeeds = [...seeds.values()];
for (let i = 0; i < detailSeeds.length; i += BATCH_SIZE) {
  const batch = detailSeeds.slice(i, i + BATCH_SIZE);
  const results = await Promise.all(batch.map(async seed => {
    diagnostics.detailAttempted += 1;
    try {
      const html = await fetchText(seed.url);
      diagnostics.detailSucceeded += 1;
      const parsed = parseDetail(html, seed);
      if (parsed.job) return parsed.job;
      if (parsed.reason === 'title') diagnostics.drops.title += 1;
      else if (parsed.reason === 'location') diagnostics.drops.location += 1;
      else if (parsed.reason === 'experience-over-5') diagnostics.drops.experienceOver5 += 1;
      else if (parsed.reason === 'experience-unknown') diagnostics.drops.experienceUnknown += 1;

      const previous = previousById.get(seed.id);
      if (previous && parsed.reason !== 'title' && parsed.reason !== 'experience-over-5') {
        diagnostics.preservedOnFailure += 1;
        return { ...previous, active: true, demo: false };
      }
      return null;
    } catch (error) {
      diagnostics.drops.fetch += 1;
      if (errors.length < 30) errors.push(`detail ${seed.id}: ${error.message}`);
      const previous = previousById.get(seed.id);
      if (previous) {
        diagnostics.preservedOnFailure += 1;
        return { ...previous, active: true, demo: false };
      }
      return null;
    }
  }));
  verified.push(...results.filter(Boolean));
}

let nextSnapshot;
if (!sourceHealthy) {
  nextSnapshot = previousSnapshot;
} else if (!diagnostics.listingComplete) {
  nextSnapshot = dedupe([...verified, ...previousSnapshot]);
} else {
  nextSnapshot = dedupe(verified);
}

const withoutCoreSite = currentJobs.filter(job => job.company !== COMPANY && !/(^|\.)jobs\.coresite\.com\//i.test(String(job.sourceUrl || '')));
const merged = dedupe([...withoutCoreSite, ...nextSnapshot]);
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
    officialSource: `${ORIGIN}${LISTING_PATH}`,
    sourceHealthy,
    qualifyingRoles: nextSnapshot.length,
    diagnostics,
    errors
  },
  errors: [
    ...(status.errors || []).filter(error => !String(error).startsWith('CoreSite Careers:')),
    ...errors.map(error => `CoreSite Careers: ${error}`)
  ]
}, null, 2) + '\n');

console.log(`CoreSite: ${nextSnapshot.length} qualifying roles; ${diagnostics.candidateRows} listed; source ${sourceHealthy ? (diagnostics.listingComplete ? 'healthy/complete' : 'healthy/partial') : 'unavailable'}; preserved ${diagnostics.preservedOnFailure}.`);
