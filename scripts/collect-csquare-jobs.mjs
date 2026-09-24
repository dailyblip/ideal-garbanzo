import { readFile, writeFile } from 'node:fs/promises';

const COMPANY = 'Csquare';
const ORIGIN = 'https://recruiting.ultipro.com';
const TENANT = 'CYX1000CYXT';
const BOARD_ID = '6ce3c532-60ea-4691-8e59-5f0a86be31a9';
const BOARD_ROOT = `${ORIGIN}/${TENANT}/JobBoard/${BOARD_ID}`;
const LIST_URL = `${BOARD_ROOT}/JobBoardView/LoadSearchResults`;
const DETAIL_ROOT = `${BOARD_ROOT}/OpportunityDetail`;
const OFFICIAL_CAREERS = 'https://www.csquare.com/careers';
const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/csquare-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const PAGE_SIZE = 50;
const MAX_PAGES = 20;

const STATE_CODES = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC']);

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

const seniorTitlePattern = /\b(?:senior|sr\.?|lead|principal|staff|director|vice president|vp|chief|head of|supervisor|architect)\b/i;
const commercialTitlePattern = /\b(?:sales|account executive|customer success|recruiter|marketing|finance|legal|counsel|human resources|business development)\b/i;
const candidateTitlePattern = /\b(?:data cent(?:er|re)|facilit(?:y|ies) technician|operations? technician|critical facilit(?:y|ies)|operations engineer|electrical|mechanical|commissioning|apprentice|trainee|intern|project manager)\b/i;
const strongMissionTitlePattern = /\b(?:data cent(?:er|re)|critical facilit(?:y|ies)|critical operations)\b/i;
const contextualTitlePattern = /\b(?:facilit(?:y|ies) technician|operations? technician|operations engineer|electrical|mechanical|commissioning|apprentice|trainee|intern|project manager)\b/i;
const dataCenterContextPattern = /\b(?:data cent(?:er|re)|mission[- ]critical|critical environment|colocation|colo facility|switchgear|generator|ups|pdu|crah|crac|chiller|data center operations)\b/i;

function requiredExperienceText(description = '') {
  const text = clean(description);
  const preferred = text.search(/\b(?:preferred qualifications?|preferred experience|preferred skills?|nice to have|bonus qualifications?)\b/i);
  return preferred >= 0 ? text.slice(0, preferred) : text;
}

function normalizeExperienceNumbers(text = '') {
  const words = new Map([['zero','0'],['one','1'],['two','2'],['three','3'],['four','4'],['five','5'],['six','6'],['seven','7'],['eight','8'],['nine','9'],['ten','10']]);
  return lower(text).replace(/\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/g, word => words.get(word) || word);
}

function statedExperienceYears(text = '') {
  const normalized = normalizeExperienceNumbers(text);
  const values = [];
  const patterns = [
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+years?['’]?(?:\s+(?:of|prior))?\s+(?:direct\s+|relevant\s+|related\s+|professional\s+|work\s+|technical\s+|mission critical\s+)?experience/gi,
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?['’]?(?:\s+(?:of|prior))?\s+(?:direct\s+|relevant\s+|related\s+|professional\s+|work\s+|technical\s+|mission critical\s+)?experience/gi,
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

function classify(title, description = '', category = '', employmentType = '') {
  const t = clean(title);
  const context = clean(`${category} ${description}`);
  if (!candidateTitlePattern.test(t)) return { classification: null, reason: 'out-of-scope-title' };
  if (seniorTitlePattern.test(t) || commercialTitlePattern.test(t)) return { classification: null, reason: 'senior-or-commercial-title' };
  const projectManagerException = /\bproject manager\b/i.test(t) && /\bdata cent(?:er|re)\b/i.test(t);
  if (/\bmanager\b/i.test(t) && !projectManagerException) return { classification: null, reason: 'manager-title' };

  const missionFit = strongMissionTitlePattern.test(t)
    || (contextualTitlePattern.test(t) && dataCenterContextPattern.test(context))
    || (/\bproject manager\b/i.test(t) && /\bdata cent(?:er|re)\b/i.test(context));
  if (!missionFit) return { classification: null, reason: 'out-of-scope-context' };

  const titleLower = lower(t);
  const employmentLower = lower(employmentType);
  let type = 'entry-level';
  if (titleLower.includes('intern') || employmentLower.includes('intern')) type = 'internship';
  else if (titleLower.includes('apprentice')) type = 'apprenticeship';
  else if (titleLower.includes('trainee')) type = 'trainee';

  const required = requiredExperienceText(description);
  const years = statedExperienceYears(required);
  if (years.some(year => year > 5)) return { classification: null, reason: 'over-5-years' };

  const explicitNoExperience = /(?:no|zero) (?:prior )?experience(?: is)? (?:required|needed)|experience (?:is )?not required/i.test(required);
  const explicitProgram = type !== 'entry-level';
  const levelOne = /\b(?:technician|operator)\s*(?:i|1)\b/i.test(t);
  const levelTwoThree = /\b(?:technician|operator)\s*(?:ii|iii|2|3)\b/i.test(t);
  if (!years.length && !explicitNoExperience && !explicitProgram && !levelOne && !levelTwoThree) {
    return { classification: null, reason: 'unknown-experience' };
  }

  let experience = '0-2-years';
  if (explicitNoExperience) experience = 'no-experience';
  else if (years.some(year => year >= 3) || levelTwoThree) experience = '2-5-years';
  return { classification: { type, experience }, reason: null };
}

function extractCandidatePayload(html) {
  const source = String(html || '');
  const marker = 'CandidateOpportunityDetail(';
  const markerAt = source.indexOf(marker);
  if (markerAt < 0) throw new Error('UKG detail page did not expose CandidateOpportunityDetail payload');
  const start = source.indexOf('{', markerAt + marker.length);
  if (start < 0) throw new Error('UKG detail payload did not contain a JSON object');
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const raw = source.slice(start, i + 1);
        try { return JSON.parse(raw); }
        catch (error) { throw new Error(`UKG detail payload was not valid JSON: ${error.message}`); }
      }
    }
  }
  throw new Error('UKG detail payload was truncated');
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, out);
  return out;
}

function firstScalar(object, keys) {
  if (!object || typeof object !== 'object') return '';
  for (const [key, value] of Object.entries(object)) {
    if (!keys.includes(key.toLowerCase())) continue;
    if (['string','number'].includes(typeof value)) {
      const text = clean(value);
      if (text) return text;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = firstScalar(value, ['code','name','value']);
      if (nested) return nested;
    }
  }
  return '';
}

function locationObjects(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) locationObjects(item, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  const city = firstScalar(value, ['city','cityname','municipality']);
  const state = firstScalar(value, ['state','statecode','stateprovince','stateprovincename','region']);
  const country = firstScalar(value, ['country','countryname','countrycode']);
  if (city && state) out.push({ city, state, country });
  for (const item of Object.values(value)) locationObjects(item, out);
  return out;
}

function normalizeLocation(detail, listing) {
  for (const candidate of [...locationObjects(detail), ...locationObjects(listing)]) {
    const state = candidate.state.toUpperCase().replace(/[^A-Z]/g, '');
    const country = lower(candidate.country);
    if (country && !/^(?:us|usa|united states|united states of america)$/.test(country)) continue;
    if (STATE_CODES.has(state)) return `${clean(candidate.city)}, ${state}`;
  }

  const likelyLocationStrings = [];
  const walk = (value, path = '') => {
    if (typeof value === 'string' && /location|address|city|state/i.test(path)) likelyLocationStrings.push(value);
    else if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}.${index}`));
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`);
  };
  walk(detail, 'detail');
  walk(listing, 'listing');
  for (const value of likelyLocationStrings) {
    const match = clean(value).match(/\b([A-Za-z][A-Za-z .'-]{1,50}),\s*([A-Z]{2})\b/);
    if (match && STATE_CODES.has(match[2])) return `${clean(match[1])}, ${match[2]}`;
  }
  return '';
}

function isoDate(value) {
  if (!value) return null;
  const dotNet = String(value).match(/\/Date\((\d+)\)\//);
  const parsed = dotNet ? new Date(Number(dotNet[1])) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
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
  if (/electrical|switchgear|ups|generator|pdu/.test(text)) tags.push('Electrical');
  if (/mechanical|hvac|chiller|crah|crac|facilit/.test(text)) tags.push('Critical Facilities');
  if (/fiber|cabling|network/.test(text)) tags.push('Network / Cabling');
  return [...new Set(tags)].slice(0, 5);
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

async function fetchWithRetry(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          accept: options.headers?.accept || '*/*',
          'user-agent': 'DataCenterCareers/1.0 (+https://datacentercareers.com)',
          ...options.headers
        }
      });
      if (response.ok) return response;
      lastError = new Error(`${response.status} ${response.statusText}`);
      if (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) break;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, Math.min(1000 * (2 ** attempt), 5000)));
  }
  throw new Error(`Fetch failed for ${url}: ${lastError?.message || 'unknown error'}`);
}

function listRequest(skip) {
  return {
    opportunitySearch: {
      Top: PAGE_SIZE,
      Skip: skip,
      QueryString: '',
      OrderBy: [{ Value: 'postedDateDesc', PropertyName: 'PostedDate', Ascending: false }],
      Filters: [4, 5, 6].map(fieldName => ({ t: 'TermsSearchFilterDto', fieldName, extra: null, values: [] }))
    },
    matchCriteria: { PreferredJobs: [], Educations: [], LicenseAndCertifications: [], Skills: [], hasNoLicenses: false, SkippedSkills: [] }
  };
}

async function collectListings() {
  const all = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await fetchWithRetry(LIST_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', referer: `${BOARD_ROOT}/?o=postedDateDesc` },
      body: JSON.stringify(listRequest(page * PAGE_SIZE))
    });
    const payload = await response.json();
    const rows = Array.isArray(payload?.opportunities) ? payload.opportunities
      : Array.isArray(payload?.data?.opportunities) ? payload.data.opportunities
      : Array.isArray(payload?.Opportunities) ? payload.Opportunities
      : [];
    if (page === 0 && !rows.length) throw new Error('Csquare UKG board returned no opportunities; preserving the prior verified snapshot.');
    all.push(...rows);
    if (rows.length < PAGE_SIZE) return all;
  }
  throw new Error(`Csquare UKG pagination exceeded ${MAX_PAGES} pages; refusing a potentially incomplete snapshot.`);
}

function runClassifierTests() {
  const cases = [
    ['ops tech 1', 'Data Center Operations Technician 1', 'Provides 24x7 data center support.', 'Data Center Operations', '0-2-years'],
    ['facilities tech 2 preferred experience', 'Data Center Facilities Technician 2 (Electrical / HVAC)', 'High School Diploma required. Technical certification preferred. 2 years mission critical facilities operations experience preferred.', 'Data Center Operations', '2-5-years'],
    ['project manager 3-5', 'Project Manager, Data Center Construction', 'Minimum 3-5 years of experience in building design, construction, or operations.', 'Data Center Operations', '2-5-years'],
    ['operations engineer 5 years', 'Operations Engineer (Mechanical / Electrical)', 'Minimum of 5 years of experience in mission critical facility building design, construction, commissioning or operations.', 'Data Center Operations', '2-5-years'],
    ['sales engineer 7 years', 'Sales Engineer, Data Centers', '5-7 years of experience required.', 'Sales', null],
    ['senior architect', 'Senior Data Center Architect', '10 years of experience required.', 'Engineering', null],
    ['unknown engineer', 'Data Center Engineer', 'Support facilities and operations.', 'Data Center Operations', null],
    ['unrelated analyst', 'Utility Analyst', 'Analyze utility bills.', 'Finance', null]
  ];
  const failures = [];
  for (const [name, title, description, category, expected] of cases) {
    const actual = classify(title, description, category).classification?.experience ?? null;
    if (actual !== expected) failures.push(`${name}: expected ${expected}, got ${actual}`);
  }
  if (failures.length) throw new Error(`Csquare classifier regression: ${failures.join(' | ')}`);
  console.log(`Csquare classifier passed ${cases.length} regression cases.`);
}

function runDetailParserTest() {
  const fixture = `<html><script>new US.Opportunity.CandidateOpportunityDetail({"Title":"Operations Technician 1","Description":"Support {critical} data center systems","Locations":[{"Address":{"City":"Irvine","State":{"Code":"CA","Name":"California"},"Country":{"Code":"USA","Name":"United States"}}}]});</script></html>`;
  const payload = extractCandidatePayload(fixture);
  if (payload.Title !== 'Operations Technician 1' || normalizeLocation(payload, {}) !== 'Irvine, CA') throw new Error('Csquare UKG detail parser regression');
  console.log('Csquare UKG detail parser regression passed.');
}

if (process.argv.includes('--test-classifier')) { runClassifierTests(); process.exit(0); }
if (process.argv.includes('--test-detail-parser')) { runDetailParserTest(); process.exit(0); }

const previousJobs = await readJson(JOBS_PATH, []);
const priorStatus = await readJson(STATUS_PATH, {});
if (!Array.isArray(previousJobs) || !previousJobs.length) throw new Error('Public jobs feed is empty or invalid.');

const listings = await collectListings();
const diagnostics = {
  listedRoles: listings.length,
  candidateRoles: 0,
  detailVerified: 0,
  qualifyingRoles: 0,
  rejectedOutOfScope: 0,
  rejectedSeniorOrCommercial: 0,
  rejectedOver5Years: 0,
  rejectedUnknownExperience: 0,
  rejectedNonUs: 0
};
const collected = [];
const detailErrors = [];

for (const listing of listings) {
  const title = clean(listing?.Title || listing?.title || listing?.Name || listing?.name);
  const category = clean(listing?.JobCategoryName || listing?.jobCategoryName || listing?.Category || listing?.category);
  if (!candidateTitlePattern.test(title)) { diagnostics.rejectedOutOfScope += 1; continue; }
  diagnostics.candidateRoles += 1;

  const id = clean(listing?.Id || listing?.id || listing?.OpportunityId || listing?.opportunityId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    detailErrors.push(`${title || '(untitled)'}: missing valid UKG opportunity id`);
    continue;
  }
  const sourceUrl = `${DETAIL_ROOT}?opportunityId=${encodeURIComponent(id)}`;
  let detail;
  try {
    const response = await fetchWithRetry(sourceUrl, { headers: { accept: 'text/html,application/xhtml+xml', referer: `${BOARD_ROOT}/?o=postedDateDesc` } });
    detail = extractCandidatePayload(await response.text());
    diagnostics.detailVerified += 1;
  } catch (error) {
    detailErrors.push(`${title}: ${error.message}`);
    continue;
  }

  const detailText = clean(collectStrings(detail).join(' '));
  const detailTitle = clean(detail?.Title || detail?.title || title) || title;
  const detailCategory = clean(detail?.JobCategoryName || detail?.jobCategoryName || category) || category;
  const employmentType = clean(detail?.EmploymentType || detail?.employmentType || listing?.EmploymentType || listing?.employmentType);
  const { classification, reason } = classify(detailTitle, detailText, detailCategory, employmentType);
  if (!classification) {
    if (reason === 'senior-or-commercial-title' || reason === 'manager-title') diagnostics.rejectedSeniorOrCommercial += 1;
    else if (reason === 'over-5-years') diagnostics.rejectedOver5Years += 1;
    else if (reason === 'unknown-experience') diagnostics.rejectedUnknownExperience += 1;
    else diagnostics.rejectedOutOfScope += 1;
    continue;
  }

  const location = normalizeLocation(detail, listing);
  if (!location) { diagnostics.rejectedNonUs += 1; continue; }
  const postedAt = isoDate(listing?.PostedDate || listing?.postedDate || detail?.PostedDate || detail?.postedDate);
  const postedHours = postedAt ? Math.max(0, Math.round((Date.now() - new Date(postedAt).getTime()) / 36e5)) : 9999;
  collected.push({
    id: `ukg-csquare-${id}`,
    title: detailTitle,
    company: COMPANY,
    location,
    type: classification.type,
    experience: classification.experience,
    tags: tagsFor(detailTitle, detailText, classification.experience, classification.type),
    pay: 'Pay not listed',
    salaryMin: null,
    salaryMax: null,
    salarySortMax: null,
    postedAt,
    postedHours,
    source: 'Employer career site',
    sourceUrl,
    active: true,
    demo: false
  });
}

if (detailErrors.length) {
  throw new Error(`Csquare UKG detail verification failed for ${detailErrors.length} candidate role(s); preserving prior verified data. ${detailErrors.slice(0, 5).join(' | ')}`);
}

const csquareJobs = dedupe(collected);
diagnostics.qualifyingRoles = csquareJobs.length;
const merged = dedupe([...previousJobs.filter(job => clean(job?.company) !== COMPANY), ...csquareJobs]);
merged.sort((a, b) => (a.postedHours ?? 9999) - (b.postedHours ?? 9999));

const checkedAt = new Date().toISOString();
const status = {
  ...priorStatus,
  updatedAt: checkedAt,
  jobs: merged.length,
  csquare: {
    checkedAt,
    lastSuccessfulAt: checkedAt,
    sourceHealthy: true,
    listingComplete: true,
    authoritativeSnapshot: true,
    officialCareerPage: OFFICIAL_CAREERS,
    officialBoard: BOARD_ROOT,
    api: LIST_URL,
    ...diagnostics
  }
};

await writeFile(SNAPSHOT_PATH, JSON.stringify(csquareJobs, null, 2) + '\n');
await writeFile(JOBS_PATH, JSON.stringify(merged, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
console.log(`Csquare: ${csquareJobs.length} qualifying U.S. role(s) from ${listings.length} official UKG listing row(s); ${diagnostics.detailVerified} candidate detail page(s) verified; feed now ${merged.length} jobs.`);
