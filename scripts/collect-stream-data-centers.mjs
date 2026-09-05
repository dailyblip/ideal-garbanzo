import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const COMPANY = 'Stream Data Centers';
const API_URL = 'https://www.workable.com/api/accounts/stream-dc?details=true';
const BOARD_ROOT = 'https://apply.workable.com/stream-dc/';
const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/stream-data-centers-jobs.json';
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

const missionTitlePattern = /\b(?:critical engineering technician|critical operations technician|critical facilities technician|data cent(?:er|re) technician|data cent(?:er|re) operations technician|facilities technician|facility technician)\b/i;
const excludedTitlePattern = /\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|superintendent|foreman)\b/i;

function requiredExperienceText(description = '') {
  const text = clean(description);
  const preferred = text.search(/\b(?:preferred qualifications?|preferred experience|preferred skills?|nice to have|bonus qualifications?)\b/i);
  return preferred >= 0 ? text.slice(0, preferred) : text;
}

function statedExperienceYears(text = '') {
  const normalized = lower(text)
    .replace(/\bzero\b/g, '0').replace(/\bone\b/g, '1').replace(/\btwo\b/g, '2')
    .replace(/\bthree\b/g, '3').replace(/\bfour\b/g, '4').replace(/\bfive\b/g, '5')
    .replace(/\bsix\b/g, '6').replace(/\bseven\b/g, '7').replace(/\beight\b/g, '8')
    .replace(/\bnine\b/g, '9').replace(/\bten\b/g, '10');
  const values = [];
  const patterns = [
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+years?['’]?(?:\s+(?:of|prior))?\s+(?:direct\s+|relevant\s+|related\s+|professional\s+|work\s+)?experience/gi,
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?['’]?(?:\s+(?:of|prior))?\s+(?:direct\s+|relevant\s+|related\s+|professional\s+|work\s+)?experience/gi,
    /experience(?:\s+(?:of|in))?\s+(?:at least\s+|minimum(?: of)?\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?/gi,
    /(\d{1,2})\s*(?:\+|or more)?\s+years?['’]?\s+experience\b/gi
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

  let type = 'entry-level';
  const titleLower = lower(t);
  if (titleLower.includes('intern')) type = 'internship';
  else if (titleLower.includes('apprentice')) type = 'apprenticeship';
  else if (titleLower.includes('trainee')) type = 'trainee';

  const required = requiredExperienceText(description);
  const years = statedExperienceYears(required);
  if (years.some(year => year > 5)) return { classification: null, reason: 'over-5-years' };

  const explicitNoExperience = /(?:no|zero) (?:prior )?experience(?: is)? (?:required|needed)|experience (?:is )?not required/i.test(required);
  const programRole = type !== 'entry-level';
  if (!years.length && !explicitNoExperience && !programRole) {
    return { classification: null, reason: 'unknown-experience' };
  }

  let experience = '0-2-years';
  if (explicitNoExperience) experience = 'no-experience';
  else if (years.some(year => year >= 3)) experience = '2-5-years';

  return { classification: { type, experience }, reason: null };
}

function locationFor(job) {
  const location = job?.location && typeof job.location === 'object' ? job.location : {};
  const countryCode = clean(job?.country_code || location.country_code || location.countryCode).toUpperCase();
  const country = lower(job?.country || location.country || location.country_name);
  const isUs = countryCode === 'US' || country === 'united states' || country === 'united states of america' || country === 'usa';
  if (!isUs) return null;
  const city = clean(job?.city || location.city);
  const state = clean(job?.state || location.region_code || location.region || location.state_code || location.state);
  const text = [city, state].filter(Boolean).join(', ');
  return text || 'United States';
}

function payFor(job, description = '') {
  const salary = job?.salary && typeof job.salary === 'object' ? job.salary : {};
  const from = Number(job?.salary_from ?? salary.salary_from ?? salary.from);
  const to = Number(job?.salary_to ?? salary.salary_to ?? salary.to);
  if (Number.isFinite(from) && Number.isFinite(to) && from > 0 && to >= from) {
    const hourly = to < 1000;
    return {
      pay: `$${from.toLocaleString('en-US', { maximumFractionDigits: 2 })}–$${to.toLocaleString('en-US', { maximumFractionDigits: 2 })} / ${hourly ? 'hr' : 'year'}`,
      salaryMin: from,
      salaryMax: to,
      salarySortMax: hourly ? Math.round(to * 2080) : to
    };
  }

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

function tagsFor(title, description, experience, type) {
  const text = lower(`${title} ${description}`);
  const tags = [];
  if (type === 'internship') tags.push('Internship');
  if (type === 'apprenticeship') tags.push('Apprenticeship');
  if (type === 'trainee') tags.push('Trainee');
  if (experience === 'no-experience') tags.push('No Experience Needed');
  else if (experience === '0-2-years') tags.push('0–2 Years');
  else tags.push('2–5 Years');
  if (/training|development|certification/.test(text)) tags.push('Training / Mentorship');
  if (/electrical|switchgear|ups|generator/.test(text)) tags.push('Electrical');
  if (/mechanical|hvac|chiller|crah|crac|cooling/.test(text)) tags.push('Critical Facilities');
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
    const urlKey = clean(job.sourceUrl);
    const identity = [job.company, job.title, job.location].map(normalizeIdentity).join('|');
    if ((urlKey && urls.has(urlKey)) || identities.has(identity)) continue;
    if (urlKey) urls.add(urlKey);
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
    ['two-year technician', 'Critical Engineering Technician', 'Basic qualifications: 2+ years experience in operations and maintenance. Preferred qualifications: 5+ years experience in a data center.', '0-2-years'],
    ['three-year technician', 'Critical Engineering Technician, Night Shift', 'Minimum qualifications: 3+ years of experience in critical environment operations and maintenance.', '2-5-years'],
    ['over-five rejected', 'Critical Engineering Technician', 'Minimum of 7 years of experience in critical facilities operations.', null],
    ['unknown rejected', 'Critical Engineering Technician', 'Maintain UPS, switchgear, generators and cooling systems in a mission-critical facility.', null],
    ['senior rejected', 'Senior Critical Engineering Technician', '2+ years experience in data center operations.', null],
    ['program role', 'Data Center Operations Technician Trainee', 'Training program supporting data center operations.', '0-2-years']
  ];
  const failures = [];
  for (const [name, title, description, expected] of cases) {
    const result = classify(title, description).classification?.experience ?? null;
    if (result !== expected) failures.push(`${name}: expected ${expected}, got ${result}`);
  }
  if (failures.length) {
    for (const failure of failures) console.error(`Stream classifier regression: ${failure}`);
    process.exit(1);
  }
  console.log(`Stream classifier passed ${cases.length} regression cases.`);
  process.exit(0);
}

const previousJobs = await readJson(JOBS_PATH, []);
const priorStatus = await readJson(STATUS_PATH, {});

const response = await fetch(API_URL, {
  headers: {
    accept: 'application/json',
    'user-agent': 'DataCenterCareersBot/1.1 (+https://datacentercareers.us/)'
  }
});
if (!response.ok) throw new Error(`Stream Workable source returned HTTP ${response.status}`);
const payload = await response.json();
if (!payload || !Array.isArray(payload.jobs) || payload.jobs.length === 0) {
  throw new Error('Stream Workable source returned no public jobs; preserving prior snapshot.');
}
const accountName = clean(payload.name || payload.account?.name || '');
if (accountName && !/stream/i.test(accountName)) {
  throw new Error(`Unexpected Workable account identity: ${accountName}`);
}

const diagnostics = {
  listedJobs: payload.jobs.length,
  usJobs: 0,
  candidateRoles: 0,
  qualifyingRoles: 0,
  rejectedOutOfScopeTitle: 0,
  rejectedSeniorTitle: 0,
  rejectedOver5Years: 0,
  rejectedUnknownExperience: 0
};
const collected = [];

for (const job of payload.jobs) {
  const location = locationFor(job);
  if (!location) continue;
  diagnostics.usJobs += 1;

  const title = clean(job.title);
  const description = clean(job.description || job.full_description || '');
  if (missionTitlePattern.test(title)) diagnostics.candidateRoles += 1;
  const { classification, reason } = classify(title, description);
  if (!classification) {
    if (reason === 'out-of-scope-title') diagnostics.rejectedOutOfScopeTitle += 1;
    else if (reason === 'senior-title') diagnostics.rejectedSeniorTitle += 1;
    else if (reason === 'over-5-years') diagnostics.rejectedOver5Years += 1;
    else if (reason === 'unknown-experience') diagnostics.rejectedUnknownExperience += 1;
    continue;
  }

  const shortcode = clean(job.shortcode || job.code || hash(`${title}|${location}`));
  const sourceUrl = `${BOARD_ROOT}j/${encodeURIComponent(shortcode)}/`;
  const postedAt = isoDate(job.published_on || job.publishedAt || job.created_at || job.createdAt);
  collected.push({
    id: `workable-stream-dc-${shortcode}`,
    title,
    company: COMPANY,
    location,
    type: classification.type,
    experience: classification.experience,
    tags: tagsFor(title, description, classification.experience, classification.type),
    ...payFor(job, description),
    postedAt,
    source: 'Employer career site',
    sourceUrl,
    active: true,
    demo: false
  });
}

const streamJobs = dedupe(collected);
diagnostics.qualifyingRoles = streamJobs.length;
if (diagnostics.candidateRoles > 0 && streamJobs.length === 0) {
  throw new Error(`Stream Workable listed ${diagnostics.candidateRoles} mission-title candidate role(s) but none passed 0–5 year classification; preserving prior snapshot.`);
}

const merged = dedupe([
  ...previousJobs.filter(job => clean(job?.company) !== COMPANY),
  ...streamJobs
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
  streamDataCenters: {
    checkedAt: new Date().toISOString(),
    sourceHealthy: true,
    listingComplete: true,
    officialCareerPage: 'https://www.streamdatacenters.com/company/careers/',
    officialWorkableBoard: BOARD_ROOT,
    api: API_URL,
    authoritativeSnapshot: true,
    ...diagnostics
  }
};

await writeFile(SNAPSHOT_PATH, JSON.stringify(streamJobs, null, 2) + '\n');
await writeFile(JOBS_PATH, JSON.stringify(merged, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

console.log(`Stream Data Centers: ${streamJobs.length} qualifying U.S. role(s) from ${payload.jobs.length} public Workable jobs; feed now ${merged.length} jobs.`);
