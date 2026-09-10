import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const CONCURRENCY = 6;
const TIMEOUT_MS = 15000;

const TENANT_BY_HOST = new Map([
  ['vantagedc.wd1.myworkdayjobs.com', 'vantagedc'],
  ['qtsdatacenters.wd5.myworkdayjobs.com', 'qtsdatacenters'],
  ['cyrusone.wd1.myworkdayjobs.com', 'cyrusone'],
  ['stackinfra.wd108.myworkdayjobs.com', 'stackinfra'],
  ['nttglobaldatacenters.wd501.myworkdayjobs.com', 'nttglobaldatacenters'],
  ['aligneddc.wd12.myworkdayjobs.com', 'aligneddc']
]);

const regionStates = {
  'mid-atlantic': { codes: ['DC','DE','MD','VA','WV'], names: ['District of Columbia','Delaware','Maryland','Virginia','West Virginia'] },
  texas: { codes: ['TX'], names: ['Texas'] },
  southwest: { codes: ['AZ','NM','NV','OK'], names: ['Arizona','New Mexico','Nevada','Oklahoma'] },
  midwest: { codes: ['IL','IN','IA','KS','MI','MN','MO','NE','ND','OH','SD','WI'], names: ['Illinois','Indiana','Iowa','Kansas','Michigan','Minnesota','Missouri','Nebraska','North Dakota','Ohio','South Dakota','Wisconsin'] },
  southeast: { codes: ['AL','AR','FL','GA','KY','LA','MS','NC','SC','TN'], names: ['Alabama','Arkansas','Florida','Georgia','Kentucky','Louisiana','Mississippi','North Carolina','South Carolina','Tennessee'] },
  northeast: { codes: ['CT','ME','MA','NH','NJ','NY','PA','RI','VT'], names: ['Connecticut','Maine','Massachusetts','New Hampshire','New Jersey','New York','Pennsylvania','Rhode Island','Vermont'] },
  west: { codes: ['AK','CA','CO','HI','ID','MT','OR','UT','WA','WY'], names: ['Alaska','California','Colorado','Hawaii','Idaho','Montana','Oregon','Utah','Washington','Wyoming'] }
};

const stateToRegion = new Map();
const stateNames = [];
for (const [region, values] of Object.entries(regionStates)) {
  values.codes.forEach(code => stateToRegion.set(code.toLowerCase(), region));
  values.names.forEach(name => {
    stateToRegion.set(name.toLowerCase(), region);
    stateNames.push(name);
  });
}
stateNames.sort((a, b) => b.length - a.length);

const siteCodeRegions = [
  [/^(?:NVA|IAD)[-_]?\d+/i, 'mid-atlantic'],
  [/^(?:DFW|DAL)[-_]?\d+/i, 'texas'],
  [/^(?:PHX|LAS)[-_]?\d+/i, 'southwest'],
  [/^(?:ORD|CMH|NEO)[-_]?\d+/i, 'midwest'],
  [/^(?:ATL|MIA|CLT|RDU)[-_]?\d+/i, 'southeast'],
  [/^(?:NYC|EWR|BOS)[-_]?\d+/i, 'northeast'],
  [/^(?:SJC|SFO|LAX|SEA|PDX|DEN|SLC)[-_]?\d+/i, 'west']
];

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const multiLocationLabel = value => /\+\s*\d+\s+more\s+locations?\b/i.test(clean(value));
const genericLocationLabel = value => /^(?:\d+\s+locations?|multiple locations?|location not listed)$/i.test(clean(value));

function locationLabel(value) {
  if (typeof value === 'string') return clean(value);
  if (!value || typeof value !== 'object') return '';
  return clean(
    value.title || value.name || value.displayName ||
    value.location?.title || value.location?.name ||
    (typeof value.location === 'string' ? value.location : '')
  );
}

function uniqueLocations(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values.map(locationLabel).filter(Boolean)) {
    if (genericLocationLabel(value)) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function regionFromLocation(value = '') {
  const text = clean(value);
  if (!text) return '';
  if (/^(?:United States|USA|US)$/i.test(text)) return 'nationwide';

  for (const [pattern, region] of siteCodeRegions) {
    if (pattern.test(text)) return region;
  }

  const remoteState = text.match(/^remote\s*[-,]\s*([A-Z]{2})\b/i);
  if (remoteState) return stateToRegion.get(remoteState[1].toLowerCase()) || '';

  const code = text.match(/(?:^|[,;]\s*)([A-Z]{2})(?:\b|\s*,|$)/);
  if (code && stateToRegion.has(code[1].toLowerCase())) return stateToRegion.get(code[1].toLowerCase());

  for (const name of stateNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) return stateToRegion.get(name.toLowerCase()) || '';
  }
  return '';
}

function regionsForLocations(locations = []) {
  const regions = [];
  for (const location of locations) {
    const region = regionFromLocation(location);
    if (!region || region === 'nationwide' || regions.includes(region)) continue;
    regions.push(region);
  }
  return regions;
}

function workdaySourceParts(sourceUrl = '') {
  let url;
  try { url = new URL(sourceUrl); } catch { return null; }
  const host = url.hostname.toLowerCase();
  const tenant = TENANT_BY_HOST.get(host);
  if (!tenant) return null;

  const parts = url.pathname.split('/').filter(Boolean);
  const jobIndex = parts.findIndex(part => part.toLowerCase() === 'job');
  if (jobIndex < 2) return null;
  const site = parts[jobIndex - 1];
  const externalPath = '/' + parts.slice(jobIndex).join('/');
  if (!site || !externalPath.startsWith('/job/')) return null;
  return {
    detailUrl: `${url.origin}/wday/cxs/${tenant}/${site}${externalPath}`,
    referer: sourceUrl
  };
}

async function fetchDetail(sourceUrl) {
  const parts = workdaySourceParts(sourceUrl);
  if (!parts) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(parts.detailUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        referer: parts.referer,
        'user-agent': 'DataCenterCareersBot/1.5 (+https://datacentercareers.us/)'
      }
    });
    if (!response.ok) throw new Error(`${response.status} ${parts.detailUrl}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function detailLocations(detail = {}) {
  const info = detail.jobPostingInfo || detail.jobInfo || detail;
  const primary = locationLabel(info.location);
  const additional = Array.isArray(info.additionalLocations) ? info.additionalLocations : [];
  return uniqueLocations([primary, ...additional]);
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, worker));
  return results;
}

const regressionRegions = regionsForLocations(['Ashburn, VA', 'Dallas, TX', 'Phoenix, AZ']);
if (regressionRegions.join('|') !== 'mid-atlantic|texas|southwest') {
  throw new Error(`Multi-location region regression: ${regressionRegions.join('|')}`);
}
const sameRegionRegression = regionsForLocations(['Hillsboro, OR', 'Seattle, WA']);
if (sameRegionRegression.join('|') !== 'west') throw new Error('Same-region multi-location regression.');
const sourceRegression = workdaySourceParts('https://qtsdatacenters.wd5.myworkdayjobs.com/en-US/QTS/job/Richmond-VA/Example_R2026-2018');
if (!sourceRegression?.detailUrl.includes('/wday/cxs/qtsdatacenters/QTS/job/Richmond-VA/Example_R2026-2018')) {
  throw new Error('Workday detail URL regression.');
}

const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
if (!Array.isArray(jobs)) throw new Error('data/jobs.json must contain an array.');
let status = {};
try { status = JSON.parse(await readFile(STATUS_PATH, 'utf8')); } catch {}

const candidates = jobs.filter(job =>
  TENANT_BY_HOST.has((() => { try { return new URL(job?.sourceUrl || '').hostname.toLowerCase(); } catch { return ''; } })()) &&
  (multiLocationLabel(job?.location) || (Array.isArray(job?.locations) && job.locations.length > 1))
);

let hydrated = 0;
let retainedExisting = 0;
let changed = 0;
let multiRegionJobs = 0;
const failures = [];
const samples = [];

await mapLimit(candidates, CONCURRENCY, async job => {
  let locations = uniqueLocations(Array.isArray(job.locations) ? job.locations : []);
  if (locations.length > 1) {
    retainedExisting += 1;
  } else {
    try {
      const detail = await fetchDetail(job.sourceUrl);
      locations = detailLocations(detail || {});
      if (locations.length > 1) hydrated += 1;
    } catch (error) {
      failures.push({ id: job.id, company: job.company, error: clean(error?.message || error) });
      return;
    }
  }

  if (locations.length < 2) return;
  const regions = regionsForLocations(locations);
  const priorLocations = JSON.stringify(Array.isArray(job.locations) ? job.locations : []);
  const priorRegions = JSON.stringify(Array.isArray(job.regions) ? job.regions : []);

  job.locations = locations;
  if (regions.length > 1) {
    job.regions = regions;
    multiRegionJobs += 1;
  } else {
    delete job.regions;
  }

  const primaryRegion = regionFromLocation(locations[0]);
  if (primaryRegion && primaryRegion !== 'nationwide') job.region = primaryRegion;

  if (priorLocations !== JSON.stringify(job.locations) || priorRegions !== JSON.stringify(job.regions || [])) changed += 1;
  if (samples.length < 10) {
    samples.push({ id: job.id, company: job.company, location: job.location, locations: job.locations, regions: job.regions || [job.region].filter(Boolean) });
  }
});

status.multiLocationRegions = {
  checkedAt: new Date().toISOString(),
  candidates: candidates.length,
  hydrated,
  retainedExisting,
  changed,
  multiRegionJobs,
  failures: failures.length,
  failureSamples: failures.slice(0, 8),
  samples
};

await writeFile(JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

console.log(`Workday multi-location enrichment checked ${candidates.length} compact multi-location role(s), resolved ${hydrated + retainedExisting}, and assigned ${multiRegionJobs} role(s) to multiple regional filters${failures.length ? `; ${failures.length} transient detail fetch(es) failed without removing jobs` : ''}.`);
