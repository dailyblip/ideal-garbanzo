import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const COMPANY = 'Equinix';
const listings = [
  'https://careers.equinix.com/internships',
  'https://careers.equinix.com/hiring-operations-us-equinix',
  ...[1,2,3,4].map(page => `https://careers.equinix.com/jobs/search?country_codes%5B%5D=US&page=${page}&query=data+center`),
  'https://careers.equinix.com/jobs/search?country_codes%5B%5D=US&page=1&query=skillbridge'
];

const titleAllow = /data\s*center|datacenter|critical facilit|customer operations|logistics technician|skillbridge|apprentice|intern|trainee/i;
const titleExclude = /\b(?:senior|sr\.?|lead|principal|manager|director|vice president|vp|head of|staff|supervisor|superintendent|foreman|architect|sales|account executive)\b|\b(?:IV|V|VI)\b/i;
const earlyTitle = /intern|apprentice|trainee|skillbridge|fellowship|work.?based learning|co-?op/i;
const contextTerms = [
  'data center','datacenter','data centre','critical facilities','critical facility','critical environment','ibx',
  'rack and stack','structured cabling','fiber','cross-connect','cross connect','switchgear','ups','generator',
  'bms','epms','hvac','chiller','colocation','mission critical','customer installations'
];
const noExperienceTerms = [
  'no experience','entry level','entry-level','high school diploma','high school or equivalent',
  'high school diploma or equivalent','training program','learning program','skillbridge'
];

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
const hash = value => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 14);
const hasAny = (text, terms) => terms.some(term => text.includes(term));
const isAllowedTitle = title => Boolean(clean(title)) && titleAllow.test(clean(title)) && !titleExclude.test(clean(title));

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'DataCenterCareersBot/1.8 (+https://dailyblip.github.io/ideal-garbanzo/)'
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

function discoverCandidates(html, baseUrl) {
  const found = new Map();
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = clean(match[1]);
    const label = clean(match[2]);
    if (!href || !titleAllow.test(`${label} ${href}`)) continue;
    let url;
    try { url = new URL(href, baseUrl).href; } catch { continue; }
    if (!/^https:\/\/careers\.equinix\.com\/(?:[a-z]{2}\/)?jobs\//i.test(url)) continue;
    if (/\/jobs\/search(?:[/?]|$)/i.test(url)) continue;
    const previous = found.get(url) || '';
    if (isAllowedTitle(label) || !previous) found.set(url, label);
  }
  return found;
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
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const found = findJobPosting(child);
      if (found) return found;
    }
  }
  return null;
}

function extractPosting(html) {
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const found = findJobPosting(JSON.parse(match[1].trim()));
      if (found) return found;
    } catch {}
  }
  return null;
}

function rawPageTitle(html) {
  return clean(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s*\|\s*Equinix.*$/i, '').trim();
}

function parsePageTitle(raw) {
  const segments = clean(raw).split(/\s+-\s+/).map(clean).filter(Boolean);
  const firstLocation = segments.findIndex(segment => /,\s*[^,]+,\s*United States$/i.test(segment));
  if (firstLocation < 0) return { title: clean(raw), locations: [] };
  return {
    title: segments.slice(0, firstLocation).join(' - '),
    locations: [...new Set(
      segments.slice(firstLocation)
        .filter(segment => /,\s*[^,]+,\s*United States$/i.test(segment))
        .map(segment => segment.replace(/,\s*United States$/i, '').trim())
    )]
  };
}

function headingCandidates(html) {
  const values = [];
  for (const match of html.matchAll(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/gi)) {
    const value = clean(match[1]);
    if (value.length >= 5 && value.length <= 180 && isAllowedTitle(value) && !/jobs in|operations jobs|search/i.test(value)) values.push(value);
  }
  return [...new Set(values)].sort((a, b) => {
    const aRole = /technician|engineer|trainee|intern|apprentice|skillbridge/i.test(a) ? 1 : 0;
    const bRole = /technician|engineer|trainee|intern|apprentice|skillbridge/i.test(b) ? 1 : 0;
    return bRole - aRole || b.length - a.length;
  });
}

function postingLocation(posting) {
  const entries = Array.isArray(posting?.jobLocation) ? posting.jobLocation : [posting?.jobLocation].filter(Boolean);
  const locations = [];
  let us = false;
  for (const entry of entries) {
    const address = entry?.address || entry || {};
    const country = clean(typeof address.addressCountry === 'object' ? address.addressCountry?.name : address.addressCountry);
    if (/united states|\busa?\b/i.test(country)) us = true;
    const label = [address.addressLocality, address.addressRegion].map(clean).filter(Boolean).join(', ');
    if (label) locations.push(label);
  }
  return { locations: [...new Set(locations)], us };
}

function experienceRange(text) {
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
  return { min: mins.length ? Math.min(...mins) : null, max: maxes.length ? Math.max(...maxes) : null };
}

function classify(title, description) {
  const t = lower(title);
  const text = lower(`${title} ${description}`);
  if (!isAllowedTitle(title)) return { drop: 'title' };
  if (!hasAny(text, contextTerms)) return { drop: 'context' };
  const years = experienceRange(text);
  if (years.min != null && years.min > 5) return { drop: 'experience' };

  let type = 'entry-level';
  if (/apprentice/.test(t)) type = 'apprenticeship';
  else if (/intern|co-?op/.test(t)) type = 'internship';
  else if (/trainee|skillbridge|fellowship|work.?based learning/.test(t)) type = 'trainee';

  let experience;
  if (years.min != null) experience = years.min <= 2 ? '0-2-years' : '2-5-years';
  else if (earlyTitle.test(title)) experience = hasAny(text, noExperienceTerms) ? 'no-experience' : '0-2-years';
  else if (hasAny(text, noExperienceTerms)) experience = 'no-experience';
  else return { drop: 'unknown-experience' };
  return { type, experience };
}

function payFromPosting(posting, description) {
  const salary = posting?.baseSalary?.value || posting?.baseSalary;
  const lo = Number(salary?.minValue ?? salary?.value?.minValue);
  const hi = Number(salary?.maxValue ?? salary?.value?.maxValue);
  const unit = clean(salary?.unitText || salary?.value?.unitText || posting?.baseSalary?.unitText);
  if (Number.isFinite(lo) && Number.isFinite(hi)) {
    const hourly = /hour/i.test(unit);
    return { pay: `$${lo.toLocaleString('en-US')}–$${hi.toLocaleString('en-US')} / ${hourly ? 'hr' : 'year'}`, salaryMin: lo, salaryMax: hi, salarySortMax: hourly ? Math.round(hi * 2080) : hi };
  }
  const match = clean(description).match(/(?:\$\s*)?([\d]{2,3},[\d]{3})\s*(?:-|–|to)\s*(?:\$\s*)?([\d]{2,3},[\d]{3})\s*(?:USD)?\s*\/\s*(Annual|Year|Hourly|Hour)/i);
  if (!match) return { pay: 'Pay not listed', salaryMin: null, salaryMax: null, salarySortMax: null };
  const min = Number(match[1].replace(/,/g, ''));
  const max = Number(match[2].replace(/,/g, ''));
  const hourly = /hour/i.test(match[3]);
  return { pay: `$${min.toLocaleString('en-US')}–$${max.toLocaleString('en-US')} / ${hourly ? 'hr' : 'year'}`, salaryMin: min, salaryMax: max, salarySortMax: hourly ? Math.round(max * 2080) : max };
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
  return [...new Set(tags)].slice(0, 5);
}

function chooseTitle(posting, listingLabel, metaTitle, headings) {
  const candidates = [posting?.title, posting?.name, listingLabel, metaTitle, ...headings].map(clean).filter(Boolean);
  return candidates.find(isAllowedTitle) || candidates[0] || '';
}

async function hydrate(url, listingLabel) {
  const html = await fetchText(url);
  const posting = extractPosting(html);
  const page = rawPageTitle(html);
  const meta = parsePageTitle(page);
  const headings = headingCandidates(html);
  const title = chooseTitle(posting, listingLabel, meta.title, headings);
  const description = clean(posting?.description || posting?.responsibilities || html);
  const cls = classify(title, description);
  if (cls.drop) return { drop: cls.drop, sample: { title, listingLabel, pageTitle: page, heading: headings[0] || '', url } };

  const structured = postingLocation(posting);
  const locations = structured.locations.length ? structured.locations : meta.locations;
  if (!(structured.us || meta.locations.length || /United States/i.test(page))) return { drop: 'non-us', sample: { title, url } };

  let postedAt = null;
  if (posting?.datePosted) {
    const date = new Date(posting.datePosted);
    if (!Number.isNaN(date.getTime())) postedAt = date.toISOString();
  }

  return {
    job: {
      id: `equinix-${hash(url)}`,
      title,
      company: COMPANY,
      location: [...new Set(locations)].join('; ') || 'United States',
      type: cls.type,
      experience: cls.experience,
      tags: tagsFor(title, description, cls),
      ...payFromPosting(posting, description),
      postedAt,
      source: 'Equinix official careers',
      sourceUrl: url,
      active: true,
      demo: false
    }
  };
}

function canonicalTitle(job) {
  let title = clean(job.title);
  const locationTokens = new Set(normalize(job.location).split(' ').filter(token => token.length > 1));
  title = title.replace(/\s+[-–—]\s+([^|]+)$/u, (full, tail) => {
    const tokens = normalize(tail).split(' ').filter(token => token.length > 1);
    return tokens.length && tokens.every(token => locationTokens.has(token)) ? '' : full;
  });
  return normalize(title);
}

function dedupe(jobs) {
  const urls = new Set();
  const identities = new Set();
  const out = [];
  for (const job of jobs) {
    if (titleExclude.test(clean(job.title))) continue;
    const url = clean(job.sourceUrl);
    const identity = [normalize(job.company), canonicalTitle(job), normalize(job.location)].join('|');
    if ((url && urls.has(url)) || identities.has(identity)) continue;
    if (url) urls.add(url);
    identities.add(identity);
    out.push(job);
  }
  return out;
}

const priority = job => ({ apprenticeship: 0, internship: 1, trainee: 2, 'entry-level': 3 }[job.type] ?? 4) * 10 + ({ 'no-experience': 0, '0-2-years': 1, '2-5-years': 3 }[job.experience] ?? 2);

const current = JSON.parse(await readFile('data/jobs.json', 'utf8'));
let status = {};
try { status = JSON.parse(await readFile('data/collector-status.json', 'utf8')); } catch {}

const candidates = new Map();
const errors = [];
const drops = {};
const dropSamples = [];
let listingPagesSucceeded = 0;
for (const listing of listings) {
  try {
    const html = await fetchText(listing);
    for (const [url, label] of discoverCandidates(html, listing)) {
      const existing = candidates.get(url) || '';
      if (isAllowedTitle(label) || !existing) candidates.set(url, label);
    }
    listingPagesSucceeded += 1;
  } catch (error) {
    errors.push(`listing ${listing}: ${error.message}`);
  }
}

const discovered = [];
for (const [url, label] of [...candidates.entries()].slice(0, 90)) {
  try {
    const result = await hydrate(url, label);
    if (result.job) discovered.push(result.job);
    else if (result.drop) {
      drops[result.drop] = (drops[result.drop] || 0) + 1;
      if (result.sample && dropSamples.length < 8) dropSamples.push(result.sample);
    }
  } catch (error) {
    errors.push(`job ${url}: ${error.message}`);
  }
}

let merged = dedupe([...discovered, ...current]);
const now = Date.now();
for (const job of merged) {
  job.postedHours = job.postedAt ? Math.max(0, Math.round((now - new Date(job.postedAt).getTime()) / 36e5)) : (job.postedHours ?? 9999);
}
const early = merged.filter(job => job.experience !== '2-5-years');
const mid = merged.filter(job => job.experience === '2-5-years');
const maxMid = Math.max(12, Math.floor(Math.max(early.length, 1) * 0.30));
merged = [...early, ...mid.sort((a, b) => (a.postedHours ?? 9999) - (b.postedHours ?? 9999)).slice(0, maxMid)]
  .sort((a, b) => priority(a) - priority(b) || (a.postedHours ?? 9999) - (b.postedHours ?? 9999));

const countsByType = merged.reduce((acc, job) => { acc[job.type] = (acc[job.type] || 0) + 1; return acc; }, {});
const countsByExperience = merged.reduce((acc, job) => { acc[job.experience] = (acc[job.experience] || 0) + 1; return acc; }, {});

await writeFile('data/jobs.json', JSON.stringify(merged, null, 2) + '\n');
await writeFile('data/collector-status.json', JSON.stringify({
  ...status,
  updatedAt: new Date().toISOString(),
  jobs: merged.length,
  countsByType,
  countsByExperience,
  priorityEmployerExpansion: {
    ...(status.priorityEmployerExpansion || {}),
    Equinix: {
      officialSource: 'https://careers.equinix.com/',
      listingPagesAttempted: listings.length,
      listingPagesSucceeded,
      candidateLinks: candidates.size,
      qualifyingRoles: discovered.length,
      drops,
      dropSamples,
      errors
    }
  }
}, null, 2) + '\n');

console.log(`Equinix official-source pass found ${candidates.size} candidates and ${discovered.length} qualifying US roles. Drops: ${JSON.stringify(drops)}`);
if (dropSamples.length) console.log(`Equinix drop samples: ${JSON.stringify(dropSamples)}`);
if (errors.length) console.warn(`Equinix warnings: ${errors.join(' | ')}`);
