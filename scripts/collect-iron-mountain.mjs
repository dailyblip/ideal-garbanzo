import { readFile, writeFile } from 'node:fs/promises';

const COMPANY = 'Iron Mountain';
const ORIGIN = 'https://ironmountain.wd5.myworkdayjobs.com';
const TENANT = 'ironmountain';
const SITE = 'iron-mountain-jobs';
const LOCALE = 'en-US';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const PAGE_SIZE = 20;
const MAX_PAGES = 100;
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

const allowedTitle = /\b(?:critical facilit(?:y|ies) technician|data cent(?:er|re)(?: operations)? technician|data cent(?:er|re) operations engineer|data cent(?:er|re) facilities technician)\b/i;
const excludedTitle = /\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|architect)\b/i;
const dataCenterContext = /\b(?:data cent(?:er|re)|critical facilit(?:y|ies)|colocation|mission[- ]critical|ups|switchgear|chiller|cooling|bms|generator)\b/i;

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: 'application/json',
      'user-agent': 'DataCenterCareersBot/1.4 (+https://datacentercareers.us/)',
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

function candidateTitle(title = '') {
  const value = clean(title);
  return Boolean(value) && allowedTitle.test(value) && !excludedTitle.test(value);
}

function sourceUrl(row = {}) {
  const path = String(row.externalPath || '').trim();
  if (!path.startsWith('/job/')) return '';
  return `${ORIGIN}/${LOCALE}/${SITE}${path}`;
}

function detailUrl(row = {}) {
  const path = String(row.externalPath || '').trim();
  if (!path.startsWith('/job/')) return '';
  return `${ORIGIN}/wday/cxs/${TENANT}/${SITE}${path}`;
}

function locationFrom(row = {}, info = {}) {
  const raw = clean(row.locationsText || info.location || info.locationText || '');
  if (!raw) return '';

  const parts = raw.split('|').map(part => clean(part)).filter(Boolean);
  if (parts.length >= 2 && /^US$/i.test(parts[0])) {
    const state = parts[1].toUpperCase();
    const city = clean(parts[2] || '');
    if (city && !/^remote$/i.test(city) && /^[A-Z]{2}$/.test(state)) return `${city}, ${state}`;
    if (/^remote$/i.test(city)) return 'Remote';
    if (/^[A-Z]{2}$/.test(state)) return `${state}, United States`;
  }

  if (/\bUnited States\b/i.test(raw)) return raw.replace(/,?\s*United States\s*$/i, '').trim() || 'United States';
  return '';
}

function statedExperience(description = '') {
  const text = clean(description);
  const values = [];
  const patterns = [
    /\b(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\s+years?['’]?\s*(?:of\s+)?(?:relevant\s+|related\s+|critical\s+operations\s+|data\s+cent(?:er|re)\s+)?experience\b/gi,
    /\b(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\+?\s+years?['’]?\s*(?:of\s+)?(?:relevant\s+|related\s+|critical\s+operations\s+|data\s+cent(?:er|re)\s+)?experience\b/gi,
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
  if (!candidateTitle(t) || !dataCenterContext.test(`${t} ${d}`)) return { cls: null, reason: 'title-or-context' };

  const earlyProgram = /\b(?:skillbridge|intern(?:ship)?|apprentice(?:ship)?|trainee)\b/i.test(t);
  const years = statedExperience(d);
  if (!years && !earlyProgram) return { cls: null, reason: 'experience-unknown' };
  if (years && (years.min > 5 || years.max > 5)) return { cls: null, reason: 'experience-over-5' };

  let type = 'entry-level';
  if (/intern(?:ship)?|skillbridge/i.test(t)) type = 'internship';
  else if (/apprentice/i.test(t)) type = 'apprenticeship';
  else if (/trainee/i.test(t)) type = 'trainee';

  let experience = '0-2-years';
  if (/\b(?:no experience|preferred,? but not required|preferred but not required)\b/i.test(d)) experience = 'no-experience';
  else if (years && years.min >= 3) experience = '2-5-years';

  return { cls: { type, experience }, reason: '' };
}

function payFrom(description = '') {
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

function postedAt(label = '') {
  const text = lower(label);
  const now = Date.now();
  if (!text) return null;
  if (text.includes('today')) return new Date(now).toISOString();
  if (text.includes('yesterday')) return new Date(now - 864e5).toISOString();
  const match = text.match(/(\d+)\+?\s+days?\s+ago/);
  if (match) return new Date(now - Number(match[1]) * 864e5).toISOString();
  return null;
}

function tagsFor(title, description, cls) {
  const text = lower(`${title} ${description}`);
  const tags = [];
  if (cls.type === 'internship') tags.push(/skillbridge/i.test(title) ? 'SkillBridge' : 'Internship');
  if (cls.type === 'apprenticeship') tags.push('Apprenticeship');
  if (cls.type === 'trainee') tags.push('Trainee');
  if (cls.experience === 'no-experience') tags.push('No Experience Needed');
  else if (cls.experience === '0-2-years') tags.push('0–2 Years');
  else tags.push('2–5 Years');
  if (/electrical|ups|switchgear|power distribution/.test(text)) tags.push('Electrical');
  if (/mechanical|hvac|cooling|chiller|critical facilit/.test(text)) tags.push('Critical Facilities');
  if (/training|learn|mentorship|skillbridge/.test(text)) tags.push('Training / Mentorship');
  return [...new Set(tags)].slice(0, 5);
}

function requisitionId(row = {}, info = {}) {
  const bullet = Array.isArray(row.bulletFields) ? row.bulletFields.find(value => /^J\d+/i.test(clean(value))) : '';
  const fromInfo = clean(info.jobReqId || info.jobRequisitionId || info.requisitionId || '');
  const fromPath = String(row.externalPath || '').match(/_(J\d+)\/?$/i)?.[1] || '';
  return clean(bullet || fromInfo || fromPath);
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

async function listJobs() {
  const endpoint = `${ORIGIN}/wday/cxs/${TENANT}/${SITE}/jobs`;
  const rows = [];
  const seen = new Set();
  let offset = 0;
  let total = null;
  let pagesAttempted = 0;
  let pagesSucceeded = 0;
  let complete = false;
  let incompleteReason = '';

  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (Number.isFinite(total) && offset >= total) { complete = true; break; }
    pagesAttempted += 1;
    const payload = await fetchJson(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        referer: `${ORIGIN}/${LOCALE}/${SITE}`
      },
      body: JSON.stringify({ appliedFacets: {}, limit: PAGE_SIZE, offset, searchText: '' })
    });
    pagesSucceeded += 1;

    if (page === 0) {
      const reported = Number(payload.total);
      if (!Number.isFinite(reported) || reported < 0) {
        incompleteReason = 'Workday did not return a valid total count';
        break;
      }
      total = reported;
      if (total === 0) { complete = true; break; }
    }

    const postings = Array.isArray(payload.jobPostings) ? payload.jobPostings : [];
    let fresh = 0;
    for (const row of postings) {
      const key = clean(row.externalPath || row.bulletFields?.[0] || `${row.title}|${row.locationsText}`);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
      fresh += 1;
    }

    offset += postings.length;
    if (offset >= total) { complete = true; break; }
    if (!postings.length) { incompleteReason = `listing ended at ${offset}/${total}`; break; }
    if (postings.length < PAGE_SIZE) { incompleteReason = `short page returned ${postings.length} rows at ${offset}/${total}`; break; }
    if (!fresh) { incompleteReason = `duplicate page before reported total (${offset}/${total})`; break; }
  }

  if (!complete && !incompleteReason) incompleteReason = `pagination cap reached at ${offset}/${total ?? 'unknown'}`;
  return { rows, total, pagesAttempted, pagesSucceeded, complete, incompleteReason };
}

const currentJobs = await readJson(JOBS_PATH, []);
const status = await readJson(STATUS_PATH, {});
const previousSnapshot = currentJobs.filter(job => job.company === COMPANY || /ironmountain\.wd5\.myworkdayjobs\.com/i.test(String(job.sourceUrl || '')));
const diagnostics = {
  listingPagesAttempted: 0,
  listingPagesSucceeded: 0,
  listingComplete: false,
  listedTotal: null,
  candidateRows: 0,
  detailAttempted: 0,
  detailSucceeded: 0,
  qualifyingRoles: 0,
  preservedPrevious: 0,
  drops: { titleOrContext: 0, nonUs: 0, experienceUnknown: 0, experienceOver5: 0, fetch: 0 }
};
const errors = [];
let sourceHealthy = false;
let verified = [];

try {
  const listing = await listJobs();
  diagnostics.listingPagesAttempted = listing.pagesAttempted;
  diagnostics.listingPagesSucceeded = listing.pagesSucceeded;
  diagnostics.listingComplete = listing.complete;
  diagnostics.listedTotal = listing.total;
  sourceHealthy = listing.pagesSucceeded > 0 && listing.rows.length > 0;
  if (!listing.complete) errors.push(`incomplete Workday listing: ${listing.incompleteReason}`);

  const candidates = listing.rows.filter(row => candidateTitle(row.title));
  diagnostics.candidateRows = candidates.length;

  for (let index = 0; index < candidates.length; index += DETAIL_BATCH) {
    const batch = candidates.slice(index, index + DETAIL_BATCH);
    const results = await Promise.all(batch.map(async row => {
      const publicUrl = sourceUrl(row);
      const apiUrl = detailUrl(row);
      if (!publicUrl || !apiUrl) return null;
      diagnostics.detailAttempted += 1;
      try {
        const detail = await fetchJson(apiUrl, { headers: { referer: publicUrl } });
        diagnostics.detailSucceeded += 1;
        const info = detail.jobPostingInfo || detail.jobInfo || detail;
        const description = clean(info.jobDescription || info.description || '');
        const location = locationFrom(row, info);
        if (!location) { diagnostics.drops.nonUs += 1; return null; }
        const { cls, reason } = classify(row.title, description);
        if (!cls) {
          if (reason === 'experience-unknown') diagnostics.drops.experienceUnknown += 1;
          else if (reason === 'experience-over-5') diagnostics.drops.experienceOver5 += 1;
          else diagnostics.drops.titleOrContext += 1;
          return null;
        }
        const reqId = requisitionId(row, info);
        if (!reqId) return null;
        return {
          id: `ironmountain-${reqId}`,
          title: clean(row.title),
          company: COMPANY,
          location,
          type: cls.type,
          experience: cls.experience,
          tags: tagsFor(row.title, description, cls),
          ...payFrom(description),
          postedAt: postedAt(row.postedOn || row.posted || ''),
          postedHours: 9999,
          source: 'Official Iron Mountain Careers',
          sourceUrl: publicUrl,
          active: true,
          demo: false
        };
      } catch (error) {
        diagnostics.drops.fetch += 1;
        if (errors.length < 25) errors.push(`detail ${clean(row.title)}: ${error.message}`);
        return null;
      }
    }));
    verified.push(...results.filter(Boolean));
  }
} catch (error) {
  errors.push(`listing: ${error.message}`);
}

verified = dedupe(verified);
diagnostics.qualifyingRoles = verified.length;
let nextSnapshot = verified;
if (!sourceHealthy || !diagnostics.listingComplete) {
  nextSnapshot = dedupe([...verified, ...previousSnapshot]);
  diagnostics.preservedPrevious = previousSnapshot.length;
}

const withoutIronMountain = currentJobs.filter(job => job.company !== COMPANY && !/ironmountain\.wd5\.myworkdayjobs\.com/i.test(String(job.sourceUrl || '')));
const merged = dedupe([...withoutIronMountain, ...nextSnapshot]);
const countsByType = merged.reduce((acc, job) => { acc[job.type] = (acc[job.type] || 0) + 1; return acc; }, {});
const countsByExperience = merged.reduce((acc, job) => { acc[job.experience] = (acc[job.experience] || 0) + 1; return acc; }, {});

await writeFile(JOBS_PATH, JSON.stringify(merged, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify({
  ...status,
  jobs: merged.length,
  countsByType,
  countsByExperience,
  ironMountain: {
    officialSource: 'https://www.ironmountain.com/data-centers',
    boardUrl: `${ORIGIN}/${LOCALE}/${SITE}`,
    sourceHealthy,
    ...diagnostics,
    errors
  }
}, null, 2) + '\n');

console.log(`Iron Mountain collector found ${verified.length} qualifying U.S. data-center roles; ${merged.length} total jobs after merge.`);
if (errors.length) console.warn(`Iron Mountain collector warnings: ${errors.slice(0, 5).join(' | ')}`);
