import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const COMPANY = 'Prime Data Centers';
const BOARD_SLUG = 'prime-data-centers';
const BOARD_API = `https://api.rippling.com/platform/api/ats/v1/board/${BOARD_SLUG}/jobs`;
const BOARD_ROOT = `https://ats.rippling.com/${BOARD_SLUG}/jobs`;
const OFFICIAL_CAREER_PAGE = 'https://primedatacenters.com/careers/';
const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/prime-data-centers-jobs.json';
const STATUS_PATH = 'data/collector-status.json';

const clean = value => String(value ?? '')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&quot;/gi, '"')
  .replace(/&ndash;|&#8211;/gi, '–')
  .replace(/&mdash;|&#8212;/gi, '—')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/\s+/g, ' ')
  .trim();
const lower = value => clean(value).toLowerCase();
const normalizeIdentity = value => lower(value).replace(/[^a-z0-9]+/g, ' ').trim();
const hash = value => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 14);

const candidateTitlePattern = /\b(?:data cent(?:er|re)|critical|facilit(?:y|ies)|technician|operator|project engineer|project coordinator|commissioning|electrical|mechanical|controls|apprentice|trainee|intern)\b/i;
const strongMissionTitlePattern = /\b(?:data cent(?:er|re)|critical operations|critical facilities|critical engineering)\b/i;
const contextualTitlePattern = /\b(?:technician|operator|project engineer|project coordinator|commissioning|facilit(?:y|ies)|electrical|mechanical|controls|apprentice|trainee|intern)\b/i;
const dataCenterContextPattern = /\b(?:data cent(?:er|re)|critical environment|mission[- ]critical|critical infrastructure|colocation|colo facility|server racks?|ups|switchgear|generator|crah|crac|chiller)\b/i;
const excludedTitlePattern = /\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|superintendent|foreman|sales|account executive|recruiter|counsel|attorney)\b/i;
const excludedDescriptionPattern = /\b(?:talent community|general interest application|future opportunit(?:y|ies)|evergreen requisition)\b/i;

function requiredExperienceText(description = '') {
  const text = clean(description);
  const preferred = text.search(/\b(?:preferred qualifications?|preferred experience|preferred skills?|nice to have|bonus qualifications?)\b/i);
  return preferred >= 0 ? text.slice(0, preferred) : text;
}

function normalizeExperienceNumbers(text = '') {
  const words = new Map([
    ['zero', '0'], ['one', '1'], ['two', '2'], ['three', '3'], ['four', '4'], ['five', '5'],
    ['six', '6'], ['seven', '7'], ['eight', '8'], ['nine', '9'], ['ten', '10']
  ]);
  return lower(text).replace(/\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/g, word => words.get(word) || word);
}

function statedExperienceYears(text = '') {
  const normalized = normalizeExperienceNumbers(text);
  const values = [];
  const patterns = [
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+years?['’]?(?:\s+(?:of|prior))?\s+(?:direct\s+|relevant\s+|related\s+|professional\s+|work\s+|technical\s+)?experience/gi,
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?['’]?(?:\s+(?:of|prior))?\s+(?:direct\s+|relevant\s+|related\s+|professional\s+|work\s+|technical\s+)?experience/gi,
    /experience(?:\s+(?:of|in))?\s+(?:at least\s+|minimum(?: of)?\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?/gi,
    /(\d{1,2})\s*(?:\+|or more)?\s+years?['’]?\s+(?:of\s+)?experience\b/gi
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      values.push(Number(match[1]));
      if (match[2]) values.push(Number(match[2]));
    }
  }
  return values.filter(value => Number.isFinite(value) && value >= 0 && value <= 50);
}

function classify(title, description = '', employmentType = '') {
  const t = clean(title);
  const d = clean(description);
  if (!candidateTitlePattern.test(t)) return { classification: null, reason: 'out-of-scope-title' };
  if (excludedTitlePattern.test(t)) return { classification: null, reason: 'senior-title' };
  if (excludedDescriptionPattern.test(d)) return { classification: null, reason: 'evergreen' };
  const missionFit = strongMissionTitlePattern.test(t) || (contextualTitlePattern.test(t) && dataCenterContextPattern.test(d));
  if (!missionFit) return { classification: null, reason: 'out-of-scope-context' };

  const titleLower = lower(t);
  const employmentLower = lower(employmentType);
  let type = 'entry-level';
  if (titleLower.includes('intern') || employmentLower.includes('intern')) type = 'internship';
  else if (titleLower.includes('apprentice')) type = 'apprenticeship';
  else if (titleLower.includes('trainee')) type = 'trainee';

  const required = requiredExperienceText(d);
  const years = statedExperienceYears(required);
  if (years.some(year => year > 5)) return { classification: null, reason: 'over-5-years' };

  const explicitNoExperience = /(?:no|zero) (?:prior )?experience(?: is)? (?:required|needed)|experience (?:is )?not required/i.test(required);
  const explicitProgram = type !== 'entry-level';
  const titleLevelSignal = /\b(?:technician|operator)\s+(?:i|ii|iii|1|2|3)\b/i.test(t);
  if (!years.length && !explicitNoExperience && !explicitProgram && !titleLevelSignal) {
    return { classification: null, reason: 'unknown-experience' };
  }

  let experience = '0-2-years';
  if (explicitNoExperience) experience = 'no-experience';
  else if (years.some(year => year >= 3) || /\b(?:technician|operator)\s+(?:ii|iii|2|3)\b/i.test(t)) experience = '2-5-years';

  return { classification: { type, experience }, reason: null };
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, out);
  return out;
}

function extractNextData(html) {
  const match = String(html).match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error('Rippling job page did not expose __NEXT_DATA__');
  let payload;
  try { payload = JSON.parse(match[1]); }
  catch (error) { throw new Error(`Rippling __NEXT_DATA__ was not valid JSON: ${error.message}`); }
  const pageProps = payload?.props?.pageProps || payload?.pageProps || {};
  const apiData = pageProps?.apiData || payload?.apiData || {};
  const jobPost = apiData?.jobPost || apiData?.job || pageProps?.jobPost || null;
  if (!jobPost || typeof jobPost !== 'object') throw new Error('Rippling __NEXT_DATA__ did not contain a jobPost payload');
  return jobPost;
}

function extractBoardRows(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['jobs', 'items', 'data', 'results']) {
    if (Array.isArray(payload?.[key])) return payload[key];
    if (Array.isArray(payload?.data?.[key])) return payload.data[key];
  }
  return [];
}

function canonicalJobUrl(row) {
  const uuid = clean(row?.uuid || row?.id || row?.jobId || row?.job_id);
  const supplied = clean(row?.url || row?.jobUrl || row?.job_url);
  if (supplied) {
    try {
      const url = new URL(supplied, BOARD_ROOT + '/');
      if (url.hostname === 'ats.rippling.com' && url.pathname.includes(`/${BOARD_SLUG}/jobs/`)) return url.href;
    } catch {}
  }
  return uuid ? `${BOARD_ROOT}/${encodeURIComponent(uuid)}` : '';
}

function locationText(value) {
  if (!value) return '';
  if (typeof value === 'string') return clean(value);
  if (Array.isArray(value)) return value.map(locationText).filter(Boolean).join('; ');
  const nested = value.location && typeof value.location === 'object' ? value.location : {};
  const city = clean(value.city || nested.city);
  const state = clean(value.state || value.region || value.stateCode || value.state_code || nested.state || nested.region || nested.stateCode || nested.state_code);
  const country = clean(value.country || value.countryName || value.country_name || nested.country || nested.countryName || nested.country_name);
  const label = clean(value.name || value.label || value.displayName || value.display_name || value.address || nested.name || nested.label);
  return [city, state].filter(Boolean).join(', ') || label || country;
}

function isUsLocation(value, text = '') {
  const objects = Array.isArray(value) ? value : [value];
  let explicitCountrySeen = false;
  for (const item of objects) {
    if (!item || typeof item !== 'object') continue;
    const nested = item.location && typeof item.location === 'object' ? item.location : {};
    const code = clean(item.countryCode || item.country_code || nested.countryCode || nested.country_code).toUpperCase();
    const country = lower(item.country || item.countryName || item.country_name || nested.country || nested.countryName || nested.country_name);
    if (code || country) explicitCountrySeen = true;
    if (code === 'US' || code === 'USA' || /^(?:united states|united states of america|usa|us)$/.test(country)) return true;
  }
  if (explicitCountrySeen) return false;
  const normalized = clean(text);
  return /\b(?:United States|USA|U\.S\.|AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/.test(normalized);
}

function descriptionFor(jobPost) {
  const raw = jobPost?.description ?? jobPost?.jobDescription ?? jobPost?.content ?? '';
  return clean(collectStrings(raw).join(' '));
}

function payFor(description = '') {
  const text = clean(description);
  const match = text.match(/\$([\d,.]+)\s*(?:-|–|to)\s*\$?([\d,.]+)\s*(?:\/|per\s+)?\s*(hour|hourly|hr|year|yearly|yr|annum|annual|annually)?/i);
  if (!match) return { pay: 'Pay not listed', salaryMin: null, salaryMax: null, salarySortMax: null };
  const min = Number(match[1].replace(/,/g, ''));
  const max = Number(match[2].replace(/,/g, ''));
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return { pay: 'Pay not listed', salaryMin: null, salaryMax: null, salarySortMax: null };
  const unit = lower(match[3] || '');
  const hourly = /hour|hr/.test(unit) || (!unit && max < 1000);
  return {
    pay: `$${match[1]}–$${match[2]} / ${hourly ? 'hr' : 'year'}`,
    salaryMin: min,
    salaryMax: max,
    salarySortMax: hourly ? Math.round(max * 2080) : max
  };
}

function tagsFor(title, description, experience, type) {
  const text = lower(`${title} ${description}`);
  const tags = [];
  if (type === 'internship') tags.push('Internship');
  if (type === 'apprenticeship') tags.push('Apprenticeship');
  if (type === 'trainee') tags.push('Trainee');
  if (experience === 'no-experience') tags.push('No Experience Needed');
  else if (experience === '0-2-years') tags.push('0–2 Years');
  else tags.push('2–5 Years');
  if (/training|mentorship|development program|certification/.test(text)) tags.push('Training / Mentorship');
  if (/electrical|switchgear|ups|generator/.test(text)) tags.push('Electrical');
  if (/mechanical|hvac|chiller|crah|crac|cooling|critical operations|critical facilities/.test(text)) tags.push('Critical Facilities');
  if (/fiber|cabling|network/.test(text)) tags.push('Network / Cabling');
  return [...new Set(tags)].slice(0, 5);
}

function isoDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function dedupe(jobs) {
  const urls = new Set();
  const identities = new Set();
  const out = [];
  for (const job of jobs) {
    const url = clean(job?.sourceUrl);
    const identity = [job?.company, job?.title, job?.location].map(normalizeIdentity).join('|');
    if ((url && urls.has(url)) || identities.has(identity)) continue;
    if (url) urls.add(url);
    identities.add(identity);
    out.push(job);
  }
  return out;
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response?.headers?.get?.('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 15000);
  return Math.min(1000 * (2 ** attempt), 8000);
}

async function fetchWithRetry(url, accept = 'application/json') {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept,
          'user-agent': 'DataCenterCareersBot/1.1 (+https://datacentercareers.us/)'
        },
        signal: AbortSignal.timeout(20000)
      });
      if (response.ok) return response;
      lastError = new Error(`${response.status} ${url}`);
      if (![408, 425, 429, 500, 502, 503, 504].includes(response.status) || attempt === 2) break;
      await new Promise(resolve => setTimeout(resolve, retryDelay(response, attempt)));
    } catch (error) {
      lastError = error;
      if (attempt === 2) break;
      await new Promise(resolve => setTimeout(resolve, 1000 * (2 ** attempt)));
    }
  }
  throw lastError || new Error(`Unable to fetch ${url}`);
}

function runClassifierTests() {
  const cases = [
    ['Prime technician 2 years', 'Critical Operations Technician - Data Centers', 'Required: 2+ years of technical experience in a mission-critical data center. Preferred: 5+ years.', '0-2-years'],
    ['Prime project engineer 3 years', 'Data Center Project Engineer', 'Minimum qualifications: 3+ years of relevant experience supporting data center construction.', '2-5-years'],
    ['senior excluded', 'Senior Data Center Project Engineer', '2+ years experience in data center construction.', null],
    ['manager excluded', 'Critical Operations Manager', '3 years of data center experience.', null],
    ['over five excluded', 'Data Center Project Engineer', 'Minimum of 7 years of relevant experience in data center construction.', null],
    ['unknown experience excluded', 'Critical Operations Technician', 'Maintain UPS, generators, switchgear and cooling systems in a data center.', null],
    ['contextual coordinator included', 'Project Coordinator', 'Minimum of 2 years of experience supporting mission-critical data center construction.', '0-2-years'],
    ['unrelated coordinator excluded', 'Project Coordinator', 'Minimum of 2 years of experience supporting office renovations.', null],
    ['program role included', 'Data Center Operations Intern', 'Support critical facilities operations and technician teams.', '0-2-years']
  ];
  const failures = [];
  for (const [name, title, description, expected] of cases) {
    const actual = classify(title, description).classification?.experience ?? null;
    if (actual !== expected) failures.push(`${name}: expected ${expected}, got ${actual}`);
  }
  if (failures.length) {
    for (const failure of failures) console.error(`Prime classifier regression: ${failure}`);
    process.exit(1);
  }
  console.log(`Prime classifier passed ${cases.length} regression cases.`);
}

function runNextDataTest() {
  const fixture = '<html><body><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"apiData":{"jobPost":{"uuid":"abc","name":"Critical Operations Technician","description":{"requirements":"2+ years experience in a data center"}}}}}}</script></body></html>';
  const jobPost = extractNextData(fixture);
  if (jobPost.uuid !== 'abc' || !descriptionFor(jobPost).includes('2+ years')) throw new Error('Prime Rippling NEXT_DATA parser regression');
  console.log('Prime Rippling NEXT_DATA parser regression passed.');
}

if (process.argv.includes('--test-classifier')) {
  runClassifierTests();
  process.exit(0);
}
if (process.argv.includes('--test-next-data')) {
  runNextDataTest();
  process.exit(0);
}

const previousJobs = await readJson(JOBS_PATH, []);
const priorStatus = await readJson(STATUS_PATH, {});
const boardResponse = await fetchWithRetry(BOARD_API, 'application/json');
const boardPayload = await boardResponse.json();
const boardRows = extractBoardRows(boardPayload);
if (!boardRows.length) throw new Error('Prime Rippling board returned no public jobs; preserving prior verified snapshot.');

const grouped = new Map();
for (const row of boardRows) {
  const uuid = clean(row?.uuid || row?.id || row?.jobId || row?.job_id || canonicalJobUrl(row));
  if (!uuid) continue;
  if (!grouped.has(uuid)) grouped.set(uuid, []);
  grouped.get(uuid).push(row);
}

const diagnostics = {
  listedRows: boardRows.length,
  uniqueJobs: grouped.size,
  candidateRoles: 0,
  detailVerified: 0,
  usCandidateRoles: 0,
  qualifyingRoles: 0,
  rejectedOutOfScopeTitle: 0,
  rejectedOutOfScopeContext: 0,
  rejectedSeniorTitle: 0,
  rejectedEvergreen: 0,
  rejectedOver5Years: 0,
  rejectedUnknownExperience: 0,
  rejectedNonUs: 0,
  detailFailures: 0
};
const collected = [];
const detailErrors = [];

for (const [groupKey, rows] of grouped) {
  const first = rows[0] || {};
  const boardTitle = clean(first?.name || first?.title || first?.jobName || first?.job_name);
  if (!candidateTitlePattern.test(boardTitle)) {
    diagnostics.rejectedOutOfScopeTitle += 1;
    continue;
  }
  diagnostics.candidateRoles += 1;

  const sourceUrl = canonicalJobUrl(first) || `${BOARD_ROOT}/${encodeURIComponent(groupKey)}`;
  let jobPost;
  try {
    const detailResponse = await fetchWithRetry(sourceUrl, 'text/html,application/xhtml+xml');
    jobPost = extractNextData(await detailResponse.text());
    diagnostics.detailVerified += 1;
  } catch (error) {
    diagnostics.detailFailures += 1;
    detailErrors.push(`${boardTitle || groupKey}: ${error.message}`);
    continue;
  }

  if (jobPost?.activeJobApplication === false || jobPost?.active === false || jobPost?.isActive === false) continue;
  const title = clean(jobPost?.name || jobPost?.title || boardTitle);
  const description = descriptionFor(jobPost);
  const employmentType = clean(jobPost?.employmentType || jobPost?.employment_type || first?.employmentType || first?.employment_type);
  const { classification, reason } = classify(title, description, employmentType);
  if (!classification) {
    if (reason === 'out-of-scope-title') diagnostics.rejectedOutOfScopeTitle += 1;
    else if (reason === 'out-of-scope-context') diagnostics.rejectedOutOfScopeContext += 1;
    else if (reason === 'senior-title') diagnostics.rejectedSeniorTitle += 1;
    else if (reason === 'evergreen') diagnostics.rejectedEvergreen += 1;
    else if (reason === 'over-5-years') diagnostics.rejectedOver5Years += 1;
    else if (reason === 'unknown-experience') diagnostics.rejectedUnknownExperience += 1;
    continue;
  }

  const detailLocations = jobPost?.workLocations || jobPost?.workLocation || jobPost?.locations || jobPost?.location || [];
  const boardLocations = rows.map(row => row?.workLocation || row?.work_location || row?.location).filter(Boolean);
  const rawLocations = Array.isArray(detailLocations) && detailLocations.length ? detailLocations : boardLocations;
  const location = [...new Set((Array.isArray(rawLocations) ? rawLocations : [rawLocations]).map(locationText).filter(Boolean))].join('; ') || 'Location not listed';
  if (!isUsLocation(rawLocations, location)) {
    diagnostics.rejectedNonUs += 1;
    continue;
  }
  diagnostics.usCandidateRoles += 1;

  const uuid = clean(jobPost?.uuid || jobPost?.id || first?.uuid || first?.id || groupKey);
  const postedAt = isoDate(jobPost?.createdOn || jobPost?.created_at || jobPost?.createdAt || first?.createdOn || first?.created_at || first?.createdAt);
  collected.push({
    id: `rippling-prime-${uuid || hash(`${title}|${location}`)}`,
    title,
    company: COMPANY,
    location,
    type: classification.type,
    experience: classification.experience,
    tags: tagsFor(title, description, classification.experience, classification.type),
    ...payFor(description),
    postedAt,
    source: 'Employer career site',
    sourceUrl: canonicalJobUrl({ ...first, uuid }) || sourceUrl,
    active: true,
    demo: false
  });
}

if (detailErrors.length) {
  throw new Error(`Prime Rippling detail verification failed for ${detailErrors.length} candidate role(s); preserving prior verified snapshot. ${detailErrors.slice(0, 4).join(' | ')}`);
}

const primeJobs = dedupe(collected);
diagnostics.qualifyingRoles = primeJobs.length;
if (diagnostics.candidateRoles > 0 && diagnostics.detailVerified > 0 && primeJobs.length === 0) {
  throw new Error(`Prime Rippling listed ${diagnostics.candidateRoles} mission-title candidate role(s), but none passed U.S. 0–5 year classification; preserving prior verified snapshot.`);
}

const merged = dedupe([
  ...previousJobs.filter(job => clean(job?.company) !== COMPANY),
  ...primeJobs
]);
const now = Date.now();
for (const job of merged) {
  job.postedHours = job.postedAt ? Math.max(0, Math.round((now - new Date(job.postedAt).getTime()) / 36e5)) : 9999;
}
merged.sort((a, b) => (a.postedHours ?? 9999) - (b.postedHours ?? 9999));

const checkedAt = new Date().toISOString();
const status = {
  ...priorStatus,
  updatedAt: checkedAt,
  jobs: merged.length,
  primeDataCenters: {
    checkedAt,
    lastSuccessfulAt: checkedAt,
    sourceHealthy: true,
    listingComplete: true,
    officialCareerPage: OFFICIAL_CAREER_PAGE,
    officialRipplingBoard: BOARD_ROOT,
    api: BOARD_API,
    authoritativeSnapshot: true,
    ...diagnostics
  }
};

await writeFile(SNAPSHOT_PATH, JSON.stringify(primeJobs, null, 2) + '\n');
await writeFile(JOBS_PATH, JSON.stringify(merged, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

console.log(`Prime Data Centers: ${primeJobs.length} qualifying U.S. role(s) from ${boardRows.length} Rippling listing row(s); ${diagnostics.detailVerified} candidate detail page(s) verified; feed now ${merged.length} jobs.`);
