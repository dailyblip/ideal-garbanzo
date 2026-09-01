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
const stateNameToCode = new Map();
for (const [region, values] of Object.entries(regionStates)) {
  values.codes.forEach((code, index) => {
    stateToRegion.set(code.toLowerCase(), region);
    const name = values.names[index];
    if (name) stateNameToCode.set(name.toLowerCase(), code);
  });
  for (const name of values.names) stateToRegion.set(name.toLowerCase(), region);
}

const stateNamesLongestFirst = [...stateNameToCode.keys()].sort((a,b) => b.length - a.length);

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

function titleCaseWords(value = '') {
  return String(value).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase());
}

function fromWorkdayUrl(sourceUrl = '') {
  let pathname = '';
  try { pathname = decodeURIComponent(new URL(sourceUrl).pathname); } catch { return null; }
  const match = pathname.match(/\/job\/([^/]+)\//i);
  if (!match) return null;

  let slug = match[1].replace(/_/g, '-').replace(/-+/g, '-').replace(/\bVirgina\b/gi, 'Virginia');

  const stateCodeMatch = slug.match(/^(.+)-([A-Z]{2})$/);
  if (stateCodeMatch && stateToRegion.has(stateCodeMatch[2].toLowerCase())) {
    const city = titleCaseWords(stateCodeMatch[1]);
    return city ? `${city}, ${stateCodeMatch[2]}` : null;
  }

  const slugLower = slug.toLowerCase();
  for (const stateName of stateNamesLongestFirst) {
    const suffix = `-${stateName.replace(/\s+/g, '-')}`;
    if (!slugLower.endsWith(suffix)) continue;
    const citySlug = slug.slice(0, -suffix.length);
    const city = titleCaseWords(citySlug);
    const code = stateNameToCode.get(stateName);
    return city && code ? `${city}, ${code}` : null;
  }

  return null;
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
  for (const name of stateNamesLongestFirst) {
    if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower)) {
      return stateToRegion.get(name) || '';
    }
  }

  for (const [pattern, region] of cityRegionFallbacks) {
    if (pattern.test(text)) return region;
  }
  return '';
}

function regionFromUrl(sourceUrl = '') {
  let pathname = '';
  try { pathname = decodeURIComponent(new URL(sourceUrl).pathname); } catch { return ''; }
  if (!pathname) return '';

  const fixed = pathname.replace(/\bVirgina\b/gi, 'Virginia');
  const words = fixed.replace(/[-_/]+/g, ' ');
  const named = regionFromText(words);
  if (named) return named;

  // Preserve case here: job-board URLs commonly encode state abbreviations as uppercase path tokens.
  const codeMatch = fixed.match(/(?:^|[-_/])(?:US[-_/])?([A-Z]{2})(?=[-_/]|$)/);
  if (codeMatch) return stateToRegion.get(codeMatch[1].toLowerCase()) || '';

  return '';
}

function inferRegion(job) {
  const location = String(job?.location || '').trim();
  if (!location || /\bremote\b/i.test(location)) return '';

  const direct = regionFromText(location);
  if (direct) return direct;

  const derived = fromWorkdayUrl(job?.sourceUrl || '');
  if (derived) {
    const region = regionFromText(derived);
    if (region) return region;
  }

  return regionFromUrl(job?.sourceUrl || '');
}

const locationChanges = [];
const missingSamples = [];
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
    if (missingSamples.length < 12) {
      missingSamples.push({
        id:job.id,
        company:job.company,
        location:job.location,
        sourceUrl:job.sourceUrl
      });
    }
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
    coveragePct:jobs.length ? Math.round((regionAssigned / jobs.length) * 1000) / 10 : 100,
    missingSamples,
    countsByRegion
  }
}, null, 2) + '\n');

console.log(`Location normalization updated ${locationChanges.length} locations and assigned ${regionAssigned}/${jobs.length} regional classifications.`);
