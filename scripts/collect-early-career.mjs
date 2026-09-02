import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const sources = [
  {
    company: 'Equinix',
    listings: [
      'https://careers.equinix.com/students-recent-grads',
      'https://careers.equinix.com/data-center-operations'
    ],
    allow: /intern|apprentice|trainee|skillbridge|fellowship|data center development/i
  },
  {
    company: 'Amazon Web Services',
    listings: [
      'https://www.amazon.jobs/en/search?base_query=work+based+learning+data+center',
      'https://www.amazon.jobs/en/search?base_query=data+center+intern'
    ],
    allow: /work.?based learning|intern|apprentice|trainee|data center/i
  },
  {
    company: 'Microsoft',
    listings: [
      'https://careers.microsoft.com/v2/global/en/datacentertechnicians.html',
      'https://careers.microsoft.com/v2/global/en/datacenters.html'
    ],
    allow: /intern|apprentice|trainee|early.career|data.?center technician|datacenter technician/i
  },
  {
    company: 'M.C. Dean',
    listings: [
      'https://careers.mcdean.com/join/jobs/categories',
      'https://www.mcdean.com/join-us/'
    ],
    allow: /apprentice|intern|trainee|entry.?level/i
  }
];

const earlySignals = [
  'intern','internship','apprentice','apprenticeship','trainee','skillbridge','fellowship',
  'work based learning','work-based learning','co-op','co op','entry level','entry-level',
  'no experience','high school diploma','high school or equivalent','training program','0+ months of experience'
];
const dataCenterSignals = [
  'data center','datacenter','data centre','critical facilities','critical environment',
  'critical environments','server rack','rack and stack','white space','switchgear','ups',
  'generator','fiber','cabling','colocation','mission critical','mission-critical',
  'telecommunications','low voltage','automation and controls','complex infrastructure'
];
const excludeSignals = [
  'senior','principal','manager','director','vice president','staff engineer','lead engineer',
  'counsel','attorney','account executive','sales manager'
];
const seniorTitlePattern = /\b(?:senior|sr\.?|lead|principal|manager|director|vice president|vp|head of|staff engineer|supervisor|superintendent|foreman|counsel|attorney|architect|recruiter|sales|account executive)\b/i;

const clean = value => String(value ?? '')
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
const hasAny = (text, terms) => terms.some(term => text.includes(term));
const hash = value => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0,14);
const normalizeIdentity = value => lower(value).replace(/[^a-z0-9]+/g,' ').trim();

function canonicalTitle(job) {
  let title = clean(job.title);
  const location = normalizeIdentity(job.location);
  const locationTokens = new Set(location.split(' ').filter(token => token.length > 1));
  const tailBelongsToLocation = tail => {
    const tokens = normalizeIdentity(tail).split(' ').filter(token => token.length > 1);
    return tokens.length > 0 && tokens.every(token => locationTokens.has(token));
  };

  title = title.replace(/\s+[-–—]\s+([^|]+)$/u, (full, tail) => tailBelongsToLocation(tail) ? '' : full);
  title = title.replace(/\s*\(([^)]+)\)\s*$/u, (full, tail) => tailBelongsToLocation(tail) ? '' : full);
  return normalizeIdentity(title);
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'DataCenterCareersBot/1.4 (+https://dailyblip.github.io/ideal-garbanzo/)'
    },
    redirect: 'follow'
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

function discoverJobLinks(html, baseUrl, allow) {
  const links = [];
  const seen = new Set();
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const label = clean(match[2]);
    const href = clean(match[1]);
    if (!href || (!allow.test(label) && !allow.test(href))) continue;
    let absolute;
    try { absolute = new URL(href, baseUrl).href; } catch { continue; }
    if (!/^https:\/\//i.test(absolute)) continue;
    if (!/\/jobs?\/|\/careers?\/job|amazon\.jobs\/.*\/jobs\//i.test(absolute)) continue;
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    links.push(absolute);
  }
  return links.slice(0, 50);
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
  return null;
}

function extractJobPosting(html) {
  const pattern = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const job = findJobPosting(parsed);
      if (job) return job;
    } catch {}
  }
  return null;
}

function locationFromPosting(posting) {
  const locations = Array.isArray(posting.jobLocation) ? posting.jobLocation : [posting.jobLocation].filter(Boolean);
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
  const unique = [...new Set(parts)];
  return { location: unique.join('; ') || 'Location not listed', us: us || unique.some(v => /\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/.test(v)) };
}

function classify(title, description='') {
  const text = lower(`${title} ${description}`);
  const t = lower(title);
  if (seniorTitlePattern.test(title) || !hasAny(text, dataCenterSignals) || hasAny(t, excludeSignals)) return null;
  if (!hasAny(text, earlySignals)) return null;

  let type = 'entry-level';
  if (/apprentice/.test(t)) type = 'apprenticeship';
  else if (/intern|co-op|co op/.test(t)) type = 'internship';
  else if (/trainee|skillbridge|fellowship|work.?based learning/.test(t) || /work.?based learning/.test(text)) type = 'trainee';

  const noExperience = /no experience|high school diploma|high school or equivalent|0\+ months of experience|work.?based learning|skillbridge|apprentice|training program/.test(text);
  const experience = noExperience ? 'no-experience' : '0-2-years';
  return { type, experience };
}

function tagsFor(title, description, type, experience) {
  const text = lower(`${title} ${description}`);
  const tags = [];
  if (type === 'internship') tags.push('Internship');
  if (type === 'apprenticeship') tags.push('Apprenticeship');
  if (type === 'trainee') tags.push('Trainee');
  tags.push(experience === 'no-experience' ? 'No Experience Needed' : '0–2 Years');
  if (/skillbridge/.test(text)) tags.push('SkillBridge');
  if (/training|mentorship|learning program|academy/.test(text)) tags.push('Training / Mentorship');
  if (/electrical|switchgear|ups/.test(text)) tags.push('Electrical');
  if (/fiber|cabling|network|telecommunications|low voltage/.test(text)) tags.push('Network / Cabling');
  if (/critical facilit|generator|hvac|chiller|mechanical/.test(text)) tags.push('Critical Facilities');
  return [...new Set(tags)].slice(0,5);
}

function payFromPosting(posting) {
  const salary = posting.baseSalary?.value || posting.baseSalary;
  const min = Number(salary?.minValue ?? salary?.value?.minValue);
  const max = Number(salary?.maxValue ?? salary?.value?.maxValue);
  const unit = clean(salary?.unitText || salary?.value?.unitText || posting.baseSalary?.unitText);
  if (Number.isFinite(min) && Number.isFinite(max)) {
    const hourly = /hour/i.test(unit);
    return {
      pay: `$${min.toLocaleString('en-US')}–$${max.toLocaleString('en-US')} / ${hourly ? 'hr' : 'year'}`,
      salaryMin:min,
      salaryMax:max,
      salarySortMax: hourly ? Math.round(max * 2080) : max
    };
  }
  return { pay:'Pay not listed', salaryMin:null, salaryMax:null, salarySortMax:null };
}

async function hydrate(source, url) {
  const html = await fetchText(url);
  const posting = extractJobPosting(html);
  if (!posting) return null;
  const title = clean(posting.title || posting.name);
  const description = clean(posting.description || posting.responsibilities || '');
  const cls = classify(title, description);
  if (!cls) return null;
  const loc = locationFromPosting(posting);
  if (!loc.us) return null;
  const postedAt = posting.datePosted ? new Date(posting.datePosted).toISOString() : null;
  return {
    id: `early-${hash(`${source.company}|${url}`)}`,
    title,
    company: source.company,
    location: loc.location,
    type: cls.type,
    experience: cls.experience,
    tags: tagsFor(title, description, cls.type, cls.experience),
    ...payFromPosting(posting),
    postedAt,
    source: 'Employer early-career program',
    sourceUrl: url,
    active: true,
    demo: false
  };
}

function priority(job) {
  const typeRank = { apprenticeship:0, internship:1, trainee:2, 'entry-level':3 }[job.type] ?? 4;
  const expRank = { 'no-experience':0, '0-2-years':1, '2-5-years':3 }[job.experience] ?? 2;
  return typeRank * 10 + expRank;
}

function dedupe(jobs) {
  const urls = new Set();
  const identities = new Set();
  const out = [];
  for (const job of jobs) {
    if (seniorTitlePattern.test(clean(job.title))) continue;
    const url = clean(job.sourceUrl);
    const identity = [normalizeIdentity(job.company), canonicalTitle(job), normalizeIdentity(job.location)].join('|');
    if ((url && urls.has(url)) || identities.has(identity)) continue;
    if (url) urls.add(url);
    identities.add(identity);
    out.push(job);
  }
  return out;
}

const current = JSON.parse(await readFile('data/jobs.json','utf8'));
let status = {};
try { status = JSON.parse(await readFile('data/collector-status.json','utf8')); } catch {}
const discovered = [];
const errors = [];
const sourceStats = [];
let sourcesSucceeded = 0;

for (const source of sources) {
  const sourceLinks = new Set();
  const stats = {
    company: source.company,
    listingPagesAttempted: 0,
    listingPagesSucceeded: 0,
    candidateLinks: 0,
    detailPagesAttempted: 0,
    detailPagesSucceeded: 0,
    detailPagesFailed: 0,
    discovered: 0
  };

  for (const listing of source.listings) {
    stats.listingPagesAttempted += 1;
    try {
      const html = await fetchText(listing);
      stats.listingPagesSucceeded += 1;
      for (const link of discoverJobLinks(html, listing, source.allow)) sourceLinks.add(link);
    } catch (error) {
      errors.push(`${source.company} listing: ${error.message}`);
    }
  }

  stats.candidateLinks = sourceLinks.size;
  if (stats.listingPagesSucceeded > 0) sourcesSucceeded += 1;

  for (const link of [...sourceLinks].slice(0,50)) {
    stats.detailPagesAttempted += 1;
    try {
      const job = await hydrate(source, link);
      stats.detailPagesSucceeded += 1;
      if (job) {
        discovered.push(job);
        stats.discovered += 1;
      }
    } catch (error) {
      stats.detailPagesFailed += 1;
      errors.push(`${source.company} job: ${error.message}`);
    }
  }

  sourceStats.push(stats);
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
  .sort((a,b) => priority(a) - priority(b) || (a.postedHours??9999) - (b.postedHours??9999));

const countsByType = merged.reduce((acc, job) => { acc[job.type] = (acc[job.type] || 0) + 1; return acc; }, {});
const countsByExperience = merged.reduce((acc, job) => { acc[job.experience] = (acc[job.experience] || 0) + 1; return acc; }, {});
await writeFile('data/jobs.json', JSON.stringify(merged, null, 2) + '\n');
await writeFile('data/collector-status.json', JSON.stringify({
  ...status,
  updatedAt:new Date().toISOString(),
  jobs:merged.length,
  countsByType,
  countsByExperience,
  earlyCareerDiscovery:{
    sourcesAttempted:sources.length,
    sourcesSucceeded,
    discovered:discovered.length,
    companies:sources.map(source => source.company),
    sourceStats,
    errors
  }
}, null, 2) + '\n');
console.log(`Early-career pass added ${discovered.length} current roles; ${sourcesSucceeded}/${sources.length} sources reachable; final feed has ${merged.length} jobs.`);
if (errors.length) console.warn(`Early-career source warnings: ${errors.join(' | ')}`);
