import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const COMPANY = 'CyrusOne';
const CAREERS_URL = 'https://www.cyrusone.com/company/careers';
const HOST = 'cyrusone.wd1.myworkdayjobs.com';
const TENANT = 'cyrusone';
const SITE = 'CyrusOneCareerPortal';
const LIST_URL = `https://${HOST}/wday/cxs/${TENANT}/${SITE}/jobs`;
const DETAIL_BASE = `https://${HOST}/wday/cxs/${TENANT}/${SITE}`;
const PUBLIC_BASE = `https://${HOST}/en-US/${SITE}`;
const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/cyrusone-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const PAGE_SIZE = 20;
const MAX_PAGES = 30;

const clean = value => String(value ?? '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&quot;/gi, '"')
  .replace(/&ndash;|&#8211;/gi, '–')
  .replace(/&mdash;|&#8212;/gi, '—')
  .replace(/\s+/g, ' ')
  .trim();
const lower = value => clean(value).toLowerCase();
const normalizeIdentity = value => lower(value).replace(/[^a-z0-9]+/g, ' ').trim();
const hash = value => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 14);
const hasAny = (text, terms) => terms.some(term => text.includes(term));

const STATE_CODES = new Map(Object.entries({
  alabama:'AL',alaska:'AK',arizona:'AZ',arkansas:'AR',california:'CA',colorado:'CO',connecticut:'CT',delaware:'DE',florida:'FL',georgia:'GA',hawaii:'HI',idaho:'ID',illinois:'IL',indiana:'IN',iowa:'IA',kansas:'KS',kentucky:'KY',louisiana:'LA',maine:'ME',maryland:'MD',massachusetts:'MA',michigan:'MI',minnesota:'MN',mississippi:'MS',missouri:'MO',montana:'MT',nebraska:'NE',nevada:'NV','new hampshire':'NH','new jersey':'NJ','new mexico':'NM','new york':'NY','north carolina':'NC','north dakota':'ND',ohio:'OH',oklahoma:'OK',oregon:'OR',pennsylvania:'PA','rhode island':'RI','south carolina':'SC','south dakota':'SD',tennessee:'TN',texas:'TX',utah:'UT',vermont:'VT',virginia:'VA',washington:'WA','west virginia':'WV',wisconsin:'WI',wyoming:'WY','district of columbia':'DC'
}));
const STATE_ABBR = new Set(STATE_CODES.values());
const STRONG_TITLE_TERMS = [
  'data center', 'data centre', 'critical environment', 'critical environments',
  'critical facilities', 'critical facility', 'facilities technician', 'facility technician',
  'facilities operator', 'facility operator'
];
const CONTEXTUAL_TITLE_TERMS = [
  'technician', 'operator', 'electrician', 'electrical', 'mechanical', 'facilities',
  'facility', 'maintenance', 'controls', 'monitoring', 'marc', 'service delivery',
  'apprentice', 'trainee', 'intern'
];
const CONTEXT_TERMS = [
  'data center', 'data centre', 'critical environment', 'critical environments',
  'critical facilities', 'mission critical', 'mission-critical', 'colocation',
  'ups', 'switchgear', 'generator', 'chiller', 'crah', 'crac', 'bms', 'epms',
  'dcim', 'power distribution', 'white space', 'server rack', '24/7/365'
];
const EXCLUDED_TITLE = /\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|superintendent|foreman|architect|security|sales|account executive|legal|counsel|recruiter|marketing|finance|product manager|program manager|project manager)\b/i;
const ENTRY_TITLE = /\b(?:intern|apprentice|trainee|technician\s+i\b|technician\s+1\b|operator\s+i\b|operator\s+1\b|level\s+i\b|level\s+1\b|associate\b|entry[- ]level)\b/i;

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'DataCenterCareersBot/1.4 (+https://datacentercareers.us/)',
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

function candidateTitle(title = '') {
  const t = lower(title);
  if (!t || EXCLUDED_TITLE.test(title)) return false;
  return hasAny(t, STRONG_TITLE_TERMS) || hasAny(t, CONTEXTUAL_TITLE_TERMS);
}

function relevant(title = '', description = '') {
  const t = lower(title);
  const d = lower(description);
  if (!t || EXCLUDED_TITLE.test(title)) return false;
  if (hasAny(t, STRONG_TITLE_TERMS)) return true;
  return hasAny(t, CONTEXTUAL_TITLE_TERMS) && hasAny(d, CONTEXT_TERMS);
}

function requiredExperienceText(description = '') {
  const text = clean(description);
  const preferredHeading = text.search(/\b(?:preferred qualifications?|preferred experience|preferred skills?|nice to have|bonus qualifications?)\b/i);
  return preferredHeading >= 0 ? text.slice(0, preferredHeading) : text;
}

function statedExperienceYears(text = '') {
  const normalized = lower(text)
    .replace(/\bzero\b/g, '0').replace(/\bone\b/g, '1').replace(/\btwo\b/g, '2')
    .replace(/\bthree\b/g, '3').replace(/\bfour\b/g, '4').replace(/\bfive\b/g, '5')
    .replace(/\bsix\b/g, '6').replace(/\bseven\b/g, '7').replace(/\beight\b/g, '8')
    .replace(/\bnine\b/g, '9').replace(/\bten\b/g, '10');
  const values = [];
  const patterns = [
    /\((\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\)\s+years?/gi,
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+years?(?:\s+of)?\s+(?:direct\s+|relevant\s+|related\s+|professional\s+|work\s+|data center\s+|mission critical\s+)?experience/gi,
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?(?:\s+of)?\s+(?:direct\s+|relevant\s+|related\s+|professional\s+|work\s+|data center\s+|mission critical\s+)?experience/gi,
    /experience(?:\s+(?:of|in))?\s+(?:at least\s+|minimum(?: of)?\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?/gi,
    /(\d{1,2})\s*(?:\+|or more)?\s+years?['’]?\s+experience\b/gi
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      values.push(Number(match[1]));
      if (match[2]) values.push(Number(match[2]));
    }
  }
  return values.filter(value => Number.isFinite(value) && value >= 0 && value <= 50);
}

function classify(title, description = '') {
  if (!relevant(title, description)) return { classification: null, reason: EXCLUDED_TITLE.test(title) ? 'senior-or-excluded-title' : 'out-of-scope' };
  const required = requiredExperienceText(description);
  const years = statedExperienceYears(required);
  if (years.some(year => year > 5)) return { classification: null, reason: 'over-5-years' };

  const t = lower(title);
  let type = 'entry-level';
  if (t.includes('intern')) type = 'internship';
  else if (t.includes('apprentice')) type = 'apprenticeship';
  else if (t.includes('trainee')) type = 'trainee';

  const explicitNoExperience = /(?:no|zero) (?:prior )?experience(?: is)? (?:required|needed)|experience (?:is )?not required/i.test(required);
  if (explicitNoExperience) return { classification: { type, experience: 'no-experience' }, reason: null };
  if (years.some(year => year >= 3)) return { classification: { type, experience: '2-5-years' }, reason: null };
  if (years.some(year => year <= 2)) return { classification: { type, experience: '0-2-years' }, reason: null };
  if (ENTRY_TITLE.test(title)) return { classification: { type, experience: '0-2-years' }, reason: null };

  return { classification: null, reason: 'unknown-experience' };
}

function normalizeLocation(value = '') {
  const text = clean(value).replace(/^locations?\s*/i, '');
  if (!text) return '';

  const comma = text.match(/^(.+?),\s*([A-Z]{2})(?:\b|$)/);
  if (comma && STATE_ABBR.has(comma[2])) return `${clean(comma[1])}, ${comma[2]}`;

  const parts = text.split(/\s+-\s+|\s*\|\s*/).map(clean).filter(Boolean);
  const lowered = parts.map(lower);
  const stateIndex = lowered.findIndex(part => STATE_CODES.has(part));
  if (stateIndex >= 0) {
    const code = STATE_CODES.get(lowered[stateIndex]);
    const cityCandidates = parts.filter((part, index) => index !== stateIndex && !/^(?:united states(?: of america)?|usa|us)$/i.test(part));
    const city = cityCandidates.at(-1);
    if (city && !STATE_CODES.has(lower(city))) return `${city}, ${code}`;
    return code;
  }

  for (const match of text.matchAll(/\b([A-Z]{2})\b/g)) {
    if (STATE_ABBR.has(match[1])) return text;
  }
  return text;
}

function isUsLocation(value = '') {
  const text = clean(value);
  const l = lower(text);
  if (!text) return false;
  if (/\b(?:united states|usa|u\.s\.)\b/i.test(text)) return true;
  if ([...STATE_CODES.keys()].some(state => l.includes(state))) return true;
  return [...text.matchAll(/\b([A-Z]{2})\b/g)].some(match => STATE_ABBR.has(match[1]));
}

function payFor(description = '') {
  const text = clean(description);
  const match = text.match(/\$([\d,.]+)\s*(?:-|–|to)\s*\$?([\d,.]+)\s*(?:\/|per\s+)?\s*(hour|hourly|hr|year|yearly|yr|annum|annual|annually)?/i);
  if (!match) return { pay: 'Pay not listed', salaryMin: null, salaryMax: null, salarySortMax: null };
  const min = Number(match[1].replace(/,/g, ''));
  const max = Number(match[2].replace(/,/g, ''));
  const unit = lower(match[3] || '');
  const hourly = /hour|hr/.test(unit) || (!unit && max < 1000);
  return {
    pay: `$${match[1]}–$${match[2]} / ${hourly ? 'hr' : 'year'}`,
    salaryMin: min,
    salaryMax: max,
    salarySortMax: Number.isFinite(max) ? (hourly ? Math.round(max * 2080) : max) : null
  };
}

function tagsFor(title, description, classification) {
  const text = lower(`${title} ${description}`);
  const tags = [];
  if (classification.type === 'internship') tags.push('Internship');
  if (classification.type === 'apprenticeship') tags.push('Apprenticeship');
  if (classification.type === 'trainee') tags.push('Trainee');
  if (classification.experience === 'no-experience') tags.push('No Experience Needed');
  else if (classification.experience === '0-2-years') tags.push('0–2 Years');
  else tags.push('2–5 Years');
  if (/training|development|certification|apprentice|mentor/.test(text)) tags.push('Training / Mentorship');
  if (/electrical|switchgear|ups|generator|epms/.test(text)) tags.push('Electrical');
  if (/mechanical|hvac|chiller|crah|crac|cooling|critical environment|critical facilit|bms/.test(text)) tags.push('Critical Facilities');
  if (/network|cabling|server|smart hands|rack/.test(text)) tags.push('IT / Infrastructure');
  return [...new Set(tags)].slice(0, 5);
}

function parseDate(value) {
  const text = clean(value);
  if (!text || /posted\s+\d|posted\s+30\+|today|yesterday/i.test(text)) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
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

async function listJobs() {
  const rows = [];
  let total = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const offset = page * PAGE_SIZE;
    const payload = await fetchJson(LIST_URL, {
      method: 'POST',
      body: JSON.stringify({ appliedFacets: {}, limit: PAGE_SIZE, offset, searchText: '' })
    });
    const pageRows = Array.isArray(payload?.jobPostings) ? payload.jobPostings : [];
    if (total === null && Number.isFinite(Number(payload?.total))) total = Number(payload.total);
    rows.push(...pageRows);
    if (!pageRows.length || pageRows.length < PAGE_SIZE) break;
    if (total !== null && offset + PAGE_SIZE >= total) break;
  }
  return rows;
}

async function detailFor(row) {
  const path = clean(row?.externalPath);
  if (!path || !path.startsWith('/job/')) return {};
  try { return await fetchJson(`${DETAIL_BASE}${path}`); }
  catch (error) {
    console.warn(`CyrusOne detail fetch failed for ${path}: ${error.message}`);
    return {};
  }
}

function sourceUrlFor(info, row) {
  const external = clean(info?.externalUrl);
  if (/^https:\/\//i.test(external) && external.includes(HOST)) return external;
  const path = clean(row?.externalPath);
  return path ? `${PUBLIC_BASE}${path}` : CAREERS_URL;
}

function idFor(info, row, title, location) {
  const req = clean(info?.jobReqId || info?.jobRequisitionId || '');
  const path = clean(row?.externalPath);
  const fromPath = path.match(/_([A-Z]?R?\d{5,})$/i)?.[1] || path.match(/([A-Z]{1,3}\d{5,})/i)?.[1];
  return `workday-cyrusone-${clean(req || fromPath || hash(`${title}|${location}|${path}`)).replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

if (process.argv.includes('--test-classifier')) {
  const cases = [
    ['entry level I', 'Critical Environments Technician I', 'Operate and maintain critical data center systems under direction.', '0-2-years'],
    ['three to five accepted', 'MARC Technician', 'Three to five (3-5) years of data center experience preferred.', '2-5-years'],
    ['two to four accepted', 'Data Center Operations Technician', '2-4 years of related experience preferred.', '2-5-years'],
    ['seven rejected', 'Critical Facilities Technician', '7+ years of critical facilities experience required.', null],
    ['senior rejected', 'Senior Critical Environments Technician', '3-5 years of experience.', null],
    ['security rejected', 'Data Center Security Operations Technician', '2-4 years of experience in physical security systems.', null],
    ['unknown rejected', 'Facilities Technician', 'Maintain electrical and mechanical systems in a mission-critical data center.', null]
  ];
  const failures = [];
  for (const [name, title, description, expected] of cases) {
    const actual = classify(title, description).classification?.experience ?? null;
    if (actual !== expected) failures.push(`${name}: expected ${expected}, got ${actual}`);
  }
  if (failures.length) {
    for (const failure of failures) console.error(`CyrusOne classifier regression: ${failure}`);
    process.exit(1);
  }
  console.log(`CyrusOne classifier passed ${cases.length} regression cases.`);
  process.exit(0);
}

const previousJobs = await readJson(JOBS_PATH, []);
const priorStatus = await readJson(STATUS_PATH, {});
const rows = await listJobs();
if (!rows.length) throw new Error('CyrusOne Workday returned no public jobs; preserving prior verified roles.');

const diagnostics = {
  checkedAt: new Date().toISOString(),
  provider: 'Workday',
  officialCareersUrl: CAREERS_URL,
  sourceHealthy: true,
  listedJobs: rows.length,
  candidateRoles: 0,
  usCandidateRoles: 0,
  qualifyingRoles: 0,
  rejectedOutOfScope: 0,
  rejectedOver5Years: 0,
  rejectedUnknownExperience: 0
};
const collected = [];

for (const row of rows) {
  const listTitle = clean(row?.title);
  if (!candidateTitle(listTitle)) continue;
  diagnostics.candidateRoles += 1;

  const detail = await detailFor(row);
  const info = detail?.jobPostingInfo || detail?.jobPosting || detail || {};
  const title = clean(info?.title || listTitle);
  const description = clean(info?.jobDescription || info?.description || row?.jobDescription || '');
  const rawLocation = clean(info?.locationsText || info?.location || row?.locationsText || row?.location || '');
  if (!isUsLocation(rawLocation)) continue;
  diagnostics.usCandidateRoles += 1;

  const { classification, reason } = classify(title, description);
  if (!classification) {
    if (reason === 'over-5-years') diagnostics.rejectedOver5Years += 1;
    else if (reason === 'unknown-experience') diagnostics.rejectedUnknownExperience += 1;
    else diagnostics.rejectedOutOfScope += 1;
    continue;
  }

  const location = normalizeLocation(rawLocation);
  if (!location) continue;
  const sourceUrl = sourceUrlFor(info, row);
  if (!sourceUrl.includes(HOST)) continue;
  const postedAt = parseDate(info?.startDate || info?.postedOn || row?.postedOn);
  collected.push({
    id: idFor(info, row, title, location),
    title,
    company: COMPANY,
    location,
    type: classification.type,
    experience: classification.experience,
    tags: tagsFor(title, description, classification),
    ...payFor(description),
    postedAt,
    postedHours: postedAt ? Math.max(0, Math.round((Date.now() - new Date(postedAt).getTime()) / 36e5)) : 9999,
    source: 'Employer career site',
    sourceUrl,
    active: true,
    demo: false
  });
}

const cyrusOneJobs = dedupe(collected);
diagnostics.qualifyingRoles = cyrusOneJobs.length;
if (diagnostics.candidateRoles > 0 && cyrusOneJobs.length === 0) {
  throw new Error(`CyrusOne Workday listed ${diagnostics.candidateRoles} mission-title candidate role(s) but none passed U.S. 0–5 year classification; preserving prior verified roles.`);
}
if (cyrusOneJobs.length === 0) {
  throw new Error('CyrusOne Workday returned no qualifying U.S. roles; preserving prior verified roles.');
}

const merged = dedupe([
  ...previousJobs.filter(job => clean(job?.company) !== COMPANY),
  ...cyrusOneJobs
]);
const status = {
  ...priorStatus,
  cyrusOne: diagnostics,
  jobs: merged.length
};

await writeFile(SNAPSHOT_PATH, JSON.stringify(cyrusOneJobs, null, 2) + '\n');
await writeFile(JOBS_PATH, JSON.stringify(merged, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

console.log(`CyrusOne Workday: ${diagnostics.listedJobs} listed, ${diagnostics.candidateRoles} mission-title candidates, ${diagnostics.usCandidateRoles} U.S. candidates, ${cyrusOneJobs.length} verified 0–5 year role(s) published.`);
