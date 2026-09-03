import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const COMPANY = 'Amazon Web Services';
const ORIGIN = 'https://www.amazon.jobs';
const SEARCH_QUERIES = [
  'data center',
  'data center technician',
  'engineering operations technician',
  'work based learning data center'
];
const CONCURRENCY = 12;
const TIMEOUT_MS = 12000;

const missionTitlePatterns = [
  /\bdata cent(?:er|re)\b.*\b(?:technician|tech|operator|operations|facilit(?:y|ies)|controls?|electrical|mechanical|engineer)\b/i,
  /\b(?:technician|tech|operator|operations|facilit(?:y|ies)|controls?|electrical|mechanical|engineer)\b.*\bdata cent(?:er|re)\b/i,
  /\bengineering operations? (?:technician|tech)\b/i,
  /\b(?:dceo|infraops|dcc communities)\b.*\b(?:technician|tech|operator|engineer)\b/i,
  /\b(?:technician|tech|operator|engineer)\b.*\b(?:dceo|infraops|dcc communities)\b/i,
  /\bcritical (?:facilit(?:y|ies)|infrastructure)\b.*\b(?:technician|tech|engineer|operator)\b/i,
  /\b(?:cable|cabling|fiber|network cable)\b.*\b(?:installation|installer|technician|tech)\b/i,
  /\b(?:installation|installer) technician\b/i,
  /\bid flex technician\b/i,
  /\binfrastructure delivery\b.*\b(?:technician|tech)\b/i
];
const excludedTitlePattern = /\b(?:senior|sr\.?|lead|principal|chief|manager|mgr\.?|director|vice president|vp|head of|staff engineer|supervisor|architect|program manager|product manager|software|developer|scientist|security engineer|security specialist|sales|account executive|recruiter|construction manager|project manager)\b/i;

const clean = value => String(value ?? '')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/\s+/g, ' ')
  .trim();

const lower = value => clean(value).toLowerCase();
const normalizeIdentity = value => lower(value).replace(/[^a-z0-9]+/g, ' ').trim();
const hash = value => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 14);

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

function headers(accept) {
  return {
    accept,
    'user-agent': 'DataCenterCareersBot/2.0 (+https://datacentercareers.us/)'
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: headers('application/json,text/plain,*/*'),
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: headers('text/html,application/xhtml+xml'),
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

async function searchEndpoint(query, endpoint) {
  const rows = [];
  const seen = new Set();
  let offset = 0;
  let hits = Infinity;

  for (let page = 0; page < 20 && offset < hits; page += 1) {
    const params = new URLSearchParams({
      offset:String(offset),
      result_limit:'100',
      sort:'recent',
      base_query:query,
      loc_query:'',
      city:'',
      region:'',
      county:'',
      query_options:''
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
      const key = clean(row.id_icims || row.id || row.job_id || row.job_path || `${row.title}|${row.location}`);
      if (!key || seen.has(key)) continue;
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
  const endpoints = [`${ORIGIN}/en/search.json`, `${ORIGIN}/search.json`];
  let lastError = null;
  for (const endpoint of endpoints) {
    try { return await searchEndpoint(query, endpoint); }
    catch (error) { lastError = error; }
  }
  throw lastError || new Error(`Unable to query Amazon Jobs for ${query}`);
}

function sourceUrl(row) {
  const raw = clean(row.job_path || row.url || row.job_url || row.apply_url);
  if (/^https:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) return `${ORIGIN}${raw}`;
  const id = clean(row.id_icims || row.id || row.job_id);
  return id ? `${ORIGIN}/en/jobs/${id}` : '';
}

function jobId(row, url) {
  const externalId = clean(row.id_icims || row.id || row.job_id || hash(url));
  return `amazon-${externalId}`;
}

function normalizeLocation(row) {
  const raw = clean(row.location || row.normalized_location || row.locations?.join?.('; ') || '');
  const country = clean(row.country_code || row.normalized_country_code || row.country || '');
  const state = clean(row.state || row.normalized_state_name || row.state_name || '');
  const city = clean(row.city || row.normalized_city_name || row.city_name || '');

  const explicitlyUs = /^(?:usa|us|united states)$/i.test(country)
    || /(?:^|[,;])\s*USA\s*(?:[,;]|$)/i.test(raw)
    || /United States/i.test(raw);
  const stateAbbrev = raw.match(/(?:^|[,;])\s*([A-Z]{2})\s*(?:[,;]|$)/)?.[1];
  const hasUsState = Boolean(stateAbbrev || (/^[A-Z]{2}$/i.test(state) && state.length === 2));

  if (country && !explicitlyUs && !/^US/i.test(country)) return null;
  if (!country && !explicitlyUs && !hasUsState) return null;

  const awsMatch = raw.match(/^USA\s*,\s*([A-Z]{2})\s*,\s*(.+)$/i);
  if (awsMatch) return `${clean(awsMatch[2])}, ${awsMatch[1].toUpperCase()}`;
  if (city && state) return `${city}, ${state}`;
  if (raw) return raw.replace(/^USA\s*,\s*/i, '');
  return state || null;
}

function missionTitle(title) {
  const text = clean(title);
  return Boolean(text)
    && !excludedTitlePattern.test(text)
    && missionTitlePatterns.some(pattern => pattern.test(text));
}

function extractBasicQualifications(html) {
  const text = clean(html);
  const normalized = text.toLowerCase();
  const startIndex = normalized.indexOf('basic qualifications');
  if (startIndex < 0) return { basic:'', text };

  const start = startIndex + 'basic qualifications'.length;
  const preferred = normalized.indexOf('preferred qualifications', start);
  const equality = normalized.indexOf('amazon is an equal opportunity employer', start);
  const endCandidates = [preferred, equality].filter(index => index > start);
  const end = endCandidates.length ? Math.min(...endCandidates) : Math.min(text.length, start + 5000);

  return { basic:clean(text.slice(start, end)), text };
}

function requiredYears(text) {
  const values = [];
  const yearPatterns = [
    /(\d{1,2})\+?\s*(?:-|–|to)\s*(\d{1,2})\s+years?\b/gi,
    /(\d{1,2})\+?\s+years?\s+of\b[^.;]{0,160}?\bexperience\b/gi,
    /(\d{1,2})\+?\s+years?\s+(?:relevant|related|technical|professional|data center|datacenter|hardware|network|electrical|mechanical|operations)\b[^.;]{0,100}?\bexperience\b/gi,
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\+?\s+years?\s+experience\b/gi
  ];
  for (const pattern of yearPatterns) {
    for (const match of text.matchAll(pattern)) {
      values.push(Number(match[1]));
      if (match[2]) values.push(Number(match[2]));
    }
  }

  const monthPatterns = [
    /(\d{1,3})\+?\s+months?\s+of\b[^.;]{0,160}?\bexperience\b/gi,
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,3})\+?\s+months?\s+experience\b/gi
  ];
  for (const pattern of monthPatterns) {
    for (const match of text.matchAll(pattern)) {
      const months = Number(match[1]);
      if (Number.isFinite(months)) values.push(months / 12);
    }
  }

  return values.filter(Number.isFinite);
}

function classify(title, basicQualifications) {
  const titleText = lower(title);
  const basic = clean(basicQualifications);
  const years = requiredYears(basic);
  const earlyProgram = /work.?based learning|intern|apprentice|trainee|skillbridge/.test(titleText);
  const noExperience = /(?:no|zero) (?:prior )?experience(?: is)? (?:required|needed)|experience (?:is )?not required/i.test(basic);

  if (years.some(year => year >= 6)) return null;
  if (!years.length && !earlyProgram && !noExperience) return null;

  let type = 'entry-level';
  if (/intern|co-?op/.test(titleText)) type = 'internship';
  else if (/apprentice/.test(titleText)) type = 'apprenticeship';
  else if (/trainee|work.?based learning|skillbridge/.test(titleText)) type = 'trainee';

  let experience = '0-2-years';
  if (!years.length && (earlyProgram || noExperience)) experience = 'no-experience';
  else if (years.some(year => year >= 3)) experience = '2-5-years';

  return { type, experience };
}

function payFromText(text) {
  const cleaned = clean(text);
  const dollar = cleaned.match(/\$([\d,.]+)\s*(?:-|–|to)\s*\$?([\d,.]+)\s*(?:\/|per\s+)?(hour|hourly|hr|year|yearly|yr|annual|annually)?/i);
  const amazon = cleaned.match(/(?:USA[^.\n]*?[-–]\s*)?([\d,.]+)\s*[-–]\s*([\d,.]+)\s*USD\s*(annually|annual|hourly|per hour)?/i);
  const match = dollar || amazon;
  if (!match) return { pay:'Pay not listed', salaryMin:null, salaryMax:null, salarySortMax:null };

  const min = Number(String(match[1]).replace(/,/g, ''));
  const max = Number(String(match[2]).replace(/,/g, ''));
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { pay:'Pay not listed', salaryMin:null, salaryMax:null, salarySortMax:null };
  }

  const hourly = /hour|hr/i.test(match[3] || '') || max < 1000;
  return {
    pay:`$${min.toLocaleString('en-US')}–$${max.toLocaleString('en-US')} / ${hourly ? 'hr' : 'year'}`,
    salaryMin:min,
    salaryMax:max,
    salarySortMax:hourly ? Math.round(max * 2080) : max
  };
}

function postedAt(row) {
  for (const value of [row.posted_date, row.postedAt, row.datePosted, row.created_at, row.createdAt]) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

function tagsFor(title, basic, type, experience) {
  const text = lower(`${title} ${basic}`);
  const titleText = lower(title);
  const tags = [];

  if (type === 'internship') tags.push('Internship');
  if (type === 'apprenticeship') tags.push('Apprenticeship');
  if (type === 'trainee') tags.push(/work.?based learning/.test(titleText) ? 'Work-Based Learning' : 'Trainee');

  tags.push(experience === 'no-experience' ? 'No Experience Needed' : experience === '0-2-years' ? '0–2 Years' : '2–5 Years');
  if (/skillbridge/.test(titleText)) tags.push('SkillBridge');
  if (/electrical|switchgear|ups/.test(text)) tags.push('Electrical');
  if (/fiber|cabling|network/.test(text)) tags.push('Network / Cabling');
  if (/critical facilit|generator|hvac|chiller|mechanical|crah|crac/.test(text)) tags.push('Critical Facilities');

  return [...new Set(tags)].slice(0, 5);
}

function dedupeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const url = sourceUrl(row);
    const key = clean(row.id_icims || row.id || row.job_id || url || `${row.title}|${row.location}`);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function dedupeJobs(jobs) {
  const seenUrls = new Set();
  const seenIdentity = new Set();
  const out = [];

  for (const job of jobs) {
    const url = clean(job.sourceUrl);
    const identity = [job.company, job.title, job.location].map(normalizeIdentity).join('|');
    if ((url && seenUrls.has(url)) || seenIdentity.has(identity)) continue;
    if (url) seenUrls.add(url);
    seenIdentity.add(identity);
    out.push(job);
  }
  return out;
}

const currentJobs = await readJson('data/jobs.json', []);
const previousAmazon = await readJson('data/amazon-jobs.json', []);
const status = await readJson('data/collector-status.json', {});
const raw = [];
const queryStats = [];
const errors = [];
let queriesSucceeded = 0;

for (const query of SEARCH_QUERIES) {
  try {
    const rows = await searchAmazon(query);
    queriesSucceeded += 1;
    queryStats.push({ query, rows:rows.length });
    raw.push(...rows);
  } catch (error) {
    errors.push(`${query}: ${error.message}`);
    queryStats.push({ query, rows:0, error:error.message });
  }
}

const candidates = dedupeRows(raw).filter(row => missionTitle(row.title) && normalizeLocation(row));
const candidateUrls = new Set(candidates.map(sourceUrl).filter(Boolean));
const previousByUrl = new Map(previousAmazon.map(job => [clean(job.sourceUrl), job]).filter(([url]) => url));
const previousById = new Map(previousAmazon.map(job => [clean(job.id), job]).filter(([id]) => id));

const recovered = [];
const toHydrate = [];
let reusedVerified = 0;
let invalidUrls = 0;

for (const row of candidates) {
  const url = sourceUrl(row);
  if (!/^https:\/\/(?:www\.)?amazon\.jobs\//i.test(url)) {
    invalidUrls += 1;
    continue;
  }

  const id = jobId(row, url);
  const previous = previousByUrl.get(clean(url)) || previousById.get(id);
  if (previous) {
    recovered.push({
      ...previous,
      title:clean(row.title) || previous.title,
      location:normalizeLocation(row) || previous.location,
      sourceUrl:url,
      active:true,
      demo:false
    });
    reusedVerified += 1;
    continue;
  }

  toHydrate.push({ row, url });
}

let detailAttempted = 0;
let detailSucceeded = 0;
let detailRecovered = 0;
let detailFetchFailed = 0;
let detailUnknownExperience = 0;
let detailOverFiveYears = 0;
const detailErrorSamples = [];

for (let index = 0; index < toHydrate.length; index += CONCURRENCY) {
  const batch = toHydrate.slice(index, index + CONCURRENCY);
  const results = await Promise.all(batch.map(async ({ row, url }) => {
    detailAttempted += 1;
    try {
      const html = await fetchText(url);
      detailSucceeded += 1;
      return { row, url, detail:extractBasicQualifications(html) };
    } catch (error) {
      detailFetchFailed += 1;
      if (detailErrorSamples.length < 20) detailErrorSamples.push(`${url}: ${error.message}`);
      return { row, url, error };
    }
  }));

  for (const result of results) {
    if (result.error) continue;

    const years = requiredYears(result.detail.basic);
    if (years.some(year => year >= 6)) {
      detailOverFiveYears += 1;
      continue;
    }

    const cls = classify(result.row.title, result.detail.basic);
    if (!cls) {
      detailUnknownExperience += 1;
      continue;
    }

    const location = normalizeLocation(result.row);
    recovered.push({
      id:jobId(result.row, result.url),
      title:clean(result.row.title),
      company:COMPANY,
      location,
      type:cls.type,
      experience:cls.experience,
      tags:tagsFor(result.row.title, result.detail.basic, cls.type, cls.experience),
      ...payFromText(result.detail.text),
      postedAt:postedAt(result.row),
      source:'Official Amazon Jobs',
      sourceUrl:result.url,
      active:true,
      demo:false
    });
    detailRecovered += 1;
  }
}

const freshAmazon = dedupeJobs(recovered);
const fullSearchHealthy = queriesSucceeded === SEARCH_QUERIES.length;
let amazonSnapshot;
let preservedPrevious = 0;

if (!queriesSucceeded || (!raw.length && previousAmazon.length)) {
  amazonSnapshot = previousAmazon;
  preservedPrevious = previousAmazon.length;
  errors.push('Amazon Jobs recovery returned no searchable rows; retained the previous verified AWS snapshot.');
} else if (!fullSearchHealthy) {
  const freshUrls = new Set(freshAmazon.map(job => clean(job.sourceUrl)).filter(Boolean));
  const retained = previousAmazon.filter(job => {
    const url = clean(job.sourceUrl);
    return !freshUrls.has(url);
  });
  preservedPrevious = retained.length;
  amazonSnapshot = dedupeJobs([...freshAmazon, ...retained]);
  errors.push(`Amazon Jobs detail recovery was partial (${queriesSucceeded}/${SEARCH_QUERIES.length} searches succeeded); retained ${preservedPrevious} previously verified roles.`);
} else {
  amazonSnapshot = freshAmazon.filter(job => candidateUrls.has(clean(job.sourceUrl)));
}

const withoutAmazon = currentJobs.filter(job => job.company !== COMPANY && !/amazon\.jobs\//i.test(String(job.sourceUrl || '')));
const merged = dedupeJobs([...amazonSnapshot, ...withoutAmazon]);
const now = Date.now();

for (const job of merged) {
  job.postedHours = job.postedAt
    ? Math.max(0, Math.round((now - new Date(job.postedAt).getTime()) / 36e5))
    : (job.postedHours ?? 9999);
}

const countsByType = merged.reduce((acc, job) => {
  acc[job.type] = (acc[job.type] || 0) + 1;
  return acc;
}, {});
const countsByExperience = merged.reduce((acc, job) => {
  acc[job.experience] = (acc[job.experience] || 0) + 1;
  return acc;
}, {});

status.updatedAt = new Date().toISOString();
status.jobs = merged.length;
status.countsByType = countsByType;
status.countsByExperience = countsByExperience;
status.amazonDetailRecovery = {
  officialSource:'https://www.amazon.jobs/en/search',
  fullSearchHealthy,
  queriesAttempted:SEARCH_QUERIES.length,
  queriesSucceeded,
  queryStats,
  rawRows:raw.length,
  missionFitUsCandidates:candidates.length,
  reusedVerified,
  detailCandidates:toHydrate.length,
  detailAttempted,
  detailSucceeded,
  detailRecovered,
  detailFetchFailed,
  detailUnknownExperience,
  detailOverFiveYears,
  invalidUrls,
  preservedPrevious,
  qualifyingRoles:amazonSnapshot.length,
  detailErrorSamples,
  errors
};

await writeFile('data/amazon-jobs.json', JSON.stringify(amazonSnapshot, null, 2) + '\n');
await writeFile('data/jobs.json', JSON.stringify(merged, null, 2) + '\n');
await writeFile('data/collector-status.json', JSON.stringify(status, null, 2) + '\n');

console.log(`AWS detail recovery kept ${amazonSnapshot.length} verified 0–5 year roles (${detailRecovered} newly recovered, ${reusedVerified} reused) from ${queriesSucceeded}/${SEARCH_QUERIES.length} healthy official searches.`);
if (errors.length) console.warn(`AWS detail recovery warnings: ${errors.join(' | ')}`);
