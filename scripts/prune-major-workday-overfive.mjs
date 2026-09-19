import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const MAJOR_PATH = 'data/major-jobs.json';
const STATUS_PATH = 'data/collector-status.json';

const clean = value => String(value ?? '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&#39;/gi, "'")
  .replace(/&quot;/gi, '"')
  .replace(/\s+/g, ' ')
  .trim();

const numberWords = new Map([
  ['zero', '0'], ['one', '1'], ['two', '2'], ['three', '3'], ['four', '4'], ['five', '5'],
  ['six', '6'], ['seven', '7'], ['eight', '8'], ['nine', '9'], ['ten', '10']
]);

function requiredExperienceText(description = '') {
  const text = clean(description);
  const preferred = text.search(/\b(?:preferred qualifications?|preferred experience|preferred skills?|nice to have|bonus qualifications?)\b/i);
  return preferred >= 0 ? text.slice(0, preferred) : text;
}

function normalizeExperienceNumbers(text = '') {
  return clean(text).toLowerCase().replace(
    /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/g,
    word => numberWords.get(word) || word
  );
}

function statedExperienceYears(text = '') {
  const normalized = normalizeExperienceNumbers(text);
  const values = [];
  const patterns = [
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+years?['’]?(?:\s+(?:of|prior))?\s+(?:direct\s+|relevant\s+|related\s+|professional\s+)?experience/gi,
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?['’]?(?:\s+(?:of|prior))?\s+(?:direct\s+|relevant\s+|related\s+|professional\s+)?experience/gi,
    /experience(?:\s+(?:of|in))?\s+(?:at least\s+|minimum(?: of)?\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?/gi,
    /(?:minimum(?: of)?\s+|at least\s+)(\d{1,2})\s*(?:\+|or more)?\s+years?\b/gi
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      values.push(Number(match[1]));
      if (match[2]) values.push(Number(match[2]));
    }
  }
  return values.filter(value => Number.isFinite(value) && value >= 0 && value <= 50);
}

export function exceedsFiveYearCeiling(description = '') {
  const required = normalizeExperienceNumbers(requiredExperienceText(description));
  if (statedExperienceYears(required).some(year => year > 5)) return true;

  const strictOverFive = [
    /\b(?:more than|over|greater than|in excess of)\s+5\s+years?\b/i,
    /\bexperience(?:\s+(?:of|in))?\s+(?:more than|over|greater than|in excess of)\s+5\s+years?\b/i,
    /(?:^|\s)>\s*5\s+years?\b/i
  ];
  return strictOverFive.some(pattern => pattern.test(required));
}

function workdayDetailUrl(sourceUrl = '') {
  const url = new URL(sourceUrl);
  if (!/\.myworkdayjobs\.com$/i.test(url.hostname)) throw new Error('not an official Workday host');
  const tenant = url.hostname.split('.')[0];
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 4) throw new Error('unexpected Workday job path');
  const locale = parts[0];
  const site = parts[1];
  const externalPath = `/${parts.slice(2).join('/')}`;
  return {
    detailUrl: `${url.origin}/wday/cxs/${tenant}/${site}${externalPath}`,
    referer: `${url.origin}/${locale}/${site}${externalPath}`
  };
}

async function fetchDetail(sourceUrl) {
  const { detailUrl, referer } = workdayDetailUrl(sourceUrl);
  const response = await fetch(detailUrl, {
    headers: {
      accept: 'application/json',
      referer,
      'user-agent': 'DataCenterCareersBot/1.5 (+https://datacentercareers.us/)'
    }
  });
  if (!response.ok) throw new Error(`${response.status} ${detailUrl}`);
  const detail = await response.json();
  const info = detail.jobPostingInfo || detail.jobInfo || detail;
  return clean(info.jobDescription || info.description || '');
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

if (process.argv.includes('--test')) {
  const cases = [
    ['more than five years is above ceiling', 'More than five years of relevant experience in data center operations is required.', true],
    ['over five years is above ceiling', 'Over 5 years of direct experience maintaining critical facilities is required.', true],
    ['greater than five years is above ceiling', 'Greater than five years of professional experience is required.', true],
    ['in excess of five years is above ceiling', 'In excess of 5 years of experience with UPS systems is required.', true],
    ['symbolic greater-than five is above ceiling', '> 5 years of relevant experience in critical environments.', true],
    ['six-year minimum is above ceiling', 'Minimum of six years of relevant experience in data center operations.', true],
    ['three-to-six range is above ceiling', '3-6 years of relevant experience in data center operations.', true],
    ['exact five-year minimum remains eligible', 'Minimum of five years of relevant experience in data center operations.', false],
    ['five-plus remains eligible at the boundary', '5+ years of relevant experience in data center operations.', false],
    ['five-or-more remains eligible at the boundary', 'Five or more years of relevant experience in data center operations.', false],
    ['preferred seven years does not override required three years', 'Minimum of three years of relevant experience. Preferred Qualifications Seven years of experience.', false]
  ];
  const failures = cases.filter(([, text, expected]) => exceedsFiveYearCeiling(text) !== expected);
  if (failures.length) {
    for (const [name] of failures) console.error(`Major Workday experience ceiling regression failed: ${name}`);
    process.exit(1);
  }
  console.log(`Major Workday experience ceiling guard passed ${cases.length} regression cases.`);
  process.exit(0);
}

const major = await readJson(MAJOR_PATH, []);
const jobs = await readJson(JOBS_PATH, []);
const status = await readJson(STATUS_PATH, {});
if (!Array.isArray(major) || !Array.isArray(jobs)) throw new Error('Expected jobs and major-jobs snapshots to be arrays.');

const checkedAt = new Date().toISOString();
const removeUrls = new Set();
const removeIds = new Set();
const prunedRoles = [];
const errors = [];
let checked = 0;

for (const job of major) {
  if (!job?.sourceUrl || !/\.myworkdayjobs\.com\//i.test(job.sourceUrl)) continue;
  checked += 1;
  try {
    const description = await fetchDetail(job.sourceUrl);
    if (!description || !exceedsFiveYearCeiling(description)) continue;
    if (job.sourceUrl) removeUrls.add(job.sourceUrl);
    if (job.id) removeIds.add(job.id);
    prunedRoles.push({ id: job.id, company: job.company, title: job.title, location: job.location, sourceUrl: job.sourceUrl });
  } catch (error) {
    errors.push(`${job.company || 'Unknown employer'} — ${job.title || job.id || 'Unknown role'}: ${error.message}`);
  }
}

const shouldRemove = job => removeIds.has(job?.id) || removeUrls.has(job?.sourceUrl);
const nextMajor = major.filter(job => !shouldRemove(job));
const nextJobs = jobs.filter(job => !shouldRemove(job));

status.majorExperienceBoundary = {
  checkedAt,
  policy: 'required experience must not be strictly greater than five years',
  checked,
  pruned: prunedRoles.length,
  prunedRoles,
  detailErrors: errors.length,
  errors: errors.slice(0, 12)
};

if (prunedRoles.length) {
  await writeFile(MAJOR_PATH, JSON.stringify(nextMajor, null, 2) + '\n');
  await writeFile(JOBS_PATH, JSON.stringify(nextJobs, null, 2) + '\n');
}
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

if (prunedRoles.length) {
  console.log(`Pruned ${prunedRoles.length} major Workday role(s) whose verified required experience exceeds five years.`);
} else {
  console.log(`Verified ${checked} major Workday role(s) against the five-year ceiling; no over-ceiling roles found.`);
}
if (errors.length) console.warn(`Experience ceiling guard could not re-verify ${errors.length} role(s); existing records were preserved.`);
