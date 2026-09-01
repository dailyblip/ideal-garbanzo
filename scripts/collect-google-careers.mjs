import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const COMPANY = 'Google';
const SNAPSHOT_PATH = 'data/google-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const SEARCH_BASE = 'https://www.google.com/about/careers/applications/jobs/results/';
const SEARCH_PAGES = 8;

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
const hash = value => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 14);

const relevantTitlePattern = /(?:data center|data centre).*(?:technician|facilities|operations|engineer)|(?:facilities technician developmental program)/i;
const excludedTitlePattern = /\b(?:senior|sr\.?|lead|principal|chief|manager|mgr\.?|director|vice president|vp|head of|staff engineer|supervisor|architect|program manager|product manager|security manager)\b/i;
const usLocationPattern = /([A-Z][A-Za-z.'’()\- ]{1,80},\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)(?:\s+\d{5}(?:-\d{4})?)?,\s*USA\b)/i;

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': 'DataCenterCareersBot/1.6 (+https://dailyblip.github.io/ideal-garbanzo/)'
    },
    redirect: 'follow'
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

function canonicalResultUrl(href) {
  const raw = clean(href);
  if (!raw) return null;

  try {
    const parsed = new URL(raw, SEARCH_BASE);
    if (parsed.hostname !== 'www.google.com') return null;
  } catch {
    return null;
  }

  // Google Careers currently emits relative result hrefs such as
  // "jobs/results/<id>-<slug>" from a page whose own path already ends in
  // /jobs/results/. Resolving those hrefs literally duplicates the path
  // (…/jobs/results/jobs/results/…) even though the browser app routes them
  // to the canonical result URL. Extract the result identity from the raw
  // href instead of trusting normal URL resolution.
  const match = raw.match(/(?:^|\/)(?:about\/careers\/applications\/)?jobs\/results\/(\d+)-([^/?#]+)/i)
    || raw.match(/^\/?(\d+)-([^/?#]+)/i);
  if (!match) return null;

  return {
    id: match[1],
    url: `${SEARCH_BASE}${match[1]}-${match[2]}`
  };
}

function extractResultLinks(html) {
  const rows = [];
  const seen = new Set();
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const result = canonicalResultUrl(match[1]);
    if (!result || seen.has(result.id)) continue;

    const label = clean(match[2]);
    const nearby = clean(html.slice(match.index, Math.min(html.length, match.index + 1400)));
    const locationMatch = label.match(usLocationPattern) || nearby.match(usLocationPattern);
    const location = clean(locationMatch?.[1] || '');
    if (!location) continue;

    let title = label;
    const labelLocation = label.match(usLocationPattern)?.[1];
    if (labelLocation) title = clean(label.slice(0, label.indexOf(labelLocation)));
    if (!title || title.length > 180 || !relevantTitlePattern.test(title) || excludedTitlePattern.test(title)) continue;

    seen.add(result.id);
    rows.push({ id: result.id, title, location, sourceUrl: result.url });
  }
  return rows;
}

function classify(title) {
  const t = lower(title);
  let type = 'entry-level';
  if (/developmental program|trainee/.test(t)) type = 'trainee';
  else if (/intern/.test(t)) type = 'internship';
  else if (/apprentice/.test(t)) type = 'apprenticeship';

  const levelTwoPlus = /\b(?:ii|iii|2|3)\b/.test(t);
  const experience = levelTwoPlus ? '2-5-years' : '0-2-years';
  return { type, experience };
}

function tagsFor(title, experience, type) {
  const t = lower(title);
  const tags = [];
  if (type === 'trainee') tags.push('Trainee');
  if (type === 'internship') tags.push('Internship');
  if (type === 'apprenticeship') tags.push('Apprenticeship');
  tags.push(experience === '2-5-years' ? '2–5 Years' : '0–2 Years');
  if (/electrical|generator|ups|switchgear/.test(t)) tags.push('Electrical');
  if (/mechanical|facilities|controls|generator|hvac|cooling/.test(t)) tags.push('Critical Facilities');
  if (/network|networking|server|operations/.test(t)) tags.push('Data Center Operations');
  return [...new Set(tags)].slice(0, 5);
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
const previousSnapshot = await readJson(SNAPSHOT_PATH, []);
const priorStatus = await readJson(STATUS_PATH, {});
const errors = [];
const rawResults = [];
let pagesAttempted = 0;
let pagesSucceeded = 0;
let sourceHealthy = true;

for (let page = 1; page <= SEARCH_PAGES; page += 1) {
  const url = new URL(SEARCH_BASE);
  url.searchParams.set('q', 'data center');
  url.searchParams.set('location', 'United States');
  url.searchParams.set('target_level', 'EARLY');
  url.searchParams.set('page', String(page));
  pagesAttempted += 1;
  try {
    const html = await fetchText(url.href);
    pagesSucceeded += 1;
    const results = extractResultLinks(html);
    if (!results.length && page === 1) {
      sourceHealthy = false;
      errors.push('Google Careers returned no parseable early-career data-center results on page 1.');
      break;
    }
    rawResults.push(...results);
    if (!results.length) break;
  } catch (error) {
    errors.push(`page ${page}: ${error.message}`);
    if (page === 1) sourceHealthy = false;
    break;
  }
}

let snapshot;
if (!sourceHealthy || !pagesSucceeded) {
  snapshot = previousSnapshot;
  if (previousSnapshot.length) errors.push('Retained previous Google snapshot because the official source was unavailable or unparseable.');
} else {
  snapshot = dedupe(rawResults.map(row => {
    const cls = classify(row.title);
    return {
      id: `google-${row.id || hash(row.sourceUrl)}`,
      title: row.title,
      company: COMPANY,
      location: row.location,
      type: cls.type,
      experience: cls.experience,
      tags: tagsFor(row.title, cls.experience, cls.type),
      pay: 'Pay not listed',
      salaryMin: null,
      salaryMax: null,
      salarySortMax: null,
      postedAt: null,
      source: 'Google Careers',
      sourceUrl: row.sourceUrl,
      active: true,
      demo: false
    };
  }));
}

if (!sourceHealthy && !snapshot.length) {
  throw new Error(`Google Careers collector failed and no prior snapshot exists: ${errors.join(' | ')}`);
}

const withoutGoogle = currentJobs.filter(job => job.company !== COMPANY && !/^https:\/\/www\.google\.com\/about\/careers\/applications\/jobs\/results\//i.test(String(job.sourceUrl || '')));
const merged = dedupe([...withoutGoogle, ...snapshot]);
const now = Date.now();
for (const job of merged) {
  job.postedHours = job.postedAt ? Math.max(0, Math.round((now - new Date(job.postedAt).getTime()) / 36e5)) : (job.postedHours ?? 9999);
}

const countsByType = merged.reduce((acc, job) => { acc[job.type] = (acc[job.type] || 0) + 1; return acc; }, {});
const countsByExperience = merged.reduce((acc, job) => { acc[job.experience] = (acc[job.experience] || 0) + 1; return acc; }, {});

await writeFile(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n');
await writeFile(JOBS_PATH, JSON.stringify(merged, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify({
  ...priorStatus,
  updatedAt: new Date().toISOString(),
  jobs: merged.length,
  sourcesAttempted: Number(priorStatus.sourcesAttempted || 0) + 1,
  providers: {
    ...(priorStatus.providers || {}),
    googleCareers: Number(priorStatus.providers?.googleCareers || 0) + 1
  },
  countsByType,
  countsByExperience,
  googleCareers: {
    officialSource: SEARCH_BASE,
    sourceHealthy,
    pagesAttempted,
    pagesSucceeded,
    candidateRows: rawResults.length,
    qualifyingRoles: snapshot.length,
    errors
  },
  errors: [...(priorStatus.errors || []), ...errors.map(error => `Google Careers: ${error}`)]
}, null, 2) + '\n');

console.log(`Google Careers ${sourceHealthy ? 'succeeded' : 'used prior snapshot'}; ${snapshot.length} qualifying early-career U.S. data-center roles; ${merged.length} total jobs.`);
if (errors.length) console.warn(`Google Careers warnings: ${errors.join(' | ')}`);
