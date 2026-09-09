import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const SNAPSHOT_PATH = 'data/edgeconnex-jobs.json';
const COMPANY = 'EdgeConneX';
const OFFICIAL_SOURCE = 'https://www.edgeconnex.com/company/why-join-us/';
const BOARD_URL = 'https://ats.rippling.com/edgeconnex/jobs';

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

const missionTitlePattern = /\b(?:data cent(?:er|re) (?:technician|operator|operations|facilities|facility|engineer)|critical facilit(?:y|ies) (?:technician|operator|engineer)|facilit(?:y|ies) (?:technician|operator|engineer)|(?:electrical|mechanical) operations engineer|operations engineer)\b/i;
const seniorTitlePattern = /\b(?:senior|sr\.?|lead|principal|staff|chief|manager|director|vice president|vp|head of|supervisor|superintendent|foreman)\b/i;
const missionContextPattern = /\b(?:data cent(?:er|re)|critical infrastructure|mission-critical|critical facilit(?:y|ies)|ups|switchgear|generator|crah|crac|chiller|pdu|rpp)\b/i;
const activeApplicationPattern = /\bapply now\b|\bapply for this job\b|\bsubmit application\b/i;
const stateMap = new Map([
  ['alabama','AL'],['alaska','AK'],['arizona','AZ'],['arkansas','AR'],['california','CA'],['colorado','CO'],['connecticut','CT'],['delaware','DE'],['florida','FL'],['georgia','GA'],['hawaii','HI'],['idaho','ID'],['illinois','IL'],['indiana','IN'],['iowa','IA'],['kansas','KS'],['kentucky','KY'],['louisiana','LA'],['maine','ME'],['maryland','MD'],['massachusetts','MA'],['michigan','MI'],['minnesota','MN'],['mississippi','MS'],['missouri','MO'],['montana','MT'],['nebraska','NE'],['nevada','NV'],['new hampshire','NH'],['new jersey','NJ'],['new mexico','NM'],['new york','NY'],['north carolina','NC'],['north dakota','ND'],['ohio','OH'],['oklahoma','OK'],['oregon','OR'],['pennsylvania','PA'],['rhode island','RI'],['south carolina','SC'],['south dakota','SD'],['tennessee','TN'],['texas','TX'],['utah','UT'],['vermont','VT'],['virginia','VA'],['washington','WA'],['west virginia','WV'],['wisconsin','WI'],['wyoming','WY'],['district of columbia','DC']
]);
const stateCodes = new Set(stateMap.values());

function requiredExperienceText(text = '') {
  const value = clean(text);
  const preferred = value.search(/\b(?:preferred qualifications?|preferred experience|preferred skills?|nice to have|strongly encouraged)\b/i);
  return preferred >= 0 ? value.slice(0, preferred) : value;
}

function requiredExperienceYears(text = '') {
  const values = [];
  const value = lower(requiredExperienceText(text));
  const patterns = [
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+years?\s+(?:of\s+)?(?:direct\s+|relevant\s+|related\s+)?experience/gi,
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?\s+(?:of\s+)?(?:direct\s+|relevant\s+|related\s+)?experience/gi,
    /experience(?:\s+(?:of|in))?\s+(?:at least\s+|minimum(?: of)?\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?/gi
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      values.push(Number(match[1]));
      if (match[2]) values.push(Number(match[2]));
    }
  }
  return values.filter(year => Number.isFinite(year) && year >= 0 && year <= 50);
}

function classify(title, text) {
  if (!missionTitlePattern.test(title) || seniorTitlePattern.test(title) || !missionContextPattern.test(text)) return null;
  const years = requiredExperienceYears(text);
  if (years.some(year => year > 5)) return null;
  const t = lower(title);
  if (/\bintern\b/.test(t)) return { type: 'internship', experience: '0-2-years' };
  if (/\bapprentice\b/.test(t)) return { type: 'apprenticeship', experience: '0-2-years' };
  if (/\btrainee\b/.test(t)) return { type: 'trainee', experience: '0-2-years' };
  if (!years.length) return null;
  return { type: 'entry-level', experience: years.some(year => year >= 3) ? '2-5-years' : '0-2-years' };
}

function tagsFor(title, text, experience) {
  const value = lower(`${title} ${text}`);
  const tags = [experience === '2-5-years' ? '2–5 Years' : '0–2 Years'];
  if (/\belectrical\b|\bups\b|\bswitchgear\b|\bgenerator\b|\bpdu\b|\brpp\b/.test(value)) tags.push('Electrical');
  if (/\bmechanical\b|\bcrah\b|\bcrac\b|\bchiller\b|\bhvac\b/.test(value)) tags.push('Critical Facilities');
  if (/\btraining\b|\bmentorship\b|\blearning\b/.test(value)) tags.push('Training / Mentorship');
  return [...new Set(tags)].slice(0, 5);
}

function decodeHref(value = '') {
  return String(value).replace(/&amp;/gi, '&').trim();
}

function extractJobLinks(html) {
  const links = new Set();
  const pattern = /href=["']([^"']*\/edgeconnex\/jobs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})["']/gi;
  for (const match of html.matchAll(pattern)) {
    const href = decodeHref(match[1]);
    let url;
    try { url = new URL(href, BOARD_URL); } catch { continue; }
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'ats.rippling.com') continue;
    url.pathname = url.pathname.replace(/^\/[a-z]{2}(?:-[A-Z]{2})?(?=\/edgeconnex\/jobs\/)/, '');
    url.search = '';
    url.hash = '';
    links.add(url.href);
  }
  return [...links];
}

function extractJsonLd(html) {
  const postings = [];
  const pattern = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length) {
        const item = queue.shift();
        if (!item || typeof item !== 'object') continue;
        if (Array.isArray(item['@graph'])) queue.push(...item['@graph']);
        const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
        if (types.some(type => String(type).toLowerCase() === 'jobposting')) postings.push(item);
      }
    } catch {}
  }
  return postings[0] || null;
}

function extractTitle(html, jsonLd) {
  const structured = clean(jsonLd?.title || '');
  if (structured) return structured;
  for (const level of ['h1','h2']) {
    const match = html.match(new RegExp(`<${level}\\b[^>]*>([\\s\\S]*?)<\\/${level}>`, 'i'));
    const title = clean(match?.[1] || '');
    if (title && lower(title) !== 'edgeconnex') return title;
  }
  return '';
}

function normalizeRegion(region = '') {
  const value = clean(region);
  const upper = value.toUpperCase();
  if (stateCodes.has(upper)) return upper;
  return stateMap.get(value.toLowerCase()) || '';
}

function extractLocation(jsonLd, text) {
  const rows = Array.isArray(jsonLd?.jobLocation) ? jsonLd.jobLocation : jsonLd?.jobLocation ? [jsonLd.jobLocation] : [];
  for (const row of rows) {
    const address = row?.address || row;
    const city = clean(address?.addressLocality || '');
    const region = normalizeRegion(address?.addressRegion || '');
    const country = clean(address?.addressCountry?.name || address?.addressCountry || '');
    if (city && region && (!country || /^(?:us|usa|united states|united states of america)$/i.test(country))) return `${city}, ${region}`;
  }
  const codes = [...stateCodes].join('|');
  const match = clean(text).match(new RegExp(`\\b([A-Z][A-Za-z .'-]{1,60}?),\\s*(${codes})\\b`));
  return match ? `${clean(match[1])}, ${match[2]}` : '';
}

function extractPay(jsonLd, text) {
  const salary = jsonLd?.baseSalary?.value || jsonLd?.baseSalary || null;
  const min = Number(salary?.minValue ?? salary?.value ?? NaN);
  const max = Number(salary?.maxValue ?? salary?.value ?? NaN);
  const unit = lower(salary?.unitText || jsonLd?.baseSalary?.unitText || '');
  if (Number.isFinite(max)) {
    const hourly = /hour/.test(unit);
    const fmt = value => Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
    const label = Number.isFinite(min) && min !== max ? `$${fmt(min)}–$${fmt(max)} / ${hourly ? 'hr' : 'year'}` : `$${fmt(max)} / ${hourly ? 'hr' : 'year'}`;
    return { pay: label, salaryMin: Number.isFinite(min) ? min : max, salaryMax: max, salarySortMax: hourly ? Math.round(max * 2080) : max };
  }
  const match = clean(text).match(/(?:\$\s*)?([\d,]{4,})\s*(?:-|–|to)\s*(?:\$\s*)?([\d,]{4,})\s*(?:USD)?\s*(?:per\s+)?(year|annum|annual|hour|hr)/i);
  if (!match) return { pay: 'Pay not listed', salaryMin: null, salaryMax: null, salarySortMax: null };
  const parsedMin = Number(match[1].replace(/,/g, ''));
  const parsedMax = Number(match[2].replace(/,/g, ''));
  const hourly = /hour|hr/i.test(match[3]);
  return { pay: `$${match[1]}–$${match[2]} / ${hourly ? 'hr' : 'year'}`, salaryMin: parsedMin, salaryMax: parsedMax, salarySortMax: hourly ? Math.round(parsedMax * 2080) : parsedMax };
}

async function fetchText(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'DataCenterCareersBot/1.6 (+https://datacenterjobs.us/)'
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
const drops = { inactive: 0, seniorOrOffMission: 0, nonUs: 0, experience: 0, fetch: 0 };
let listingFetched = false;
let detailSucceeded = 0;
let candidateUrls = [];
const qualifying = [];

try {
  const listing = await fetchText(BOARD_URL);
  listingFetched = true;
  candidateUrls = extractJobLinks(listing.html);
  if (!candidateUrls.length) errors.push('board returned no parseable Rippling job links');
} catch (error) {
  errors.push(`job board: ${error.message}`);
}

for (const url of candidateUrls) {
  try {
    const detail = await fetchText(url);
    detailSucceeded += 1;
    const jsonLd = extractJsonLd(detail.html);
    const text = clean(jsonLd?.description || detail.html);
    if (!activeApplicationPattern.test(clean(detail.html))) {
      drops.inactive += 1;
      continue;
    }
    const title = extractTitle(detail.html, jsonLd);
    if (!title || !missionTitlePattern.test(title) || seniorTitlePattern.test(title) || !missionContextPattern.test(text)) {
      drops.seniorOrOffMission += 1;
      continue;
    }
    const location = extractLocation(jsonLd, detail.html);
    if (!location) {
      drops.nonUs += 1;
      continue;
    }
    const cls = classify(title, text);
    if (!cls) {
      drops.experience += 1;
      continue;
    }
    const finalUrl = detail.finalUrl || url;
    const jobId = new URL(finalUrl).pathname.split('/').filter(Boolean).pop() || hash(finalUrl);
    const postedAt = jsonLd?.datePosted ? new Date(jsonLd.datePosted).toISOString() : null;
    qualifying.push({
      id: `edgeconnex-${jobId}`,
      title,
      company: COMPANY,
      location,
      type: cls.type,
      experience: cls.experience,
      tags: tagsFor(title, text, cls.experience),
      ...extractPay(jsonLd, text),
      postedAt,
      postedHours: postedAt ? Math.max(0, Math.round((Date.now() - new Date(postedAt).getTime()) / 36e5)) : 9999,
      source: 'Official EdgeConneX careers',
      sourceUrl: finalUrl,
      active: true,
      demo: false
    });
  } catch (error) {
    drops.fetch += 1;
    errors.push(`job page: ${error.message}`);
  }
}

const sourceHealthy = listingFetched && candidateUrls.length > 0 && detailSucceeded === candidateUrls.length;
const selected = sourceHealthy ? qualifying : previousSnapshot;
if (sourceHealthy) await writeFile(SNAPSHOT_PATH, JSON.stringify(qualifying, null, 2) + '\n');

jobs = jobs.filter(job => String(job?.company || '').trim() !== COMPANY);
const existingUrls = new Set(jobs.map(job => String(job?.sourceUrl || '')).filter(Boolean));
for (const job of selected) {
  if (job?.sourceUrl && existingUrls.has(job.sourceUrl)) continue;
  jobs.push(job);
  if (job?.sourceUrl) existingUrls.add(job.sourceUrl);
}

status.edgeconnexCareers = {
  officialSource: OFFICIAL_SOURCE,
  boardUrl: BOARD_URL,
  provider: 'rippling',
  sourceHealthy,
  listingFetched,
  candidateLinks: candidateUrls.length,
  detailSucceeded,
  qualifyingRoles: qualifying.length,
  preservedPrevious: sourceHealthy ? 0 : previousSnapshot.length,
  drops,
  errors: errors.slice(0, 12)
};
status.jobs = jobs.length;

await writeFile(JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

console.log(`EdgeConneX Rippling: ${candidateUrls.length} live listings, ${detailSucceeded} detail pages, ${qualifying.length} mission-fit 0–5 year roles.`);
if (!sourceHealthy && previousSnapshot.length) console.warn(`EdgeConneX source incomplete; preserved ${previousSnapshot.length} previously verified role(s).`);
if (errors.length) console.warn(`EdgeConneX source warnings: ${errors.slice(0, 6).join(' | ')}`);
