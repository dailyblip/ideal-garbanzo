import { readFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const MAJOR_PATH = 'data/major-jobs.json';

// These dedicated snapshots are already treated as authoritative by the
// priority-source guard. Preserve both their U.S. state footprint and the
// audience segments available in each market so a refresh cannot keep one
// role in a state while silently dropping its beginner or work-based-learning
// opportunities.
const protectedSnapshots = [
  { company: 'Amazon Web Services', path: 'data/amazon-jobs.json' },
  { company: 'Google', path: 'data/google-jobs.json' },
  { company: 'Microsoft', path: 'data/microsoft-jobs.json' },
  { company: 'Meta', path: 'data/meta-jobs.json' },
  { company: 'Oracle', path: 'data/oracle-jobs.json' },
  { company: 'Digital Realty', path: 'data/digital-realty-jobs.json' },
  { company: 'Iron Mountain', path: 'data/iron-mountain-jobs.json' },
  { company: 'Cologix', path: 'data/cologix-jobs.json' },
  { company: 'Flexential', path: 'data/flexential-jobs.json' },
  { company: 'T5 Data Centers', path: 'data/t5-data-centers-jobs.json' },
  { company: 'Stream Data Centers', path: 'data/stream-data-centers-jobs.json' },
  { company: 'Switch', path: 'data/switch-jobs.json' },
  { company: 'DataBank', path: 'data/databank-jobs.json' },
  { company: 'TierPoint', path: 'data/tierpoint-jobs.json' },
  { company: 'Sabey Data Centers', path: 'data/sabey-jobs.json' },
  { company: 'Novva Data Centers', path: 'data/novva-jobs.json' }
];

const majorWorkdayCompanies = [
  'Vantage Data Centers',
  'QTS Data Centers',
  'CyrusOne',
  'STACK Infrastructure',
  'NTT Global Data Centers',
  'Aligned Data Centers'
];

const statePairs = [
  ['alabama', 'AL'], ['alaska', 'AK'], ['arizona', 'AZ'], ['arkansas', 'AR'],
  ['california', 'CA'], ['colorado', 'CO'], ['connecticut', 'CT'], ['delaware', 'DE'],
  ['district of columbia', 'DC'], ['florida', 'FL'], ['georgia', 'GA'], ['hawaii', 'HI'],
  ['idaho', 'ID'], ['illinois', 'IL'], ['indiana', 'IN'], ['iowa', 'IA'], ['kansas', 'KS'],
  ['kentucky', 'KY'], ['louisiana', 'LA'], ['maine', 'ME'], ['maryland', 'MD'],
  ['massachusetts', 'MA'], ['michigan', 'MI'], ['minnesota', 'MN'], ['mississippi', 'MS'],
  ['missouri', 'MO'], ['montana', 'MT'], ['nebraska', 'NE'], ['nevada', 'NV'],
  ['new hampshire', 'NH'], ['new jersey', 'NJ'], ['new mexico', 'NM'], ['new york', 'NY'],
  ['north carolina', 'NC'], ['north dakota', 'ND'], ['ohio', 'OH'], ['oklahoma', 'OK'],
  ['oregon', 'OR'], ['pennsylvania', 'PA'], ['rhode island', 'RI'], ['south carolina', 'SC'],
  ['south dakota', 'SD'], ['tennessee', 'TN'], ['texas', 'TX'], ['utah', 'UT'],
  ['vermont', 'VT'], ['virginia', 'VA'], ['washington', 'WA'], ['west virginia', 'WV'],
  ['wisconsin', 'WI'], ['wyoming', 'WY']
];
const stateCodes = new Set(statePairs.map(([, code]) => code));
const stateNamesLongestFirst = [...statePairs].sort((a, b) => b[0].length - a[0].length);
const programTypes = new Set(['internship', 'apprenticeship', 'trainee']);
const experienceBands = new Set(['no-experience', '0-2-years', '2-5-years']);

const normalize = value => String(value ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function stateCode(location = '') {
  const text = String(location || '').trim();
  if (!text) return '';

  // Employer boards use both conventional "City, VA" locations and internal
  // labels such as "US VA Ashburn 1 DC1". Prefer an explicit two-letter state
  // token when present, scanning from right to left for conventional addresses.
  const upperTokens = text.match(/\b[A-Z]{2}\b/g) || [];
  for (let index = upperTokens.length - 1; index >= 0; index -= 1) {
    if (stateCodes.has(upperTokens[index])) return upperTokens[index];
  }

  const normalized = ` ${normalize(text)} `;
  for (const [name, code] of stateNamesLongestFirst) {
    if (normalized.includes(` ${name} `)) return code;
  }
  return '';
}

function audienceSegment(job = {}) {
  const type = String(job?.type || '').trim().toLowerCase();
  if (programTypes.has(type)) return type;
  const experience = String(job?.experience || '').trim().toLowerCase();
  return experienceBands.has(experience) ? experience : '';
}

function stateCoverage(records = []) {
  return new Set(records.map(job => stateCode(job?.location)).filter(Boolean));
}

function stateAudienceCoverage(records = []) {
  const coverage = new Set();
  for (const job of records) {
    const state = stateCode(job?.location);
    const segment = audienceSegment(job);
    if (state && segment) coverage.add(`${state}:${segment}`);
  }
  return coverage;
}

async function readJobs(path) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray(value.jobs)) return value.jobs;
  throw new Error(`${path} must contain a job array or an object with a jobs array.`);
}

// Keep state parsing deterministic before it becomes a publication gate.
const stateRegressionCases = [
  ['Newark, CA', 'CA'],
  ['121 Riverside Court, Kings Mountain, NC', 'NC'],
  ['Ashburn, Virginia', 'VA'],
  ['US OR Hillsboro 1 DC1', 'OR'],
  ['Washington, District of Columbia', 'DC'],
  ['Toronto, Canada', ''],
  ['Remote - United States', '']
];
for (const [location, expected] of stateRegressionCases) {
  const actual = stateCode(location);
  if (actual !== expected) {
    throw new Error(`Priority regional coverage state parser regression for "${location}": expected ${expected || '(none)'}, got ${actual || '(none)'}.`);
  }
}

const audienceRegressionCases = [
  [{ type: 'internship', experience: '0-2-years' }, 'internship'],
  [{ type: 'apprenticeship', experience: 'no-experience' }, 'apprenticeship'],
  [{ type: 'trainee', experience: '0-2-years' }, 'trainee'],
  [{ type: 'entry-level', experience: 'no-experience' }, 'no-experience'],
  [{ type: 'entry-level', experience: '0-2-years' }, '0-2-years'],
  [{ type: 'entry-level', experience: '2-5-years' }, '2-5-years'],
  [{ type: 'entry-level', experience: 'unknown' }, '']
];
for (const [job, expected] of audienceRegressionCases) {
  const actual = audienceSegment(job);
  if (actual !== expected) {
    throw new Error(`Priority regional audience parser regression: expected ${expected || '(none)'}, got ${actual || '(none)'}.`);
  }
}

const jobs = await readJobs(JOBS_PATH);
const violations = [];

function requireStateCoverage(company, snapshotJobs, publicJobs, context) {
  const expectedStates = stateCoverage(snapshotJobs);
  if (!expectedStates.size) return;
  const publicStates = stateCoverage(publicJobs);
  const missingStates = [...expectedStates].filter(code => !publicStates.has(code)).sort();
  if (missingStates.length) {
    violations.push(`${company}: public feed lost ${missingStates.length}/${expectedStates.size} authoritative U.S. state market(s) from ${context}: ${missingStates.join(', ')}`);
  }
}

function requireAudienceCoverage(company, snapshotJobs, publicJobs, context) {
  const expected = stateAudienceCoverage(snapshotJobs);
  if (!expected.size) return;
  const published = stateAudienceCoverage(publicJobs);
  const missing = [...expected].filter(key => !published.has(key)).sort();
  if (missing.length) {
    violations.push(`${company}: public feed lost ${missing.length}/${expected.size} authoritative regional audience segment(s) from ${context}: ${missing.join(', ')}`);
  }
}

function requireRegionalCoverage(company, snapshotJobs, publicJobs, context) {
  requireStateCoverage(company, snapshotJobs, publicJobs, context);
  requireAudienceCoverage(company, snapshotJobs, publicJobs, context);
}

for (const { company, path } of protectedSnapshots) {
  const snapshotJobs = await readJobs(path);
  const ownedSnapshotJobs = snapshotJobs.filter(job => String(job?.company || '').trim() === company);
  const publicJobs = jobs.filter(job => String(job?.company || '').trim() === company);
  requireRegionalCoverage(company, ownedSnapshotJobs, publicJobs, 'dedicated snapshot');
}

const majorJobs = await readJobs(MAJOR_PATH);
for (const company of majorWorkdayCompanies) {
  const snapshotJobs = majorJobs.filter(job => String(job?.company || '').trim() === company);
  const publicJobs = jobs.filter(job => String(job?.company || '').trim() === company);
  requireRegionalCoverage(company, snapshotJobs, publicJobs, 'major Workday snapshot');
}

if (violations.length) {
  for (const violation of violations) console.error(`Priority regional coverage violation: ${violation}`);
  throw new Error(`Blocked ${violations.length} priority-employer regional coverage regression(s).`);
}

const summaryCompanies = [...protectedSnapshots.map(item => item.company), ...majorWorkdayCompanies];
const summary = summaryCompanies.map(company => {
  const companyJobs = jobs.filter(job => String(job?.company || '').trim() === company);
  const states = [...stateCoverage(companyJobs)].sort();
  const audienceMarkets = stateAudienceCoverage(companyJobs).size;
  return `${company}=${states.length ? states.join('/') : 'no-state-coded-roles'} (${audienceMarkets} audience-market segments)`;
}).join(', ');
console.log(`Priority regional coverage guard passed. ${summary}`);