import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const SNAPSHOT_PATH = 'data/novva-jobs.json';
const OFFICIAL_SOURCE = 'https://www.novva.com/careers/';
const COMPANY = 'Novva Data Centers';
const KNOWN_CANDIDATES = [
  'https://www.novva.com/portfolio/command-center-operator-utah/'
];

const clean = value => String(value ?? '')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&quot;/gi, '"')
  .replace(/&#8211;|&ndash;/gi, '–')
  .replace(/&#8212;|&mdash;/gi, '—')
  .replace(/\s+/g, ' ')
  .trim();
const lower = value => clean(value).toLowerCase();
const hash = value => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 14);

const missionTitlePattern = /\b(?:command center operator|data cent(?:er|re) (?:technician|operator|operations|facilities|facility|engineer)|critical facilit(?:y|ies) (?:technician|operator|engineer)|facilities technician|facility technician)\b/i;
const excludedTitlePattern = /\b(?:senior|sr\.?|lead|principal|chief|manager|director|vice president|vp|head of|staff|supervisor|superintendent|foreman|sales|account executive)\b/i;
const missionContextPattern = /\bdata cent(?:er|re)\b/i;
const infrastructureContextPattern = /\b(?:mechanical|electrical|power|critical system|critical infrastructure|facility|facilities|operations?|monitoring|troubleshooting|ups|generator|hvac|chiller|server|network)\b/i;
const activeApplicationPattern = /\bplease submit resumes? to\s+careers@novva\.com\b|\bapply (?:now|today)\b|\bsubmit (?:your )?(?:resume|application)\b/i;

function requiredExperienceYears(text = '') {
  const values = [];
  const patterns = [
    /(?:minimum(?: of)?|required|requires?|must have)\s*:?\s*(\d{1,2})\+?\s*(?:-|–|to)\s*(\d{1,2})\s+years?/gi,
    /(?:minimum(?: of)?|required|requires?|must have)\s*:?\s*(\d{1,2})\+?\s+years?/gi,
    /(\d{1,2})\+?\s+years?\s+(?:of\s+)?(?:required|required experience)/gi
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      values.push(Number(match[1]));
      if (match[2]) values.push(Number(match[2]));
    }
  }
  return values.filter(Number.isFinite);
}

function classify(title, text) {
  if (!missionTitlePattern.test(title) || excludedTitlePattern.test(title)) return null;
  const normalized = lower(text);
  if (!missionContextPattern.test(normalized) || !infrastructureContextPattern.test(normalized)) return null;

  const years = requiredExperienceYears(normalized);
  if (years.some(year => year >= 6)) return null;
  if (years.some(year => year >= 3)) return { type: 'entry-level', experience: '2-5-years' };
  if (years.some(year => year >= 1)) return { type: 'entry-level', experience: '0-2-years' };

  if (/\bminimum\s*:\s*high school diploma\b/i.test(normalized) || /\bminimum\s+(?:education\s*:\s*)?high school diploma\b/i.test(normalized)) {
    return { type: 'entry-level', experience: 'no-experience' };
  }

  return null;
}

function tagsFor(title, text, experience) {
  const value = lower(`${title} ${text}`);
  const tags = [experience === 'no-experience' ? 'No Experience Needed' : experience === '2-5-years' ? '2–5 Years' : '0–2 Years'];
  if (/\b(?:mechanical|electrical|power|critical system|critical infrastructure|ups|generator|hvac|chiller)\b/.test(value)) tags.push('Critical Facilities');
  if (/\btraining\b|\bonboarding\b|\blearn(?:ing)?\b/.test(value)) tags.push('Training / Mentorship');
  if (/\bcustomer service\b|\bcustomer support\b|\bsupport for .*customers?\b/.test(value)) tags.push('Customer Operations');
  if (/\bnetwork\b|\bserver\b|\bcabling\b|\bfiber\b/.test(value)) tags.push('Network / Cabling');
  return [...new Set(tags)].slice(0, 5);
}

function decodeHref(value = '') {
  return String(value).replace(/&amp;/gi, '&').trim();
}

function extractJobLinks(html) {
  const links = [];
  const seen = new Set();
  const pattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    const label = clean(match[2]);
    const href = decodeHref(match[1]);
    if (!href || (!missionTitlePattern.test(label) && !missionTitlePattern.test(href.replace(/[-_/]+/g, ' ')))) continue;
    let absolute;
    try { absolute = new URL(href, OFFICIAL_SOURCE); } catch { continue; }
    if (absolute.protocol !== 'https:' || !/(^|\.)novva\.com$/i.test(absolute.hostname)) continue;
    if (!/^\/portfolio\//i.test(absolute.pathname)) continue;
    absolute.hash = '';
    const url = absolute.href;
    if (seen.has(url)) continue;
    seen.add(url);
    links.push(url);
  }
  return links;
}

function extractTitle(html) {
  const h1 = clean(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');
  return h1.replace(/\s+-\s+(?:Utah|Colorado|Nevada|Arizona|California)\s*$/i, '').trim();
}

function extractLocation(html) {
  const text = clean(html);
  const match = text.match(/\bLocation\s*:\s*([A-Za-z][A-Za-z .'-]{1,70}?,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC))\b/i);
  return clean(match?.[1] || '');
}

function payNotListed() {
  return { pay: 'Pay not listed', salaryMin: null, salaryMax: null, salarySortMax: null };
}

async function fetchText(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'DataCenterCareersBot/1.5 (+https://datacentercareers.us/)'
    },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return { html: await response.text(), finalUrl: response.url || url };
}

let jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
if (!Array.isArray(jobs)) throw new Error('jobs.json must contain an array');
let status = {};
try { status = JSON.parse(await readFile(STATUS_PATH, 'utf8')); } catch {}
let previousSnapshot = [];
try {
  previousSnapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
  if (!Array.isArray(previousSnapshot)) previousSnapshot = [];
} catch {}

const errors = [];
const drops = { inactive: 0, titleOrContext: 0, experience: 0, location: 0, fetch: 0 };
let careersFetched = false;
let detailSucceeded = 0;
const candidates = new Set(KNOWN_CANDIDATES);
const qualifying = [];

try {
  const listing = await fetchText(OFFICIAL_SOURCE);
  careersFetched = true;
  for (const url of extractJobLinks(listing.html)) candidates.add(url);
} catch (error) {
  errors.push(`careers page: ${error.message}`);
}

for (const url of candidates) {
  try {
    const detail = await fetchText(url);
    detailSucceeded += 1;
    const text = clean(detail.html);
    if (!activeApplicationPattern.test(text)) {
      drops.inactive += 1;
      continue;
    }

    const title = extractTitle(detail.html);
    if (!title || !missionTitlePattern.test(title) || excludedTitlePattern.test(title) || !missionContextPattern.test(text) || !infrastructureContextPattern.test(text)) {
      drops.titleOrContext += 1;
      continue;
    }

    const cls = classify(title, text);
    if (!cls) {
      drops.experience += 1;
      continue;
    }

    const location = extractLocation(detail.html);
    if (!location) {
      drops.location += 1;
      continue;
    }

    const finalUrl = detail.finalUrl || url;
    const slug = new URL(finalUrl).pathname.split('/').filter(Boolean).pop() || hash(finalUrl);
    qualifying.push({
      id: `novva-${slug.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()}`,
      title,
      company: COMPANY,
      location,
      type: cls.type,
      experience: cls.experience,
      tags: tagsFor(title, text, cls.experience),
      ...payNotListed(),
      postedAt: null,
      postedHours: 9999,
      source: 'Official Novva careers',
      sourceUrl: finalUrl,
      active: true,
      demo: false
    });
  } catch (error) {
    drops.fetch += 1;
    errors.push(`job page: ${error.message}`);
  }
}

const sourceHealthy = careersFetched && detailSucceeded > 0;
const selected = sourceHealthy ? qualifying : previousSnapshot;

if (sourceHealthy) {
  await writeFile(SNAPSHOT_PATH, JSON.stringify(qualifying, null, 2) + '\n');
}

jobs = jobs.filter(job => String(job?.company || '').trim() !== COMPANY);
const existingUrls = new Set(jobs.map(job => String(job?.sourceUrl || '')).filter(Boolean));
for (const job of selected) {
  if (job?.sourceUrl && existingUrls.has(job.sourceUrl)) continue;
  jobs.push(job);
  if (job?.sourceUrl) existingUrls.add(job.sourceUrl);
}

status.novvaCareers = {
  officialSource: OFFICIAL_SOURCE,
  sourceHealthy,
  candidateLinks: candidates.size,
  detailSucceeded,
  qualifyingRoles: qualifying.length,
  preservedPrevious: sourceHealthy ? 0 : previousSnapshot.length,
  drops,
  errors: errors.slice(0, 12)
};
status.jobs = jobs.length;

await writeFile(JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

console.log(`Novva careers: ${candidates.size} candidate links, ${detailSucceeded} live detail pages, ${qualifying.length} qualifying 0–5 year roles.`);
if (!sourceHealthy && previousSnapshot.length) console.warn(`Novva source incomplete; preserved ${previousSnapshot.length} previously verified role(s).`);
if (errors.length) console.warn(`Novva source warnings: ${errors.slice(0, 6).join(' | ')}`);
