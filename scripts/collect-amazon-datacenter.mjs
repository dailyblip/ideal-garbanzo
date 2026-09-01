import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const COMPANY = 'Amazon Web Services';
const SEARCH_ORIGIN = 'https://www.amazon.jobs';
const queries = [
  'data center',
  'data center technician',
  'engineering operations technician',
  'critical facilities',
  'work based learning data center'
];

const strongTitleTerms = [
  'data center', 'datacenter', 'data centre', 'engineering operations technician',
  'critical facilities', 'critical environment', 'infraops', 'dceo'
];
const contextualTitleTerms = [
  'technician', 'operator', 'operations', 'facilities', 'facility', 'electrical',
  'mechanical', 'controls', 'fiber', 'cabling', 'logistics', 'maintenance'
];
const contextTerms = [
  'data center', 'datacenter', 'data centre', 'critical facilities', 'critical environment',
  'server rack', 'rack and stack', 'fiber', 'cabling', 'switchgear', 'ups', 'generator',
  'chiller', 'crah', 'crac', 'mission critical', 'mission-critical', 'infrastructure operations'
];
const excludedTitlePattern = /\b(?:senior|sr\.?|lead|principal|manager|director|vice president|vp|head of|staff engineer|supervisor|architect|program manager|product manager|software|developer|scientist|security engineer|sales|account executive|recruiter)\b/i;

const clean = value => String(value ?? '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/\s+/g, ' ')
  .trim();
const lower = value => clean(value).toLowerCase();
const hasAny = (text, terms) => terms.some(term => text.includes(term));
const hash = value => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 14);
const normalizeIdentity = value => lower(value).replace(/[^a-z0-9]+/g, ' ').trim();

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json,text/plain,*/*',
      'user-agent': 'DataCenterCareersBot/1.6 (+https://dailyblip.github.io/ideal-garbanzo/)'
    },
    redirect: 'follow'
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

async function searchEndpoint(query, endpoint) {
  const rows = [];
  const seen = new Set();
  let offset = 0;
  let hits = Infinity;

  for (let page = 0; page < 20 && offset < hits; page += 1) {
    const params = new URLSearchParams({
      offset: String(offset),
      result_limit: '100',
      sort: 'recent',
      base_query: query,
      loc_query: '',
      city: '',
      region: '',
      county: '',
      query_options: ''
    });
    params.append('country[]', 'USA');
    params.append('facets[]', 'normalized_country_code');
    params.append('facets[]', 'normalized_state_name');
    params.append('facets[]', 'normalized_city_name');
    params.append('facets[]', 'is_intern');

    const payload = await fetchJson(`${endpoint}?${params.toString()}`);
    const batch = Array.isArray(payload.jobs) ? payload.jobs : [];
    if (Number.isFinite(Number(payload.hits))) hits = Number(payload.hits);
    if (!batch.length) break;

    let fresh = 0;
    for (const row of batch) {
      const key = String(row.id_icims || row.id || row.job_id || row.job_path || `${row.title}|${row.location}`);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
      fresh += 1;
    }
    if (!fresh) break;
    offset += batch.length;
  }
  return rows;
}

async function searchAmazon(query) {
  const endpoints = [
    `${SEARCH_ORIGIN}/en/search.json`,
    `${SEARCH_ORIGIN}/search.json`
  ];
  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      return await searchEndpoint(query, endpoint);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`Unable to query Amazon Jobs for ${query}`);
}

function sourceUrl(row) {
  const raw = clean(row.job_path || row.url || row.job_url || row.apply_url);
  if (/^https:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) return `${SEARCH_ORIGIN}${raw}`;
  const id = clean(row.id_icims || row.id || row.job_id);
  return id ? `${SEARCH_ORIGIN}/en/jobs/${id}` : '';
}

function normalizeLocation(row) {
  const raw = clean(row.location || row.normalized_location || row.locations?.join?.('; ') || '');
  const country = clean(row.country_code || row.normalized_country_code || row.country || '');
  const state = clean(row.state || row.normalized_state_name || row.state_name || '');
  const city = clean(row.city || row.normalized_city_name || row.city_name || '');

  const explicitlyUs = /^(?:usa|us|united states)$/i.test(country) || /(?:^|[,;])\s*USA\s*(?:[,;]|$)/i.test(raw) || /United States/i.test(raw);
  const stateAbbrev = raw.match(/(?:^|[,;])\s*([A-Z]{2})\s*(?:[,;]|$)/)?.[1];
  const hasUsState = Boolean(stateAbbrev || (/^[A-Z]{2}$/i.test(state) && state.length === 2));
  if (country && !explicitlyUs && !/^US/i.test(country)) return null;
  if (!country && !explicitlyUs && !hasUsState) return null;

  const awsMatch = raw.match(/^USA\s*,\s*([A-Z]{2})\s*,\s*(.+)$/i);
  if (awsMatch) return `${clean(awsMatch[2])}, ${awsMatch[1].toUpperCase()}`;
  if (city && state) return `${city}, ${state}`;
  if (raw) return raw.replace(/^USA\s*,\s*/i, '');
  return state ? state : 'Location not listed';
}

function requiredExperienceYears(text = '') {
  const values = [];
  const patterns = [
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\+?\s*(?:-|–|to)\s*(\d{1,2})\s+years?(?:\s+of)?\s+(?:relevant\s+|related\s+)?experience/gi,
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\+?\s+years?(?:\s+of)?\s+(?:relevant\s+|related\s+)?experience/gi,
    /(\d{1,2})\+?\s+years?\s+(?:of\s+)?(?:technical|professional|data center|datacenter|hardware|network|electrical|mechanical|operations)\s+experience/gi
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      values.push(Number(match[1]));
      if (match[2]) values.push(Number(match[2]));
    }
  }
  return values.filter(Number.isFinite);
}

function classify(row) {
  const title = clean(row.title);
  const description = clean(row.description || row.short_description || '');
  const required = clean(row.basic_qualifications || row.minimum_qualifications || row.qualifications || description);
  const text = lower(`${title} ${description} ${required}`);
  const t = lower(title);

  if (!title || excludedTitlePattern.test(title)) return { drop: 'title' };
  if (!hasAny(t, strongTitleTerms) && !(hasAny(t, contextualTitleTerms) && hasAny(text, contextTerms))) return { drop: 'context' };

  const years = requiredExperienceYears(required);
  if (years.some(year => year >= 6)) return { drop: 'experience' };

  let type = 'entry-level';
  if (/intern|co-?op/.test(t)) type = 'internship';
  else if (/apprentice/.test(t)) type = 'apprenticeship';
  else if (/trainee|work.?based learning|skillbridge/.test(text)) type = 'trainee';

  let experience = '0-2-years';
  if (years.some(year => year >= 3)) experience = '2-5-years';
  else if (!years.length && /work.?based learning|no experience|training program|high school or equivalent|high school diploma/.test(text)) experience = 'no-experience';
  else if (years.some(year => year <= 2)) experience = '0-2-years';

  return { type, experience };
}

function tagsFor(row, type, experience) {
  const text = lower(`${row.title} ${row.description || ''} ${row.basic_qualifications || ''}`);
  const tags = [];
  if (type === 'internship') tags.push('Internship');
  if (type === 'apprenticeship') tags.push('Apprenticeship');
  if (type === 'trainee') tags.push(/work.?based learning/.test(text) ? 'Work-Based Learning' : 'Trainee');
  tags.push(experience === 'no-experience' ? 'No Experience Needed' : experience === '0-2-years' ? '0–2 Years' : '2–5 Years');
  if (/skillbridge/.test(text)) tags.push('SkillBridge');
  if (/electrical|switchgear|ups/.test(text)) tags.push('Electrical');
  if (/fiber|cabling|network/.test(text)) tags.push('Network / Cabling');
  if (/critical facilit|generator|hvac|chiller|mechanical|crah|crac/.test(text)) tags.push('Critical Facilities');
  return [...new Set(tags)].slice(0, 5);
}

function extractPay(row) {
  const text = clean(`${row.salary || ''} ${row.compensation || ''} ${row.description || ''}`);
  const dollar = text.match(/\$([\d,.]+)\s*(?:-|–|to)\s*\$?([\d,.]+)\s*(?:\/|per\s+)?(hour|hourly|hr|year|yearly|yr|annual|annually)?/i);
  const amazon = text.match(/(?:USA[^.\n]*?[-–]\s*)?([\d,]{4,})\s*[-–]\s*([\d,]{4,})\s*USD\s*(annually|annual|hourly|per hour)?/i);
  const match = dollar || amazon;
  if (!match) return { pay:'Pay not listed', salaryMin:null, salaryMax:null, salarySortMax:null };
  const min = Number(String(match[1]).replace(/,/g, ''));
  const max = Number(String(match[2]).replace(/,/g, ''));
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { pay:'Pay not listed', salaryMin:null, salaryMax:null, salarySortMax:null };
  const unit = lower(match[3] || '');
  const hourly = /hour|hr/.test(unit) || max < 1000;
  return {
    pay: `$${min.toLocaleString('en-US')}–$${max.toLocaleString('en-US')} / ${hourly ? 'hr' : 'year'}`,
    salaryMin:min,
    salaryMax:max,
    salarySortMax: hourly ? Math.round(max * 2080) : max
  };
}

function postedAt(row) {
  const candidates = [row.posted_date, row.postedAt, row.datePosted, row.created_at, row.createdAt];
  for (const value of candidates) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

function dedupe(jobs) {
  const urls = new Set();
  const identities = new Set();
  const out = [];
  for (const job of jobs) {
    const urlKey = clean(job.sourceUrl);
    const identity = [job.company, job.title, job.location].map(normalizeIdentity).join('|');
    if ((urlKey && urls.has(urlKey)) || identities.has(identity)) continue;
    if (urlKey) urls.add(urlKey);
    identities.add(identity);
    out.push(job);
  }
  return out;
}

const current = await readJson('data/jobs.json', []);
const previous = await readJson('data/amazon-jobs.json', []);
const status = await readJson('data/collector-status.json', {});
const raw = [];
const errors = [];
const queryStats = [];
let successfulQueries = 0;

for (const query of queries) {
  try {
    const rows = await searchAmazon(query);
    successfulQueries += 1;
    queryStats.push({ query, rows:rows.length });
    raw.push(...rows);
  } catch (error) {
    errors.push(`${query}: ${error.message}`);
    queryStats.push({ query, rows:0, error:error.message });
  }
}

const uniqueRaw = dedupe(raw.map(row => ({
  company:COMPANY,
  title:clean(row.title),
  location:normalizeLocation(row) || '',
  sourceUrl:sourceUrl(row),
  row
}))).map(item => item.row);

const jobs = [];
const drops = { nonUs:0, title:0, context:0, experience:0, invalidUrl:0 };
for (const row of uniqueRaw) {
  const location = normalizeLocation(row);
  if (!location) { drops.nonUs += 1; continue; }
  const cls = classify(row);
  if (cls.drop) { drops[cls.drop] = (drops[cls.drop] || 0) + 1; continue; }
  const url = sourceUrl(row);
  if (!/^https:\/\/www\.amazon\.jobs\//i.test(url) && !/^https:\/\/amazon\.jobs\//i.test(url)) { drops.invalidUrl += 1; continue; }
  const externalId = clean(row.id_icims || row.id || row.job_id || hash(url));
  jobs.push({
    id:`amazon-${externalId}`,
    title:clean(row.title),
    company:COMPANY,
    location,
    type:cls.type,
    experience:cls.experience,
    tags:tagsFor(row, cls.type, cls.experience),
    ...extractPay(row),
    postedAt:postedAt(row),
    source:'Official Amazon Jobs',
    sourceUrl:url,
    active:true,
    demo:false
  });
}

let snapshot;
let sourceHealthy = true;
if (!successfulQueries || (!raw.length && previous.length)) {
  snapshot = previous;
  sourceHealthy = false;
  if (!raw.length) errors.push('Amazon Jobs returned no rows; retained previous AWS snapshot.');
} else {
  snapshot = dedupe(jobs);
}

const withoutAmazon = current.filter(job => job.company !== COMPANY && !/amazon\.jobs\//i.test(String(job.sourceUrl || '')));
const merged = dedupe([...snapshot, ...withoutAmazon]);
const now = Date.now();
for (const job of merged) {
  job.postedHours = job.postedAt ? Math.max(0, Math.round((now - new Date(job.postedAt).getTime()) / 36e5)) : (job.postedHours ?? 9999);
}

const countsByType = merged.reduce((acc, job) => { acc[job.type] = (acc[job.type] || 0) + 1; return acc; }, {});
const countsByExperience = merged.reduce((acc, job) => { acc[job.experience] = (acc[job.experience] || 0) + 1; return acc; }, {});

await writeFile('data/amazon-jobs.json', JSON.stringify(snapshot, null, 2) + '\n');
await writeFile('data/jobs.json', JSON.stringify(merged, null, 2) + '\n');
await writeFile('data/collector-status.json', JSON.stringify({
  ...status,
  updatedAt:new Date().toISOString(),
  jobs:merged.length,
  countsByType,
  countsByExperience,
  amazonDatacenter:{
    officialSource:'https://www.amazon.jobs/content/en/teams/amazon-web-services/data-centers',
    searchSource:'https://www.amazon.jobs/en/search',
    sourceHealthy,
    queriesAttempted:queries.length,
    queriesSucceeded:successfulQueries,
    queryStats,
    candidateRows:raw.length,
    uniqueCandidates:uniqueRaw.length,
    qualifyingRoles:snapshot.length,
    drops,
    errors
  }
}, null, 2) + '\n');

console.log(`AWS collector kept ${snapshot.length} qualifying roles from ${successfulQueries}/${queries.length} successful official searches; ${merged.length} total jobs.`);
if (errors.length) console.warn(`AWS collector warnings: ${errors.join(' | ')}`);
