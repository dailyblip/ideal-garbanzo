import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'Equinix';
const SOURCE = 'Equinix official localized detail recovery';
const ID_PREFIX = 'equinix-rendered-';
const CONCURRENCY = 5;
const FETCH_TIMEOUT_MS = 15000;

const listingUrls = [
  ...[1,2,3,4].map(page => `https://careers.equinix.com/jobs/search?country_codes%5B%5D=US&page=${page}&query=skillbridge`),
  ...[1,2].map(page => `https://careers.equinix.com/jobs/search?country_codes%5B%5D=US&page=${page}&query=intern`),
  'https://careers.equinix.com/students-recent-grads'
];

const roleSignal = /data\s*center|datacenter|critical facilit|customer operations/i;
const earlySignal = /skillbridge|intern|apprentice|trainee|co-?op|work.?based learning/i;
const excludedTitle = /\b(?:senior|sr\.?|lead|principal|manager|director|vice president|vp|head of|staff|supervisor|security|iam|sales)\b/i;
const numberWords = new Map([
  ['zero','0'],['one','1'],['two','2'],['three','3'],['four','4'],['five','5'],
  ['six','6'],['seven','7'],['eight','8'],['nine','9'],['ten','10']
]);

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

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': 'Mozilla/5.0 (compatible; DataCenterCareers/1.0; +https://datacentercareers.us/)'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

function canonicalUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'careers.equinix.com') return '';
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/^\/(?:[a-z]{2}(?:-[a-z]{2})?)\/jobs\//i, '/jobs/');
    if (!parsed.pathname.startsWith('/jobs/')) return '';
    return parsed.href.replace(/\/$/, '');
  } catch { return ''; }
}

function localizedVariants(url) {
  const canonical = canonicalUrl(url);
  if (!canonical) return [];
  const parsed = new URL(canonical);
  const tail = parsed.pathname.replace(/^\/jobs\//, '');
  return [canonical, ...['ko','fr','ja'].map(locale => `https://careers.equinix.com/${locale}/jobs/${tail}`)];
}

function usable(title, url = '') {
  const text = `${clean(title)} ${url}`;
  return earlySignal.test(text) && roleSignal.test(text) && !excludedTitle.test(clean(title));
}

function discover(html, baseUrl) {
  const out = new Map();
  for (const match of String(html || '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = clean(match[1]);
    const label = clean(match[2]);
    if (!href) continue;
    let absolute;
    try { absolute = new URL(href, baseUrl).href; } catch { continue; }
    const url = canonicalUrl(absolute);
    if (!url || !/united-states/i.test(url) || !usable(label, url)) continue;
    out.set(url, label);
  }
  return out;
}

function findJobPosting(node) {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findJobPosting(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  if (types.some(type => String(type || '').toLowerCase() === 'jobposting')) return node;
  for (const child of Object.values(node)) {
    if (child && typeof child === 'object') {
      const found = findJobPosting(child);
      if (found) return found;
    }
  }
  return null;
}

function extractPosting(html) {
  for (const match of String(html || '').matchAll(/<script\b[^>]*type=["']application\/ld\+json[^"']*["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const found = findJobPosting(JSON.parse(match[1] || ''));
      if (found) return found;
    } catch {}
  }
  return null;
}

function heading(html, fallback) {
  for (const match of String(html || '').matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)) {
    const value = clean(match[1]);
    if (value && usable(value)) return value;
  }
  return clean(fallback);
}

function requiredExperienceText(description = '') {
  const text = clean(description);
  const preferred = text.search(/\b(?:preferred qualifications?|preferred experience|preferred skills?|nice to have|bonus qualifications?)\b/i);
  return preferred >= 0 ? text.slice(0, preferred) : text;
}

function normalizeNumberWords(text = '') {
  return lower(text).replace(/\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/g, word => numberWords.get(word) || word);
}

function experienceValues(text = '') {
  const normalized = normalizeNumberWords(text);
  const values = [];
  const yearPatterns = [
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+years?['’]?(?:\s+(?:of|prior))?\s+(?:direct\s+|equivalent\s+|relevant\s+|related\s+|professional\s+|technical\s+|work\s+)*experience/gi,
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?['’]?(?:\s+(?:of|prior))?\s+(?:direct\s+|equivalent\s+|relevant\s+|related\s+|professional\s+|technical\s+|work\s+)*experience/gi,
    /experience.{0,55}?(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+years?/gi,
    /experience.{0,55}?(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?/gi,
    /(?:relevant|related|equivalent|technical|professional)\s+experience\s+(?:with|w\/)\s*(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+years?/gi
  ];
  for (const pattern of yearPatterns) {
    for (const match of normalized.matchAll(pattern)) {
      values.push(Number(match[1]));
      if (match[2]) values.push(Number(match[2]));
    }
  }
  for (const match of normalized.matchAll(/(?:minimum(?: of)?\s+|at least\s+)?(\d{1,3})\s*(?:\+|or more)?\s+months?(?:\s+(?:of|prior))?\s+(?:direct\s+|relevant\s+|related\s+|professional\s+|technical\s+|work\s+)*experience/gi)) {
    const months = Number(match[1]);
    if (Number.isFinite(months)) values.push(months / 12);
  }
  return values.filter(value => Number.isFinite(value) && value >= 0 && value <= 50);
}

function classifyExperience(title, description) {
  const required = `${title} ${requiredExperienceText(description)}`;
  const years = experienceValues(required);
  if (years.some(year => year > 5)) return { drop: 'over-experience' };
  if (years.length) {
    const highest = Math.max(...years);
    return { experience: highest <= 2 ? '0-2-years' : '2-5-years' };
  }
  if (/(?:no|zero) (?:prior )?experience(?: is)? (?:required|needed)|experience (?:is )?not required/i.test(required)) {
    return { experience: 'no-experience' };
  }
  if (/intern|co-?op|apprentice/i.test(title)) return { experience: '0-2-years' };
  return { drop: 'unknown-experience' };
}

function locationFromPosting(posting, url) {
  const entries = Array.isArray(posting?.jobLocation) ? posting.jobLocation : [posting?.jobLocation].filter(Boolean);
  const locations = [];
  for (const item of entries) {
    const address = item?.address || item || {};
    const country = clean(typeof address.addressCountry === 'object' ? address.addressCountry?.name : address.addressCountry);
    if (country && !/united states|\busa?\b/i.test(country)) continue;
    const label = [address.addressLocality, address.addressRegion].map(clean).filter(Boolean).join(', ');
    if (label) locations.push(label);
  }
  if (locations.length) return [...new Set(locations)].join('; ');
  return /united-states/i.test(url) ? 'United States' : '';
}

function typeFor(title) {
  if (/apprentice/i.test(title)) return 'apprenticeship';
  if (/intern|co-?op/i.test(title)) return 'internship';
  return 'trainee';
}

async function mapPool(items, worker) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length || 1) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  }));
}

const jobs = await readJson(JOBS_PATH, []);
const status = await readJson(STATUS_PATH, {});
if (!Array.isArray(jobs)) throw new Error(`${JOBS_PATH} must contain an array.`);

const previousManaged = jobs.filter(job => String(job?.id || '').startsWith(ID_PREFIX) || job?.source === SOURCE);
const previousByUrl = new Map(previousManaged.map(job => [canonicalUrl(job.sourceUrl), job]));
const candidates = new Map();
const errors = [];
let listingSucceeded = 0;

for (const listing of listingUrls) {
  try {
    const html = await fetchText(listing);
    for (const [url, title] of discover(html, listing)) candidates.set(url, title);
    listingSucceeded += 1;
  } catch (error) {
    errors.push(`listing ${listing}: ${error.message}`);
  }
}

for (const sample of status?.priorityEmployerExpansion?.Equinix?.dropSamples || []) {
  const url = canonicalUrl(sample?.url);
  const title = clean(sample?.title || sample?.listingLabel);
  if (url && /united-states/i.test(url) && usable(title, url)) candidates.set(url, title);
}

const recovered = [];
const preserved = [];
let mirrorRecovered = 0;
let overExperience = 0;
let unknownExperience = 0;
let unusable = 0;
let fetchFailures = 0;

await mapPool([...candidates.entries()], async ([url, label]) => {
  let eligible = null;
  let sawOverExperience = false;
  let fetchedAny = false;
  let lastError = null;

  for (const variant of localizedVariants(url)) {
    try {
      const html = await fetchText(variant);
      fetchedAny = true;
      const posting = extractPosting(html);
      const title = clean(posting?.title || posting?.name) || heading(html, label);
      if (!title || !usable(title, url)) continue;
      const description = clean(posting?.description || html);
      const classification = classifyExperience(title, description);
      if (classification.drop === 'over-experience') {
        sawOverExperience = true;
        break;
      }
      if (classification.drop) continue;
      eligible = { title, posting, experience: classification.experience, variant };
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (sawOverExperience) {
    overExperience += 1;
    return;
  }
  if (!eligible) {
    if (!fetchedAny) {
      fetchFailures += 1;
      const prior = previousByUrl.get(url);
      if (prior) preserved.push({ ...prior, active: true, demo: false, pay: prior.pay === 'Pay not listed' ? '' : (prior.pay || '') });
      if (lastError && errors.length < 20) errors.push(`job ${url}: ${lastError.message}`);
    } else {
      unknownExperience += 1;
    }
    return;
  }

  if (eligible.variant !== url) mirrorRecovered += 1;
  const type = typeFor(eligible.title);
  const tags = [
    type === 'internship' ? 'Internship' : type === 'apprenticeship' ? 'Apprenticeship' : 'Trainee',
    eligible.experience === 'no-experience' ? 'No Experience Needed' : eligible.experience === '2-5-years' ? '2–5 Years' : '0–2 Years'
  ];
  if (/skillbridge/i.test(eligible.title)) tags.push('SkillBridge');
  if (/critical facilit/i.test(eligible.title)) tags.push('Critical Facilities');
  if (/customer operations|technician/i.test(eligible.title)) tags.push('Data Center Operations');
  const datePosted = clean(eligible.posting?.datePosted);
  const postedAt = /^\d{4}-\d{2}-\d{2}/.test(datePosted) ? new Date(datePosted).toISOString() : null;
  const postedHours = postedAt ? Math.max(0, Math.round((Date.now() - new Date(postedAt).getTime()) / 36e5)) : 9999;

  recovered.push({
    id: `${ID_PREFIX}${hash(url)}`,
    title: eligible.title,
    company: COMPANY,
    location: locationFromPosting(eligible.posting, url),
    type,
    experience: eligible.experience,
    tags: [...new Set(tags)].slice(0, 5),
    pay: '',
    salaryMin: null,
    salaryMax: null,
    salarySortMax: null,
    postedAt,
    postedHours,
    source: SOURCE,
    sourceUrl: url,
    active: true,
    demo: false
  });
});

const listingComplete = listingSucceeded === listingUrls.length;
const candidateUrls = new Set(candidates.keys());
if (!listingComplete) {
  for (const prior of previousManaged) {
    const url = canonicalUrl(prior.sourceUrl);
    if (url && !candidateUrls.has(url) && !preserved.some(job => canonicalUrl(job.sourceUrl) === url)) {
      preserved.push({ ...prior, active: true, demo: false, pay: prior.pay === 'Pay not listed' ? '' : (prior.pay || '') });
    }
  }
}

const nextManagedByUrl = new Map();
for (const job of [...recovered, ...preserved]) nextManagedByUrl.set(canonicalUrl(job.sourceUrl), job);
const nextManaged = [...nextManagedByUrl.values()];
const withoutManaged = jobs.filter(job => !(String(job?.id || '').startsWith(ID_PREFIX) || job?.source === SOURCE));
const representedUrls = new Set(withoutManaged.map(job => canonicalUrl(job?.sourceUrl)).filter(Boolean));
const additions = nextManaged.filter(job => !representedUrls.has(canonicalUrl(job.sourceUrl)));
const merged = [...additions, ...withoutManaged];

const before = JSON.stringify(jobs);
const after = JSON.stringify(merged);
if (before !== after) {
  status.priorityEmployerExpansion = {
    ...(status.priorityEmployerExpansion || {}),
    EquinixRenderedRecovery: {
      officialSource: 'https://careers.equinix.com/',
      listingComplete,
      listingPagesAttempted: listingUrls.length,
      listingPagesSucceeded: listingSucceeded,
      candidates: candidates.size,
      recovered: additions.length,
      mirrorRecovered,
      preserved: preserved.length,
      overExperience,
      unknownExperience,
      fetchFailures,
      errors
    }
  };
  await writeFile(JOBS_PATH, `${JSON.stringify(merged, null, 2)}\n`);
  await writeFile(STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`);
}

console.log(`Equinix rendered-detail recovery evaluated ${candidates.size} candidate(s), added ${additions.length} eligible role(s), recovered ${mirrorRecovered} through official locale pages, dropped ${overExperience} over-experience and ${unknownExperience} unknown-experience candidate(s).`);
if (errors.length) console.warn(`Equinix rendered-detail recovery warnings: ${errors.join(' | ')}`);
