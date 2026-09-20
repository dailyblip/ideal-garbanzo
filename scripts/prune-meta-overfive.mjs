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
const headingPattern = /\b(?:minimum\s+qualifications?|minimum\s+requirements?|required\s+qualifications?|basic\s+qualifications?)\b/i;

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

function decodeEscapes(value) {
  return String(value || '')
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\n|\\r|\\t/g, ' ')
    .replace(/\\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/minimumQualifications/gi, 'minimum qualifications')
    .replace(/minimum_qualifications/gi, 'minimum qualifications')
    .replace(/minimumRequirements/gi, 'minimum requirements')
    .replace(/minimum_requirements/gi, 'minimum requirements')
    .replace(/preferredQualifications/gi, 'preferred qualifications')
    .replace(/preferred_qualifications/gi, 'preferred qualifications')
    .replace(/requiredQualifications/gi, 'required qualifications')
    .replace(/required_qualifications/gi, 'required qualifications');
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

function minimumBlock(text = '') {
  const normalized = clean(decodeEscapes(text));
  const heading = headingPattern.exec(normalized);
  headingPattern.lastIndex = 0;
  if (!heading) return '';

  const after = normalized.slice(heading.index);
  const afterLower = after.toLowerCase();
  const markers = [
    'preferred qualifications',
    'preferred requirements',
    'responsibilities',
    'about meta',
    'equal employment opportunity',
    'individual compensation',
    'locations',
    'compensation details',
    'related jobs'
  ];
  const minimumOffset = Math.max(heading[0].length, 30);
  const ends = markers
    .map(marker => afterLower.indexOf(marker, minimumOffset))
    .filter(index => index > minimumOffset);
  const end = ends.length ? Math.min(...ends) : Math.min(after.length, 12000);
  return clean(after.slice(0, end));
}

function visibleText(html = '') {
  return clean(String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' '));
}

function collectStrings(node, out, seen = new Set(), depth = 0) {
  if (node == null || depth > 16) return;
  if (typeof node === 'string') {
    const value = clean(decodeEscapes(node));
    if (value) out.push(value);
    return;
  }
  if (typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);

  if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, out, seen, depth + 1);
    return;
  }

  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string' && /(?:qualif|require|responsib|description|experience)/i.test(key)) {
      const text = clean(decodeEscapes(value));
      if (text) {
        if (/minimum.*(?:qualif|require)|required.*qualif|basic.*qualif/i.test(key)) out.push(`minimum qualifications ${text}`);
        else if (/preferred.*(?:qualif|require)/i.test(key)) out.push(`preferred qualifications ${text}`);
        else out.push(text);
      }
    }
    collectStrings(value, out, seen, depth + 1);
  }
}

function structuredText(html = '') {
  const strings = [];
  for (const match of String(html).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = match[1] || '';
    if (!raw.trim()) continue;
    try {
      collectStrings(JSON.parse(raw), strings);
    } catch {
      const decoded = clean(decodeEscapes(raw));
      if (headingPattern.test(decoded) || /\b(?:\d{1,2}|zero|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:\([^)]*\))?\s*(?:\+|plus)?\s*(?:years?|yrs?)\b/i.test(decoded)) {
        strings.push(decoded.slice(0, 120000));
      }
      headingPattern.lastIndex = 0;
    }
  }

  const metaDescriptions = [...String(html).matchAll(/<meta\b[^>]*(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']*)["'][^>]*>/gi)]
    .map(match => clean(decodeEscapes(match[1])));
  return clean([...metaDescriptions, ...strings].join(' '));
}

function findJobPostingObjects(node, out = [], seen = new Set(), depth = 0) {
  if (!node || typeof node !== 'object' || seen.has(node) || depth > 16) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) findJobPostingObjects(item, out, seen, depth + 1);
    return out;
  }

  const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  if (types.some(type => /JobPosting/i.test(String(type || '')))) out.push(node);
  for (const value of Object.values(node)) findJobPostingObjects(value, out, seen, depth + 1);
  return out;
}

function jobPostingMinimum(html = '') {
  const postings = [];
  for (const match of String(html).matchAll(/<script\b[^>]*type=["']application\/ld\+json[^"']*["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = match[1] || '';
    if (!raw.trim()) continue;
    try {
      findJobPostingObjects(JSON.parse(raw), postings);
    } catch {}
  }

  for (const posting of postings) {
    const description = clean(decodeEscapes(posting.description || ''));
    const scoped = minimumBlock(description);
    if (scoped) return scoped;

    const direct = [];
    for (const key of ['experienceRequirements', 'qualifications']) {
      const value = posting[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          const text = clean(decodeEscapes(typeof item === 'string' ? item : item?.name || item?.description || ''));
          if (text) direct.push(text);
        }
      } else {
        const text = clean(decodeEscapes(typeof value === 'string' ? value : value?.name || value?.description || ''));
        if (text) direct.push(text);
      }
    }
    const directText = clean(direct.join(' '));
    if (directText) return directText;
  }
  return '';
}

function findMinimumQualifications(html = '') {
  const visibleMinimum = minimumBlock(visibleText(html));
  if (visibleMinimum) return { text: visibleMinimum, source: 'visible-html' };

  const jobPosting = jobPostingMinimum(html);
  if (jobPosting) return { text: jobPosting, source: 'jobposting-jsonld' };

  const structuredMinimum = minimumBlock(structuredText(html));
  if (structuredMinimum) return { text: structuredMinimum, source: 'structured-data' };

  return { text: '', source: '' };
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
    const required = minimumBlock(text);
    const result = evaluateMinimum(required);
    if (result.reject !== expectedReject) {
      throw new Error(`Meta experience ceiling regression failed: ${name}; expected reject=${expectedReject}, got reject=${result.reject}.`);
    }
  }

  const jsonLd = `<script type="application/ld+json">${JSON.stringify({
    '@type': 'JobPosting',
    description: 'Minimum Qualifications More than five years of experience in data center operations. Preferred Qualifications Ten years of experience.'
  })}</script>`;
  const jsonLdResult = evaluateMinimum(findMinimumQualifications(jsonLd).text);
  if (!jsonLdResult.reject) throw new Error('Meta experience ceiling must reject >5-year requirements recovered from JobPosting JSON-LD.');

  const structured = `<script type="application/json">${JSON.stringify({
    minimumQualifications: 'Six years of experience in critical facilities.',
    preferredQualifications: 'Ten years of experience.'
  })}</script>`;
  const structuredResult = evaluateMinimum(findMinimumQualifications(structured).text);
  if (!structuredResult.reject) throw new Error('Meta experience ceiling must reject spelled-out >5-year requirements recovered from structured data.');

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
  sources: {},
  prunedJobs: []
};

for (const job of snapshot) {
  const url = canonicalMetaUrl(job.sourceUrl);
  if (!url) continue;

  diagnostics.checked += 1;
  try {
    const html = await fetchDetail(url);
    const found = findMinimumQualifications(html);
    if (!found.text) continue;
    diagnostics.scoped += 1;
    diagnostics.sources[found.source] = (diagnostics.sources[found.source] || 0) + 1;

    const result = evaluateMinimum(found.text);
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
        requirementSource: found.source,
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
