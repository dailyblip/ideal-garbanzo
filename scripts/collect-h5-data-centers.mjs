import { readFile, writeFile } from 'node:fs/promises';

const COMPANY = 'H5 Data Centers';
const ORIGIN = 'https://workforcenow.adp.com';
const CID = '82492f85-be81-40ce-8d7b-b3a16956630b';
const CCID = '19000101_000001';
const LANG = 'en_US';
const PORTAL = `${ORIGIN}/mascsr/default/mdf/recruitment/recruitment.html`;
const API = `${ORIGIN}/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions`;
const SNAPSHOT = 'data/h5-data-centers-jobs.json';
const JOBS = 'data/jobs.json';
const STATUS = 'data/collector-status.json';
const PAGE_SIZE = 100;

const seniorTitle = /\b(?:senior|sr\.?|lead|principal|manager|director|vice president|vp|head of|chief|supervisor)\b/i;
const nonOpsTitle = /\b(?:sales|account executive|marketing|finance|legal|human resources|recruiter|product manager|program manager|project manager|business development)\b/i;
const missionTitle = /(?:data\s*center|critical facilities?|facilities?|facility|operations?|noc).*(?:technician|engineer|analyst|operator)|(?:technician|engineer|analyst|operator).*(?:data\s*center|critical facilities?|facilities?|facility|operations?|noc)/i;
const missionText = /\b(?:data\s*center|datacenter|colocation|mission[- ]critical|critical facilit(?:y|ies))\b/i;
const entrySignal = /\b(?:entry[- ]level|no experience|no prior experience|training provided|will train|technician\s+(?:i|1)|level\s+(?:i|1))\b/i;

const stateNames = new Map(Object.entries({
  Alabama:'AL',Alaska:'AK',Arizona:'AZ',Arkansas:'AR',California:'CA',Colorado:'CO',Connecticut:'CT',Delaware:'DE',Florida:'FL',Georgia:'GA',Hawaii:'HI',Idaho:'ID',Illinois:'IL',Indiana:'IN',Iowa:'IA',Kansas:'KS',Kentucky:'KY',Louisiana:'LA',Maine:'ME',Maryland:'MD',Massachusetts:'MA',Michigan:'MI',Minnesota:'MN',Mississippi:'MS',Missouri:'MO',Montana:'MT',Nebraska:'NE',Nevada:'NV','New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM','New York':'NY','North Carolina':'NC','North Dakota':'ND',Ohio:'OH',Oklahoma:'OK',Oregon:'OR',Pennsylvania:'PA','Rhode Island':'RI','South Carolina':'SC','South Dakota':'SD',Tennessee:'TN',Texas:'TX',Utah:'UT',Vermont:'VT',Virginia:'VA',Washington:'WA','West Virginia':'WV',Wisconsin:'WI',Wyoming:'WY','District of Columbia':'DC'
}));
const stateCodes = new Set(stateNames.values());

const clean = value => String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"').replace(/\s+/g, ' ').trim();
const identity = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
async function json(path, fallback) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; } }

function query(extra = {}) {
  return new URLSearchParams({ cid: CID, ccId: CCID, lang: LANG, locale: LANG, ...extra }).toString();
}
function headers() {
  return {
    accept: 'application/json',
    'accept-language': LANG,
    'content-type': 'application/json',
    locale: LANG,
    'x-forwarded-host': 'workforcenow.adp.com',
    'x-requested-with': 'XMLHttpRequest',
    'user-agent': 'Mozilla/5.0 (compatible; DataCenterCareersBot/1.7; +https://datacentercareers.us/)'
  };
}
async function getJson(url, attempts = 3) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: headers(), redirect: 'follow' });
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      return await response.json();
    } catch (error) {
      last = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, attempt * 800));
    }
  }
  throw last;
}

function customString(item, code) {
  const fields = item?.customFieldGroup?.stringFields;
  if (!Array.isArray(fields)) return '';
  const found = fields.find(field => clean(field?.nameCode?.codeValue) === code);
  return clean(found?.stringValue);
}
function locationParts(item) {
  const raw = Array.isArray(item?.requisitionLocations) ? item.requisitionLocations : [];
  return raw.map(value => ({
    name: clean(value?.nameCode?.shortName),
    country: clean(value?.address?.countryCode?.codeValue).toUpperCase()
  })).filter(value => value.name);
}
function isUsCountry(value) {
  const country = clean(value).toUpperCase().replace(/[.]/g, '');
  return !country || ['US', 'USA', 'UNITED STATES', 'UNITED STATES OF AMERICA'].includes(country);
}
function normalizeLocation(raw) {
  let value = clean(raw).replace(/^H5 Data Centers\s*[-–—:]\s*/i, '');
  value = value.replace(/,?\s*(?:United States(?: of America)?|USA?)$/i, '').trim();
  const code = value.match(/\b([A-Z]{2})\b(?=\s*$)/)?.[1];
  if (code && stateCodes.has(code)) return value;
  for (const [name, state] of [...stateNames.entries()].sort((a,b) => b[0].length - a[0].length)) {
    const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (pattern.test(value)) return value.replace(pattern, state);
  }
  return '';
}
function firstUsLocation(item) {
  for (const loc of locationParts(item)) {
    if (!isUsCountry(loc.country)) continue;
    const normalized = normalizeLocation(loc.name);
    if (normalized) return normalized;
  }
  return '';
}
function requiredYears(text) {
  const required = String(text).split(/\b(?:preferred|nice to have|bonus)\b/i)[0];
  const years = [];
  for (const pattern of [
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+years?\b/gi,
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?\b/gi
  ]) {
    for (const match of required.matchAll(pattern)) {
      years.push(Number(match[1]));
      if (match[2]) years.push(Number(match[2]));
    }
  }
  return years.filter(Number.isFinite);
}
function classify(title, description) {
  const t = clean(title);
  const body = clean(description);
  if (!t || seniorTitle.test(t) || nonOpsTitle.test(t)) return null;
  if (!missionTitle.test(t) || !missionText.test(`${t} ${body}`)) return null;
  const years = requiredYears(body);
  if (years.some(year => year > 5)) return null;
  if (/\b(?:no experience|no prior experience)\b/i.test(body)) return { type: 'entry-level', experience: 'no-experience' };
  if (years.some(year => year >= 3)) return { type: 'entry-level', experience: '2-5-years' };
  if (years.length) return { type: 'entry-level', experience: '0-2-years' };
  if (entrySignal.test(`${t} ${body}`) || /\b(?:support technician|noc analyst|operations technician)\b/i.test(t)) {
    return { type: 'entry-level', experience: '0-2-years' };
  }
  return null;
}
const classifierCases = [
  ['Data Center Support Technician', 'Entry-level role supporting a data center. Training provided.', '0-2-years'],
  ['Data Center Facilities Technician', 'Minimum 3 years experience in mission-critical data center facilities.', '2-5-years'],
  ['Data Center Facilities Technician', 'Minimum 7 years experience in mission-critical data center facilities.', null],
  ['Senior Data Center Technician', '1 year experience in a data center.', null],
  ['Account Executive - Data Centers', '1 year of sales experience supporting data center clients.', null],
  ['NOC Analyst', 'No experience required. Monitor a data center network operations center.', 'no-experience'],
  ['Electrical Engineer', '2 years experience with office electrical systems.', null]
];
for (const [title, text, expected] of classifierCases) {
  const actual = classify(title, text)?.experience ?? null;
  if (actual !== expected) throw new Error(`H5 classifier regression for ${title}: expected ${expected ?? 'excluded'}, got ${actual ?? 'excluded'}`);
}

function publicUrl(itemId) {
  return `${PORTAL}?${new URLSearchParams({ cid: CID, ccId: CCID, lang: LANG, jobId: String(itemId), source: 'CC2' })}`;
}
function postedFields(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return { postedAt: null, postedHours: 9999 };
  return { postedAt: date.toISOString(), postedHours: Math.max(0, Math.floor((Date.now() - date.getTime()) / 3600000)) };
}
function payFields(item) {
  const range = item?.payGradeRange;
  const min = Number(range?.minimumRate?.amountValue);
  const max = Number(range?.maximumRate?.amountValue);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max <= 0 || min > max) {
    return { pay: 'Pay not listed', salaryMin: null, salaryMax: null, salarySortMax: null };
  }
  const hourly = max < 500;
  const display = value => Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return {
    pay: `$${display(min)}–$${display(max)} / ${hourly ? 'hr' : 'year'}`,
    salaryMin: min,
    salaryMax: max,
    salarySortMax: hourly ? Math.round(max * 2080) : max
  };
}
function tags(title, description, experience) {
  const text = `${title} ${description}`.toLowerCase();
  const out = [experience === 'no-experience' ? 'No Experience Needed' : experience === '2-5-years' ? '2–5 Years' : '0–2 Years'];
  if (/electrical|switchgear|ups|generator/.test(text)) out.push('Electrical');
  if (/fiber|cabling|network|rack|server|noc/.test(text)) out.push('Network / Cabling');
  if (/critical facilit|hvac|chiller|crah|crac|mechanical/.test(text)) out.push('Critical Facilities');
  if (/entry[- ]level|training|will train|apprentice/.test(text)) out.push('Training / Mentorship');
  return [...new Set(out)].slice(0, 5);
}
function dedupe(records) {
  const urls = new Set();
  const keys = new Set();
  const out = [];
  for (const job of records) {
    const key = [job.company, job.title, job.location].map(identity).join('|');
    if (urls.has(job.sourceUrl) || keys.has(key)) continue;
    urls.add(job.sourceUrl);
    keys.add(key);
    out.push(job);
  }
  return out;
}

async function collectListing() {
  const all = [];
  let skip = 0;
  let total = null;
  while (total === null || skip < total) {
    const payload = await getJson(`${API}?${query({ '$skip': String(skip), '$top': String(PAGE_SIZE), userQuery: '' })}`);
    const rows = payload?.jobRequisitions;
    const reported = payload?.meta?.totalNumber;
    if (!Array.isArray(rows) || !Number.isInteger(reported) || reported < 0) throw new Error('ADP listing response omitted jobRequisitions/meta.totalNumber');
    total = reported;
    if (!rows.length) {
      if (skip < total) throw new Error(`ADP pagination ended at ${skip}/${total}`);
      break;
    }
    all.push(...rows);
    skip += rows.length;
    if (rows.length > PAGE_SIZE) throw new Error(`ADP returned ${rows.length} rows for page size ${PAGE_SIZE}`);
  }
  return { rows: all, total: total ?? 0 };
}

const base = await json(JOBS, []);
const previous = await json(SNAPSHOT, []);
const priorStatus = await json(STATUS, {});
let snapshot = [];
let sourceHealthy = true;
let error = '';
let listingStats = { advertised: 0, fetched: 0, drift: 0 };
const drops = { missingDetailId: 0, detailFetch: 0, nonUs: 0, classification: 0 };
const samples = [];
try {
  const listing = await collectListing();
  listingStats = { advertised: listing.total, fetched: listing.rows.length, drift: listing.rows.length - listing.total };
  // ADP's total can lag a just-opened role by one response. More rows than the
  // advertised count are safe to inspect; fewer rows would mean an incomplete crawl.
  if (listing.total > listing.rows.length) throw new Error(`ADP listing parity mismatch ${listing.rows.length}/${listing.total}`);
  for (let offset = 0; offset < listing.rows.length; offset += 6) {
    const batch = listing.rows.slice(offset, offset + 6);
    const found = await Promise.all(batch.map(async item => {
      const itemId = clean(item?.itemID);
      const title = clean(item?.requisitionTitle);
      const externalId = customString(item, 'ExternalJobID');
      if (!itemId || !title || !externalId) {
        drops.missingDetailId += 1;
        if (samples.length < 8) samples.push({ itemId, title, reason: 'missing item/title/external detail id' });
        return null;
      }
      let detail;
      try {
        detail = await getJson(`${API}/${encodeURIComponent(externalId)}?${query()}`);
      } catch (detailError) {
        drops.detailFetch += 1;
        if (samples.length < 8) samples.push({ itemId, title, reason: detailError.message });
        return null;
      }
      if (clean(detail?.itemID) && clean(detail.itemID) !== itemId) throw new Error(`ADP detail identity mismatch for ${itemId}`);
      const description = clean(detail?.requisitionDescription);
      const location = firstUsLocation(item);
      if (!location) {
        drops.nonUs += 1;
        if (samples.length < 8) samples.push({ itemId, title, locations: locationParts(item), reason: 'no normalized US location' });
        return null;
      }
      const classification = classify(title, description);
      if (!classification) {
        drops.classification += 1;
        return null;
      }
      return {
        id: `adp-h5-${itemId}`,
        title,
        company: COMPANY,
        location,
        type: classification.type,
        experience: classification.experience,
        tags: tags(title, description, classification.experience),
        ...payFields(item),
        ...postedFields(item?.postDate),
        source: 'Employer career site',
        sourceUrl: publicUrl(itemId),
        active: true,
        demo: false
      };
    }));
    snapshot.push(...found.filter(Boolean));
  }
  snapshot = dedupe(snapshot);
  if (listing.total > 0 && !snapshot.length) throw new Error(`ADP exposed ${listing.total} roles but zero mission-fit 0–5 year roles; drops=${JSON.stringify(drops)} samples=${JSON.stringify(samples)}`);
} catch (sourceError) {
  sourceHealthy = false;
  error = sourceError.message;
  if (Array.isArray(previous) && previous.length) snapshot = previous;
  else throw sourceError;
}

const merged = dedupe([...base.filter(job => clean(job?.company) !== COMPANY), ...snapshot]);
merged.sort((a, b) => Number(a.postedHours ?? 9999) - Number(b.postedHours ?? 9999));
const status = {
  ...priorStatus,
  updatedAt: new Date().toISOString(),
  jobs: merged.length,
  sourcesAttempted: Number(priorStatus.sourcesAttempted || 0) + 1,
  providers: { ...(priorStatus.providers || {}), adp: Number(priorStatus.providers?.adp || 0) + 1 },
  h5DataCenters: {
    officialSource: 'https://h5datacenters.com/data-center-careers.html',
    boardUrl: `${PORTAL}?${query()}`,
    sourceHealthy,
    qualifyingRoles: snapshot.length,
    usedPreviousSnapshot: !sourceHealthy,
    listing: listingStats,
    drops,
    samples,
    ...(error ? { error } : {})
  },
  errors: error ? [...(priorStatus.errors || []), `H5 Data Centers: ${error} (kept previous verified snapshot)`] : (priorStatus.errors || [])
};

await writeFile(SNAPSHOT, `${JSON.stringify(snapshot, null, 2)}\n`);
await writeFile(JOBS, `${JSON.stringify(merged, null, 2)}\n`);
await writeFile(STATUS, `${JSON.stringify(status, null, 2)}\n`);
console.log(`H5 Data Centers ${sourceHealthy ? 'verified' : 'preserved'} ${snapshot.length} qualifying employer-direct role(s); ${merged.length} total jobs.`);
