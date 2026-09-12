import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const SNAPSHOT_PATH = 'data/coreweave-jobs.json';
const COMPANY = 'CoreWeave';
const CAREERS_URL = 'https://www.coreweave.com/careers';
const BOARD_TOKENS = ['coreweave', 'coreweaveinc', 'coreweavecareers'];

const clean = value => String(value ?? '')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&quot;/gi, '"')
  .replace(/\s+/g, ' ')
  .trim();
const lower = value => clean(value).toLowerCase();

const missionTitle = /\b(?:data center technician|critical facilit(?:y|ies) technician|critical operations technician|data center operator|data center operations technician|command center systems engineer|facilities technician|electrical technician)\b/i;
const excludedTitle = /\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|head|supervisor|security|sales|accounting|finance|marketing|procurement)\b/i;
const infrastructureContext = /\b(?:data center|server|rack|hardware|network|fiber|cabling|electrical|mechanical|power|ups|generator|hvac|critical infrastructure|critical facilit)\b/i;
const explicitNoExperience = /\b(?:no\s+(?:prior|previous)?\s*experience\s+(?:is\s+)?(?:required|necessary|needed)|(?:prior|previous)?\s*experience\s+(?:is\s+)?not\s+required|0\s*(?:-|–|to)\s*\d{1,2}\s+years?(?:\s+of)?\s+(?:relevant\s+|related\s+|professional\s+|hands-on\s+)?experience)\b/i;
const earlyCareerSignal = /\b(?:entry[- ]level|junior|high school diploma|ged|associate(?:'s)? degree|equivalent experience|0\s*[-–]\s*2 years?)\b/i;

function requiredExperienceYears(text = '') {
  const values = [];
  const patterns = [
    /(?:minimum(?: of)?|at least|required|requires?|must have|minimum experience)\s*:?\s*(\d{1,2})\+?\s*(?:-|–|to)\s*(\d{1,2})\s+years?/gi,
    /(?:minimum(?: of)?|at least|required|requires?|must have|minimum experience)\s*:?\s*(\d{1,2})\+?\s+years?/gi,
    /(\d{1,2})\+?\s+years?\s+(?:of\s+)?(?:relevant|related|professional|hands-on|experience)/gi
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      values.push(Number(match[1]));
      if (match[2]) values.push(Number(match[2]));
    }
  }
  return values.filter(Number.isFinite);
}

function classify(title, text) {
  if (!missionTitle.test(title) || excludedTitle.test(title)) return null;
  const normalized = lower(text);
  if (!infrastructureContext.test(normalized)) return null;
  const years = requiredExperienceYears(normalized);
  if (years.some(year => year >= 6)) return null;
  if (years.some(year => year >= 3)) return { type: 'entry-level', experience: '2-5-years' };
  if (years.some(year => year >= 1)) return { type: 'entry-level', experience: '0-2-years' };
  if (explicitNoExperience.test(normalized)) return { type: 'entry-level', experience: 'no-experience' };
  if (earlyCareerSignal.test(normalized)) return { type: 'entry-level', experience: '0-2-years' };
  return null;
}

function runClassifierSelfTest() {
  const cases = [
    {
      name: 'entry-level wording does not erase a two-year requirement',
      title: 'Data Center Technician',
      text: 'Entry-level data center role. Minimum of 2 years of relevant experience required.',
      expected: '0-2-years'
    },
    {
      name: 'education and training signals do not claim zero experience',
      title: 'Data Center Technician',
      text: 'High school diploma or GED. Training and mentorship provided for data center operations.',
      expected: '0-2-years'
    },
    {
      name: 'explicit no-experience evidence is preserved',
      title: 'Data Center Technician',
      text: 'No prior experience required. Training is provided for data center operations and critical facilities work.',
      expected: 'no-experience'
    },
    {
      name: 'four-year requirement stays in appropriate mid-level bucket',
      title: 'Critical Facilities Technician',
      text: 'Minimum of 4 years of relevant critical facilities experience required.',
      expected: '2-5-years'
    },
    {
      name: 'six-year requirement is rejected',
      title: 'Critical Facilities Technician',
      text: 'Minimum of 6 years of relevant critical facilities experience required.',
      expected: null
    }
  ];

  for (const testCase of cases) {
    const result = classify(testCase.title, testCase.text);
    const actual = result?.experience ?? null;
    if (actual !== testCase.expected) {
      throw new Error(`${testCase.name}: expected ${testCase.expected}, got ${actual}`);
    }
  }
  console.log('CoreWeave experience-classifier regression tests passed.');
}

if (process.argv.includes('--test-experience-parser')) {
  runClassifierSelfTest();
  process.exit(0);
}

function tagsFor(title, text, experience) {
  const value = lower(`${title} ${text}`);
  const tags = [experience === 'no-experience' ? 'No Experience Needed' : experience === '2-5-years' ? '2–5 Years' : '0–2 Years'];
  if (/\b(?:electrical|mechanical|power|ups|generator|hvac|critical facilit|critical infrastructure)\b/.test(value)) tags.push('Critical Facilities');
  if (/\b(?:rack|server|hardware|network|fiber|cabling)\b/.test(value)) tags.push('Data Center Operations');
  if (/\b(?:training|mentor|learn|development)\b/.test(value)) tags.push('Training / Mentorship');
  return [...new Set(tags)].slice(0, 5);
}

function normalizeLocation(value = '') {
  return clean(value)
    .replace(/\s*-\s*DC\b/gi, '')
    .replace(/\bUnited States\s*-\s*Data Centers\b/i, 'United States')
    .replace(/\s+/g, ' ')
    .trim();
}

function postedHours(value) {
  const time = Date.parse(String(value || ''));
  if (!Number.isFinite(time)) return 9999;
  return Math.max(0, Math.round((Date.now() - time) / 3600000));
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'DataCenterCareersBot/1.6 (+https://datacentercareers.us/)'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000)
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

let jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
if (!Array.isArray(jobs)) throw new Error('jobs.json must contain an array');
let status = {};
try { status = JSON.parse(await readFile(STATUS_PATH, 'utf8')); } catch {}
let previousSnapshot = [];
try {
  previousSnapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
  if (!Array.isArray(previousSnapshot)) previousSnapshot = [];
} catch {}

let selectedBoard = null;
let boardJobs = [];
const errors = [];
for (const token of BOARD_TOKENS) {
  try {
    const payload = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`);
    const candidates = Array.isArray(payload?.jobs) ? payload.jobs : [];
    const confirmsCoreWeave = candidates.some(job => /\bdata center technician\b/i.test(String(job?.title || '')));
    if (candidates.length && confirmsCoreWeave) {
      selectedBoard = token;
      boardJobs = candidates;
      break;
    }
  } catch (error) {
    errors.push(`${token}: ${error.message}`);
  }
}

const drops = { title: 0, experience: 0, location: 0 };
const qualifying = [];
for (const sourceJob of boardJobs) {
  const title = clean(sourceJob?.title);
  if (!missionTitle.test(title) || excludedTitle.test(title)) {
    drops.title += 1;
    continue;
  }
  const content = clean(sourceJob?.content || '');
  const cls = classify(title, content);
  if (!cls) {
    drops.experience += 1;
    continue;
  }
  const location = normalizeLocation(sourceJob?.location?.name || sourceJob?.offices?.[0]?.location || sourceJob?.offices?.[0]?.name || '');
  if (!location || (!/\bUnited States\b/i.test(location) && !/,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/.test(location))) {
    drops.location += 1;
    continue;
  }
  const id = String(sourceJob?.id || '').trim();
  if (!id) continue;
  const sourceUrl = `${CAREERS_URL}?gh_jid=${encodeURIComponent(id)}`;
  qualifying.push({
    id: `coreweave-${id}`,
    title,
    company: COMPANY,
    location,
    type: cls.type,
    experience: cls.experience,
    tags: tagsFor(title, content, cls.experience),
    pay: 'Pay not listed',
    salaryMin: null,
    salaryMax: null,
    salarySortMax: null,
    postedAt: sourceJob?.first_published || sourceJob?.updated_at || null,
    postedHours: postedHours(sourceJob?.first_published || sourceJob?.updated_at),
    source: 'Official CoreWeave careers',
    sourceUrl,
    active: true,
    demo: false
  });
}

const sourceHealthy = Boolean(selectedBoard && boardJobs.length > 0);
const selected = sourceHealthy ? qualifying : previousSnapshot;
if (sourceHealthy) await writeFile(SNAPSHOT_PATH, JSON.stringify(qualifying, null, 2) + '\n');

jobs = jobs.filter(job => String(job?.company || '').trim() !== COMPANY);
const existingUrls = new Set(jobs.map(job => String(job?.sourceUrl || '')).filter(Boolean));
for (const job of selected) {
  if (existingUrls.has(job.sourceUrl)) continue;
  jobs.push(job);
  existingUrls.add(job.sourceUrl);
}

status.coreWeaveCareers = {
  careersUrl: CAREERS_URL,
  sourceHealthy,
  boardToken: selectedBoard,
  sourceRoles: boardJobs.length,
  qualifyingRoles: qualifying.length,
  preservedPrevious: sourceHealthy ? 0 : previousSnapshot.length,
  drops,
  errors: errors.slice(0, 8)
};
status.jobs = jobs.length;

await writeFile(JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

console.log(`CoreWeave careers: ${selectedBoard || 'no board'}; ${boardJobs.length} source roles; ${qualifying.length} qualifying 0–5 year data-center roles.`);
if (!sourceHealthy && previousSnapshot.length) console.warn(`CoreWeave source incomplete; preserved ${previousSnapshot.length} previously verified role(s).`);
if (errors.length) console.warn(`CoreWeave source warnings: ${errors.slice(0, 4).join(' | ')}`);
