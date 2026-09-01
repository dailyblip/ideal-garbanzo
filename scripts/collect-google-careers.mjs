import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const COMPANY = 'Google';
const SNAPSHOT_PATH = 'data/google-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const SEARCH_BASE = 'https://www.google.com/about/careers/applications/jobs/results/';
const SEARCH_PAGES = 4;
const MAX_DETAIL_CANDIDATES = 80;
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
const hash = value => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 14);

const relevantTitlePattern = /(?:data center|data centre).*(?:technician|facilities|operations|engineer)|(?:facilities technician developmental program)/i;
const excludedTitlePattern = /\b(?:senior|sr\.?|lead|principal|chief|manager|mgr\.?|director|vice president|vp|head of|staff engineer|supervisor|architect|program manager|product manager|security manager)\b/i;
const usLocationPattern = /([A-Z][A-Za-z.'’()\- ]{1,90},\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)(?:\s+\d{5}(?:-\d{4})?)?,\s*USA\b)/i;
const experienceYearsPattern = /\b(\d{1,2})\s+years?\s+(?:of\s+)?(?:[A-Za-z0-9/&+(),.'’\-]+\s+){0,8}experience\b/gi;

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': 'DataCenterCareersBot/1.8 (+https://dailyblip.github.io/ideal-garbanzo/)'
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

  const match = raw.match(/(?:^|\/)(?:about\/careers\/applications\/)?jobs\/results\/(\d+)-([^/?#]+)/i)
    || raw.match(/^\/?(\d+)-([^/?#]+)/i);
  if (!match) return null;
  return { id: match[1], slug: match[2], url: `${SEARCH_BASE}${match[1]}-${match[2]}` };
}

function titleFromSlug(slug) {
  return String(slug || '').split('-').filter(Boolean).map(word => {
    const w = word.toLowerCase();
    if (/^(?:ii|iii|iv|v)$/.test(w)) return w.toUpperCase();
    if (/^(?:hvac|ups|pdu|dcim|it|ai)$/.test(w)) return w.toUpperCase();
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}

function normalizeGoogleLocation(value) {
  return clean(value)
    .replace(/^.*?\bplace\s+/i, '')
    .replace(/\s+\d{5}(?:-\d{4})?(?=,\s*USA\b)/i, '')
    .replace(/,\s*USA\b.*$/i, '')
    .trim();
}

function extractCandidates(html, diagnostics) {
  const rows = [];
  const seen = new Set();
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const rawHref = clean(match[1]);
    const result = canonicalResultUrl(rawHref);
    if (!result || seen.has(result.id)) continue;
    diagnostics.canonicalLinks += 1;

    const label = clean(match[2]);
    const title = label || titleFromSlug(result.slug);
    if (!title || title.length > 180 || !relevantTitlePattern.test(title) || excludedTitlePattern.test(title)) continue;

    diagnostics.missionFitLinks += 1;
    seen.add(result.id);
    rows.push({ id: result.id, title, sourceUrl: result.url });
  }
  return rows;
}

function extractExperienceYears(text) {
  experienceYearsPattern.lastIndex = 0;
  return [...String(text || '').matchAll(experienceYearsPattern)]
    .map(match => Number(match[1]))
    .filter(Number.isFinite);
}

function parseMinimumQualifications(detailText) {
  const text = clean(detailText);
  const normalized = lower(text);
  const start = normalized.indexOf('minimum qualifications');
  if (start < 0) return { text: '', maxYears: null };
  const after = text.slice(start);
  const preferredIndex = lower(after).indexOf('preferred qualifications');
  const aboutIndex = lower(after).indexOf('about the job');
  const ends = [preferredIndex, aboutIndex].filter(index => index > 0);
  const end = ends.length ? Math.min(...ends) : Math.min(after.length, 5000);
  const minimumText = after.slice(0, end);
  const years = extractExperienceYears(minimumText);
  return { text: minimumText, maxYears: years.length ? Math.max(...years) : null };
}

function classify(title, minimumText, maxYears) {
  const t = lower(title);
  let type = 'entry-level';
  if (/developmental program|trainee/.test(t)) type = 'trainee';
  else if (/intern/.test(t)) type = 'internship';
  else if (/apprentice/.test(t)) type = 'apprenticeship';

  const noExperience = /developmental program|trainee|apprentice/.test(t)
    && extractExperienceYears(minimumText).length === 0;
  if (noExperience) return { type, experience: 'no-experience' };

  if (Number.isFinite(maxYears)) {
    return { type, experience: maxYears >= 3 ? '2-5-years' : '0-2-years' };
  }
  const levelTwoPlus = /\b(?:ii|iii|2|3)\b/.test(t);
  return { type, experience: levelTwoPlus ? '2-5-years' : '0-2-years' };
}

function parsePay(detailText) {
  const match = clean(detailText).match(/\bUS:\s*\$?([\d,]+)\s*-\s*\$?([\d,]+)\s*\(USD\)/i);
  if (!match) return { pay: 'Pay not listed', salaryMin: null, salaryMax: null, salarySortMax: null };
  const salaryMin = Number(match[1].replace(/,/g, ''));
  const salaryMax = Number(match[2].replace(/,/g, ''));
  if (!Number.isFinite(salaryMin) || !Number.isFinite(salaryMax)) {
    return { pay: 'Pay not listed', salaryMin: null, salaryMax: null, salarySortMax: null };
  }
  return {
    pay: `$${salaryMin.toLocaleString('en-US')}–$${salaryMax.toLocaleString('en-US')} / year`,
    salaryMin,
    salaryMax,
    salarySortMax: salaryMax
  };
}

function tagsFor(title, experience, type) {
  const t = lower(title);
  const tags = [];
  if (type === 'trainee') tags.push('Trainee');
  if (type === 'internship') tags.push('Internship');
  if (type === 'apprenticeship') tags.push('Apprenticeship');
  if (experience === 'no-experience') tags.push('No Experience Needed');
  else tags.push(experience === '2-5-years' ? '2–5 Years' : '0–2 Years');
  if (/developmental|trainee|apprentice/.test(t)) tags.push('Training / Mentorship');
  if (/electrical|generator|ups|switchgear/.test(t)) tags.push('Electrical');
  if (/mechanical|facilities|controls|generator|hvac|cooling/.test(t)) tags.push('Critical Facilities');
  if (/network|networking|server|operations/.test(t)) tags.push('Data Center Operations');
  return [...new Set(tags)].slice(0, 5);
}

function extractDetail(html, row, diagnostics) {
  const headings = [...html.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
    .map(match => ({ title: clean(match[1]), index: match.index }))
    .filter(item => item.title && relevantTitlePattern.test(item.title) && !excludedTitlePattern.test(item.title));
  const heading = headings.at(-1);
  const detailTitle = heading?.title || row.title;
  const detailStart = heading?.index ?? 0;
  const detailText = clean(html.slice(detailStart, Math.min(html.length, detailStart + 30000)));
  if (/job not found|this job may have been taken down/i.test(detailText.slice(0, 2500))) {
    diagnostics.detailDrops.stale += 1;
    return null;
  }

  const locationMatch = detailText.match(usLocationPattern);
  const location = normalizeGoogleLocation(locationMatch?.[1] || '');
  if (!location) {
    diagnostics.detailDrops.location += 1;
    return null;
  }

  const minimum = parseMinimumQualifications(detailText);
  if (Number.isFinite(minimum.maxYears) && minimum.maxYears > 5) {
    diagnostics.detailDrops.experience += 1;
    return null;
  }

  const cls = classify(detailTitle, minimum.text, minimum.maxYears);
  const pay = parsePay(detailText);
  diagnostics.detailVerified += 1;
  return {
    id: `google-${row.id || hash(row.sourceUrl)}`,
    title: detailTitle,
    company: COMPANY,
    location,
    type: cls.type,
    experience: cls.experience,
    tags: tagsFor(detailTitle, cls.experience, cls.type),
    ...pay,
    postedAt: null,
    source: 'Google Careers',
    sourceUrl: row.sourceUrl,
    active: true,
    demo: false
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
const previousSnapshot = await readJson(SNAPSHOT_PATH, []);
const priorStatus = await readJson(STATUS_PATH, {});
const errors = [];
const diagnostics = {
  canonicalLinks: 0,
  missionFitLinks: 0,
  uniqueCandidates: 0,
  detailAttempted: 0,
  detailVerified: 0,
  detailDrops: { stale: 0, location: 0, experience: 0, fetch: 0 }
};
let pagesAttempted = 0;
let pagesSucceeded = 0;
let sourceHealthy = true;
const candidatesById = new Map();

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
    for (const row of extractCandidates(html, diagnostics)) candidatesById.set(row.id, row);
  } catch (error) {
    errors.push(`search page ${page}: ${error.message}`);
    if (page === 1) sourceHealthy = false;
    break;
  }
}

diagnostics.uniqueCandidates = candidatesById.size;
if (!candidatesById.size) {
  sourceHealthy = false;
  errors.push('Google Careers returned no mission-fit early-career result links.');
}

const detailCandidates = [...candidatesById.values()].slice(0, MAX_DETAIL_CANDIDATES);
const verified = [];
for (let i = 0; i < detailCandidates.length; i += DETAIL_BATCH_SIZE) {
  const batch = detailCandidates.slice(i, i + DETAIL_BATCH_SIZE);
  const settled = await Promise.all(batch.map(async row => {
    diagnostics.detailAttempted += 1;
    try {
      const html = await fetchText(row.sourceUrl);
      return extractDetail(html, row, diagnostics);
    } catch (error) {
      diagnostics.detailDrops.fetch += 1;
      errors.push(`detail ${row.id}: ${error.message}`);
      return null;
    }
  }));
  verified.push(...settled.filter(Boolean));
}

let snapshot;
if (!sourceHealthy || !pagesSucceeded || (!verified.length && previousSnapshot.length)) {
  snapshot = previousSnapshot;
  if (!verified.length && previousSnapshot.length) errors.push('Retained previous Google snapshot because no current detail pages could be verified.');
} else {
  snapshot = dedupe(verified);
}

if (!snapshot.length) {
  throw new Error(`Google Careers collector failed and no verified snapshot exists: ${errors.join(' | ')}`);
}

const withoutGoogle = currentJobs.filter(job => job.company !== COMPANY && !/^https:\/\/www\.google\.com\/about\/careers\/applications\/jobs\/results\//i.test(String(job.sourceUrl || '')));
const merged = dedupe([...withoutGoogle, ...snapshot]);
const now = Date.now();
for (const job of merged) {
  job.postedHours = job.postedAt ? Math.max(0, Math.round((now - new Date(job.postedAt).getTime()) / 36e5)) : (job.postedHours ?? 9999);
}

const countsByType = merged.reduce((acc, job) => { acc[job.type] = (acc[job.type] || 0) + 1; return acc; }, {});
const countsByExperience = merged.reduce((acc, job) => { acc[job.experience] = (acc[job.experience] || 0) + 1; return acc; }, {});
const cleanGlobalErrors = (priorStatus.errors || []).filter(error => !String(error).startsWith('Google Careers:'));

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
    sourceHealthy: sourceHealthy && verified.length > 0,
    pagesAttempted,
    pagesSucceeded,
    candidateRows: candidatesById.size,
    qualifyingRoles: snapshot.length,
    diagnostics,
    errors
  },
  errors: [...cleanGlobalErrors, ...errors.map(error => `Google Careers: ${error}`)]
}, null, 2) + '\n');

console.log(`Google Careers ${sourceHealthy && verified.length ? 'succeeded' : 'used prior snapshot'}; ${snapshot.length} verified early-career U.S. data-center roles; ${merged.length} total jobs.`);
if (errors.length) console.warn(`Google Careers warnings: ${errors.join(' | ')}`);
