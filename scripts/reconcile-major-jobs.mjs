import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const MAJOR_PATH = 'data/major-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const preserveExisting = process.argv.includes('--preserve-existing');
const majorCompanies = new Set([
  'Vantage Data Centers',
  'QTS Data Centers',
  'CyrusOne',
  'STACK Infrastructure',
  'NTT Global Data Centers',
  'Aligned Data Centers'
]);

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalize = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const identity = job => [job?.company, job?.title, job?.location].map(normalize).join('|');
const jobKey = job => clean(job?.id) || clean(job?.sourceUrl) || identity(job);
const clearlyForeignLocationTerms = [
  'malaysia', 'india', 'indonesia', 'japan', 'taiwan', 'thailand', 'germany', 'england', 'united kingdom', 'uk',
  'wales', 'netherlands', 'switzerland', 'ireland', 'canada', 'hong kong', 'china', 'singapore', 'australia', 'france',
  'spain', 'italy', 'poland', 'sweden', 'norway', 'denmark', 'belgium', 'austria', 'portugal',
  'brazil', 'mexico', 'south africa', 'united arab emirates',
  'montreal quebec', 'toronto on', 'frankfurt', 'amsterdam', 'ams1', 'eemshaven', 'bengaluru', 'noida',
  'navi mumbai', 'mumbai', 'osaka', 'taipei', 'cyberjaya', 'munich', 'zurich', 'jakarta', 'chon buri'
].map(normalize);
const usStateNames = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware',
  'district of columbia', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa',
  'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota',
  'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey',
  'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon',
  'pennsylvania', 'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah',
  'vermont', 'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming'
];
const usStateCodes = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM',
  'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA',
  'WV', 'WI', 'WY'
]);

// Workday sometimes emits CyrusOne campus codes instead of a city. Keep this
// mapping company-specific and limited to verified U.S. campuses so the public
// feed gets readable geography without guessing across employers.
const cyrusOneCampusLocations = [
  [/^PHX[1-8]$/i, 'Chandler, AZ'],
  [/^CHI[1-3]$/i, 'Aurora, IL'],
  [/^OCB1$/i, 'Council Bluffs, IA'],
  [/^COL1$/i, 'New Albany, OH'],
  [/^NYM1$/i, 'Somerset, NJ'],
  [/^NYM2$/i, 'Totowa, NJ'],
  [/^NYM5$/i, 'Norwalk, CT'],
  [/^NYM7$/i, 'Wappingers Falls, NY'],
  [/^DUR[1-2]$/i, 'Durham, NC'],
  [/^CIN2$/i, 'Cincinnati, OH'],
  [/^CIN5$/i, 'Lebanon, OH'],
  [/^CIN6$/i, 'Florence, KY'],
  [/^AUS[2-3]$/i, 'Austin, TX'],
  [/^DFW1$/i, 'Carrollton, TX'],
  [/^DFW2$/i, 'Lewisville, TX'],
  [/^DFW[3-5]$/i, 'Allen, TX'],
  [/^HOU[3-4]$/i, 'Houston, TX'],
  [/^SAT[1-6]$/i, 'San Antonio, TX'],
  [/^NVA[1-9]$/i, 'Sterling, VA'],
  [/^PNW1$/i, 'Quincy, WA']
];

// Aligned publishes exact site IDs and postal locations on its official
// locations pages. Keep these mappings exact and company-scoped so Workday
// campus codes become useful city/state labels without guessing across sites.
const alignedCampusLocations = [
  [/^DFW0?1_0?2$/i, 'Plano, TX'],
  [/^DFW[-_]?0?4$/i, 'Plano, TX'],
  [/^ORD[-_]?0?1$/i, 'Northlake, IL'],
  [/^ORD[-_]?0?2$/i, 'Northlake, IL'],
  [/^ORD[-_]?0?3$/i, 'Elk Grove Village, IL'],
  [/^PDX[-_]?0?1$/i, 'Hillsboro, OR'],
  [/^PHX[-_]?0?[1-3]$/i, 'Phoenix, AZ'],
  [/^PHX[-_]?0?4$/i, 'Chandler, AZ'],
  [/^PHX[-_]?0?5$/i, 'Phoenix, AZ'],
  [/^PHX[-_]?0?6$/i, 'Chandler, AZ'],
  [/^PHX[-_]?0?7$/i, 'Waddell, AZ'],
  [/^IAD[-_]?0?4$/i, 'Frederick, MD'],
  [/^IAD[-_]?0?6$/i, 'Frederick, MD']
];

// These are the same deliberately narrow U.S. campus-code families used by
// normalize-job-locations.mjs for operators whose codes do not have a verified
// company-specific city mapping here. Foreign codes such as DUB11 stay excluded.
const verifiedUsSiteCodePattern = /^(?:NVA|IAD|DFW|DAL|PHX|LAS|ORD|CMH|NEO|ATL|MIA|CLT|RDU|NYC|EWR|BOS|SJC|SFO|LAX|SEA|PDX|DEN|SLC)[-_]?\d+\b/i;

function primaryLocation(value) {
  return clean(value)
    .replace(/\s+\+\s+\d+\s+more\s+locations?\s*$/i, '')
    .replace(/\bVirgina\b/gi, 'Virginia')
    .trim();
}

function canonicalMajorLocation(job) {
  const location = primaryLocation(job?.location);
  const company = clean(job?.company);
  const mappings = company === 'CyrusOne'
    ? cyrusOneCampusLocations
    : company === 'Aligned Data Centers'
      ? alignedCampusLocations
      : [];
  for (const [pattern, replacement] of mappings) {
    if (pattern.test(location)) return replacement;
  }
  return location;
}

function mergeCanonicalSnapshot(existingJobs, snapshotJobs) {
  const existingByKey = new Map(existingJobs.map(job => [jobKey(job), job]));
  return snapshotJobs.map(job => {
    const existing = existingByKey.get(jobKey(job));
    // Preserve history/enrichment fields that exist only in the public feed,
    // but let the current authoritative snapshot win for location, title, pay,
    // source URL and other fields it actually supplies.
    return existing ? { ...existing, ...job } : job;
  });
}

// Keep campus-code mappings company-specific, and ensure preserve-existing mode
// still applies fresh canonical fields instead of freezing older display data.
for (const [job, expected] of [
  [{ company: 'CyrusOne', location: 'COL1' }, 'New Albany, OH'],
  [{ company: 'Vantage Data Centers', location: 'COL1' }, 'COL1'],
  [{ company: 'Aligned Data Centers', location: 'DFW01_02' }, 'Plano, TX'],
  [{ company: 'Aligned Data Centers', location: 'DFW-04' }, 'Plano, TX'],
  [{ company: 'Aligned Data Centers', location: 'ORD-03' }, 'Elk Grove Village, IL'],
  [{ company: 'Aligned Data Centers', location: 'PDX-01' }, 'Hillsboro, OR'],
  [{ company: 'Aligned Data Centers', location: 'PHX-03' }, 'Phoenix, AZ'],
  [{ company: 'Aligned Data Centers', location: 'PHX-06' }, 'Chandler, AZ'],
  [{ company: 'Aligned Data Centers', location: 'PHX-07' }, 'Waddell, AZ'],
  [{ company: 'Aligned Data Centers', location: 'IAD-04' }, 'Frederick, MD'],
  [{ company: 'Aligned Data Centers', location: 'IAD-06' }, 'Frederick, MD'],
  [{ company: 'Vantage Data Centers', location: 'PHX-06' }, 'PHX-06']
]) {
  const actual = canonicalMajorLocation(job);
  if (actual !== expected) {
    throw new Error(`Major location regression for ${job.company} ${job.location}: expected ${expected}, got ${actual}`);
  }
}

const preserveRegression = mergeCanonicalSnapshot(
  [{ id: 'regression-role', company: 'Aligned Data Centers', location: 'PHX-06', firstSeenAt: 'keep-me' }],
  [{ id: 'regression-role', company: 'Aligned Data Centers', location: 'Chandler, AZ', pay: '$35–$45 / hr' }]
)[0];
if (preserveRegression.location !== 'Chandler, AZ' || preserveRegression.firstSeenAt !== 'keep-me' || preserveRegression.pay !== '$35–$45 / hr') {
  throw new Error('Major preserve-existing regression: current canonical fields must override stale feed fields while retaining feed-only history.');
}

function clearlyOutsideUnitedStates(job) {
  const text = ` ${normalize(`${job?.location || ''} ${job?.sourceUrl || ''}`)} `;
  return clearlyForeignLocationTerms.some(term => term && text.includes(` ${term} `));
}

function confidentlyInsideUnitedStates(job) {
  const location = primaryLocation(job?.location);
  if (!location) return false;
  if (/\b(?:united states(?: of america)?|u\.s\.a\.?|usa)\b/i.test(location)) return true;
  if (/\bremote\b/i.test(location) && /\b(?:us|usa|united states)\b/i.test(location)) return true;
  if (verifiedUsSiteCodePattern.test(location)) return true;

  // Workday commonly emits remote labels such as "Remote - OK". A trailing
  // USPS state code is enough to establish U.S. geography without guessing a
  // city; normalize-job-locations.mjs will assign the correct regional filter.
  const remoteState = location.match(/^remote\s*[-,]\s*([A-Z]{2})\b/i);
  if (remoteState && usStateCodes.has(remoteState[1].toUpperCase())) return true;

  const normalizedLocation = normalize(location);
  if (/\bus\s+(?:al|ak|az|ar|ca|co|ct|de|dc|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy)\b/.test(normalizedLocation)) return true;

  const parts = location.split(/[,|/]/).map(part => clean(part)).filter(Boolean);
  if (parts.some(part => usStateCodes.has(part.toUpperCase()))) return true;

  return usStateNames.some(state =>
    normalizedLocation === state ||
    normalizedLocation.startsWith(`${state} `) ||
    normalizedLocation.endsWith(` ${state}`) ||
    normalizedLocation.includes(` ${state} `)
  );
}

async function readJson(path) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(value)) throw new Error(`${path} must contain an array.`);
  return value;
}

async function readJsonObject(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function dedupe(jobs) {
  const ids = new Set();
  const urls = new Set();
  const identities = new Set();
  const out = [];
  for (const job of jobs) {
    if (!job || typeof job !== 'object') continue;
    const id = clean(job.id);
    const url = clean(job.sourceUrl);
    const key = identity(job);
    if ((id && ids.has(id)) || (url && urls.has(url)) || (key && identities.has(key))) continue;
    if (id) ids.add(id);
    if (url) urls.add(url);
    if (key) identities.add(key);
    out.push(job);
  }
  return out;
}

const jobs = await readJson(JOBS_PATH);
const rawMajorInput = await readJson(MAJOR_PATH);
const siteCodeLocationChanges = [];
const rawMajorSnapshot = dedupe(rawMajorInput.map(job => {
  const before = primaryLocation(job?.location);
  const after = canonicalMajorLocation(job);
  if (after && after !== before) {
    siteCodeLocationChanges.push({
      company: clean(job?.company),
      title: clean(job?.title),
      before,
      after
    });
  }
  return { ...job, location: after };
}));
const foreignMajor = rawMajorSnapshot.filter(clearlyOutsideUnitedStates);
const unresolvedMajor = rawMajorSnapshot.filter(job => !clearlyOutsideUnitedStates(job) && !confidentlyInsideUnitedStates(job));
const majorSnapshot = rawMajorSnapshot.filter(job => !clearlyOutsideUnitedStates(job) && confidentlyInsideUnitedStates(job));
if (!majorSnapshot.length) throw new Error('Refusing to reconcile an empty confidently U.S. major-employer snapshot.');

for (const job of majorSnapshot) {
  if (!majorCompanies.has(clean(job.company))) {
    throw new Error(`Unexpected company in ${MAJOR_PATH}: ${clean(job.company) || '(missing company)'}`);
  }
}

const oldMajor = jobs.filter(job => majorCompanies.has(clean(job?.company)));
const nonMajor = jobs.filter(job => !majorCompanies.has(clean(job?.company)));
const currentKeys = new Set(majorSnapshot.map(jobKey));
const staleRemoved = oldMajor.filter(job => !currentKeys.has(jobKey(job))).length;

let authoritativeMajor = majorSnapshot;
if (preserveExisting) {
  authoritativeMajor = mergeCanonicalSnapshot(oldMajor, majorSnapshot);
}

const merged = dedupe([...nonMajor, ...authoritativeMajor]);
const now = Date.now();
for (const job of merged) {
  const posted = job.postedAt ? new Date(job.postedAt).getTime() : NaN;
  job.postedHours = Number.isFinite(posted) ? Math.max(0, Math.round((now - posted) / 36e5)) : 9999;
}
merged.sort((a, b) => (a.postedHours ?? 9999) - (b.postedHours ?? 9999));

const reconciledMajor = merged.filter(job => majorCompanies.has(clean(job?.company)));
if (reconciledMajor.length !== majorSnapshot.length) {
  throw new Error(`Major-employer reconciliation mismatch: snapshot=${majorSnapshot.length}, feed=${reconciledMajor.length}.`);
}

const status = await readJsonObject(STATUS_PATH);
status.majorSources = {
  ...(status.majorSources || {}),
  reconciliation: {
    checkedAt: new Date().toISOString(),
    rawJobs: rawMajorSnapshot.length,
    publishedUsJobs: majorSnapshot.length,
    nonUsRemoved: foreignMajor.length,
    unresolvedLocationRemoved: unresolvedMajor.length,
    siteCodeLocationsResolved: siteCodeLocationChanges.length,
    siteCodeLocationSamples: siteCodeLocationChanges.slice(0, 8),
    nonUsSamples: foreignMajor.slice(0, 8).map(job => ({ company: clean(job.company), title: clean(job.title), location: clean(job.location) })),
    unresolvedLocationSamples: unresolvedMajor.slice(0, 8).map(job => ({ company: clean(job.company), title: clean(job.title), location: clean(job.location) }))
  }
};

await writeFile(MAJOR_PATH, JSON.stringify(majorSnapshot, null, 2) + '\n');
await writeFile(JOBS_PATH, JSON.stringify(merged, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
console.log(`Reconciled ${majorSnapshot.length} confidently U.S. major-employer jobs into the feed; normalized ${siteCodeLocationChanges.length} verified campus-code locations, filtered ${foreignMajor.length} clearly non-U.S. records, removed ${unresolvedMajor.length} unresolved-location records, and removed ${staleRemoved} stale records${preserveExisting ? ' while preserving normalized current records' : ''}.`);
