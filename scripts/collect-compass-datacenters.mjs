import { readFile, writeFile } from 'node:fs/promises';

const COMPANY = 'Compass Datacenters';
const BOARD_URL = 'https://compass-datacenters.breezy.hr/';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const DETAIL_BATCH = 6;

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

const allowedTitle = /\b(?:data cent(?:er|re)|critical facilit(?:y|ies)|facilit(?:y|ies)|electrical|mechanical|controls?|commissioning|maintenance|operations?)\b.*\b(?:technician|engineer|specialist|operator|apprentice|intern|trainee)\b|\b(?:technician|engineer|specialist|operator|apprentice|intern|trainee)\b.*\b(?:data cent(?:er|re)|critical facilit(?:y|ies)|facilit(?:y|ies)|electrical|mechanical|controls?|commissioning|maintenance|operations?)\b/i;
const excludedTitle = /\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|architect|security|sales|finance|marketing)\b/i;
const dataCenterContext = /\b(?:data cent(?:er|re)|critical facilit(?:y|ies)|mission[- ]critical|ups|switchgear|generator|chiller|cooling|bms|building management system|power distribution|electrical distribution)\b/i;

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

function positionLinks(html = '') {
  const links = new Set();
  for (const match of String(html).matchAll(/href=["']([^"']*\/p\/[a-z0-9-]+)["']/gi)) {
    try {
      const url = new URL(match[1], BOARD_URL);
      if (url.hostname === 'compass-datacenters.breezy.hr' && /^\/p\/[a-z0-9-]+\/?$/i.test(url.pathname)) {
        url.search = '';
        url.hash = '';
        links.add(url.toString());
      }
    } catch {}
  }
  return [...links];
}

function jobPostingFrom(html = '') {
  const blocks = [...String(html).matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    const raw = block[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of candidates) {
        if (item?.['@type'] === 'JobPosting') return item;
        if (Array.isArray(item?.['@graph'])) {
          const found = item['@graph'].find(node => node?.['@type'] === 'JobPosting');
          if (found) return found;
        }
      }
    } catch {}
  }
  return null;
}

function schemaText(value) {
  if (Array.isArray(value)) return value.map(schemaText).filter(Boolean).join(' ');
  if (value && typeof value === 'object') return Object.values(value).map(schemaText).filter(Boolean).join(' ');
  return clean(value);
}

function locationFrom(schema = {}) {
  if (String(schema.jobLocationType || '').toUpperCase() === 'TELECOMMUTE') return 'Remote';
  const locations = Array.isArray(schema.jobLocation) ? schema.jobLocation : [schema.jobLocation].filter(Boolean);
  for (const place of locations) {
    const address = place?.address || place || {};
    const country = clean(address.addressCountry?.name || address.addressCountry || '');
    if (country && !/^(?:US|USA|United States(?: of America)?)$/i.test(country)) continue;
    const city = clean(address.addressLocality || '');
    const region = clean(address.addressRegion || '');
    if (city && region) return `${city}, ${region}`;
    if (region) return `${region}, United States`;
  }
  return '';
}

function statedExperience(description = '') {
  const text = clean(description);
  const values = [];
  const patterns = [
    /\b(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\s+years?['’]?\s*(?:of\s+)?(?:relevant\s+|related\s+|professional\s+|data\s+cent(?:er|re)\s+|critical\s+facilit(?:y|ies)\s+)?experience\b/gi,
    /\b(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\+?\s+years?['’]?\s*(?:of\s+)?(?:relevant\s+|related\s+|professional\s+|data\s+cent(?:er|re)\s+|critical\s+facilit(?:y|ies)\s+)?experience\b/gi,
    /\bexperience\s+(?:of\s+)?(?:at least\s+|minimum(?: of)?\s+)?(\d{1,2})\+?\s+years?\b/gi
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      values.push(Number(match[1]));
      if (match[2]) values.push(Number(match[2]));
    }
  }
  const years = values.filter(value => Number.isFinite(value) && value >= 0 && value <= 50);
  if (!years.length) return null;
  return { min: Math.min(...years), max: Math.max(...years) };
}

function classify(title, description) {
  const t = clean(title);
  const d = clean(description);
  if (!allowedTitle.test(t) || excludedTitle.test(t) || !dataCenterContext.test(`${t} ${d}`)) {
    return { cls: null, reason: 'title-or-context' };
  }

  const earlyProgram = /\b(?:intern(?:ship)?|apprentice(?:ship)?|trainee|work[- ]based learning)\b/i.test(t);
  const years = statedExperience(d);
  if (!years && !earlyProgram) return { cls: null, reason: 'experience-unknown' };
  if (years && (years.min > 5 || years.max > 5)) return { cls: null, reason: 'experience-over-5' };

  let type = 'entry-level';
  if (/intern(?:ship)?/i.test(t)) type = 'internship';
  else if (/apprentice/i.test(t)) type = 'apprenticeship';
  else if (/trainee|work[- ]based learning/i.test(t)) type = 'trainee';

  let experience = '0-2-years';
  if (/\b(?:no experience|experience (?:is )?not required|entry[- ]level)\b/i.test(d)) experience = 'no-experience';
  else if (years && years.min >= 3) experience = '2-5-years';

  return { cls: { type, experience }, reason: '' };
}

function payFrom(schema = {}, description = '') {
  const salary = schema.baseSalary;
  const values = Array.isArray(salary) ? salary : [salary].filter(Boolean);
  for (const item of values) {
    const currency = clean(item?.currency || 'USD') || 'USD';
    const value = item?.value || item;
    const min = Number(value?.minValue ?? value?.value);
    const max = Number(value?.maxValue ?? value?.value);
    const unit = String(value?.unitText || '').toUpperCase();
    if (currency === 'USD' && (Number.isFinite(min) || Number.isFinite(max))) {
      const low = Number.isFinite(min) ? min : max;
      const high = Number.isFinite(max) ? max : min;
      const annual = unit === 'YEAR' || unit === 'ANNUAL' || (!unit && high >= 1000);
      return {
        pay: `$${low.toLocaleString('en-US')}–$${high.toLocaleString('en-US')} / ${annual ? 'year' : 'hr'}`,
        salaryMin: low,
        salaryMax: high,
        salarySortMax: annual ? high : Math.round(high * 2080)
      };
    }
  }

  const text = clean(description);
  const range = text.match(/\$([\d,.]+)\s*(?:-|–|—|to)\s*\$?([\d,.]+)\s*(?:\/|per\s+)?(hour|hourly|hr|year|yearly|yr|annual|annually)?/i);
  if (!range) return { pay: 'Pay not listed', salaryMin: null, salaryMax: null, salarySortMax: null };
  const min = Number(range[1].replace(/,/g, ''));
  const max = Number(range[2].replace(/,/g, ''));
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { pay: 'Pay not listed', salaryMin: null, salaryMax: null, salarySortMax: null };
  const unit = lower(range[3] || '');
  const annual = /year|yr|annual/.test(unit) || (!unit && max >= 1000);
  return {
    pay: `$${min.toLocaleString('en-US')}–$${max.toLocaleString('en-US')} / ${annual ? 'year' : 'hr'}`,
    salaryMin: min,
    salaryMax: max,
    salarySortMax: annual ? max : Math.round(max * 2080)
  };
}

function tagsFor(title, description, cls) {
  const text = lower(`${title} ${description}`);
  const tags = [];
  if (cls.type === 'internship') tags.push('Internship');
  if (cls.type === 'apprenticeship') tags.push('Apprenticeship');
  if (cls.type === 'trainee') tags.push('Trainee');
  if (cls.experience === 'no-experience') tags.push('No Experience Needed');
  else if (cls.experience === '0-2-years') tags.push('0–2 Years');
  else tags.push('2–5 Years');
  if (/electrical|ups|switchgear|power distribution/.test(text)) tags.push('Electrical');
  if (/mechanical|hvac|cooling|chiller|critical facilit/.test(text)) tags.push('Critical Facilities');
  if (/controls?|bms|building management system/.test(text)) tags.push('Controls / BMS');
  if (/training|learn|mentorship|apprentice|trainee|intern/.test(text)) tags.push('Training / Mentorship');
  return [...new Set(tags)].slice(0, 5);
}

function stableId(url = '') {
  const match = String(url).match(/\/p\/([a-z0-9]+)-/i);
  return match?.[1] || String(url).replace(/[^a-z0-9]/gi, '').slice(-16);
}

function dedupe(jobs) {
  const ids = new Set();
  const urls = new Set();
  const identities = new Set();
  const out = [];
  for (const job of jobs) {
    if (!job || typeof job !== 'object') continue;
    const id = clean(job.id);
    const url = clean(job.sourceUrl);
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
const status = await readJson(STATUS_PATH, {});
const previousSnapshot = currentJobs.filter(job => job.company === COMPANY || /compass-datacenters\.breezy\.hr/i.test(String(job.sourceUrl || '')));
const diagnostics = {
  boardFetched: false,
  listedPositions: 0,
  detailAttempted: 0,
  detailFetched: 0,
  structuredDetails: 0,
  qualifyingRoles: 0,
  preservedPrevious: 0,
  drops: { titleOrContext: 0, nonUs: 0, experienceUnknown: 0, experienceOver5: 0, structuredData: 0, fetch: 0 }
};
const errors = [];
let sourceHealthy = false;
let verified = [];

try {
  const boardHtml = await fetchText(BOARD_URL);
  diagnostics.boardFetched = true;
  const links = positionLinks(boardHtml);
  diagnostics.listedPositions = links.length;
  if (!links.length) throw new Error('Breezy career portal returned no public position links');

  for (let index = 0; index < links.length; index += DETAIL_BATCH) {
    const batch = links.slice(index, index + DETAIL_BATCH);
    const results = await Promise.all(batch.map(async url => {
      diagnostics.detailAttempted += 1;
      try {
        const html = await fetchText(url);
        diagnostics.detailFetched += 1;
        const schema = jobPostingFrom(html);
        if (!schema) {
          diagnostics.drops.structuredData += 1;
          if (errors.length < 25) errors.push(`structured data missing: ${url}`);
          return null;
        }
        diagnostics.structuredDetails += 1;
        const title = clean(schema.title || schema.name || '');
        const description = clean(schema.description || schemaText(schema.responsibilities) || '');
        const location = locationFrom(schema);
        if (!location) { diagnostics.drops.nonUs += 1; return null; }
        const { cls, reason } = classify(title, description);
        if (!cls) {
          if (reason === 'experience-unknown') diagnostics.drops.experienceUnknown += 1;
          else if (reason === 'experience-over-5') diagnostics.drops.experienceOver5 += 1;
          else diagnostics.drops.titleOrContext += 1;
          return null;
        }
        const id = stableId(url);
        if (!id || !title) return null;
        const datePosted = clean(schema.datePosted || '');
        return {
          id: `compass-${id}`,
          title,
          company: COMPANY,
          location,
          type: cls.type,
          experience: cls.experience,
          tags: tagsFor(title, description, cls),
          ...payFrom(schema, description),
          postedAt: /^\d{4}-\d{2}-\d{2}/.test(datePosted) ? new Date(datePosted).toISOString() : null,
          postedHours: 9999,
          source: 'Official Compass Datacenters Careers',
          sourceUrl: url,
          active: true,
          demo: false
        };
      } catch (error) {
        diagnostics.drops.fetch += 1;
        if (errors.length < 25) errors.push(`detail ${url}: ${error.message}`);
        return null;
      }
    }));
    verified.push(...results.filter(Boolean));
  }

  sourceHealthy = diagnostics.boardFetched
    && diagnostics.listedPositions > 0
    && diagnostics.detailFetched > 0
    && diagnostics.structuredDetails >= Math.ceil(diagnostics.detailFetched * 0.5);
  if (!sourceHealthy) errors.push(`Breezy detail coverage was ${diagnostics.structuredDetails}/${diagnostics.detailFetched}`);
} catch (error) {
  errors.push(`listing: ${error.message}`);
}

verified = dedupe(verified);
diagnostics.qualifyingRoles = verified.length;
let nextSnapshot = verified;
if (!sourceHealthy) {
  nextSnapshot = dedupe([...verified, ...previousSnapshot]);
  diagnostics.preservedPrevious = previousSnapshot.length;
}

const withoutCompass = currentJobs.filter(job => job.company !== COMPANY && !/compass-datacenters\.breezy\.hr/i.test(String(job.sourceUrl || '')));
const merged = dedupe([...withoutCompass, ...nextSnapshot]);
const countsByType = merged.reduce((acc, job) => { acc[job.type] = (acc[job.type] || 0) + 1; return acc; }, {});
const countsByExperience = merged.reduce((acc, job) => { acc[job.experience] = (acc[job.experience] || 0) + 1; return acc; }, {});

await writeFile(JOBS_PATH, JSON.stringify(merged, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify({
  ...status,
  jobs: merged.length,
  countsByType,
  countsByExperience,
  compass: {
    officialSource: 'https://www.compassdatacenters.com/about/contact-us/',
    boardUrl: BOARD_URL,
    sourceHealthy,
    ...diagnostics,
    errors
  }
}, null, 2) + '\n');

console.log(`Compass collector found ${verified.length} qualifying U.S. data-center roles from ${diagnostics.listedPositions} public positions; ${merged.length} total jobs after merge.`);
if (errors.length) console.warn(`Compass collector warnings: ${errors.slice(0, 5).join(' | ')}`);
