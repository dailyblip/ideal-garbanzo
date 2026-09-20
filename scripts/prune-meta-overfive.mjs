import { readFile, writeFile } from 'node:fs/promises';
import './meta-fetch-policy.mjs';

const SNAPSHOT_PATH = 'data/meta-jobs.json';
const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const FETCH_INTERVAL_MS = Number(process.env.META_EXPERIENCE_INTERVAL_MS || 700);

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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const experienceNumberWords = new Map([
  ['zero', '0'], ['one', '1'], ['two', '2'], ['three', '3'], ['four', '4'], ['five', '5'],
  ['six', '6'], ['seven', '7'], ['eight', '8'], ['nine', '9'], ['ten', '10']
]);

const experienceYearsPattern = /\b(\d{1,2})(?:\s*\(\d{1,2}\))?\s*\+?\s*years?\s+(?:of\s+)?(?:[A-Za-z0-9/&+(),.'’\-]+\s+){0,10}experience\b/gi;
const educationAlternativePattern = /\b(?:in lieu of|will be considered in lieu|or (?:an? )?(?:associate|bachelor|master)|(?:associate|bachelor|master)(?:'s)? degree[^.]{0,120}(?:plus|\+))\b/i;

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

function normalizeExperienceNumbers(text = '') {
  return lower(text).replace(/\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/g, word => experienceNumberWords.get(word) || word);
}

function extractExperienceYears(text = '') {
  experienceYearsPattern.lastIndex = 0;
  return [...normalizeExperienceNumbers(text).matchAll(experienceYearsPattern)]
    .map(match => Number(match[1]))
    .filter(years => Number.isFinite(years) && years >= 0);
}

function exceedsFiveYearCeiling(text = '') {
  const normalized = normalizeExperienceNumbers(text);
  const strictMinimumPatterns = [
    /\b(?:more than|over|greater than|in excess of)\s+(\d{1,2})(?:\s*\(\d{1,2}\))?\s+years?\b/g,
    />\s*(\d{1,2})(?:\s*\(\d{1,2}\))?\s+years?\b/g
  ];
  for (const pattern of strictMinimumPatterns) {
    for (const match of normalized.matchAll(pattern)) {
      if (Number(match[1]) >= 5) return true;
    }
  }
  return false;
}

function minimumQualifications(detailText = '') {
  const text = clean(detailText);
  const normalized = lower(text);
  const start = normalized.indexOf('minimum qualifications');
  if (start < 0) return '';

  const after = text.slice(start);
  const afterLower = lower(after);
  const markers = [
    'preferred qualifications',
    'about meta',
    'equal employment opportunity',
    'individual compensation',
    'locations',
    'related jobs'
  ];
  const ends = markers
    .map(marker => afterLower.indexOf(marker, 25))
    .filter(index => index > 25);
  const end = ends.length ? Math.min(...ends) : Math.min(after.length, 7000);
  return after.slice(0, end);
}

function evaluateMinimum(minimumText = '') {
  const text = clean(minimumText);
  if (!text) return { reject: false, reason: 'unscoped', years: [] };

  const years = extractExperienceYears(text);
  if (exceedsFiveYearCeiling(text)) {
    return { reject: true, reason: 'strictly-over-five', years };
  }

  const maxYears = years.length ? Math.max(...years) : null;
  if (Number.isFinite(maxYears) && maxYears > 5 && !educationAlternativePattern.test(text)) {
    return { reject: true, reason: 'minimum-over-five', years };
  }

  return { reject: false, reason: 'eligible-or-unproven', years };
}

function runTests() {
  const cases = [
    ['exact five', 'Minimum Qualifications 5 years of experience in data center operations.', false],
    ['five plus remains eligible by policy', 'Minimum Qualifications 5+ years of experience in critical facilities.', false],
    ['more than five', 'Minimum Qualifications More than five years of experience in data center operations.', true],
    ['over five', 'Minimum Qualifications Over 5 years of experience in critical facilities.', true],
    ['greater than five', 'Minimum Qualifications Greater than five years of experience in facility operations.', true],
    ['in excess of five', 'Minimum Qualifications In excess of 5 years of experience in a critical environment.', true],
    ['symbol greater than five', 'Minimum Qualifications > 5 years of experience in data center operations.', true],
    ['spelled six', 'Minimum Qualifications Six years of experience in data center operations.', true],
    ['parenthetical six', 'Minimum Qualifications six (6) years of experience in critical facilities.', true],
    ['preferred seniority ignored', 'Minimum Qualifications 3 years of experience in data center operations. Preferred Qualifications 8 years of experience.', false],
    ['education alternative preserved', "Minimum Qualifications 7 years of experience or a bachelor's degree will be considered in lieu of experience.", false]
  ];

  for (const [name, text, expectedReject] of cases) {
    const required = minimumQualifications(text);
    const result = evaluateMinimum(required);
    if (result.reject !== expectedReject) {
      throw new Error(`Meta experience ceiling regression failed: ${name}; expected reject=${expectedReject}, got reject=${result.reject}.`);
    }
  }

  console.log('Meta experience ceiling regression tests passed.');
}

function canonicalMetaUrl(value = '') {
  try {
    const parsed = new URL(clean(value));
    if (!/(^|\.)metacareers\.com$/i.test(parsed.hostname)) return '';
    return parsed.href;
  } catch {
    return '';
  }
}

async function fetchDetail(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': 'facebookexternalhit/1.1 (+https://datacentercareers.us/)'
    },
    redirect: 'follow'
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

runTests();
if (process.argv.includes('--test')) process.exit(0);

const snapshot = await readJson(SNAPSHOT_PATH, []);
const jobs = await readJson(JOBS_PATH, []);
const status = await readJson(STATUS_PATH, {});

const prunedIds = new Set();
const diagnostics = {
  checked: 0,
  scoped: 0,
  pruned: 0,
  fetchFailures: 0,
  prunedJobs: []
};

for (const job of snapshot) {
  const url = canonicalMetaUrl(job.sourceUrl);
  if (!url) continue;

  diagnostics.checked += 1;
  try {
    const html = await fetchDetail(url);
    const required = minimumQualifications(html);
    if (!required) continue;
    diagnostics.scoped += 1;

    const result = evaluateMinimum(required);
    if (result.reject) {
      const id = String(job.id || '');
      if (id) prunedIds.add(id);
      diagnostics.pruned += 1;
      diagnostics.prunedJobs.push({
        id,
        title: job.title,
        location: job.location,
        reason: result.reason,
        years: result.years,
        sourceUrl: url
      });
    }
  } catch (error) {
    diagnostics.fetchFailures += 1;
    console.warn(`Meta experience check preserved ${job.id || job.sourceUrl}: ${error.message}`);
  }

  if (FETCH_INTERVAL_MS > 0) await sleep(FETCH_INTERVAL_MS);
}

if (!prunedIds.size) {
  console.log(`Meta experience ceiling checked ${diagnostics.checked} roles (${diagnostics.scoped} with scoped minimum qualifications); no >5-year roles removed; ${diagnostics.fetchFailures} fetch failures.`);
  process.exit(0);
}

const filteredSnapshot = snapshot.filter(job => !prunedIds.has(String(job.id || '')));
const filteredJobs = jobs.filter(job => !prunedIds.has(String(job.id || '')));

await writeFile(SNAPSHOT_PATH, JSON.stringify(filteredSnapshot, null, 2) + '\n');
await writeFile(JOBS_PATH, JSON.stringify(filteredJobs, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify({
  ...status,
  metaExperienceCeiling: {
    checkedAt: new Date().toISOString(),
    ...diagnostics
  }
}, null, 2) + '\n');

console.log(`Meta experience ceiling removed ${prunedIds.size} role(s) requiring more than five years; ${filteredSnapshot.length} Meta roles remain; ${filteredJobs.length} total jobs remain.`);