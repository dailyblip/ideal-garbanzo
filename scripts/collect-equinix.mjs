import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const COMPANY = 'Equinix';
const listingUrls = [
  'https://careers.equinix.com/internships',
  'https://careers.equinix.com/jobs/search?country_codes%5B%5D=US&page=1&query=data+center',
  'https://careers.equinix.com/jobs/search?country_codes%5B%5D=US&page=2&query=data+center',
  'https://careers.equinix.com/jobs/search?country_codes%5B%5D=US&page=3&query=data+center',
  'https://careers.equinix.com/jobs/search?country_codes%5B%5D=US&page=4&query=data+center',
  'https://careers.equinix.com/jobs/search?country_codes%5B%5D=US&page=1&query=skillbridge'
];

const titleAllow = /data\s*center|datacenter|critical facilit|customer operations|logistics technician|skillbridge|apprentice|intern|trainee/i;
const titleExclude = /\b(?:senior|sr\.?|lead|principal|manager|director|vice president|vp|head of|staff|supervisor|superintendent|foreman|architect|sales|account executive)\b|\b(?:IV|V|VI)\b/i;
const earlyTitle = /intern|apprentice|trainee|skillbridge|fellowship|work.?based learning|co-?op/i;
const dataCenterSignals = [
  'data center','datacenter','data centre','critical facilities','critical facility','critical environment',
  'ibx','rack and stack','structured cabling','fiber','cross-connect','cross connect','switchgear','ups',
  'generator','bms','epms','hvac','chiller','colocation','mission critical','customer installations'
];
const noExperienceSignals = [
  'no experience','entry level','entry-level','high school diploma','high school or equivalent',
  'high school diploma or equivalent','training program','training will be','learning program'
];

const clean = value => String(value ?? '')
  .replace(/<script\b[\s\S]*?<\/script>/gi,' ')
  .replace(/<style\b[\s\S]*?<\/style>/gi,' ')
  .replace(/<[^>]*>/g,' ')
  .replace(/&nbsp;|&#160;/gi,' ')
  .replace(/&amp;/gi,'&')
  .replace(/&quot;/gi,'"')
  .replace(/&#39;|&apos;/gi,"'")
  .replace(/&ndash;|&#8211;/gi,'–')
  .replace(/&mdash;|&#8212;/gi,'—')
  .replace(/\s+/g,' ')
  .trim();
const lower = value => clean(value).toLowerCase();
const hash = value => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0,14);
const normalizeIdentity = value => lower(value).replace(/[^a-z0-9]+/g,' ').trim();
const hasAny = (text, terms) => terms.some(term => text.includes(term));

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'DataCenterCareersBot/1.6 (+https://dailyblip.github.io/ideal-garbanzo/)'
      },
      redirect: 'follow',
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`${response.status} ${url}`);
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

function discoverLinks(html, baseUrl) {
  const links = [];
  const seen = new Set();
  const anchors = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchors)) {
    const href = clean(match[1]);
    const label = clean(match[2]);
    if (!href || !titleAllow.test(`${label} ${href}`) || titleExclude.test(label)) continue;
    let absolute;
    try { absolute = new URL(href, baseUrl).href; } catch { continue; }
    if (!/^https:\/\/careers\.equinix\.com\/[^?]*jobs\//i.test(absolute)) continue;
    if (/\/jobs\/search(?:[/?]|$)/i.test(absolute) || seen.has(absolute)) continue;
    seen.add(absolute);
    links.push(absolute);
  }
  return links;
}

function findJobPosting(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJobPosting(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const type = value['@type'];
  if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) return value;
  if (value['@graph']) return findJobPosting(value['@graph']);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const found = findJobPosting(child);
      if (found) return found;
    }
  }
  return null;
}

function extractJobPosting(html) {
  const pattern = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    try {
      const posting = findJobPosting(JSON.parse(match[1].trim()));
      if (posting) return posting;
    } catch {}
  }
  return null;
}

function pageTitle(html) {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return clean(match?.[1] || '');
}

function headingTitle(html) {
  const pattern = /<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/gi;
  for (const match of html.matchAll(pattern)) {
    const candidate = clean(match[1]);
    if (candidate.length < 4 || candidate.length > 220) continue;
    if (titleAllow.test(candidate) && !/search|people also viewed|data center operations jobs/i.test(candidate)) return candidate;
  }
  return '';
}

function titleAndLocationsFromPageTitle(value) {
  const segments = clean(value).split(/\s+-\s+/).map(clean).filter(Boolean);
  const firstLocation = segments.findIndex(segment => /,\s*[^,]+,\s*United States$/i.test(segment));
  if (firstLocation < 0) return { title: clean(value), locations: [] };
  const locations = segments.slice(firstLocation)
    .filter(segment => /,\s*[^,]+,\s*United States$/i.test(segment))
    .map(segment => segment.replace(/,\s*United States$/i,'').trim());
  return { title: segments.slice(0, firstLocation).join(' - '), locations: [...new Set(locations)] };
}

function locationFromPosting(posting) {
  const locations = Array.isArray(posting?.jobLocation) ? posting.jobLocation : [posting?.jobLocation].filter(Boolean);
  const parts = [];
  let us = false;
  for (const location of locations) {
    const address = location?.address || location || {};
    const countryRaw = typeof address.addressCountry === 'object' ? address.addressCountry?.name : address.addressCountry;
    const country = clean(countryRaw);
    if (/united states|\bus\b|\busa\b/i.test(country)) us = true;
    const label = [address.addressLocality, address.addressRegion].map(clean).filter(Boolean).join(', ');
    if (label) parts.push(label);
  }
  return { location:[...new Set(parts)].join('; '), us };
}

function statedExperience(text='') {
  const mins = [];
  const maxes = [];
  const ranges = /(?:requires?|minimum(?: of)?|at least|typically requires)?\s*(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+years?(?:\s+of)?\s+(?:equivalent\s+|relevant\s+|related\s+)?(?:work\s+)?experience/gi;
  for (const match of text.matchAll(ranges)) {
    mins.push(Number(match[1]));
    maxes.push(Number(match[2]));
  }
  const singles = /(?:requires?|minimum(?: of)?|at least|typically requires)\s+(\d{1,2})\+?\s+years?(?:\s+of)?\s+(?:equivalent\s+|relevant\s+|related\s+)?(?:work\s+)?experience/gi;
  for (const match of text.matchAll(singles)) {
    mins.push(Number(match[1]));
    maxes.push(Number(match[1]));
  }
  return {
    min: mins.length ? Math.min(...mins.filter(Number.isFinite)) : null,
    max: maxes.length ? Math.max(...maxes.filter(Number.isFinite)) : null
  };
}

function classify(title, description) {
  const t = lower(title);
  const text = lower(`${title} ${description}`);
  if (!titleAllow.test(title) || titleExclude.test(title) || !hasAny(text, dataCenterSignals)) return null;

  const years = statedExperience(text);
  if (years.min != null && years.min > 5) return null;

  let type = 'entry-level';
  if (/apprentice/.test(t)) type = 'apprenticeship';
  else if (/intern|co-?op/.test(t)) type = 'internship';
  else if (/trainee|skillbridge|fellowship|work.?based learning/.test(t)) type = 'trainee';

  let experience;
  if (years.min != null) experience = years.min <= 2 ? '0-2-years' : '2-5-years';
  else if (earlyTitle.test(title) || hasAny(text, noExperienceSignals)) experience = hasAny(text, noExperienceSignals) ? 'no-experience' : '0-2-years';
  else return null;

  return { type, experience };
}

function payFromPosting(posting, description) {
  const salary = posting?.baseSalary?.value || posting?.baseSalary;
  const min = Number(salary?.minValue ?? salary?.value?.minValue);
  const max = Number(salary?.maxValue ?? salary?.value?.maxValue);
  const unit = clean(salary?.unitText || salary?.value?.unitText || posting?.baseSalary?.unitText);
  if (Number.isFinite(min) && Number.isFinite(max)) {
    const hourly = /hour/i.test(unit);
    return { pay:`$${min.toLocaleString('en-US')}–$${max.toLocaleString('en-US')} / ${hourly ? 'hr' : 'year'}`, salaryMin:min, salaryMax:max, salarySortMax:hourly ? Math.round(max * 2080) : max };
  }
  const match = clean(description).match(/(?:\$\s*)?([\d]{2,3},[\d]{3})\s*(?:-|–|to)\s*(?:\$\s*)?([\d]{2,3},[\d]{3})\s*(?:USD)?\s*\/\s*(Annual|Year|Hourly|Hour)/i);
  if (match) {
    const lo = Number(match[1].replace(/,/g,''));
    const hi = Number(match[2].replace(/,/g,''));
    const hourly = /hour/i.test(match[3]);
    return { pay:`$${lo.toLocaleString('en-US')}–$${hi.toLocaleString('en-US')} / ${hourly ? 'hr' : 'year'}`, salaryMin:lo, salaryMax:hi, salarySortMax:hourly ? Math.round(hi * 2080) : hi };
  }
  return { pay:'Pay not listed', salaryMin:null, salaryMax:null, salarySortMax:null };
}

function tagsFor(title, description, cls) {
  const text = lower(`${title} ${description}`);
  const tags = [];
  if (cls.type === 'internship') tags.push('Internship');
  if (cls.type === 'apprenticeship') tags.push('Apprenticeship');
  if (cls.type === 'trainee') tags.push('Trainee');
  tags.push(cls.experience === 'no-experience' ? 'No Experience Needed' : cls.experience === '2-5-years' ? '2–5 Years' : '0–2 Years');
  if (/skillbridge/.test(text)) tags.push('SkillBridge');
  if (/training|learning|mentorship/.test(text)) tags.push('Training / Mentorship');
  if (/electrical|switchgear|ups|epms/.test(text)) tags.push('Electrical');
  if (/fiber|cabling|network|cross-connect|cross connect/.test(text)) tags.push('Network / Cabling');
  if (/critical facilit|generator|hvac|chiller|mechanical|bms/.test(text)) tags.push('Critical Facilities');
  return [...new Set(tags)].slice(0,5);
}

async function hydrate(url) {
  const html = await fetchText(url);
  const posting = extractJobPosting(html);
  const titleMeta = titleAndLocationsFromPageTitle(pageTitle(html));
  const title = clean(posting?.title || posting?.name || headingTitle(html) || titleMeta.title);
  const description = clean(posting?.description || posting?.responsibilities || html);
  const cls = classify(title, description);
  if (!cls) return null;

  const structuredLocation = locationFromPosting(posting);
  const locations = structuredLocation.location ? structuredLocation.location.split(';').map(clean).filter(Boolean) : titleMeta.locations;
  const isUs = structuredLocation.us || titleMeta.locations.length > 0 || /United States/i.test(pageTitle(html));
  if (!isUs) return null;
  const location = [...new Set(locations)].join('; ') || 'United States';

  let postedAt = null;
  if (posting?.datePosted) {
    const date = new Date(posting.datePosted);
    if (!Number.isNaN(date.getTime())) postedAt = date.toISOString();
  }

  return {
    id:`equinix-${hash(url)}`,
    title,
    company:COMPANY,
    location,
    type:cls.type,
    experience:cls.experience,
    tags:tagsFor(title, description, cls),
    ...payFromPosting(posting, description),
    postedAt,
    source:'Equinix official careers',
    sourceUrl:url,
    active:true,
    demo:false
  };
}

function canonicalTitle(job) {
  let title = clean(job.title);
  const locationTokens = new Set(normalizeIdentity(job.location).split(' ').filter(token => token.length > 1));
  title = title.replace(/\s+[-–—]\s+([^|]+)$/u, (full, tail) => {
    const tokens = normalizeIdentity(tail).split(' ').filter(token => token.length > 1);
    return tokens.length && tokens.every(token => locationTokens.has(token)) ? '' : full;
  });
  return normalizeIdentity(title);
}

function dedupe(jobs) {
  const urls = new Set();
  const identities = new Set();
  const out = [];
  for (const job of jobs) {
    if (titleExclude.test(clean(job.title))) continue;
    const url = clean(job.sourceUrl);
    const identity = [normalizeIdentity(job.company), canonicalTitle(job), normalizeIdentity(job.location)].join('|');
    if ((url && urls.has(url)) || identities.has(identity)) continue;
    if (url) urls.add(url);
    identities.add(identity);
    out.push(job);
  }
  return out;
}

function priority(job) {
  const typeRank = { apprenticeship:0, internship:1, trainee:2, 'entry-level':3 }[job.type] ?? 4;
  const expRank = { 'no-experience':0, '0-2-years':1, '2-5-years':3 }[job.experience] ?? 2;
  return typeRank * 10 + expRank;
}

const current = JSON.parse(await readFile('data/jobs.json','utf8'));
let status = {};
try { status = JSON.parse(await readFile('data/collector-status.json','utf8')); } catch {}

const links = new Set();
const errors = [];
let listingPagesSucceeded = 0;
for (const listing of listingUrls) {
  try {
    const html = await fetchText(listing);
    for (const link of discoverLinks(html, listing)) links.add(link);
    listingPagesSucceeded += 1;
  } catch (error) {
    errors.push(`listing ${listing}: ${error.message}`);
  }
}

const discovered = [];
for (const link of [...links].slice(0,90)) {
  try {
    const job = await hydrate(link);
    if (job) discovered.push(job);
  } catch (error) {
    errors.push(`job ${link}: ${error.message}`);
  }
}

let merged = dedupe([...discovered, ...current]);
const now = Date.now();
for (const job of merged) {
  job.postedHours = job.postedAt ? Math.max(0, Math.round((now - new Date(job.postedAt).getTime()) / 36e5)) : (job.postedHours ?? 9999);
}
const early = merged.filter(job => job.experience !== '2-5-years');
const mid = merged.filter(job => job.experience === '2-5-years');
const maxMid = Math.max(12, Math.floor(Math.max(early.length,1) * 0.30));
merged = [...early, ...mid.sort((a,b)=>(a.postedHours??9999)-(b.postedHours??9999)).slice(0,maxMid)]
  .sort((a,b)=>priority(a)-priority(b) || (a.postedHours??9999)-(b.postedHours??9999));

const countsByType = merged.reduce((acc, job) => { acc[job.type] = (acc[job.type] || 0) + 1; return acc; }, {});
const countsByExperience = merged.reduce((acc, job) => { acc[job.experience] = (acc[job.experience] || 0) + 1; return acc; }, {});
const existingExpansion = status.priorityEmployerExpansion || {};

await writeFile('data/jobs.json', JSON.stringify(merged, null, 2) + '\n');
await writeFile('data/collector-status.json', JSON.stringify({
  ...status,
  updatedAt:new Date().toISOString(),
  jobs:merged.length,
  countsByType,
  countsByExperience,
  priorityEmployerExpansion:{
    ...existingExpansion,
    Equinix:{
      officialSource:'https://careers.equinix.com/',
      listingPagesAttempted:listingUrls.length,
      listingPagesSucceeded,
      candidateLinks:links.size,
      qualifyingRoles:discovered.length,
      errors
    }
  }
}, null, 2) + '\n');

console.log(`Equinix official-source pass found ${links.size} candidate links and ${discovered.length} qualifying US roles.`);
if (errors.length) console.warn(`Equinix warnings: ${errors.join(' | ')}`);
