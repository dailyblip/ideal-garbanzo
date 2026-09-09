import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const COMPANY = 'Cologix';
const API_URL = 'https://api.lever.co/v0/postings/cologix?mode=json';
const BOARD_ROOT = 'https://jobs.lever.co/cologix';
const CAREERS_URL = 'https://cologix.com/about-us/careers/';
const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/cologix-jobs.json';
const STATUS_PATH = 'data/collector-status.json';

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

const missionTitlePattern = /\b(?:data cent(?:er|re) (?:operations? )?technician|data cent(?:er|re) electrician|data cent(?:er|re) hvac technician|critical facilities technician|facilities technician|facility technician)\b/i;
const excludedTitlePattern = /\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|superintendent|foreman|architect|security|sales|account executive)\b/i;

function descriptionForLever(job = {}) {
  const listText = Array.isArray(job?.lists)
    ? job.lists.map(item => `${clean(item?.text)} ${clean(item?.content)}`).join(' ')
    : '';
  return clean([
    job?.descriptionPlain,
    job?.description,
    listText,
    job?.additionalPlain,
    job?.additional
  ].filter(Boolean).join(' '));
}

function requiredExperienceText(description = '') {
  const text = clean(description);
  const preferredSection = text.search(/\b(?:preferred qualifications?|preferred experience|preferred skills?|nice to have|bonus qualifications?)\b/i);
  return preferredSection >= 0 ? text.slice(0, preferredSection) : text;
}

function statedExperienceYears(text = '') {
  const normalized = lower(text)
    .replace(/\bzero\b/g, '0').replace(/\bone\b/g, '1').replace(/\btwo\b/g, '2')
    .replace(/\bthree\b/g, '3').replace(/\bfour\b/g, '4').replace(/\bfive\b/g, '5')
    .replace(/\bsix\b/g, '6').replace(/\bseven\b/g, '7').replace(/\beight\b/g, '8')
    .replace(/\bnine\b/g, '9').replace(/\bten\b/g, '10');
  const values = [];
  const patterns = [
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+years?['’]?(?:\s+(?:of|prior))?\s+(?:direct\s+|relevant\s+|related\s+|professional\s+|work\s+|mission critical\s+)?experience/gi,
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?['’]?(?:\s+(?:of|prior))?\s+(?:direct\s+|relevant\s+|related\s+|professional\s+|work\s+|mission critical\s+)?experience/gi,
    /experience(?:\s+(?:of|in))?\s+(?:at least\s+|minimum(?: of)?\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?/gi,
    /(\d{1,2})\s*(?:\+|or more)?\s+years?['’]?\s+(?:of\s+)?experience\b/gi
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      values.push(Number(match[1]));
      if (match[2]) values.push(Number(match[2]));
    }
  }
  return values.filter(value => Number.isFinite(value) && value >= 0 && value <= 50);
}

function classify(title, description = '') {
  const t = clean(title);
  if (!missionTitlePattern.test(t)) return { classification: null, reason: 'out-of-scope-title' };
  if (excludedTitlePattern.test(t)) return { classification: null, reason: 'senior-title' };

  const required = requiredExperienceText(description);
  const years = statedExperienceYears(required);
  if (years.some(year => year > 5)) return { classification: null, reason: 'over-5-years' };

  const explicitNoExperience = /(?:no|zero) (?:prior )?experience(?: is)? (?:required|needed)|experience (?:is )?not required/i.test(required);
  const earlyCareerSignal = /\bearly career\b|\bentry[- ]level\b|\btraining provided\b/i.test(required);
  if (!years.length && !explicitNoExperience && !earlyCareerSignal) {
    return { classification: null, reason: 'unknown-experience' };
  }

  let experience = '0-2-years';
  if (explicitNoExperience) experience = 'no-experience';
  else if (years.some(year => year >= 3)) experience = '2-5-years';

  return { classification: { type: 'entry-level', experience }, reason: null };
}

const usStateNames = [
  'alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi','missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico','new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota','tennessee','texas','utah','vermont','virginia','washington','west virginia','wisconsin','wyoming','district of columbia'
];
const stateAbbrPattern = /(?:,|\s)\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)(?:\b|$)/i;
function isUsLocation(value = '') {
  const text = clean(value);
  const l = lower(text);
  if (!text) return false;
  if (/\b(?:united states|usa|u\.s\.)\b/i.test(text)) return true;
  if (stateAbbrPattern.test(text)) return true;
  return usStateNames.some(state => l.includes(state));
}

function locationFor(job = {}) {
  const allLocations = Array.isArray(job?.categories?.allLocations) ? job.categories.allLocations : [];
  const candidates = [job?.categories?.location, ...allLocations].map(clean).filter(Boolean);
  return candidates.find(isUsLocation) || null;
}

function payFor(description = '') {
  const text = clean(description);
  const match = text.match(/\$([\d,.]+)\s*(?:-|–|to)\s*\$?([\d,.]+)\s*(?:\/|per\s+)?\s*(hour|hourly|hr|year|yearly|yr|annum|annual|annually)?/i);
  if (!match) return { pay: 'Pay not listed', salaryMin: null, salaryMax: null, salarySortMax: null };
  const min = Number(match[1].replace(/,/g, ''));
  const max = Number(match[2].replace(/,/g, ''));
  const unit = lower(match[3] || '');
  const hourly = /hour|hr/.test(unit) || (!unit && max < 1000);
  return {
    pay: `$${match[1]}–$${match[2]} / ${hourly ? 'hr' : 'year'}`,
    salaryMin: min,
    salaryMax: max,
    salarySortMax: hourly ? Math.round(max * 2080) : max
  };
}

function tagsFor(title, description, experience) {
  const text = lower(`${title} ${description}`);
  const tags = [experience === 'no-experience' ? 'No Experience Needed' : experience === '2-5-years' ? '2–5 Years' : '0–2 Years'];
  if (/\belectrical\b|\belectrician\b|\bswitchgear\b|\bups\b|\bgenerator\b/.test(text)) tags.push('Electrical');
  if (/\bhvac\b|\bmechanical\b|\bchiller\b|\bcrah\b|\bcrac\b|\bcooling\b|\bcritical facilit/.test(text)) tags.push('Critical Facilities');
  if (/\bfiber\b|\bcabling\b|\bcross-connect\b|\bnetwork\b/.test(text)) tags.push('Network / Cabling');
  if (/\bearly career\b|\btraining\b|\bmentorship\b|\bdevelopment\b/.test(text)) tags.push('Training / Mentorship');
  return [...new Set(tags)].slice(0, 5);
}

function isoDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
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

if (process.argv.includes('--test-classifier')) {
  const cases = [
    ['preferred two-year technician accepted', 'Data Center Technician- 2nd shift (Sunday- Wednesday)', '2+ years of experience in data center operations, structured cabling, telecom, IT support, or a related field preferred.', '0-2-years'],
    ['two-to-three year technician accepted', 'Data Center Technician- 3rd Shift (Wednesday- Saturday)', 'Minimum 2-3 years experience in similar critical facilities.', '2-5-years'],
    ['five-year electrician accepted', 'Data Center Electrician- 1st shift (Sunday- Wednesday)', '5+ years of experience working with electrical systems in mission-critical, industrial, or similar environments.', '2-5-years'],
    ['five-year hvac accepted', 'Data Center Technician, HVAC- 2nd shift (Wednesday- Saturday)', 'We are looking for an early career specialist. 5+ years of experience working with HVAC, refrigeration, or mechanical systems.', '2-5-years'],
    ['over-five rejected', 'Data Center Technician', 'Minimum of 7 years of experience in critical facilities operations.', null],
    ['unknown rejected', 'Data Center Technician', 'Operate and support a mission-critical data center environment.', null],
    ['security rejected', 'Data Center Security Technician', '2 years of experience in data center security operations.', null]
  ];
  const failures = [];
  for (const [name, title, description, expected] of cases) {
    const actual = classify(title, description).classification?.experience ?? null;
    if (actual !== expected) failures.push(`${name}: expected ${expected}, got ${actual}`);
  }

  const leverFixture = {
    descriptionPlain: 'Support day-to-day operations in a 24x7 colocation environment.',
    lists: [{ text: 'Qualifications', content: '<li>2+ years of experience in data center operations preferred</li>' }]
  };
  const fixtureDescription = descriptionForLever(leverFixture);
  const fixtureResult = classify('Data Center Technician', fixtureDescription).classification?.experience ?? null;
  if (fixtureResult !== '0-2-years') failures.push(`Lever list-field parsing: expected 0-2-years, got ${fixtureResult}`);

  if (failures.length) {
    for (const failure of failures) console.error(`Cologix classifier regression: ${failure}`);
    process.exit(1);
  }
  console.log(`Cologix classifier passed ${cases.length + 1} regression cases.`);
  process.exit(0);
}

const previousJobs = await readJson(JOBS_PATH, []);
const priorStatus = await readJson(STATUS_PATH, {});

const response = await fetch(API_URL, {
  headers: {
    accept: 'application/json',
    'user-agent': 'DataCenterCareersBot/1.6 (+https://datacentercareers.us/)'
  },
  signal: AbortSignal.timeout(20000)
});
if (!response.ok) throw new Error(`Cologix Lever source returned HTTP ${response.status}`);
const payload = await response.json();
if (!Array.isArray(payload) || payload.length === 0) {
  throw new Error('Cologix Lever source returned no public jobs; preserving the last verified snapshot.');
}

const diagnostics = {
  listedJobs: payload.length,
  usJobs: 0,
  candidateRoles: 0,
  qualifyingRoles: 0,
  rejectedOutOfScopeTitle: 0,
  rejectedSeniorTitle: 0,
  rejectedOver5Years: 0,
  rejectedUnknownExperience: 0
};
const collected = [];

for (const job of payload) {
  const location = locationFor(job);
  if (!location) continue;
  diagnostics.usJobs += 1;

  const title = clean(job?.text);
  const description = descriptionForLever(job);
  if (missionTitlePattern.test(title)) diagnostics.candidateRoles += 1;
  const { classification, reason } = classify(title, description);
  if (!classification) {
    if (reason === 'out-of-scope-title') diagnostics.rejectedOutOfScopeTitle += 1;
    else if (reason === 'senior-title') diagnostics.rejectedSeniorTitle += 1;
    else if (reason === 'over-5-years') diagnostics.rejectedOver5Years += 1;
    else if (reason === 'unknown-experience') diagnostics.rejectedUnknownExperience += 1;
    continue;
  }

  const leverId = clean(job?.id || hash(`${title}|${location}`));
  const sourceUrl = clean(job?.hostedUrl || `${BOARD_ROOT}/${leverId}`);
  if (!sourceUrl.startsWith(`${BOARD_ROOT}/`)) continue;
  collected.push({
    id: `lever-cologix-${leverId}`,
    title,
    company: COMPANY,
    location,
    type: classification.type,
    experience: classification.experience,
    tags: tagsFor(title, description, classification.experience),
    ...payFor(description),
    postedAt: isoDate(job?.createdAt),
    source: 'Employer career site',
    sourceUrl,
    active: true,
    demo: false
  });
}

const cologixJobs = dedupe(collected);
diagnostics.qualifyingRoles = cologixJobs.length;

const merged = dedupe([
  ...previousJobs.filter(job => clean(job?.company) !== COMPANY),
  ...cologixJobs
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
  cologix: {
    checkedAt: new Date().toISOString(),
    sourceHealthy: true,
    listingComplete: true,
    officialCareerPage: CAREERS_URL,
    officialLeverBoard: BOARD_ROOT,
    api: API_URL,
    authoritativeSnapshot: true,
    ...diagnostics
  }
};

await writeFile(SNAPSHOT_PATH, JSON.stringify(cologixJobs, null, 2) + '\n');
await writeFile(JOBS_PATH, JSON.stringify(merged, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

console.log(`Cologix: ${cologixJobs.length} qualifying U.S. role(s) from ${payload.length} public Lever jobs; feed now ${merged.length} jobs.`);
