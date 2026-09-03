import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const COMPANY = 'Oracle';
const OFFICIAL_SOURCE = 'https://careers.oracle.com/';
const HOST = 'eeho.fa.us2.oraclecloud.com';
const SITE_CANDIDATES = ['jobsearch', 'CX_1'];
const LANG = 'en';
const PAGE_SIZE = 200;
const MAX_PAGES = 30;
const DETAIL_BATCH_SIZE = 6;
const SNAPSHOT_PATH = 'data/oracle-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';

const strongTitleTerms = [
  'data center', 'data centre', 'datacenter', 'critical facilities', 'critical facility',
  'critical environment', 'critical environments', 'cloud hardware support'
];
const contextualTitleTerms = [
  'technician', 'electrician', 'electrical', 'mechanical', 'facilities', 'facility engineer',
  'operator', 'operations', 'controls', 'maintenance', 'commissioning', 'deployment',
  'hardware support', 'apprentice', 'trainee', 'intern'
];
const contextTerms = [
  'data center', 'data centre', 'datacenter', 'critical facilities', 'critical facility',
  'critical environment', 'critical environments', 'cloud infrastructure', 'cloud hardware',
  'mission critical', 'mission-critical', 'server fleet', 'server hardware', 'rack and stack',
  'rack-and-stack', 'ups', 'switchgear', 'generator', 'chiller', 'crah', 'crac', 'bms',
  'epms', 'dcim', 'power distribution', 'white space', 'server rack'
];
const excludedTitlePattern = /(^|[^a-z])(senior|sr\.?|lead|principal|manager|director|vice president|vp|head of|chief|supervisor|architect|sales|account executive|legal|counsel|recruiter|marketing|finance|product manager|program manager|project manager)([^a-z]|$)/i;
const explicitEarlyTerms = [
  'intern', 'internship', 'apprentice', 'apprenticeship', 'trainee', 'entry level', 'entry-level',
  'no experience', 'level i', 'level 1', 'technician i', 'technician 1', 'engineer i',
  'engineer 1', 'operator i', 'operator 1', '0-2 years', '0–2 years', '1-2 years', '1–2 years'
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
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': 'Mozilla/5.0 (compatible; DataCenterCareersBot/2.0; +https://dailyblip.github.io/ideal-garbanzo/)'
    },
    redirect: 'follow'
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

function buildListUrl(site, offset) {
  const facets = 'LOCATIONS;WORK_LOCATIONS;WORKPLACE_TYPES;TITLES;CATEGORIES;ORGANIZATIONS;POSTING_DATES;FLEX_FIELDS';
  const finder = `findReqs;siteNumber=${site},facetsList=${facets},limit=${PAGE_SIZE},sortBy=POSTING_DATES_DESC,offset=${offset}`;
  const expand = encodeURIComponent('requisitionList.workLocation,requisitionList.secondaryLocations');
  return `https://${HOST}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=${expand}&finder=${encodeURIComponent(finder)}&limit=${PAGE_SIZE}&offset=${offset}`;
}

function buildDetailUrl(site, id) {
  const finder = `ById;Id=${id},siteNumber=${site}`;
  return `https://${HOST}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?onlyData=true&expand=all&finder=${encodeURIComponent(finder)}`;
}

function buildJobUrl(site, id) {
  return `https://${HOST}/hcmUI/CandidateExperience/${LANG}/sites/${site}/job/${encodeURIComponent(id)}`;
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
  if (country === 'us' || US_COUNTRY_LABELS.has(tail) || US_COUNTRY_LABELS.has(country)) return true;
  if (parts.length >= 3 && tail && !US_COUNTRY_LABELS.has(tail)) return false;
  return parts.some(part => US_STATE_NAMES.includes(lower(part)) || US_STATE_CODES.has(part.toUpperCase()));
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
    /experience(?:\s+of)?\s+(?:at least\s+|minimum(?: of)?\s+)?(\d{1,2})\+?\s+years?/gi,
    /\byears?\s*:?\s*(\d{1,2})\+?(?:\s*(?:-|–|to)\s*(\d{1,2}))?/gi
  ];
  for (const pattern of patterns) {
    for (const match of String(text || '').matchAll(pattern)) {
      values.push(Number(match[1]));
      if (match[2]) values.push(Number(match[2]));
    }
  }
  return values.filter(Number.isFinite);
}

function careerLevelClass(value = '') {
  const v = lower(value).replace(/\s+/g, '');
  const m = v.match(/\b(ic|m)(\d)\b/);
  if (!m) return null;
  if (m[1] === 'm') return 'reject';
  const level = Number(m[2]);
  if (level >= 4) return 'reject';
  if (level === 3) return '2-5-years';
  if (level === 1) return 'no-experience';
  if (level === 2) return '0-2-years';
  return null;
}

function classify(title, description = '', metadata = '') {
  if (!relevant(title, description)) return null;
  const t = lower(title);
  const text = lower(`${title} ${description} ${metadata}`);
  const years = statedExperienceYears(text);
  if (years.some(year => year >= 6)) return null;
  const careerFit = careerLevelClass(metadata);
  if (careerFit === 'reject') return null;
  if (/people manager|manages a team|management role/.test(lower(metadata))) return null;

  let type = 'entry-level';
  if (t.includes('intern')) type = 'internship';
  else if (t.includes('apprentice')) type = 'apprenticeship';
  else if (t.includes('trainee')) type = 'trainee';

  const noExperience = hasAny(text, ['no experience required', 'no prior experience', 'entry level', 'entry-level']);
  if (noExperience || careerFit === 'no-experience') return { type, experience: 'no-experience' };
  if (years.some(year => year >= 3) || hasAny(text, explicitMidTerms) || careerFit === '2-5-years') return { type, experience: '2-5-years' };
  if (years.some(year => year <= 2) || hasAny(text, explicitEarlyTerms) || careerFit === '0-2-years') return { type, experience: '0-2-years' };
  return null;
}

function payObject(label = 'Pay not listed', min = null, max = null, interval = '') {
  const hourly = /hour|hourly|hr/i.test(interval);
  const salarySortMax = Number.isFinite(max) ? (hourly ? Math.round(max * 2080) : max) : null;
  return { pay: label, salaryMin: min, salaryMax: max, salarySortMax };
}

function extractPay(text = '') {
  const s = clean(text);
  const range = s.match(/(?:hiring range[^$]{0,80})?\$([\d,.]+)\s*(?:-|–|to)\s*\$?([\d,.]+)\s*(?:\/|per\s+)?(hour|hourly|hr|year|yearly|yr|annum|annual|annually)?/i);
  if (!range) return payObject();
  const min = Number(range[1].replace(/,/g, ''));
  const max = Number(range[2].replace(/,/g, ''));
  if (!Number.isFinite(min) || !Number.isFinite(max)) return payObject();
  const unit = lower(range[3] || '');
  const annual = /year|yr|annum|annual/.test(unit) || (!unit && max >= 1000);
  return payObject(`$${min.toLocaleString('en-US')}–$${max.toLocaleString('en-US')} / ${annual ? 'year' : 'hr'}`, min, max, annual ? 'year' : 'hour');
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
  if (hasAny(text, ['server', 'hardware support', 'rack and stack', 'rack-and-stack', 'deployment'])) tags.push('Data Center Operations');
  if (hasAny(text, ['fiber', 'network', 'cabling'])) tags.push('Network / Cabling');
  return [...new Set(tags)].slice(0, 5);
}

function dedupe(jobs) {
  const ids = new Set();
  const urls = new Set();
  const identities = new Set();
  const out = [];
  for (const job of jobs) {
    const id = String(job.id || '');
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

function oracleJobKey(job = {}) {
  const idMatch = String(job.id || '').match(/^oracle-careers-(.+)$/i);
  if (idMatch) return `req:${normalizeIdentity(idMatch[1])}`;
  const urlMatch = String(job.sourceUrl || '').match(/\/job\/([^/?#]+)/i);
  if (urlMatch) return `job:${decodeURIComponent(urlMatch[1]).toLowerCase()}`;
  return '';
}

function priorOracleIndex(snapshot = []) {
  const index = new Map();
  for (const job of snapshot) {
    const requisitionKey = oracleJobKey(job);
    if (requisitionKey) index.set(requisitionKey, job);
    const urlMatch = String(job.sourceUrl || '').match(/\/job\/([^/?#]+)/i);
    if (urlMatch) index.set(`job:${decodeURIComponent(urlMatch[1]).toLowerCase()}`, job);
  }
  return index;
}

function priorForRow(row, index) {
  const id = String(row?.Id ?? '').trim();
  const requisition = String(row?.RequisitionNumber ?? '').trim();
  if (id && index.has(`job:${id.toLowerCase()}`)) return index.get(`job:${id.toLowerCase()}`);
  if (requisition) {
    const normalized = normalizeIdentity(requisition);
    if (index.has(`req:${normalized}`)) return index.get(`req:${normalized}`);
  }
  return null;
}

function requisitionIdentity(row = {}) {
  const id = String(row?.Id ?? '').trim();
  if (id) return `id:${id.toLowerCase()}`;
  const requisition = String(row?.RequisitionNumber ?? '').trim();
  if (requisition) return `req:${normalizeIdentity(requisition)}`;
  return `fallback:${hash(`${firstText(row, ['Title','title'])}|${locationFor(row)}`)}`;
}

async function listRequisitions(site) {
  const rows = [];
  const seen = new Set();
  let total = null;
  let pagesAttempted = 0;
  let pagesSucceeded = 0;
  let complete = false;
  let incompleteReason = null;
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const currentOffset = offset;
    pagesAttempted += 1;
    const json = await fetchJson(buildListUrl(site, currentOffset));
    pagesSucceeded += 1;
    const item = Array.isArray(json?.items) ? json.items[0] : null;
    const pageRows = item && Array.isArray(item.requisitionList) ? item.requisitionList : [];
    const reportedTotal = Number(item?.TotalJobsCount);
    if (Number.isFinite(reportedTotal)) total = reportedTotal;

    let fresh = 0;
    for (const row of pageRows) {
      const key = requisitionIdentity(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
      fresh += 1;
    }

    if (total !== null && rows.length >= total) {
      complete = true;
      break;
    }

    if (pageRows.length === 0) {
      const shortfall = total === null ? null : total - rows.length;
      // The Oracle CE count can drift by a few requisitions while a long paginated
      // scan is running. Only accept an exhausted listing when that drift is tiny;
      // larger gaps remain a hard failure so partial feeds cannot replace the snapshot.
      if (total === null && rows.length > 0) complete = true;
      else if (Number.isFinite(shortfall) && shortfall >= 0 && shortfall <= 5) complete = true;
      else incompleteReason = `listing ended at ${rows.length}/${total ?? 'unknown'} unique rows`;
      break;
    }

    if (fresh === 0) {
      incompleteReason = `duplicate page before reaching reported total (${rows.length}/${total ?? 'unknown'})`;
      break;
    }

    if (total === null && pageRows.length < PAGE_SIZE) {
      complete = true;
      break;
    }

    // Oracle Recruiting Cloud occasionally returns a short page before the reported
    // total is exhausted (for example 199 rows on a 200-row request). Advance by the
    // number of rows the API actually returned instead of assuming fixed-size pages,
    // then keep reading until the reported total is reached or the source truly ends.
    offset = currentOffset + pageRows.length;
    if (offset <= currentOffset) {
      incompleteReason = `pagination did not advance at ${rows.length}/${total ?? 'unknown'} unique rows`;
      break;
    }
  }

  if (!complete && !incompleteReason) {
    incompleteReason = `pagination cap reached at ${rows.length}/${total ?? 'unknown'} unique rows`;
  }

  return { rows, total, pagesAttempted, pagesSucceeded, complete, incompleteReason };
}

async function discoverSite() {
  const failures = [];
  for (const site of SITE_CANDIDATES) {
    try {
      const result = await listRequisitions(site);
      if (result.rows.length && result.complete) return { site, ...result, failures };
      if (result.rows.length) failures.push(`${site}: incomplete listing (${result.incompleteReason})`);
      else failures.push(`${site}: returned no requisitions`);
    } catch (error) {
      failures.push(`${site}: ${error.message}`);
    }
  }
  throw new Error(failures.join(' | '));
}

async function hydrateCandidate(site, row, previousIndex) {
  const id = String(row?.Id ?? row?.RequisitionNumber ?? '').trim();
  if (!id) return { job: null, reason: 'missingId', detailAttempted: false, detailFailed: false, preserved: false };

  let detail;
  try {
    const json = await fetchJson(buildDetailUrl(site, id));
    detail = Array.isArray(json?.items) ? (json.items[0] || {}) : {};
  } catch (error) {
    const prior = priorForRow(row, previousIndex);
    if (prior) {
      return {
        job: { ...prior, active: true },
        reason: null,
        detailAttempted: true,
        detailFailed: true,
        preserved: true,
        error: error.message
      };
    }
    return {
      job: null,
      reason: 'fetch',
      detailAttempted: true,
      detailFailed: true,
      preserved: false,
      error: error.message
    };
  }

  const merged = { ...row, ...detail };
  const title = firstText(merged, ['Title', 'title']);
  const location = locationFor(merged) || locationFor(row);
  if (!isUSLocation(location, merged)) return { job: null, reason: 'nonUs', detailAttempted: true, detailFailed: false, preserved: false };

  const description = [
    firstText(merged, ['ExternalDescriptionStr','Description','JobDescription','ShortDescriptionStr']),
    firstText(merged, ['ExternalQualificationsStr','Qualifications','RequiredQualifications']),
    firstText(merged, ['ExternalResponsibilitiesStr','Responsibilities','JobResponsibilities'])
  ].filter(Boolean).join(' ');
  if (!relevant(title, description)) return { job: null, reason: 'context', detailAttempted: true, detailFailed: false, preserved: false };

  const metadata = [
    firstText(merged, ['CareerLevel','CareerLevelName','ManagerLevel','Role','JobFunction']),
    firstText(merged, ['YearsOfExperience','Experience','ExperienceLevel'])
  ].filter(Boolean).join(' ');
  const cls = classify(title, description, metadata);
  if (!cls) return { job: null, reason: 'experience', detailAttempted: true, detailFailed: false, preserved: false };

  const postedAt = firstText(merged, ['PostedDate','PostingDate','postedDate']) || null;
  const requisition = String(row?.RequisitionNumber ?? id).replace(/[^a-zA-Z0-9_-]/g, '') || hash(id);
  return {
    reason: null,
    detailAttempted: true,
    detailFailed: false,
    preserved: false,
    job: {
      id: `oracle-careers-${requisition}`,
      title,
      company: COMPANY,
      location: location || 'Location not listed',
      type: cls.type,
      experience: cls.experience,
      tags: tagsFor(title, description, cls.type, cls.experience),
      ...extractPay(description),
      postedAt,
      source: 'Oracle Careers',
      sourceUrl: buildJobUrl(site, id),
      active: true,
      demo: false
    }
  };
}

const currentJobs = await readJson(JOBS_PATH, []);
const previousSnapshot = await readJson(SNAPSHOT_PATH, []);
const previousIndex = priorOracleIndex(previousSnapshot);
const priorStatus = await readJson(STATUS_PATH, {});
const errors = [];
const drops = { title: 0, nonUs: 0, context: 0, experience: 0, missingId: 0, fetch: 0 };
let sourceHealthy = false;
let site = null;
let totalOpenRoles = null;
let listingRows = 0;
let listingComplete = false;
let pagesAttempted = 0;
let pagesSucceeded = 0;
let incompleteReason = null;
let candidateRows = 0;
let detailAttempted = 0;
let detailFailed = 0;
let preservedFromPrevious = 0;
let snapshot = previousSnapshot;

try {
  const discovery = await discoverSite();
  site = discovery.site;
  totalOpenRoles = discovery.total;
  listingRows = discovery.rows.length;
  listingComplete = discovery.complete;
  pagesAttempted = discovery.pagesAttempted;
  pagesSucceeded = discovery.pagesSucceeded;
  incompleteReason = discovery.incompleteReason;
  sourceHealthy = discovery.complete;
  if (discovery.failures.length) errors.push(...discovery.failures.map(message => `site probe ${message}`));

  const candidates = discovery.rows.filter(row => {
    const keep = titleCandidate(firstText(row, ['Title','title']));
    if (!keep) drops.title += 1;
    return keep;
  });
  candidateRows = candidates.length;

  const jobs = [];
  for (let index = 0; index < candidates.length; index += DETAIL_BATCH_SIZE) {
    const batch = candidates.slice(index, index + DETAIL_BATCH_SIZE);
    const results = await Promise.all(batch.map(row => hydrateCandidate(site, row, previousIndex)));
    for (const result of results) {
      if (result.detailAttempted) detailAttempted += 1;
      if (result.detailFailed) detailFailed += 1;
      if (result.preserved) preservedFromPrevious += 1;
      if (result.error) errors.push(`detail ${result.error}`);
      if (result.job) jobs.push(result.job);
      else if (result.reason && result.reason in drops) drops[result.reason] += 1;
    }
  }
  snapshot = dedupe(jobs);
} catch (error) {
  errors.push(error.message);
  const partial = SITE_CANDIDATES.map(candidate => String(error.message).includes(`${candidate}: incomplete listing`)).some(Boolean);
  if (partial) incompleteReason = error.message;
}

const withoutOracle = currentJobs.filter(job => job.company !== COMPANY);
const merged = dedupe([...withoutOracle, ...snapshot]);
const now = Date.now();
for (const job of merged) {
  job.postedHours = job.postedAt ? Math.max(0, Math.round((now - new Date(job.postedAt).getTime()) / 36e5)) : (job.postedHours ?? 9999);
}
const countsByType = merged.reduce((acc, job) => { acc[job.type] = (acc[job.type] || 0) + 1; return acc; }, {});
const countsByExperience = merged.reduce((acc, job) => { acc[job.experience] = (acc[job.experience] || 0) + 1; return acc; }, {});
const cleanGlobalErrors = (priorStatus.errors || []).filter(error => !String(error).startsWith('Oracle Careers:'));

await writeFile(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n');
await writeFile(JOBS_PATH, JSON.stringify(merged, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify({
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
  oracleCareers: {
    officialSource: OFFICIAL_SOURCE,
    boardUrl: site ? `https://${HOST}/hcmUI/CandidateExperience/${LANG}/sites/${site}` : `https://${HOST}/hcmUI/CandidateExperience/${LANG}/sites/jobsearch`,
    site,
    sourceHealthy,
    listingComplete,
    totalOpenRoles,
    listingRows,
    pagesAttempted,
    pagesSucceeded,
    ...(incompleteReason ? { incompleteReason } : {}),
    candidateRows,
    detailAttempted,
    detailFailed,
    preservedFromPrevious,
    qualifyingRoles: snapshot.length,
    drops,
    errors
  },
  errors: [...cleanGlobalErrors, ...errors.map(error => `Oracle Careers: ${error}`)]
}, null, 2) + '\n');

if (sourceHealthy) {
  console.log(`Oracle Careers complete scan succeeded on ${site}; ${listingRows}/${totalOpenRoles ?? 'unknown'} listing rows; ${snapshot.length} qualifying U.S. data-center roles; ${detailFailed} detail failures (${preservedFromPrevious} preserved); ${merged.length} total jobs.`);
} else {
  console.warn(`Oracle Careers listing was unavailable or incomplete; retained ${snapshot.length} prior roles. ${errors.join(' | ')}`);
}
