import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const COMPANY = 'TierPoint';
const ORIGIN = 'https://careers-tierpoint.icims.com';
const SEARCH_URL = `${ORIGIN}/jobs/search?hashed=-626007049&ss=1`;
const SNAPSHOT_PATH = 'data/tierpoint-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';

const excludedTitleTerms = [
  'senior', 'sr.', 'sr ', 'lead ', 'principal', 'manager', 'director', 'vice president',
  'vp ', 'head of', 'supervisor', 'architect', 'sales', 'account executive', 'cloud engineer',
  'support analyst', 'operations specialist'
];

const clean = value => String(value ?? '')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  .replace(/<\/(?:p|div|li|h1|h2|h3|section|article|br)>/gi, '\n')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&quot;/gi, '"')
  .replace(/&#x2F;/gi, '/')
  .replace(/\r/g, '')
  .replace(/[ \t]+/g, ' ')
  .replace(/\n\s*\n+/g, '\n')
  .trim();
const lower = value => clean(value).toLowerCase();
const hash = value => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 14);
const normalizeIdentity = value => lower(value).replace(/[^a-z0-9]+/g, ' ').trim();

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'DataCenterCareersBot/1.4 (+https://datacentercareers.us/)'
    },
    redirect: 'follow'
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

function detailLinks(html) {
  const out = new Set();
  const patterns = [
    /href=["']([^"']*\/jobs\/\d+\/[^"']*\/job(?:\?[^"']*)?)["']/gi,
    /(https:\/\/careers-tierpoint\.icims\.com\/jobs\/\d+\/[^"'<>\s]+\/job)/gi
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      try {
        const url = new URL(match[1], ORIGIN);
        if (url.hostname === 'careers-tierpoint.icims.com') {
          url.search = '';
          url.hash = '';
          out.add(url.toString());
        }
      } catch {}
    }
  }
  return [...out];
}

function listingPageNumber(html) {
  const text = clean(html);
  const match = text.match(/Search Results Page\s+(\d+)\s+of\s+(\d+)/i);
  return match ? { current: Number(match[1]), total: Number(match[2]) } : null;
}

async function listCurrentJobs() {
  const urls = new Set();
  const diagnostics = { pagesAttempted: 0, pagesSucceeded: 0, reportedPages: null, candidateLinks: 0 };
  let expectedPages = 1;

  for (let page = 0; page < Math.min(expectedPages, 20); page += 1) {
    diagnostics.pagesAttempted += 1;
    const url = page === 0 ? SEARCH_URL : `${ORIGIN}/jobs/search?o=&pr=${page}&schemaId=`;
    const html = await fetchText(url);
    diagnostics.pagesSucceeded += 1;
    const pageInfo = listingPageNumber(html);
    if (pageInfo?.total && pageInfo.total <= 20) {
      expectedPages = Math.max(expectedPages, pageInfo.total);
      diagnostics.reportedPages = pageInfo.total;
    }
    for (const jobUrl of detailLinks(html)) urls.add(jobUrl);
  }

  diagnostics.candidateLinks = urls.size;
  if (!urls.size) throw new Error('TierPoint iCIMS listing returned no job detail links.');
  if (diagnostics.reportedPages && diagnostics.pagesSucceeded < diagnostics.reportedPages) {
    throw new Error(`TierPoint iCIMS pagination was incomplete (${diagnostics.pagesSucceeded}/${diagnostics.reportedPages} pages).`);
  }
  return { urls: [...urls], diagnostics };
}

function extractH1(html) {
  const match = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  return clean(match?.[1] || '');
}

function parseLocation(text) {
  const match = text.match(/\bJob Locations?\s+US-([A-Z]{2})-([^\n]+)/i);
  if (!match) return '';
  const state = match[1].toUpperCase();
  const city = clean(match[2]).replace(/\s+ID\s+\d{4}-\d+.*$/i, '').trim();
  return city ? `${city}, ${state}` : state;
}

function parseExternalId(text, url) {
  const match = text.match(/\bID\s+(\d{4}-\d+)\b/i);
  if (match) return match[1];
  const urlMatch = String(url).match(/\/jobs\/(\d+)\//);
  return urlMatch?.[1] || hash(url);
}

function requiredExperienceYears(text = '') {
  const required = String(text).split(/\bPreferred (?:Experience|Qualifications?)\b/i)[0];
  const values = [];
  const patterns = [
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+years?\b/gi,
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?\b/gi,
    /experience(?:\s+(?:of|in))?\s+(?:at least\s+|minimum(?: of)?\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?/gi
  ];
  for (const pattern of patterns) {
    for (const match of required.matchAll(pattern)) {
      values.push(Number(match[1]));
      if (match[2]) values.push(Number(match[2]));
    }
  }
  return values.filter(Number.isFinite);
}

function classify(title, text) {
  const t = lower(title);
  const d = lower(text);
  if (!t || excludedTitleTerms.some(term => t.includes(term))) return null;
  if (!d.includes('data center operations') && !d.includes('data center facilities') && !d.includes('supporting the data center')) return null;
  if (!t.includes('technician')) return null;

  const years = requiredExperienceYears(text);
  if (years.some(year => year > 5)) return null;

  const isLevelOne = /\btechnician\s+(?:i|1)\b/i.test(title);
  const isLevelTwoOrThree = /\btechnician\s+(?:ii|iii|2|3)\b/i.test(title);
  const entryLanguage = /\b(?:novice|entry[- ]level|no experience)\b/i.test(text);

  let experience = '0-2-years';
  if (isLevelOne && entryLanguage) experience = 'no-experience';
  else if (isLevelTwoOrThree || years.some(year => year >= 3)) experience = '2-5-years';
  else if (!isLevelOne && !years.some(year => year <= 2)) return null;

  return { type: 'entry-level', experience };
}

function extractPay(text = '') {
  const match = clean(text).match(/Pay Range\s*\$([\d,.]+)\s*(?:-|–|to)\s*\$?([\d,.]+)/i);
  if (!match) return { pay: 'Pay not listed', salaryMin: null, salaryMax: null, salarySortMax: null };
  const min = Number(match[1].replace(/,/g, ''));
  const max = Number(match[2].replace(/,/g, ''));
  const hourly = Number.isFinite(max) && max < 500;
  return {
    pay: `$${match[1]}–$${match[2]} / ${hourly ? 'hr' : 'year'}`,
    salaryMin: Number.isFinite(min) ? min : null,
    salaryMax: Number.isFinite(max) ? max : null,
    salarySortMax: Number.isFinite(max) ? (hourly ? Math.round(max * 2080) : max) : null
  };
}

function tagsFor(title, text, experience) {
  const value = lower(`${title} ${text}`);
  const tags = [experience === 'no-experience' ? 'No Experience Needed' : (experience === '0-2-years' ? '0–2 Years' : '2–5 Years')];
  if (/\b(?:electrical|switchgear|ups|generator)\b/.test(value)) tags.push('Electrical');
  if (/\b(?:fiber|cabling|network|rack|server)\b/.test(value)) tags.push('Network / Cabling');
  if (/\b(?:critical facilit|hvac|chiller|crah|crac|mechanical)\b/.test(value)) tags.push('Critical Facilities');
  if (/\b(?:entry[- ]level|novice|training)\b/.test(value)) tags.push('Training / Mentorship');
  return [...new Set(tags)].slice(0, 5);
}

async function hydrateJob(url) {
  const html = await fetchText(url);
  const text = clean(html);
  const title = extractH1(html);
  const location = parseLocation(text);
  if (!title || !location) return null;
  const cls = classify(title, text);
  if (!cls) return null;
  const externalId = parseExternalId(text, url);
  return {
    id: `icims-tierpoint-${externalId}`,
    title,
    company: COMPANY,
    location,
    type: cls.type,
    experience: cls.experience,
    tags: tagsFor(title, text, cls.experience),
    ...extractPay(text),
    postedAt: null,
    postedHours: 9999,
    source: 'Employer career site',
    sourceUrl: url,
    active: true,
    demo: false
  };
}

function dedupe(jobs) {
  const urls = new Set();
  const identities = new Set();
  const output = [];
  for (const job of jobs) {
    const url = String(job?.sourceUrl || '').trim();
    const identity = [job?.company, job?.title, job?.location].map(normalizeIdentity).join('|');
    if ((url && urls.has(url)) || identities.has(identity)) continue;
    if (url) urls.add(url);
    identities.add(identity);
    output.push(job);
  }
  return output;
}

const baseJobs = await readJson(JOBS_PATH, []);
const previousTierPoint = await readJson(SNAPSHOT_PATH, []);
const priorStatus = await readJson(STATUS_PATH, {});
let tierPointJobs = [];
let diagnostics = { pagesAttempted: 0, pagesSucceeded: 0, reportedPages: null, candidateLinks: 0, detailAttempted: 0, detailSucceeded: 0 };
let sourceHealthy = true;
let sourceError = '';

try {
  const listing = await listCurrentJobs();
  diagnostics = { ...diagnostics, ...listing.diagnostics };
  for (let index = 0; index < listing.urls.length; index += 6) {
    const batch = listing.urls.slice(index, index + 6);
    diagnostics.detailAttempted += batch.length;
    const results = await Promise.all(batch.map(async url => {
      try {
        const job = await hydrateJob(url);
        diagnostics.detailSucceeded += 1;
        return job;
      } catch {
        return null;
      }
    }));
    tierPointJobs.push(...results.filter(Boolean));
  }
  tierPointJobs = dedupe(tierPointJobs);
  if (!diagnostics.detailSucceeded) throw new Error('TierPoint job detail pages could not be verified.');
} catch (error) {
  sourceHealthy = false;
  sourceError = error.message;
  if (Array.isArray(previousTierPoint) && previousTierPoint.length) {
    tierPointJobs = previousTierPoint;
  } else {
    throw new Error(`TierPoint source failed before an initial snapshot could be created: ${error.message}`);
  }
}

const withoutTierPoint = baseJobs.filter(job => String(job?.company || '').trim() !== COMPANY);
const merged = dedupe([...withoutTierPoint, ...tierPointJobs]);
merged.sort((a, b) => (a.postedHours ?? 9999) - (b.postedHours ?? 9999));

const status = {
  ...priorStatus,
  updatedAt: new Date().toISOString(),
  jobs: merged.length,
  sourcesAttempted: Number(priorStatus.sourcesAttempted || 0) + 1,
  providers: { ...(priorStatus.providers || {}), icims: 1 },
  tierPoint: {
    officialSource: 'https://www.tierpoint.com/about-us/careers/',
    boardUrl: SEARCH_URL,
    sourceHealthy,
    qualifyingRoles: tierPointJobs.length,
    usedPreviousSnapshot: !sourceHealthy,
    diagnostics,
    ...(sourceError ? { error: sourceError } : {})
  },
  errors: sourceError ? [...(priorStatus.errors || []), `TierPoint: ${sourceError} (kept previous verified snapshot)`] : (priorStatus.errors || [])
};

await writeFile(SNAPSHOT_PATH, JSON.stringify(tierPointJobs, null, 2) + '\n');
await writeFile(JOBS_PATH, JSON.stringify(merged, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

console.log(`TierPoint collector ${sourceHealthy ? 'verified' : 'preserved'} ${tierPointJobs.length} qualifying employer-direct role(s); ${merged.length} total jobs.`);
