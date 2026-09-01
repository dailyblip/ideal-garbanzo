import { readFile, writeFile } from 'node:fs/promises';

const jobs = JSON.parse(await readFile('data/jobs.json','utf8'));
let status = {};
try { status = JSON.parse(await readFile('data/collector-status.json','utf8')); } catch {}

const typoFixes = [
  [/\bVirgina\b/g, 'Virginia']
];

const locationAliases = [
  [/^San Jose Office(?:\s*\([^)]*\))?$/i, 'San Jose, CA'],
  [/^Santa Clara Office(?:\s*\([^)]*\))?$/i, 'Santa Clara, CA']
];

const regionStates = {
  'mid-atlantic': {
    codes: ['DC','DE','MD','VA','WV'],
    names: ['District of Columbia','Delaware','Maryland','Virginia','West Virginia']
  },
  texas: {
    codes: ['TX'],
    names: ['Texas']
  },
  southwest: {
    codes: ['AZ','NM','NV','OK'],
    names: ['Arizona','New Mexico','Nevada','Oklahoma']
  },
  midwest: {
    codes: ['IL','IN','IA','KS','MI','MN','MO','NE','ND','OH','SD','WI'],
    names: ['Illinois','Indiana','Iowa','Kansas','Michigan','Minnesota','Missouri','Nebraska','North Dakota','Ohio','South Dakota','Wisconsin']
  },
  southeast: {
    codes: ['AL','AR','FL','GA','KY','LA','MS','NC','SC','TN'],
    names: ['Alabama','Arkansas','Florida','Georgia','Kentucky','Louisiana','Mississippi','North Carolina','South Carolina','Tennessee']
  },
  northeast: {
    codes: ['CT','ME','MA','NH','NJ','NY','PA','RI','VT'],
    names: ['Connecticut','Maine','Massachusetts','New Hampshire','New Jersey','New York','Pennsylvania','Rhode Island','Vermont']
  },
  west: {
    codes: ['AK','CA','CO','HI','ID','MT','OR','UT','WA','WY'],
    names: ['Alaska','California','Colorado','Hawaii','Idaho','Montana','Oregon','Utah','Washington','Wyoming']
  }
};

const stateToRegion = new Map();
for (const [region, values] of Object.entries(regionStates)) {
  for (const code of values.codes) stateToRegion.set(code.toLowerCase(), region);
  for (const name of values.names) stateToRegion.set(name.toLowerCase(), region);
}

const cityRegionFallbacks = [
  [/\bsan jose\b/i, 'west'],
  [/\bsanta clara\b/i, 'west'],
  [/\bhillsboro\b/i, 'west'],
  [/\breno\b/i, 'southwest'],
  [/\bmesa\b/i, 'southwest'],
  [/\bphoenix\b/i, 'southwest'],
  [/\bashburn\b/i, 'mid-atlantic'],
  [/\bmanassas\b/i, 'mid-atlantic'],
  [/\bsuwanee\b/i, 'southeast'],
  [/\batlanta\b/i, 'southeast'],
  [/\bmemphis\b/i, 'southeast'],
  [/\birving\b/i, 'texas'],
  [/\bgarland\b/i, 'texas'],
  [/\bdallas\b/i, 'texas'],
  [/\baustin\b/i, 'texas'],
  [/\bpiscataway\b/i, 'northeast'],
  [/\bchicago\b/i, 'midwest'],
  [/\bcolumbus\b/i, 'midwest']
];

function fromWorkdayUrl(sourceUrl = '') {
  let pathname = '';
  try { pathname = new URL(sourceUrl).pathname; } catch { return null; }
  const match = pathname.match(/\/job\/([^/]+)\//i);
  if (!match) return null;
  let slug = decodeURIComponent(match[1]).replace(/_/g, '-').replace(/-+/g, '-');
  const stateMatch = slug.match(/^(.+)-([A-Z]{2})$/);
  if (!stateMatch) return null;
  const city = stateMatch[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
  return city ? `${city}, ${stateMatch[2]}` : null;
}

function genericLocation(value = '') {
  const location = String(value || '').trim();
  return /^\d+\s+locations?$/i.test(location) || /^location not listed$/i.test(location) || /^multiple locations?$/i.test(location);
}

function normalizeLocation(job) {
  let location = String(job.location || '').trim();
  for (const [pattern, replacement] of typoFixes) location = location.replace(pattern, replacement);
  for (const [pattern, replacement] of locationAliases) {
    if (pattern.test(location)) {
      location = replacement;
      break;
    }
  }

  if (genericLocation(location)) {
    const derived = fromWorkdayUrl(job.sourceUrl);
    if (derived) location = derived;
  }

  return location;
}

function regionFromText(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';

  const commaCodeMatch = text.match(/,\s*([A-Z]{2})(?:\b|$)/);
  if (commaCodeMatch) return stateToRegion.get(commaCodeMatch[1].toLowerCase()) || '';

  // Some Workday boards return internal labels such as "US GA Atlanta Suwanee 1 DC1".
  const usCodeMatch = text.match(/\bUS\s+([A-Z]{2})\b/i);
  if (usCodeMatch) return stateToRegion.get(usCodeMatch[1].toLowerCase()) || '';

  const lower = text.toLowerCase();
  // Test longer state names first so "West Virginia" is not reduced to "Virginia".
  const names = [...stateToRegion.keys()].filter(key => key.length > 2).sort((a,b) => b.length - a.length);
  for (const name of names) {
    if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower)) {
      return stateToRegion.get(name) || '';
    }
  }

  for (const [pattern, region] of cityRegionFallbacks) {
    if (pattern.test(text)) return region;
  }
  return '';
}

function inferRegion(job) {
  const location = String(job?.location || '').trim();
  if (!location || /\bremote\b/i.test(location)) return '';

  const direct = regionFromText(location);
  if (direct) return direct;

  const derived = fromWorkdayUrl(job?.sourceUrl || '');
  if (derived) return regionFromText(derived);

  return '';
}

const locationChanges = [];
let regionAssigned = 0;
let regionMissing = 0;
const countsByRegion = {};

for (const job of jobs) {
  const before = String(job.location || '');
  const after = normalizeLocation(job);
  if (after && after !== before) {
    job.location = after;
    locationChanges.push({ id:job.id, before, after });
  }

  const region = inferRegion(job);
  if (region) {
    job.region = region;
    regionAssigned += 1;
    countsByRegion[region] = (countsByRegion[region] || 0) + 1;
  } else {
    delete job.region;
    regionMissing += 1;
  }
}

await writeFile('data/jobs.json', JSON.stringify(jobs, null, 2) + '\n');
await writeFile('data/collector-status.json', JSON.stringify({
  ...status,
  locationNormalization:{
    updatedAt:new Date().toISOString(),
    changed:locationChanges.length,
    samples:locationChanges.slice(0,8),
    regionAssigned,
    regionMissing,
    countsByRegion
  }
}, null, 2) + '\n');

console.log(`Location normalization updated ${locationChanges.length} locations and assigned ${regionAssigned}/${jobs.length} regional classifications.`);
