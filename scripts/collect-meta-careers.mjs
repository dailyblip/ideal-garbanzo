import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const COMPANY = 'Meta';
const SNAPSHOT_PATH = 'data/meta-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const SEARCH_URLS = [
  'https://www.metacareers.com/jobs?q=data%20center&location=United%20States',
  'https://www.metacareers.com/jobsearch/?teams%5B0%5D=Data%20Center'
];
const SITEMAP_URL = 'https://www.metacareers.com/jobsearch/sitemap.xml';
const DETAIL_BATCH_SIZE = 8;
const MAX_SITEMAP_DETAILS = 700;

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

const relevantTitlePattern = /(?:data cent(?:er|re)|critical facilit(?:y|ies)|critical environment|facility operations).*(?:technician|engineer|operations|building)|(?:technician|engineer|operations|building).*(?:data cent(?:er|re)|critical facilit(?:y|ies)|critical environment)/i;
const excludedTitlePattern = /\b(?:senior|sr\.?|lead|principal|chief|manager|mgr\.?|director|vice president|vp|head of|staff engineer|supervisor|architect|program manager|project manager|product manager|capacity manager|partnerships?|strategy|counsel|attorney|recruiter|sales)\b/i;
const physicalContextPattern = /\b(?:server hardware|rack(?:s|ing)?|break[ /-]?fix|critical systems?|critical facilit(?:y|ies)|electrical|mechanical|ups|generator|switchgear|hvac|cooling|chiller|maintenance|facility operations|data center operations|production operations|work orders?|preventive maintenance|controls systems?)\b/i;
const experiencePattern = /\b(\d{1,2})\s*\+?\s*years?\s+(?:of\s+)?(?:[A-Za-z0-9/&+(),.'’\-]+\s+){0,10}experience\b/gi;
const usStatePattern = /(?:,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b|\b(?:Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|District of Columbia)\b)/i;

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

async function fetchText(url, accept = 'text/html,application/xhtml+xml') {
  const response = await fetch(url, {
    headers: {
      accept,
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': 'facebookexternalhit/1.1 (+https://datacentercareers.us/)'
    },
    redirect: 'follow'
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

function metaContent(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta\\b[^>]*(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["'][^>]*>`, 'i'),
    new RegExp(`<meta\\b[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${escaped}["'][^>]*>`, 'i')
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return clean(match[1]);
  }
  return '';
}

function canonicalJobUrl(value, id = '') {
  const raw = clean(value);
  const candidate = raw || (id ? `https://www.metacareers.com/profile/job_details/${id}/` : '');
  if (!candidate) return '';
  try {
    const parsed = new URL(candidate, 'https://www.metacareers.com/');
    if (!/(^|\.)metacareers\.com$/i.test(parsed.hostname)) return '';
    const match = parsed.pathname.match(/\/(?:profile\/job_details|jobs)\/(\d+)/i);
    const jobId = match?.[1] || String(id || '').match(/^\d+$/)?.[0];
    return jobId ? `https://www.metacareers.com/profile/job_details/${jobId}/` : '';
  } catch {
    return '';
  }
}

function extractId(value) {
  const match = String(value || '').match(/(?:job_details|jobs)\/(\d+)/i);
  return match?.[1] || '';
}

function locationStrings(value) {
  const out = [];
  const add = item => {
    if (typeof item === 'string' && clean(item)) out.push(clean(item));
    else if (item && typeof item === 'object') {
      for (const key of ['name','label','display_name','displayName','city','location']) {
        if (typeof item[key] === 'string' && clean(item[key])) out.push(clean(item[key]));
      }
    }
  };
  if (Array.isArray(value)) value.forEach(add);
  else add(value);
  return out;
}

function findJobObjects(node, out = [], seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) findJobObjects(item, out, seen);
    return out;
  }

  const title = clean(node.title || node.name || node.job_title || node.jobTitle);
  const rawId = clean(node.id || node.req_id || node.reqId || node.job_id || node.jobId);
  const rawUrl = clean(node.url || node.job_url || node.jobUrl || node.href);
  const url = canonicalJobUrl(rawUrl, rawId);
  const id = extractId(url) || (/^\d{6,}$/.test(rawId) ? rawId : '');
  const locations = [
    ...locationStrings(node.locations),
    ...locationStrings(node.location),
    ...locationStrings(node.office_locations),
    ...locationStrings(node.offices)
  ];
  const teams = [
    ...locationStrings(node.teams),
    ...locationStrings(node.team),
    ...locationStrings(node.sub_teams),
    ...locationStrings(node.department)
  ];
  if (title && id && url) out.push({ id, title, url, locations, teams, raw: node });

  for (const value of Object.values(node)) findJobObjects(value, out, seen);
  return out;
}

function parseEmbeddedCandidates(html) {
  const objects = [];
  const scriptPatterns = [
    /<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/gi,
    /<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi
  ];
  for (const pattern of scriptPatterns) {
    for (const match of html.matchAll(pattern)) {
      try { objects.push(JSON.parse(match[1])); } catch {}
    }
  }
  const rows = [];
  for (const object of objects) findJobObjects(object, rows);
  return rows;
}

function parseSitemap(html) {
  const rows = [];
  const seen = new Set();
  for (const match of html.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)) {
    const url = canonicalJobUrl(clean(match[1]));
    const id = extractId(url);
    if (!url || !id || seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, url });
  }
  return rows;
}

function isUsLocation(value) {
  const text = clean(value);
  return /\b(?:United States|USA|US)\b/i.test(text) || usStatePattern.test(text);
}

function normalizeLocation(value) {
  return clean(value)
    .replace(/,?\s*(?:United States(?: of America)?|USA|US)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function selectUsLocation(locations, detailText = '') {
  for (const location of locations || []) {
    if (isUsLocation(location)) return normalizeLocation(location);
  }
  const matches = clean(detailText).match(/[A-Z][A-Za-z.'’()\- ]{1,80},\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/g);
  return matches?.length ? normalizeLocation(matches[0]) : '';
}

function experienceYears(text) {
  experiencePattern.lastIndex = 0;
  return [...String(text || '').matchAll(experiencePattern)]
    .map(match => Number(match[1]))
    .filter(years => Number.isFinite(years) && years >= 0);
}

function classify(title, detailText) {
  const t = lower(title);
  let type = 'entry-level';
  if (/intern(?:ship)?\b/.test(t)) type = 'internship';
  else if (/apprentice/.test(t)) type = 'apprenticeship';
  else if (/trainee|developmental program|skillbridge/.test(t)) type = 'trainee';

  const years = experienceYears(detailText);
  const maxYears = years.length ? Math.max(...years) : null;
  if (type !== 'entry-level' && (!Number.isFinite(maxYears) || maxYears <= 1)) {
    return { type, experience: /apprentice|trainee|developmental program|skillbridge/.test(t) ? 'no-experience' : '0-2-years', maxYears };
  }
  if (!Number.isFinite(maxYears)) return null;
  if (maxYears > 5) return null;
  return { type, experience: maxYears >= 3 ? '2-5-years' : '0-2-years', maxYears };
}

function parsePay(text) {
  const value = clean(text);
  const range = value.match(/\$([\d,]{2,})\s*(?:\/\s*(?:year|yr))?\s*(?:-|–|—|to)\s*\$([\d,]{2,})(?:\s*\/\s*(?:year|yr))?/i);
  if (!range) return { pay: 'Pay not listed', salaryMin: null, salaryMax: null, salarySortMax: null };
  const salaryMin = Number(range[1].replace(/,/g, ''));
  const salaryMax = Number(range[2].replace(/,/g, ''));
  if (!Number.isFinite(salaryMin) || !Number.isFinite(salaryMax) || salaryMax < 10000) {
    return { pay: 'Pay not listed', salaryMin: null, salaryMax: null, salarySortMax: null };
  }
  return {
    pay: `$${salaryMin.toLocaleString('en-US')}–$${salaryMax.toLocaleString('en-US')} / year`,
    salaryMin,
    salaryMax,
    salarySortMax: salaryMax
  };
}

function tagsFor(title, experience, type, detailText) {
  const text = lower(`${title} ${detailText}`);
  const tags = [];
  if (type === 'internship') tags.push('Internship');
  if (type === 'apprenticeship') tags.push('Apprenticeship');
  if (type === 'trainee') tags.push('Trainee');
  if (experience === 'no-experience') tags.push('No Experience Needed');
  else tags.push(experience === '2-5-years' ? '2–5 Years' : '0–2 Years');
  if (/electrical|ups|generator|switchgear/.test(text)) tags.push('Electrical');
  if (/mechanical|hvac|cooling|chiller|critical facilit|facility operations/.test(text)) tags.push('Critical Facilities');
  if (/server hardware|rack|production operations|data center operations/.test(text)) tags.push('Data Center Operations');
  if (/training|trainee|apprentice|developmental|skillbridge/.test(text)) tags.push('Training / Mentorship');
  return [...new Set(tags)].slice(0, 5);
}

function missionFit(title, detailText = '', teams = []) {
  if (!relevantTitlePattern.test(title) || excludedTitlePattern.test(title)) return false;
  const teamText = (teams || []).join(' ');
  return /data center/i.test(teamText) || physicalContextPattern.test(`${title} ${detailText}`);
}

function extractDetail(html, seed, diagnostics) {
  const embedded = parseEmbeddedCandidates(html).find(row => row.id === seed.id) || {};
  const title = clean(embedded.title || metaContent(html, 'og:title') || metaContent(html, 'twitter:title') || seed.title || '')
    .replace(/\s*[|–—-]\s*Meta Careers\s*$/i, '')
    .trim();
  const description = clean(metaContent(html, 'og:description') || metaContent(html, 'description') || '');
  const pageText = clean(html);
  const detailText = clean(`${description} ${pageText.slice(0, 40000)}`);
  const teams = [...new Set([...(seed.teams || []), ...(embedded.teams || [])])];
  if (!title || !missionFit(title, detailText, teams)) {
    diagnostics.drops.titleOrContext += 1;
    return null;
  }

  const locations = [...new Set([...(seed.locations || []), ...(embedded.locations || [])])];
  const location = selectUsLocation(locations, detailText);
  if (!location) {
    diagnostics.drops.nonUsOrUnknownLocation += 1;
    return null;
  }

  const cls = classify(title, detailText);
  if (!cls) {
    diagnostics.drops.experience += 1;
    return null;
  }

  const pay = parsePay(detailText);
  diagnostics.verified += 1;
  return {
    id: `meta-${seed.id || hash(seed.url)}`,
    title,
    company: COMPANY,
    location,
    type: cls.type,
    experience: cls.experience,
    tags: tagsFor(title, cls.experience, cls.type, detailText),
    ...pay,
    postedAt: null,
    source: 'Meta Careers',
    sourceUrl: canonicalJobUrl(seed.url, seed.id),
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
const previousById = new Map(previousSnapshot.map(job => [String(job.id || '').replace(/^meta-/, ''), job]));
const errors = [];
const diagnostics = {
  searchPagesAttempted: 0,
  searchPagesSucceeded: 0,
  embeddedCandidates: 0,
  sitemapFetched: false,
  sitemapJobs: 0,
  detailAttempted: 0,
  detailSucceeded: 0,
  reusedFromSitemap: 0,
  verified: 0,
  drops: { titleOrContext: 0, nonUsOrUnknownLocation: 0, experience: 0, fetch: 0 }
};
let sourceHealthy = false;
const seeds = new Map();

for (const url of SEARCH_URLS) {
  diagnostics.searchPagesAttempted += 1;
  try {
    const html = await fetchText(url);
    diagnostics.searchPagesSucceeded += 1;
    const rows = parseEmbeddedCandidates(html);
    diagnostics.embeddedCandidates += rows.length;
    for (const row of rows) {
      if (!seeds.has(row.id)) seeds.set(row.id, row);
    }
    sourceHealthy = true;
  } catch (error) {
    errors.push(`search ${url}: ${error.message}`);
  }
}

let sitemapRows = [];
try {
  const sitemap = await fetchText(SITEMAP_URL, 'application/xml,text/xml,*/*');
  sitemapRows = parseSitemap(sitemap);
  diagnostics.sitemapFetched = true;
  diagnostics.sitemapJobs = sitemapRows.length;
  if (sitemapRows.length) sourceHealthy = true;
  for (const row of sitemapRows) {
    if (!seeds.has(row.id)) seeds.set(row.id, { ...row, title: '', locations: [], teams: [] });
  }
} catch (error) {
  errors.push(`sitemap: ${error.message}`);
}

const activeIds = new Set(sitemapRows.map(row => row.id));
const verified = [];
if (diagnostics.sitemapFetched && activeIds.size) {
  for (const [id, job] of previousById) {
    if (activeIds.has(id)) {
      verified.push({ ...job, active: true, demo: false });
      diagnostics.reusedFromSitemap += 1;
    }
  }
}

const existingIds = new Set(verified.map(job => String(job.id || '').replace(/^meta-/, '')));
const detailSeeds = [...seeds.values()]
  .filter(seed => !existingIds.has(seed.id))
  .slice(0, diagnostics.embeddedCandidates ? Math.max(120, diagnostics.embeddedCandidates) : MAX_SITEMAP_DETAILS);

for (let i = 0; i < detailSeeds.length; i += DETAIL_BATCH_SIZE) {
  const batch = detailSeeds.slice(i, i + DETAIL_BATCH_SIZE);
  const settled = await Promise.all(batch.map(async seed => {
    diagnostics.detailAttempted += 1;
    try {
      const html = await fetchText(seed.url);
      diagnostics.detailSucceeded += 1;
      return extractDetail(html, seed, diagnostics);
    } catch (error) {
      diagnostics.drops.fetch += 1;
      if (errors.length < 40) errors.push(`detail ${seed.id}: ${error.message}`);
      return null;
    }
  }));
  verified.push(...settled.filter(Boolean));
  if (diagnostics.detailAttempted >= 40 && diagnostics.detailSucceeded === 0) break;
}

let snapshot;
if (!sourceHealthy) {
  snapshot = previousSnapshot;
  if (previousSnapshot.length) errors.push('Retained previous Meta snapshot because the official source could not be reached.');
} else if (diagnostics.sitemapFetched && activeIds.size) {
  snapshot = dedupe(verified).filter(job => activeIds.has(String(job.id).replace(/^meta-/, '')));
} else if (verified.length) {
  snapshot = dedupe(verified);
} else {
  snapshot = previousSnapshot;
  if (previousSnapshot.length) errors.push('Retained previous Meta snapshot because no current qualifying details could be verified.');
}

const withoutMeta = currentJobs.filter(job => job.company !== COMPANY && !/(^|\.)metacareers\.com\//i.test(String(job.sourceUrl || '')));
const merged = dedupe([...withoutMeta, ...snapshot]);
const now = Date.now();
for (const job of merged) {
  job.postedHours = job.postedAt ? Math.max(0, Math.round((now - new Date(job.postedAt).getTime()) / 36e5)) : (job.postedHours ?? 9999);
}

const countsByType = merged.reduce((acc, job) => { acc[job.type] = (acc[job.type] || 0) + 1; return acc; }, {});
const countsByExperience = merged.reduce((acc, job) => { acc[job.experience] = (acc[job.experience] || 0) + 1; return acc; }, {});
const cleanGlobalErrors = (priorStatus.errors || []).filter(error => !String(error).startsWith('Meta Careers:'));

await writeFile(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n');
await writeFile(JOBS_PATH, JSON.stringify(merged, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify({
  ...priorStatus,
  updatedAt: new Date().toISOString(),
  jobs: merged.length,
  sourcesAttempted: Number(priorStatus.sourcesAttempted || 0) + 1,
  providers: {
    ...(priorStatus.providers || {}),
    metaCareers: Number(priorStatus.providers?.metaCareers || 0) + 1
  },
  countsByType,
  countsByExperience,
  metaCareers: {
    officialSource: 'https://www.metacareers.com/jobsearch/',
    sourceHealthy,
    qualifyingRoles: snapshot.length,
    diagnostics,
    errors
  },
  errors: [...cleanGlobalErrors, ...errors.map(error => `Meta Careers: ${error}`)]
}, null, 2) + '\n');

console.log(`Meta Careers ${sourceHealthy ? 'checked' : 'degraded'}; ${snapshot.length} verified U.S. 0–5 year data-center roles; ${merged.length} total jobs.`);
if (errors.length) console.warn(`Meta Careers warnings: ${errors.join(' | ')}`);
