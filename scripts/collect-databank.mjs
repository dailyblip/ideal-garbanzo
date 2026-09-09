import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const COMPANY = 'DataBank';
const CAREERS_URL = 'https://www.databank.com/about-databank/careers-at-databank/';
const PORTAL_ROOT = 'https://www.databankcareers.com';
const TALENTREEF_API = 'https://prod-kong.internal.talentreef.com';
const SEARCH_URL = `${TALENTREEF_API}/apply/proxy-es/search-en-us/posting/_search`;
const ALIASES = ['databank', 'DataBank', 'databank-holdings', 'databankholdings', 'databankholdingsltd'];
const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/databank-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

const SEARCH_FIELDS = [
  'positionType', 'category', 'description', 'address', 'jobId', 'clientId',
  'clientName', 'brandId', 'brand', 'location', 'internalOrExternal', 'url',
  'postingUuid', 'isSalaried', 'minCompensation', 'maxCompensation', 'pubCompensation'
];

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
const hash = value => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 14);
const normalizeIdentity = value => lower(value).replace(/[^a-z0-9]+/g, ' ').trim();

const strongTitlePattern = /\b(?:data cent(?:er|re)(?: operations?)? technician|data cent(?:er|re) engineering intern|data cent(?:er|re) operations?|critical infrastructure(?: technician| engineer| operator)?|critical facilit(?:y|ies)(?: technician| engineer| operator)?|facilit(?:y|ies) technician|electrical technician|mechanical technician|critical environment(?:s)?(?: technician| engineer| operator)?)\b/i;
const contextualTitlePattern = /\b(?:technician|operator|engineer|electrician|mechanic|intern|apprentice|trainee)\b/i;
const dataCenterContextPattern = /\b(?:data cent(?:er|re)|critical infrastructure|critical facilit(?:y|ies)|critical environment|colocation|mission[- ]critical|ups|switchgear|generator|pdu|bms|epms|crah|crac|chiller|cooling|white space|server racks?)\b/i;
const excludedTitlePattern = /\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|superintendent|foreman|architect|security|sales|account executive|solutions engineer|technical support|support engineer|project manager|product manager|analyst|finance|procurement|marketing|software|developer|data scientist|human resources|recruiter)\b/i;
const excludedDescriptionPattern = /\b(?:evergreen requisition|talent pool|talent community|general application|future opportunit(?:y|ies))\b/i;

const stateAbbrPattern = /(?:,|\s)\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)(?:\b|$)/i;
const usStateNames = [
  'alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi','missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico','new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota','tennessee','texas','utah','vermont','virginia','washington','west virginia','wisconsin','wyoming','district of columbia'
];

function requiredExperienceText(description = '') {
  const text = clean(description);
  const preferred = text.search(/\b(?:preferred qualifications?|preferred experience|preferred skills?|nice to have|bonus qualifications?)\b/i);
  return preferred >= 0 ? text.slice(0, preferred) : text;
}

function statedExperienceYears(text = '') {
  const normalized = lower(text)
    .replace(/\bzero\b/g, '0').replace(/\bone\b/g, '1').replace(/\btwo\b/g, '2')
    .replace(/\bthree\b/g, '3').replace(/\bfour\b/g, '4').replace(/\bfive\b/g, '5')
    .replace(/\bsix\b/g, '6').replace(/\bseven\b/g, '7').replace(/\beight\b/g, '8')
    .replace(/\bnine\b/g, '9').replace(/\bten\b/g, '10');
  const values = [];
  const patterns = [
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+years?['’]?(?:\s+(?:of|prior))?\s+(?:direct\s+|relevant\s+|related\s+|professional\s+|work\s+|data cent(?:er|re)\s+|mission critical\s+)?experience/gi,
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?['’]?(?:\s+(?:of|prior))?\s+(?:direct\s+|relevant\s+|related\s+|professional\s+|work\s+|data cent(?:er|re)\s+|mission critical\s+)?experience/gi,
    /experience(?:\s+(?:of|in))?\s+(?:at least\s+|minimum(?: of)?\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?/gi,
    /(\d{1,2})\s*(?:\+|or more)?\s+years?['’]?\s+(?:of\s+)?experience\b/gi
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const suffix = normalized.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 60);
      if (/^\s*(?:is|are|would be)?\s*(?:preferred|desired|a plus|helpful|beneficial)\b/i.test(suffix)) continue;
      values.push(Number(match[1]));
      if (match[2]) values.push(Number(match[2]));
    }
  }
  return values.filter(value => Number.isFinite(value) && value >= 0 && value <= 50);
}

function classify(title, description = '') {
  const t = clean(title);
  const d = clean(description);
  if (!t || excludedTitlePattern.test(t) || excludedDescriptionPattern.test(d)) return { classification: null, reason: 'out-of-scope-title' };
  if (!strongTitlePattern.test(t) && !(contextualTitlePattern.test(t) && dataCenterContextPattern.test(d))) {
    return { classification: null, reason: 'out-of-scope-title' };
  }

  let type = 'entry-level';
  if (/\bintern(?:ship)?\b/i.test(t)) type = 'internship';
  else if (/\bapprentice(?:ship)?\b/i.test(t)) type = 'apprenticeship';
  else if (/\btrainee\b/i.test(t)) type = 'trainee';

  const required = requiredExperienceText(d);
  const years = statedExperienceYears(required);
  if (years.some(year => year > 5)) return { classification: null, reason: 'over-5-years' };

  const explicitProgram = type !== 'entry-level';
  const explicitNoExperience = /(?:no|zero) (?:prior )?experience(?: is)? (?:required|needed)|experience (?:is )?not required/i.test(required);
  const levelOneOrTwo = /\b(?:technician|operator|engineer)\s*(?:i|ii|1|2)\b/i.test(t) || /\b(?:level|tier)\s*(?:i|ii|1|2)\b/i.test(t);
  const earlySignal = explicitProgram || explicitNoExperience || levelOneOrTwo || /\bearly career\b|\bentry[- ]level\b|\btraining provided\b|\b0\s*(?:-|–|to)\s*2\s+years?\b/i.test(required) || years.some(year => year <= 2);
  const midSignal = /\b(?:technician|operator|engineer)\s*(?:ii|2)\b/i.test(t) || years.some(year => year >= 3);
  if (!years.length && !earlySignal) return { classification: null, reason: 'unknown-experience' };

  let experience = '0-2-years';
  if (explicitNoExperience) experience = 'no-experience';
  else if (midSignal) experience = '2-5-years';

  return { classification: { type, experience }, reason: null };
}

function isUsLocation(value = '') {
  const text = clean(value);
  if (!text) return false;
  const l = lower(text);
  if (/\b(?:united states|usa|u\.s\.)\b/i.test(text)) return true;
  if (stateAbbrPattern.test(text)) return true;
  return usStateNames.some(state => l.includes(state));
}

function locationFromSource(source = {}) {
  const address = source?.address && typeof source.address === 'object' ? source.address : {};
  const city = clean(address?.city || source?.city || '');
  const state = clean(address?.stateOrProvince || address?.state || source?.stateOrProvince || source?.stateOrProvinceFull || '');
  const cityState = [city, state].filter(Boolean).join(', ');
  if (isUsLocation(cityState)) return cityState;

  const location = typeof source?.location === 'string'
    ? clean(source.location)
    : clean(source?.location?.name || source?.location?.title || source?.location?.number || '');
  if (isUsLocation(location)) return location;

  const rawUrl = clean(source?.url);
  const slug = rawUrl.match(/-job-([A-Za-z0-9-]+)-([A-Z]{2})-US-(?:\d+)\.html/i);
  if (slug) {
    const cityFromSlug = slug[1].split('-').map(part => part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : '').join(' ');
    return `${cityFromSlug}, ${slug[2].toUpperCase()}`;
  }
  return null;
}

function payFor(source = {}) {
  const min = Number(source?.minCompensation);
  const max = Number(source?.maxCompensation);
  const salaryMin = Number.isFinite(min) && min > 0 ? min : null;
  const salaryMax = Number.isFinite(max) && max > 0 ? max : null;
  if (!salaryMin && !salaryMax) return { pay: 'Pay not listed', salaryMin: null, salaryMax: null, salarySortMax: null };
  const low = salaryMin ?? salaryMax;
  const high = salaryMax ?? salaryMin;
  const published = lower(source?.pubCompensation || '');
  const explicitlyAnnual = /\b(?:annual|annually|year|yearly|yr|salary|salaried)\b/i.test(published);
  const explicitlyHourly = /\b(?:hour|hourly|hr)\b/i.test(published);
  const salaried = explicitlyAnnual || (!explicitlyHourly && (source?.isSalaried === true || String(source?.isSalaried).toLowerCase() === 'true' || high >= 1000));
  return {
    pay: `$${Number(low).toLocaleString('en-US')}–$${Number(high).toLocaleString('en-US')} / ${salaried ? 'year' : 'hr'}`,
    salaryMin: low,
    salaryMax: high,
    salarySortMax: salaried ? high : Math.round(high * 2080)
  };
}

function tagsFor(title, description, classification) {
  const text = lower(`${title} ${description}`);
  const tags = [];
  if (classification.type === 'internship') tags.push('Internship');
  if (classification.type === 'apprenticeship') tags.push('Apprenticeship');
  if (classification.type === 'trainee') tags.push('Trainee');
  tags.push(classification.experience === 'no-experience' ? 'No Experience Needed' : classification.experience === '2-5-years' ? '2–5 Years' : '0–2 Years');
  if (/\belectrical\b|\bswitchgear\b|\bups\b|\bgenerator\b|\bpdu\b/.test(text)) tags.push('Electrical');
  if (/\bcritical facilit|\bcritical infrastructure|\bmechanical\b|\bhvac\b|\bchiller\b|\bcrah\b|\bcrac\b|\bcooling\b/.test(text)) tags.push('Critical Facilities');
  if (/\bfiber\b|\bcabling\b|\bcross-connect\b|\bnetwork\b/.test(text)) tags.push('Network / Cabling');
  if (/\btraining\b|\bmentorship\b|\bearly career\b/.test(text)) tags.push('Training / Mentorship');
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

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: 'application/json',
      'user-agent': 'DataCenterCareersBot/1.7 (+https://datacentercareers.us/)',
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(20000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${url}: ${text.slice(0, 180)}`);
  try { return JSON.parse(text); }
  catch { throw new Error(`Invalid JSON from ${url}`); }
}

async function resolveClient() {
  const errors = [];
  for (const alias of ALIASES) {
    const url = `${TALENTREEF_API}/apply/careerPages/alias/${encodeURIComponent(alias)}`;
    try {
      const payload = await fetchJson(url);
      if (!Array.isArray(payload) || !payload.length) continue;
      const first = payload[0] || {};
      const clients = Array.isArray(first.clients) ? first.clients : [];
      const clientId = clean(clients[0]?.legacyClientId || clients[0]?.clientId || first?.clientId);
      if (!clientId) continue;
      const brands = Array.isArray(first.brands) ? first.brands : [];
      const brand = clean(brands[0]?.name || brands[0]?.brand || first?.brand || '');
      return { alias, clientId, brand };
    } catch (error) {
      errors.push(`${alias}: ${error.message}`);
      if (!/^404\b/.test(error.message)) continue;
    }
  }
  throw new Error(`Unable to resolve DataBank TalentReef client alias. ${errors.join(' | ')}`);
}

async function listPostings(clientId) {
  const rows = [];
  let total = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const payload = await fetchJson(SEARCH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from,
        size: PAGE_SIZE,
        _source: SEARCH_FIELDS,
        query: { bool: { filter: [{ terms: { 'clientId.raw': [clientId] } }] } },
        sort: [{ jobId: { order: 'desc' } }]
      })
    });
    const hits = Array.isArray(payload?.hits?.hits) ? payload.hits.hits : [];
    const rawTotal = payload?.hits?.total;
    total = typeof rawTotal === 'number' ? rawTotal : Number(rawTotal?.value ?? total);
    rows.push(...hits.map(hit => hit?._source).filter(source => source && typeof source === 'object'));
    if (hits.length < PAGE_SIZE || (Number.isFinite(total) && rows.length >= total)) break;
  }
  if (!Number.isFinite(total)) throw new Error('TalentReef search did not return a valid total count.');
  if (rows.length < total) throw new Error(`TalentReef listing incomplete: fetched ${rows.length}/${total} postings.`);
  return { rows, total };
}

if (process.argv.includes('--test-classifier')) {
  const cases = [
    ['technician one no explicit years', 'Data Center Technician 1', 'Maintain data center critical infrastructure, UPS and generators.', 'entry-level', '0-2-years'],
    ['technician one preferred range stays early', 'Data Center Technician 1', 'High school diploma required. 0-4 years of data center or NOC experience preferred.', 'entry-level', '0-2-years'],
    ['technician two mid-level', 'Data Center Technician 2', 'Maintain data center critical infrastructure and cooling systems.', 'entry-level', '2-5-years'],
    ['engineering internship', 'Data Center Engineering Intern', 'Support data center facilities engineering projects.', 'internship', '0-2-years'],
    ['five-year critical infrastructure accepted', 'Critical Infrastructure Technician', 'Minimum 5 years of experience in mission critical operations.', 'entry-level', '2-5-years'],
    ['building systems at five years accepted', 'Building Systems Engineer', 'Design BMS and EPMS for data center facilities. 5+ years of experience in building systems engineering.', 'entry-level', '2-5-years'],
    ['seven-year role rejected', 'Critical Infrastructure Engineer', 'Minimum 7 years of experience in data center critical infrastructure.', null, null],
    ['business internship rejected', 'Business Operations Analyst Intern', 'Support pricing and managed services operations in a data center company.', null, null],
    ['technical support rejected', 'Technical Support Engineer 2 (Remote)', 'Support Windows, Linux, cloud, application and network issues across a multi data center environment. 5+ years of IT experience required.', null, null],
    ['solutions engineer rejected', 'Solutions Engineer', 'Five years of experience designing data center solutions for customers.', null, null],
    ['unknown unlevelled role rejected', 'Critical Facilities Engineer', 'Operate mission-critical electrical and mechanical systems.', null, null]
  ];
  const failures = [];
  for (const [name, title, description, expectedType, expectedExperience] of cases) {
    const result = classify(title, description).classification;
    const actualType = result?.type ?? null;
    const actualExperience = result?.experience ?? null;
    if (actualType !== expectedType || actualExperience !== expectedExperience) {
      failures.push(`${name}: expected ${expectedType}/${expectedExperience}, got ${actualType}/${actualExperience}`);
    }
  }
  const annualPay = payFor({ minCompensation: 140000, maxCompensation: 160000, isSalaried: false });
  if (annualPay.pay !== '$140,000–$160,000 / year' || annualPay.salarySortMax !== 160000) {
    failures.push(`annual compensation inference: got ${annualPay.pay} / ${annualPay.salarySortMax}`);
  }
  const hourlyPay = payFor({ minCompensation: 28.28, maxCompensation: 30, isSalaried: false });
  if (hourlyPay.pay !== '$28.28–$30 / hr' || hourlyPay.salarySortMax !== 62400) {
    failures.push(`hourly compensation inference: got ${hourlyPay.pay} / ${hourlyPay.salarySortMax}`);
  }
  if (failures.length) {
    failures.forEach(failure => console.error(`DataBank classifier regression: ${failure}`));
    process.exit(1);
  }
  console.log(`DataBank classifier passed ${cases.length} role cases plus compensation inference.`);
  process.exit(0);
}

const previousJobs = await readJson(JOBS_PATH, []);
const priorStatus = await readJson(STATUS_PATH, {});
const client = await resolveClient();
const listing = await listPostings(client.clientId);
if (listing.total === 0) throw new Error('DataBank TalentReef source returned zero public postings; preserving the last verified snapshot.');

const diagnostics = {
  listedJobs: listing.total,
  externalJobs: 0,
  usJobs: 0,
  candidateRoles: 0,
  qualifyingRoles: 0,
  rejectedOutOfScopeTitle: 0,
  rejectedOver5Years: 0,
  rejectedUnknownExperience: 0,
  rejectedLocation: 0
};
const collected = [];

for (const source of listing.rows) {
  const visibility = lower(source?.internalOrExternal || '');
  if (visibility.includes('internal') && !visibility.includes('external')) continue;
  diagnostics.externalJobs += 1;

  const location = locationFromSource(source);
  if (!location) {
    diagnostics.rejectedLocation += 1;
    continue;
  }
  diagnostics.usJobs += 1;

  const title = clean(source?.positionType || source?.title || '');
  const description = clean(source?.description || '');
  if (strongTitlePattern.test(title) || (contextualTitlePattern.test(title) && dataCenterContextPattern.test(description))) diagnostics.candidateRoles += 1;
  const { classification, reason } = classify(title, description);
  if (!classification) {
    if (reason === 'over-5-years') diagnostics.rejectedOver5Years += 1;
    else if (reason === 'unknown-experience') diagnostics.rejectedUnknownExperience += 1;
    else diagnostics.rejectedOutOfScopeTitle += 1;
    continue;
  }

  const jobId = clean(source?.jobId || source?.postingUuid || hash(`${title}|${location}`));
  if (!jobId) continue;
  const sourceUrl = `${PORTAL_ROOT}/clients/${encodeURIComponent(client.clientId)}/posting/${encodeURIComponent(jobId)}`;
  collected.push({
    id: `talentreef-databank-${jobId}`,
    title,
    company: COMPANY,
    location,
    type: classification.type,
    experience: classification.experience,
    tags: tagsFor(title, description, classification),
    ...payFor(source),
    postedAt: null,
    source: 'Employer career site',
    sourceUrl,
    active: true,
    demo: false
  });
}

const databankJobs = dedupe(collected);
diagnostics.qualifyingRoles = databankJobs.length;
const merged = dedupe([
  ...previousJobs.filter(job => clean(job?.company) !== COMPANY),
  ...databankJobs
]);
const now = Date.now();
for (const job of merged) {
  job.postedHours = job.postedAt ? Math.max(0, Math.round((now - new Date(job.postedAt).getTime()) / 36e5)) : 9999;
}
merged.sort((a, b) => (a.postedHours ?? 9999) - (b.postedHours ?? 9999));

const status = {
  ...priorStatus,
  updatedAt: new Date().toISOString(),
  jobs: merged.length,
  databank: {
    checkedAt: new Date().toISOString(),
    sourceHealthy: true,
    listingComplete: true,
    officialCareerPage: CAREERS_URL,
    officialTalentReefPortal: PORTAL_ROOT,
    talentReefAlias: client.alias,
    talentReefClientId: client.clientId,
    talentReefBrand: client.brand || null,
    authoritativeSnapshot: true,
    ...diagnostics
  }
};

await writeFile(SNAPSHOT_PATH, JSON.stringify(databankJobs, null, 2) + '\n');
await writeFile(JOBS_PATH, JSON.stringify(merged, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
console.log(`DataBank: ${databankJobs.length} qualifying U.S. role(s) from ${listing.total} public TalentReef postings; feed now ${merged.length} jobs.`);
