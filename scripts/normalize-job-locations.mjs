import { readFile, writeFile } from 'node:fs/promises';

const jobs = JSON.parse(await readFile('data/jobs.json','utf8'));
let status = {};
try { status = JSON.parse(await readFile('data/collector-status.json','utf8')); } catch {}

const typoFixes = [
  [/\bVirgina\b/g, 'Virginia']
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

function normalizeLocation(job) {
  let location = String(job.location || '').trim();
  for (const [pattern, replacement] of typoFixes) location = location.replace(pattern, replacement);

  if (/^\d+\s+locations?$/i.test(location) || /^location not listed$/i.test(location)) {
    const derived = fromWorkdayUrl(job.sourceUrl);
    if (derived) location = derived;
  }

  return location;
}

function inferRegion(location = '') {
  const value = String(location || '').trim();
  if (!value || /\bremote\b/i.test(value)) return '';

  const codeMatch = value.match(/,\s*([A-Z]{2})(?:\b|$)/);
  if (codeMatch) return stateToRegion.get(codeMatch[1].toLowerCase()) || '';

  const lower = value.toLowerCase();
  // Test longer state names first so "West Virginia" is not reduced to "Virginia".
  const names = [...stateToRegion.keys()].filter(key => key.length > 2).sort((a,b) => b.length - a.length);
  for (const name of names) {
    if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower)) {
      return stateToRegion.get(name) || '';
    }
  }
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

  const region = inferRegion(job.location);
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
