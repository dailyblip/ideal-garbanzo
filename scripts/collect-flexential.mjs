import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const COMPANY = 'Flexential';
const API_URL = 'https://boards-api.greenhouse.io/v1/boards/flexentialcorp/jobs?content=true';
const BOARD_ROOT = 'https://job-boards.greenhouse.io/flexentialcorp';
const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/flexential-jobs.json';
const STATUS_PATH = 'data/collector-status.json';

const clean = value => String(value ?? '')
  .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&ndash;|&#8211;/gi, '–')
  .replace(/&mdash;|&#8212;/gi, '—')
  .replace(/\s+/g, ' ')
  .trim();
const lower = value => clean(value).toLowerCase();
const normalize = value => lower(value).replace(/[^a-z0-9]+/g, ' ').trim();
const hash = value => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 14);

const missionTitlePattern = /\b(?:data\s*center\s+technician(?:\s+[i1-3v]+)?|critical\s+infrastructure\s+engineer(?:\s+[i1-3v]+)?|critical\s+facilities\s+(?:technician|engineer)|data\s*center\s+operations\s+technician|facilities\s+technician)\b/i;
const excludedTitlePattern = /\b(?:talent community|senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|superintendent|foreman)\b/i;
const stateCodes = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY']);

function requiredExperienceText(description = '') {
  const text = clean(description);
  const preferred = text.search(/\b(?:preferred qualifications?|preferred experience|preferred skills?|nice to have|bonus qualifications?)\b/i);
  return preferred >= 0 ? text.slice(0, preferred) : text;
}

function normalizeNumberWords(text = '') {
  const words = { zero:'0', one:'1', two:'2', three:'3', four:'4', five:'5', six:'6', seven:'7', eight:'8', nine:'9', ten:'10' };
  return lower(text).replace(/\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/g, word => words[word] || word);
}

function requiredExperienceMinimums(text = '') {
  let remaining = normalizeNumberWords(text);
  const values = [];
  const rangePattern = /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+years?['’]?(?:\s+(?:of|prior))?\s+(?:direct\s+|relevant\s+|related\s+|professional\s+|technical\s+|work\s+|data\s*center\s+|critical\s+infrastructure\s+|facilities\s+)?experience/gi;
  remaining = remaining.replace(rangePattern, (...args) => {
    const minimum = Number(args[1]);
    if (Number.isFinite(minimum)) values.push(minimum);
    return ' ';
  });

  const singlePatterns = [
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?['’]?(?:\s+(?:of|prior))?\s+(?:direct\s+|relevant\s+|related\s+|professional\s+|technical\s+|work\s+|data\s*center\s+|critical\s+infrastructure\s+|facilities\s+)?experience/gi,
    /experience.{0,45}?(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?/gi
  ];
  for (const pattern of singlePatterns) {
    for (const match of remaining.matchAll(pattern)) {
      const minimum = Number(match[1]);
      if (Number.isFinite(minimum)) values.push(minimum);
    }
  }
  return values.filter(value => value >= 0 && value <= 50);
}

function classify(title, description = '') {
  const t = clean(title);
  if (!missionTitlePattern.test(t)) return { classification:null, reason:'out-of-scope-title' };
  if (excludedTitlePattern.test(t)) return { classification:null, reason:'excluded-title' };

  let type = 'entry-level';
  if (/intern/i.test(t)) type = 'internship';
  else if (/apprentice/i.test(t)) type = 'apprenticeship';
  else if (/trainee/i.test(t)) type = 'trainee';

  const required = requiredExperienceText(description);
  const explicitNoExperience = /(?:no|zero) (?:prior )?experience(?: is)? (?:required|needed)|experience (?:is )?not required/i.test(required);
  const minimums = requiredExperienceMinimums(required);
  if (!minimums.length && !explicitNoExperience && type === 'entry-level') {
    return { classification:null, reason:'unknown-experience' };
  }

  const requiredMinimum = minimums.length ? Math.max(...minimums) : 0;
  if (requiredMinimum > 5) return { classification:null, reason:'over-5-years' };

  let experience = '0-2-years';
  if (explicitNoExperience || requiredMinimum === 0) experience = 'no-experience';
  else if (requiredMinimum >= 3) experience = '2-5-years';

  return { classification:{ type, experience }, reason:null };
}

function locationFor(job) {
  const raw = clean(job?.location?.name || job?.location || 'United States');
  const aliases = new Map([
    ['GA - Alpharetta (HUB)', 'Alpharetta, GA'],
    ['NV - Las Vegas North', 'Las Vegas North, NV'],
    ['OR - Portland Hillsboro 2', 'Hillsboro, OR']
  ]);
  if (aliases.has(raw)) return aliases.get(raw);

  const prefixed = raw.match(/^([A-Z]{2})\s*[-–—]\s*(.+)$/);
  if (prefixed && stateCodes.has(prefixed[1])) {
    const site = clean(prefixed[2]).replace(/\s*\(HUB\)\s*$/i, '');
    return site ? `${site}, ${prefixed[1]}` : raw;
  }
  return raw;
}

function payFor(description = '') {
  const text = clean(description);
  const match = text.match(/\$([\d,.]+)\s*(?:-|–|to)\s*\$?([\d,.]+)(?:\s*(?:\/|per\s+)?\s*(hour|hourly|hr|year|yearly|yr|annum|annual|annually))?/i);
  if (!match) return { pay:'Pay not listed', salaryMin:null, salaryMax:null, salarySortMax:null };
  const min = Number(match[1].replace(/,/g, ''));
  const max = Number(match[2].replace(/,/g, ''));
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
    return { pay:'Pay not listed', salaryMin:null, salaryMax:null, salarySortMax:null };
  }
  const unit = lower(match[3] || '');
  const hourly = /hour|hr/.test(unit) || (!unit && max < 1000);
  const formatter = value => value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return {
    pay:`$${formatter(min)}–$${formatter(max)} / ${hourly ? 'hr' : 'year'}`,
    salaryMin:min,
    salaryMax:max,
    salarySortMax:hourly ? Math.round(max * 2080) : max
  };
}

function tagsFor(title, description, experience, type) {
  const text = lower(`${title} ${description}`);
  const tags = [];
  if (type === 'internship') tags.push('Internship');
  else if (type === 'apprenticeship') tags.push('Apprenticeship');
  else if (type === 'trainee') tags.push('Trainee');
  if (experience === 'no-experience') tags.push('No Experience Needed');
  else if (experience === '0-2-years') tags.push('0–2 Years');
  else tags.push('2–5 Years');
  if (/structured training|training program|professional development|mentorship/.test(text)) tags.push('Training / Mentorship');
  if (/critical infrastructure|critical facilit|generator|ups|switchgear|hvac|cooling/.test(text)) tags.push('Critical Facilities');
  if (/electrical|power distribution|switchgear|ups/.test(text)) tags.push('Electrical');
  if (/data\s*center technician|remote hands|cabling|network\/power monitoring/.test(text)) tags.push('Data Center Operations');
  return [...new Set(tags)].slice(0, 5);
}

function sourceUrlFor(job) {
  const direct = clean(job?.absolute_url);
  if (/^https:\/\/job-boards\.greenhouse\.io\/flexentialcorp\/jobs\/\d+/i.test(direct)) return direct;
  const id = clean(job?.id);
  return id ? `${BOARD_ROOT}/jobs/${encodeURIComponent(id)}` : '';
}

function dedupe(jobs) {
  const urls = new Set();
  const identities = new Set();
  const out = [];
  for (const job of jobs) {
    const url = clean(job?.sourceUrl);
    const identity = [normalize(job?.company), normalize(job?.title), normalize(job?.location)].join('|');
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
    ['zero-to-four stays open to beginners', 'Data Center Technician I', 'Required Qualifications: 0-4 years of experience working within an IT or Data Center Support environment. Preferred Qualifications: 1 year of experience.', 'no-experience'],
    ['two-to-five uses minimum requirement', 'Data Center Technician II', 'Required Qualifications: 2-5 years of relevant experience.', '0-2-years'],
    ['multiple required clauses use strictest minimum', 'Critical Infrastructure Engineer II', 'Required Qualifications: 2 years of data center experience. 4+ years of critical infrastructure experience. Preferred Qualifications: 5+ years of experience.', '2-5-years'],
    ['over-five rejected', 'Critical Infrastructure Engineer II', 'Required Qualifications: Minimum 6 years of critical infrastructure experience.', null],
    ['talent community rejected', 'Data Center Technician - Flexential Talent Community', 'Required Qualifications: 0-4 years of experience.', null],
    ['senior rejected', 'Senior Data Center Technician', 'Required Qualifications: 2 years of experience.', null],
    ['unknown rejected', 'Data Center Technician I', 'Support customers and operate data center infrastructure.', null]
  ];
  const failures = [];
  for (const [name, title, description, expected] of cases) {
    const actual = classify(title, description).classification?.experience ?? null;
    if (actual !== expected) failures.push(`${name}: expected ${expected}, got ${actual}`);
  }
  if (failures.length) {
    for (const failure of failures) console.error(`Flexential classifier regression: ${failure}`);
    process.exit(1);
  }
  console.log(`Flexential classifier passed ${cases.length} regression cases.`);
  process.exit(0);
}

const previousJobs = await readJson(JOBS_PATH, []);
const priorStatus = await readJson(STATUS_PATH, {});

const response = await fetch(API_URL, {
  headers:{ accept:'application/json', 'user-agent':'DataCenterCareersBot/1.0 (+https://datacentercareers.us/)' },
  signal:AbortSignal.timeout(30000)
});
if (!response.ok) throw new Error(`Flexential Greenhouse source returned HTTP ${response.status}`);
const payload = await response.json();
if (!payload || !Array.isArray(payload.jobs) || payload.jobs.length === 0) {
  throw new Error('Flexential Greenhouse source returned no public jobs; preserving prior snapshot.');
}

const diagnostics = {
  listedJobs:payload.jobs.length,
  missionCandidates:0,
  qualifyingRoles:0,
  rejectedOutOfScopeTitle:0,
  rejectedExcludedTitle:0,
  rejectedOver5Years:0,
  rejectedUnknownExperience:0,
  rejectedInvalidUrl:0
};
const collected = [];

for (const job of payload.jobs) {
  const title = clean(job?.title);
  const description = clean(job?.content || '');
  if (missionTitlePattern.test(title) && !excludedTitlePattern.test(title)) diagnostics.missionCandidates += 1;
  const { classification, reason } = classify(title, description);
  if (!classification) {
    if (reason === 'out-of-scope-title') diagnostics.rejectedOutOfScopeTitle += 1;
    else if (reason === 'excluded-title') diagnostics.rejectedExcludedTitle += 1;
    else if (reason === 'over-5-years') diagnostics.rejectedOver5Years += 1;
    else if (reason === 'unknown-experience') diagnostics.rejectedUnknownExperience += 1;
    continue;
  }

  const sourceUrl = sourceUrlFor(job);
  if (!sourceUrl) { diagnostics.rejectedInvalidUrl += 1; continue; }
  const location = locationFor(job);
  const id = clean(job?.id) || hash(`${title}|${location}`);
  collected.push({
    id:`greenhouse-flexential-${id}`,
    title,
    company:COMPANY,
    location,
    type:classification.type,
    experience:classification.experience,
    tags:tagsFor(title, description, classification.experience, classification.type),
    ...payFor(description),
    postedAt:null,
    postedHours:9999,
    source:'Employer career site',
    sourceUrl,
    active:true,
    demo:false
  });
}

const flexentialJobs = dedupe(collected);
diagnostics.qualifyingRoles = flexentialJobs.length;
if (diagnostics.missionCandidates > 0 && flexentialJobs.length === 0) {
  throw new Error(`Flexential Greenhouse listed ${diagnostics.missionCandidates} mission-fit candidate role(s) but none passed 0–5 year classification; preserving prior snapshot.`);
}

const merged = dedupe([
  ...previousJobs.filter(job => clean(job?.company) !== COMPANY),
  ...flexentialJobs
]);
const now = Date.now();
for (const job of merged) {
  job.postedHours = job.postedAt ? Math.max(0, Math.round((now - new Date(job.postedAt).getTime()) / 36e5)) : (job.postedHours ?? 9999);
}

const status = {
  ...priorStatus,
  updatedAt:new Date().toISOString(),
  jobs:merged.length,
  flexential:{
    checkedAt:new Date().toISOString(),
    sourceHealthy:true,
    listingComplete:true,
    officialCareerPage:'https://www.flexential.com/careers',
    officialGreenhouseBoard:BOARD_ROOT,
    api:API_URL,
    authoritativeSnapshot:true,
    ...diagnostics
  }
};

await writeFile(SNAPSHOT_PATH, JSON.stringify(flexentialJobs, null, 2) + '\n');
await writeFile(JOBS_PATH, JSON.stringify(merged, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

console.log(`Flexential: ${flexentialJobs.length} qualifying U.S. data center role(s) from ${payload.jobs.length} public Greenhouse jobs; feed now ${merged.length} jobs.`);
