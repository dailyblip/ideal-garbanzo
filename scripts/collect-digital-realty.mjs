import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

// Digital Realty's official careers page redirects to this Oracle Recruiting Cloud
// Candidate Experience site. The requisitions endpoint is public and unauthenticated.
const COMPANY = 'Digital Realty';
const OFFICIAL_SOURCE = 'https://www.digitalrealty.com/about/careers';
const HOST = 'hdep.fa.us2.oraclecloud.com';
const SITE = 'CX';
const LANG = 'en';
const PAGE_SIZE = 200;
const MAX_PAGES = 10;

const strongTitleTerms = [
  'data center', 'data centre', 'critical facilities', 'critical facility',
  'critical environment', 'critical environments', 'facility operations',
  'facilities operations'
];
const contextualTitleTerms = [
  'site engineer', 'technician', 'electrician', 'electrical', 'mechanical', 'facilities',
  'facility engineer', 'operator', 'controls', 'maintenance', 'commissioning',
  'apprentice', 'trainee', 'intern'
];
const contextTerms = [
  'data center', 'data centre', 'critical facilities', 'critical facility',
  'critical environment', 'critical environments', 'mission critical', 'mission-critical',
  'colocation', 'colo facility', 'ups', 'switchgear', 'generator', 'chiller', 'crah',
  'crac', 'bms', 'epms', 'dcim', 'power distribution', 'white space', 'server rack'
];
const excludedTitlePattern = /(^|[^a-z])(senior|sr\.?|lead|principal|manager|director|vice president|vp|head of|chief|supervisor|superintendent|foreman|architect|sales|account executive|legal|counsel|recruiter|marketing|finance|product manager|program manager|project manager)([^a-z]|$)/i;
const explicitEarlyTerms = [
  'intern', 'internship', 'apprentice', 'apprenticeship', 'trainee', 'entry level',
  'entry-level', 'no experience', 'level i', 'level 1', 'technician i', 'technician 1',
  'engineer i', 'engineer 1', 'operator i', 'operator 1', '0-2 years', '0–2 years',
  '1-2 years', '1–2 years'
];
const explicitMidTerms = [
  'level ii', 'level 2', 'technician ii', 'technician 2', 'engineer ii', 'engineer 2',
  'operator ii', 'operator 2', 'journeyman', '3 years', '4 years', '5 years',
  '2-5 years', '2–5 years', '3-5 years', '3–5 years'
];

const US_STATE_NAMES = [
  'alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware',
  'district of columbia','florida','georgia','hawaii','idaho','illinois','indiana','iowa',
  'kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan','minnesota',
  'mississippi','missouri','montana','nebraska','nevada','new hampshire','new jersey',
  'new mexico','new york','north carolina','north dakota','ohio','oklahoma','oregon',
  'pennsylvania','rhode island','south carolina','south dakota','tennessee','texas','utah',
  'vermont','virginia','washington','west virginia','wisconsin','wyoming'
];
const US_STATE_CODES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY',
  'LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH',
  'OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'
]);
const US_COUNTRY_LABELS = new Set(['united states', 'united states of america', 'usa', 'us', 'u.s.', 'u.s.a.']);

const clean = value => String(value ?? '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&#39;/gi, "'")
  .replace(/&quot;/gi, '"')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
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
      accept: 'application/json',
      'user-agent': 'Mozilla/5.0 (compatible; DataCenterCareersBot/1.3; +https://dailyblip.github.io/ideal-garbanzo/)'
    }
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

function buildListUrl(offset) {
  const facets = 'LOCATIONS%3BWORK_LOCATIONS%3BWORKPLACE_TYPES%3BTITLES%3BCATEGORIES%3BORGANIZATIONS%3BPOSTING_DATES%3BFLEX_FIELDS';
  const finder = `findReqs;siteNumber=${SITE},facetsList=${facets},limit=${PAGE_SIZE},sortBy=POSTING_DATES_DESC,offset=${offset}`;
  const expand = encodeURIComponent('requisitionList.workLocation,requisitionList.secondaryLocations');
  return `https://${HOST}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=${expand}&finder=${finder}&limit=${PAGE_SIZE}&offset=${offset}`;
}

function buildDetailUrl(id) {
  const finder = encodeURIComponent(`ById;Id=${id},siteNumber=${SITE}`);
  return `https://${HOST}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?onlyData=true&expand=all&finder=${finder}`;
}

function buildJobUrl(id) {
  return `https://${HOST}/hcmUI/CandidateExperience/${LANG}/sites/${SITE}/job/${encodeURIComponent(id)}`;
}

function firstText(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (typeof value === 'string' && clean(value)) return clean(value);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const nested of ['displayValue','Meaning','meaning','value','Value','label','Label','name','Name','text','content']) {
        if (typeof value[nested] === 'string' && clean(value[nested])) return clean(value[nested]);
      }
    }
  }
  return '';
}

function locationFor(req = {}) {
  const primary = firstText(req, ['PrimaryLocation', 'Location', 'location']);
  if (primary) return primary;
  const locations = Array.isArray(req.workLocation) ? req.workLocation : [];
  const first = locations[0] || {};
  return [first.TownOrCity, first.Region, first.Country].map(clean).filter(Boolean).join(', ');
}

function isUSLocation(location, req = {}) {
  const parts = String(location || '').split(',').map(clean).filter(Boolean);
  const tail = lower(parts.at(-1) || '');
  const country = lower(firstText(req, ['PrimaryLocationCountry', 'Country']));
  if (US_COUNTRY_LABELS.has(tail) || US_COUNTRY_LABELS.has(country)) return true;

  // Oracle commonly returns City, Region, Country. If a three-part location has
  // an explicit non-US country at the end, reject it before looking at state codes.
  if (parts.length >= 3 && tail && !US_COUNTRY_LABELS.has(tail)) return false;

  return parts.some(part => {
    const normalized = lower(part);
    return US_STATE_NAMES.includes(normalized) || US_STATE_CODES.has(part.toUpperCase());
  });
}

function titleCandidate(title = '') {
  const t = lower(title);
  if (!t || excludedTitlePattern.test(t)) return false;
  return hasAny(t, strongTitleTerms) || hasAny(t, contextualTitleTerms);
}

function relevant(title, description = '') {
  const t = lower(title);
  const d = lower(description);
  if (!t || excludedTitlePattern.test(t)) return false;
  if (hasAny(t, strongTitleTerms)) return true;
  return hasAny(t, contextualTitleTerms) && hasAny(d, contextTerms);
}

function statedExperienceYears(text = '') {
  const values = [];
  const patterns = [
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\+?\s*(?:-|–|to)\s*(\d{1,2})\s+years?(?:\s+of)?\s+(?:relevant\s+|related\s+)?experience/gi,
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\+?\s+years?(?:\s+of)?\s+(?:relevant\s+|related\s+)?experience/gi,
    /experience(?:\s+of)?\s+(?:at least\s+|minimum(?: of)?\s+)?(\d{1,2})\+?\s+years?/gi
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      values.push(Number(match[1]));
      if (match[2]) values.push(Number(match[2]));
    }
  }
  return values.filter(Number.isFinite);
}

function classify(title, description = '', schedule = '') {
  if (!relevant(title, description)) return null;
  const t = lower(title);
  const text = lower(`${title} ${description}`);
  const years = statedExperienceYears(text);
  if (years.some(year => year >= 6)) return null;

  let type = 'entry-level';
  if (t.includes('intern') || lower(schedule).includes('intern')) type = 'internship';
  else if (t.includes('apprentice')) type = 'apprenticeship';
  else if (t.includes('trainee')) type = 'trainee';

  const noExperience = hasAny(text, ['no experience required', 'no prior experience', 'entry level', 'entry-level']);
  if (noExperience) return { type, experience: 'no-experience' };
  if (years.some(year => year >= 3) || hasAny(text, explicitMidTerms)) return { type, experience: '2-5-years' };
  if (years.some(year => year <= 2) || hasAny(text, explicitEarlyTerms)) return { type, experience: '0-2-years' };

  // Avoid publishing roles whose experience fit cannot be confirmed.
  return null;
}

function payObject(label = 'Pay not listed', min = null, max = null, interval = '') {
  const hourly = /hour|hourly|hr/i.test(interval);
  const salarySortMax = Number.isFinite(max) ? (hourly ? Math.round(max * 2080) : max) : null;
  return { pay: label, salaryMin: min, salaryMax: max, salarySortMax };
}

function extractPay(text = '') {
  const s = clean(text);
  const range = s.match(/\$([\d,.]+)\s*(?:-|–|to)\s*\$?([\d,.]+)\s*(?:\/|per\s+)?(hour|hourly|hr|year|yearly|yr|annum|annual|annually)?/i);
  if (!range) return payObject();
  const min = Number(range[1].replace(/,/g, ''));
  const max = Number(range[2].replace(/,/g, ''));
  const unit = lower(range[3] || '');
  const annual = /year|yr|annum|annual/.test(unit) || (!unit && max >= 1000);
  return payObject(`$${range[1]}–$${range[2]} / ${annual ? 'year' : 'hr'}`, min, max, annual ? 'year' : 'hour');
}

function tagsFor(title, description, type, experience) {
  const text = lower(`${title} ${description}`);
  const tags = [];
  if (type === 'internship') tags.push('Internship');
  if (type === 'apprenticeship') tags.push('Apprenticeship');
  if (type === 'trainee') tags.push('Trainee');
  if (experience === 'no-experience') tags.push('No Experience Needed');
  else if (experience === '0-2-years') tags.push('0–2 Years');
  else tags.push('2–5 Years');
  if (hasAny(text, ['electrical', 'electrician', 'ups', 'switchgear', 'epms'])) tags.push('Electrical');
  if (hasAny(text, ['critical facilities', 'critical environment', 'hvac', 'generator', 'mechanical', 'chiller', 'crah', 'crac', 'bms'])) tags.push('Critical Facilities');
  if (hasAny(text, ['fiber', 'network', 'cabling'])) tags.push('Network / Cabling');
  return [...new Set(tags)].slice(0, 5);
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

async function listRequisitions() {
  const rows = [];
  let total = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const offset = page * PAGE_SIZE;
    const json = await fetchJson(buildListUrl(offset));
    const item = Array.isArray(json?.items) ? json.items[0] : null;
    const pageRows = item && Array.isArray(item.requisitionList) ? item.requisitionList : [];
    if (total === null && Number.isFinite(Number(item?.TotalJobsCount))) total = Number(item.TotalJobsCount);
    rows.push(...pageRows);
    if (pageRows.length === 0 || pageRows.length < PAGE_SIZE) break;
    if (total !== null && offset + PAGE_SIZE >= total) break;
  }
  return rows;
}

async function hydrateCandidate(row) {
  const id = String(row?.Id ?? row?.RequisitionNumber ?? '').trim();
  const requisitionKey = String(row?.RequisitionNumber ?? id).replace(/[^a-zA-Z0-9_-]/g, '') || hash(id);
  const jobId = `oracle-digitalrealty-${requisitionKey}`;
  if (!id) return { job: null, reason: 'missingId', jobId, detailAttempted: false, detailError: null };

  let detail = {};
  let detailError = null;
  try {
    const json = await fetchJson(buildDetailUrl(id));
    detail = Array.isArray(json?.items) ? (json.items[0] || {}) : {};
  } catch (error) {
    detailError = error.message;
    // Listing data still supplies title/location/short description. Keep going;
    // classification below will reject the row if experience fit is not explicit.
  }

  const result = (job, reason) => ({ job, reason, jobId, detailAttempted: true, detailError });
  const merged = { ...row, ...detail };
  const title = firstText(merged, ['Title', 'title']);
  const location = locationFor(merged) || locationFor(row);
  if (!isUSLocation(location, merged)) return result(null, 'nonUs');

  const description = [
    firstText(merged, ['ExternalDescriptionStr','Description','JobDescription','ShortDescriptionStr']),
    firstText(merged, ['ExternalQualificationsStr','Qualifications','RequiredQualifications']),
    firstText(merged, ['ExternalResponsibilitiesStr','Responsibilities','JobResponsibilities'])
  ].filter(Boolean).join(' ');
  if (!relevant(title, description)) return result(null, 'context');

  const cls = classify(title, description, firstText(merged, ['JobSchedule','FullPartTime','RegularTemporary']));
  if (!cls) return result(null, 'experience');

  const postedAt = firstText(merged, ['PostedDate','PostingDate','postedDate']) || null;
  return result({
    id: jobId,
    title,
    company: COMPANY,
    location: location || 'Location not listed',
    type: cls.type,
    experience: cls.experience,
    tags: tagsFor(title, description, cls.type, cls.experience),
    ...extractPay(description),
    postedAt,
    source: 'Employer career site',
    sourceUrl: buildJobUrl(id),
    active: true,
    demo: false
  }, null);
}

const currentJobs = await readJson('data/jobs.json', []);
const previousSnapshot = await readJson('data/digital-realty-jobs.json', []);
const priorStatus = await readJson('data/collector-status.json', {});
const previousById = new Map(previousSnapshot.map(job => [String(job.id || ''), job]));
const errors = [];
const drops = { title: 0, nonUs: 0, context: 0, experience: 0, missingId: 0 };
let sourceHealthy = false;
let candidateRows = 0;
let detailAttempts = 0;
let detailFailures = 0;
let preservedPrevious = 0;
let snapshot = [];

try {
  const rows = await listRequisitions();
  sourceHealthy = true;
  const candidates = rows.filter(row => {
    const keep = titleCandidate(firstText(row, ['Title','title']));
    if (!keep) drops.title += 1;
    return keep;
  });
  candidateRows = candidates.length;

  const jobs = [];
  for (let index = 0; index < candidates.length; index += 5) {
    const batch = candidates.slice(index, index + 5);
    const results = await Promise.all(batch.map(hydrateCandidate));
    for (const result of results) {
      if (result.detailAttempted) detailAttempts += 1;
      if (result.detailError) {
        detailFailures += 1;
        errors.push(`detail ${result.jobId}: ${result.detailError}`);
        const previous = previousById.get(result.jobId);
        if (previous) {
          // The requisition still exists in Digital Realty's current official listing,
          // so keep the previously verified record until its detail page recovers.
          jobs.push(previous);
          preservedPrevious += 1;
          continue;
        }
      }
      if (result.job) jobs.push(result.job);
      else if (result.reason && result.reason in drops) drops[result.reason] += 1;
    }
  }
  snapshot = dedupe(jobs);
} catch (error) {
  errors.push(error.message);
  snapshot = previousSnapshot;
}

if (!sourceHealthy && !snapshot.length) {
  throw new Error(`Digital Realty collector failed and no prior snapshot exists: ${errors.join(' | ')}`);
}

const withoutDigitalRealty = currentJobs.filter(job => job.company !== COMPANY);
const merged = dedupe([...withoutDigitalRealty, ...snapshot]);
const countsByType = merged.reduce((acc, job) => {
  acc[job.type] = (acc[job.type] || 0) + 1;
  return acc;
}, {});
const countsByExperience = merged.reduce((acc, job) => {
  acc[job.experience] = (acc[job.experience] || 0) + 1;
  return acc;
}, {});

await writeFile('data/digital-realty-jobs.json', JSON.stringify(snapshot, null, 2) + '\n');
await writeFile('data/jobs.json', JSON.stringify(merged, null, 2) + '\n');
await writeFile('data/collector-status.json', JSON.stringify({
  ...priorStatus,
  updatedAt: new Date().toISOString(),
  jobs: merged.length,
  sourcesAttempted: Number(priorStatus.sourcesAttempted || 0) + 1,
  providers: {
    ...(priorStatus.providers || {}),
    oracleRecruitingCloud: Number(priorStatus.providers?.oracleRecruitingCloud || 0) + 1
  },
  countsByType,
  countsByExperience,
  digitalRealty: {
    officialSource: OFFICIAL_SOURCE,
    boardUrl: `https://${HOST}/hcmUI/CandidateExperience/${LANG}/sites/${SITE}`,
    sourceHealthy,
    candidateRows,
    detailAttempts,
    detailFailures,
    preservedPrevious,
    qualifyingRoles: snapshot.length,
    drops,
    errors
  },
  errors: [...(priorStatus.errors || []), ...errors.map(error => `Digital Realty: ${error}`)]
}, null, 2) + '\n');

console.log(`Digital Realty official source ${sourceHealthy ? 'succeeded' : 'fell back to prior snapshot'}; ${snapshot.length} qualifying roles; ${merged.length} total jobs; ${detailFailures} detail failures; ${preservedPrevious} preserved previous roles.`);
