import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const OFFICIAL_SOURCE = 'https://sabey.com/about/careers';
const COMPANY = 'Sabey Data Centers';

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

const missionTitlePattern = /\bdata center\b.*\b(?:operations?|facilit(?:y|ies)|mechanical|electrical|critical|technician|engineer)\b/i;
const excludedTitlePattern = /\b(?:senior|sr\.?|lead|principal|chief|manager|director|vice president|vp|head of|staff|supervisor|superintendent|foreman)\b/i;

function statedExperienceYears(text = '') {
  const values = [];
  const patterns = [
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\+?\s*(?:-|–|to)\s*(\d{1,2})\s+years?(?:\s+of)?\s+(?:relevant\s+|related\s+)?experience/gi,
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\+?\s+years?(?:\s+of)?\s+(?:relevant\s+|related\s+)?experience/gi,
    /(?:with|requires?|bring)\s+(\d{1,2})\+?\s+years?(?:\s+of)?\s+experience/gi
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
  const normalized = lower(`${title} ${text}`);
  const years = statedExperienceYears(normalized);
  if (years.some(year => year >= 6)) return null;

  if (years.some(year => year >= 3)) return { type: 'entry-level', experience: '2-5-years' };
  if (years.some(year => year <= 2)) return { type: 'entry-level', experience: '0-2-years' };

  if (/\b(?:operations?|facilities?) technician\b/i.test(title) && /\bhigh school diploma\b/i.test(normalized)) {
    return { type: 'entry-level', experience: '0-2-years' };
  }
  if (/\b(?:engineer|technician)\s+(?:ii|2)\b/i.test(title)) {
    return { type: 'entry-level', experience: '2-5-years' };
  }

  // Do not guess when the recruiter page does not state a usable experience level.
  return null;
}

function extractPay(text) {
  const match = clean(text).match(/(?:salary(?: range)?\s*:?\s*)?\$([\d,.]+)\s*(?:-|–|to)\s*\$?([\d,.]+)/i);
  if (!match) return { pay: 'Pay not listed', salaryMin: null, salaryMax: null, salarySortMax: null };
  const min = Number(match[1].replace(/,/g, ''));
  const max = Number(match[2].replace(/,/g, ''));
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { pay: 'Pay not listed', salaryMin: null, salaryMax: null, salarySortMax: null };
  return {
    pay: `$${min.toLocaleString('en-US', { maximumFractionDigits: 2 })}–$${max.toLocaleString('en-US', { maximumFractionDigits: 2 })} / year`,
    salaryMin: min,
    salaryMax: max,
    salarySortMax: max
  };
}

function tagsFor(title, text, experience) {
  const value = lower(`${title} ${text}`);
  const tags = [experience === '2-5-years' ? '2–5 Years' : '0–2 Years'];
  if (/\belectrical\b|\bswitchgear\b|\bups\b/.test(value)) tags.push('Electrical');
  if (/\bmechanical\b|\bhvac\b|\bchiller\b|\bcrah\b|\bcrac\b/.test(value)) tags.push('Critical Facilities');
  if (/\btraining\b|\bdevelop(?:ing|ment)?\b|\blearn\b/.test(value)) tags.push('Training / Mentorship');
  return [...new Set(tags)].slice(0, 5);
}

function decodeHref(value = '') {
  return String(value).replace(/&amp;/gi, '&').trim();
}

function extractJobLinks(html) {
  const links = [];
  const pattern = /href=["']([^"']*careers2-anothersource\.icims\.com\/jobs\/\d+\/[^"']*\/job[^"']*)["']/gi;
  for (const match of html.matchAll(pattern)) {
    const url = decodeHref(match[1]);
    if (url && !links.includes(url)) links.push(url);
  }
  return links;
}

function extractTitle(html) {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  let title = clean(h1?.[1] || '');
  title = title.replace(/\s+-\s+Sabey Data Center(?:s| Properties(?:, LLC)?)\s*$/i, '').trim();
  return title;
}

function extractLocation(html) {
  const titleTag = clean(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const titleLocation = titleTag.match(/\|\s*Careers at\s+(.+?)(?:\s+\d{5}(?:-\d{4})?)?$/i)?.[1]?.trim();
  if (titleLocation && /,\s*[A-Z]{2}\b/.test(titleLocation)) return titleLocation;

  const text = clean(html);
  const atsLocation = text.match(/Job Locations?\s+US-([A-Z]{2})-([A-Za-z][A-Za-z .'-]{1,60}?)(?=\s+(?:At a glance|Description|Overview|Company|Category|ID)\b)/i);
  if (!atsLocation) return '';
  const city = atsLocation[2].replace(/-/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, char => char.toUpperCase());
  return city ? `${city}, ${atsLocation[1].toUpperCase()}` : '';
}

function applicationDeadlinePassed(text) {
  const match = clean(text).match(/Application Deadline\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
  if (!match) return false;
  const endOfDayUtc = Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2]) + 1) - 1;
  return Date.now() > endOfDayUtc;
}

async function fetchText(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': 'DataCenterCareersBot/1.2 (+https://datacentercareers.us/)'
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

const previousSabey = jobs.filter(job => job?.company === COMPANY || /^Official Sabey careers$/i.test(String(job?.source || '')));
const errors = [];
const drops = { stale: 0, titleOrExperience: 0, location: 0, fetch: 0 };
let listingFetched = false;
let candidateLinks = 0;
let detailSucceeded = 0;
const qualifying = [];

try {
  const listing = await fetchText(OFFICIAL_SOURCE);
  listingFetched = true;
  const links = extractJobLinks(listing.html);
  candidateLinks = links.length;
  if (!links.length) throw new Error('official careers page exposed no iCIMS job links');

  for (const url of links) {
    try {
      const detail = await fetchText(url);
      detailSucceeded += 1;
      const text = clean(detail.html);
      if (applicationDeadlinePassed(text)) {
        drops.stale += 1;
        continue;
      }

      const title = extractTitle(detail.html);
      const location = extractLocation(detail.html);
      const cls = classify(title, text);
      if (!cls) {
        drops.titleOrExperience += 1;
        continue;
      }
      if (!location) {
        drops.location += 1;
        continue;
      }

      const idMatch = detail.finalUrl.match(/\/jobs\/(\d+)\//i) || url.match(/\/jobs\/(\d+)\//i);
      const id = `sabey-${idMatch?.[1] || hash(detail.finalUrl || `${title}|${location}`)}`;
      qualifying.push({
        id,
        title,
        company: COMPANY,
        location,
        type: cls.type,
        experience: cls.experience,
        tags: tagsFor(title, text, cls.experience),
        ...extractPay(text),
        postedAt: null,
        source: 'Official Sabey careers',
        sourceUrl: detail.finalUrl || url,
        active: true,
        demo: false,
        postedHours: 9999
      });
    } catch (error) {
      drops.fetch += 1;
      errors.push(error.message);
    }
  }
} catch (error) {
  errors.push(error.message);
}

const sourceHealthy = listingFetched && candidateLinks > 0 && detailSucceeded > 0;
if (sourceHealthy) {
  jobs = jobs.filter(job => !(job?.company === COMPANY || /^Official Sabey careers$/i.test(String(job?.source || ''))));
  const existingUrls = new Set(jobs.map(job => String(job?.sourceUrl || '')).filter(Boolean));
  const existingIdentities = new Set(jobs.map(job => [job?.company, job?.title, job?.location].map(lower).join('|')));
  for (const job of qualifying) {
    const identity = [job.company, job.title, job.location].map(lower).join('|');
    if ((job.sourceUrl && existingUrls.has(job.sourceUrl)) || existingIdentities.has(identity)) continue;
    jobs.push(job);
    if (job.sourceUrl) existingUrls.add(job.sourceUrl);
    existingIdentities.add(identity);
  }
}

status.sabeyCareers = {
  officialSource: OFFICIAL_SOURCE,
  sourceHealthy,
  candidateLinks,
  detailSucceeded,
  qualifyingRoles: qualifying.length,
  preservedPrevious: sourceHealthy ? 0 : previousSabey.length,
  drops,
  errors: errors.slice(0, 12)
};
status.jobs = jobs.length;

await writeFile(JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

console.log(`Sabey careers: ${candidateLinks} candidate links, ${detailSucceeded} live detail pages, ${qualifying.length} qualifying 0–5 year roles.`);
if (!sourceHealthy && previousSabey.length) console.warn(`Sabey source incomplete; preserved ${previousSabey.length} previously published role(s).`);
if (errors.length) console.warn(`Sabey source warnings: ${errors.slice(0, 6).join(' | ')}`);
