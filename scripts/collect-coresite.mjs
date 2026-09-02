import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const COMPANY = 'CoreSite';
const SEARCH_ORIGIN = 'https://jobs.coresite.com';
const SEARCH_PATH = '/search/data-center-operations/jobs/in';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const MAX_PAGES = 6;
const DETAIL_BATCH_SIZE = 6;

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
const normalizeIdentity = value => lower(value).replace(/[^a-z0-9]+/g, ' ').trim();

const allowedTitle = /\b(?:data center(?: operations)? technician|critical operations engineer)\b/i;
const excludedTitle = /\b(?:senior|sr\.?|lead|principal|manager|director|vice president|vp|head of|staff|supervisor|program manager|project manager|architect)\b/i;
const earlyProgram = /\b(?:skillbridge|intern(?:ship)?|apprentice|trainee)\b/i;

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

async function readCommittedJobs() {
  try {
    const { stdout } = await exec('git', ['show', `HEAD:${JOBS_PATH}`], { maxBuffer: 30 * 1024 * 1024 });
    const jobs = JSON.parse(stdout);
    return Array.isArray(jobs) ? jobs : [];
  } catch {
    return [];
  }
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': 'DataCenterCareersBot/1.2 (+https://datacentercareers.us/)'
    },
    redirect: 'follow'
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

function canonicalJobUrl(value) {
  try {
    const parsed = new URL(String(value || ''), SEARCH_ORIGIN);
    if (parsed.hostname !== 'jobs.coresite.com') return '';
    const match = parsed.pathname.match(/^\/jobs\/(\d+)(?:-[^/?#]+)?\/?$/i);
    if (!match) return '';
    return `${SEARCH_ORIGIN}${parsed.pathname.replace(/\/$/, '')}`;
  } catch {
    return '';
  }
}

function parseListingCandidates(html) {
  const rows = [];
  const seen = new Set();
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']*\/jobs\/(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = canonicalJobUrl(match[1]);
    const id = match[2];
    const title = clean(match[3]).replace(/\s+NEW\s*$/i, '').trim();
    if (!url || !id || !title || seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, title, url });
  }
  return rows;
}

function listedTotal(html) {
  const text = clean(html);
  const match = text.match(/Showing\s+\d+\s*-\s*\d+\s+of\s+(\d+)\s+results?/i)
    || text.match(/Showing\s+\d+\s+of\s+(\d+)\s+results?/i);
  return match ? Number(match[1]) : null;
}

function heading(html) {
  const match = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  return clean(match?.[1] || '');
}

function parseLocation(pageText) {
  const text = clean(pageText);
  const bounded = text.match(/\bLocation:\s*(.+?)(?=\s+(?:Salary Range:|Work Schedule:|Shift:|Description\b))/i)?.[1] || '';
  const location = clean(bounded).replace(/,?\s*United States\s*$/i, '').trim();
  if (location) return location;
  return clean(text.match(/\b([A-Z][A-Za-z.'’ -]{1,60},\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|D\.C\.))\b/)?.[1] || '');
}

function experienceRange(text) {
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
  if (!years.length) return null;
  return { min: Math.min(...years), max: Math.max(...years) };
}

function classify(title, text) {
  if (!allowedTitle.test(title) || excludedTitle.test(title)) return { cls: null, reason: 'title' };

  const program = earlyProgram.test(title);
  let type = 'entry-level';
  if (/intern(?:ship)?/i.test(title)) type = 'internship';
  else if (/apprentice/i.test(title)) type = 'apprenticeship';
  else if (/trainee|skillbridge/i.test(title)) type = 'trainee';

  const years = experienceRange(text);
  if (!years) {
    if (!program) return { cls: null, reason: 'experience-unknown' };
    return { cls: { type, experience: '0-2-years', minYears: null, maxYears: null }, reason: '' };
  }
  if (years.min > 5 || years.max > 5) return { cls: null, reason: 'experience-over-5' };

  return {
    cls: {
      type,
      experience: years.min >= 3 ? '2-5-years' : '0-2-years',
      minYears: years.min,
      maxYears: years.max
    },
    reason: ''
  };
}

function parsePay(text) {
  const value = clean(text);
  const explicit = value.match(/Salary Range:\s*\$([\d,.]+)\s*(?:-|–|—|to)\s*\$?([\d,.]+)/i)
    || value.match(/base (?:salary|pay)[^$]{0,80}\$([\d,.]+)\s*(?:\/\s*(?:hr|hour))?\s*(?:-|–|—|to|and)\s*\$?([\d,.]+)(?:\s*\/\s*(?:hr|hour))?/i)
    || value.match(/\$([\d,.]+)\s*\/\s*(?:hr|hour)[^$]{0,40}(?:-|–|—|to|and)\s*\$?([\d,.]+)\s*\/\s*(?:hr|hour)/i);
  if (!explicit) return { pay: 'Pay not listed', salaryMin: null, salaryMax: null, salarySortMax: null };
  const min = Number(explicit[1].replace(/,/g, ''));
  const max = Number(explicit[2].replace(/,/g, ''));
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= 0) {
    return { pay: 'Pay not listed', salaryMin: null, salaryMax: null, salarySortMax: null };
  }
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
  const title = clean(heading(html) || seed.title);
  const location = parseLocation(text);
  if (!location) return { job: null, reason: 'location' };
  const { cls, reason } = classify(title, text);
  if (!cls) return { job: null, reason };
  return {
    job: {
      id: `coresite-${seed.id}`,
      title,
      company: COMPANY,
      location,
      type: cls.type,
      experience: cls.experience,
      tags: tagsFor(title, cls, text),
      ...parsePay(text),
      postedAt: null,
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
    const id = String(job.id || '');
    const url = String(job.sourceUrl || '');
    const identity = [job.company, job.title, job.location].map(normalizeIdentity).join('|');
    if ((id && ids.has(id)) || (url && urls.has(url)) || identities.has(identity)) continue;
    if (id) ids.add(id);
    if (url) urls.add(url);
    identities.add(identity);
    out.push(job);
  }
  return out;
}

const currentJobs = await readJson(JOBS_PATH, []);
const committedJobs = await readCommittedJobs();
const previousSnapshot = committedJobs.filter(job => job.company === COMPANY || /(^|\.)jobs\.coresite\.com\//i.test(String(job.sourceUrl || '')));
const priorStatus = await readJson(STATUS_PATH, {});
const previousById = new Map(previousSnapshot.map(job => [String(job.id || '').replace(/^coresite-/, ''), job]));
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
  const url = `${SEARCH_ORIGIN}${SEARCH_PATH}${page === 1 ? '' : `?page=${page}`}`;
  try {
    const html = await fetchText(url);
    diagnostics.listingPagesSucceeded += 1;
    const total = listedTotal(html);
    if (Number.isFinite(total)) diagnostics.listedTotal = total;
    const rows = parseListingCandidates(html);
    let added = 0;
    for (const row of rows) {
      if (!seeds.has(row.id)) {
        seeds.set(row.id, row);
        added += 1;
      }
    }
    if (diagnostics.listedTotal && seeds.size >= diagnostics.listedTotal) {
      reachedEnd = true;
      break;
    }
    if (page > 1 && added === 0) {
      reachedEnd = true;
      break;
    }
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
for (let i = 0; i < detailSeeds.length; i += DETAIL_BATCH_SIZE) {
  const batch = detailSeeds.slice(i, i + DETAIL_BATCH_SIZE);
  const settled = await Promise.all(batch.map(async seed => {
    diagnostics.detailAttempted += 1;
    try {
      const html = await fetchText(seed.url);
      diagnostics.detailSucceeded += 1;
      const parsed = parseDetail(html, seed);
      if (parsed.job) return parsed.job;

      if (parsed.reason === 'title') diagnostics.drops.title += 1;
      else if (parsed.reason === 'location') diagnostics.drops.location += 1;
      else if (parsed.reason === 'experience-over-5') diagnostics.drops.experienceOver5 += 1;
      else if (parsed.reason === 'experience-unknown') {
        diagnostics.drops.experienceUnknown += 1;
        const previous = previousById.get(seed.id);
        if (previous) {
          diagnostics.preservedOnFailure += 1;
          return { ...previous, active: true, demo: false };
        }
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
  verified.push(...settled.filter(Boolean));
}

let snapshot;
if (!sourceHealthy) {
  snapshot = previousSnapshot;
  if (previousSnapshot.length) errors.push('Retained previous CoreSite roles because the official listing source could not be verified.');
} else if (diagnostics.listingComplete) {
  const activeIds = new Set(seeds.keys());
  snapshot = dedupe(verified).filter(job => activeIds.has(String(job.id).replace(/^coresite-/, '')));
} else {
  snapshot = dedupe([...previousSnapshot, ...verified]);
  if (previousSnapshot.length) errors.push('Retained prior CoreSite roles because the official listing scan was incomplete.');
}

const withoutCoreSite = currentJobs.filter(job => job.company !== COMPANY && !/(^|\.)jobs\.coresite\.com\//i.test(String(job.sourceUrl || '')));
const merged = dedupe([...withoutCoreSite, ...snapshot]);
const now = Date.now();
for (const job of merged) {
  job.postedHours = job.postedAt ? Math.max(0, Math.round((now - new Date(job.postedAt).getTime()) / 36e5)) : (job.postedHours ?? 9999);
}

const countsByType = merged.reduce((acc, job) => { acc[job.type] = (acc[job.type] || 0) + 1; return acc; }, {});
const countsByExperience = merged.reduce((acc, job) => { acc[job.experience] = (acc[job.experience] || 0) + 1; return acc; }, {});
const cleanGlobalErrors = (priorStatus.errors || []).filter(error => !String(error).startsWith('CoreSite Careers:'));

await writeFile(JOBS_PATH, JSON.stringify(merged, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify({
  ...priorStatus,
  updatedAt: new Date().toISOString(),
  jobs: merged.length,
  countsByType,
  countsByExperience,
  coreSite: {
    officialSource: `${SEARCH_ORIGIN}${SEARCH_PATH}`,
    sourceHealthy,
    qualifyingRoles: snapshot.length,
    diagnostics,
    errors
  },
  errors: [...cleanGlobalErrors, ...errors.map(error => `CoreSite Careers: ${error}`)]
}, null, 2) + '\n');

console.log(`CoreSite Careers ${sourceHealthy ? 'checked' : 'degraded'}; ${snapshot.length} verified U.S. 0–5 year data-center operations roles; ${merged.length} total jobs.`);
if (errors.length) console.warn(`CoreSite Careers warnings: ${errors.join(' | ')}`);
