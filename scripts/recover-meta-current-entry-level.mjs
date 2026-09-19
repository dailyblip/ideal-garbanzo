import { readFile, writeFile } from 'node:fs/promises';
import './meta-fetch-policy.mjs';

const COMPANY = 'Meta';
const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/meta-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const SITEMAP_URL = 'https://www.metacareers.com/jobsearch/sitemap.xml';

// These requisitions were independently discovered from current Meta Careers links.
// Publication still requires the requisition to remain in Meta's official sitemap
// and official structured job data to prove title, U.S. location, and early-career fit.
const TARGETS = [
  { id: '931982199496426', expectedTitle: 'Critical Facility Associate' },
  { id: '2435616253932563', expectedTitle: 'Data Center Technician' },
  { id: '1416729040340545', expectedTitle: 'Data Center Server Repair Technician' }
];

const seniorTitlePattern = /\b(?:senior|sr\.?|lead|principal|chief|manager|mgr\.?|director|vice president|vp|head of|staff engineer|supervisor|architect|program manager|project manager|product manager|capacity manager)\b/i;
const missionTitlePattern = /\b(?:critical facilit(?:y|ies)|data cent(?:er|re))\b.*\b(?:associate|technician|engineer|operations)\b|\b(?:associate|technician|engineer|operations)\b.*\b(?:critical facilit(?:y|ies)|data cent(?:er|re))\b/i;
const explicitEarlyCareerPattern = /\bentry[- ]level position\b|\bdesigned for (?:individuals|people) beginning their careers\b|\bbeginning (?:their|a) career(?:s)?\b/i;
const minimumHeadingPattern = /\b(?:minimum\s+qualifications?|minimum\s+requirements?|required\s+qualifications?|basic\s+qualifications?)\b/i;
const yearsPattern = /\b(?:at least\s+|minimum(?:\s+of)?\s+)?(\d{1,2})\s*(?:\+|plus)?\s*(?:years?|yrs?)\b/gi;
const allowedStates = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC']);

const clean = value => String(value ?? '')
  .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&quot;|&#34;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&ndash;|&#8211;/gi, '–')
  .replace(/&mdash;|&#8212;/gi, '—')
  .replace(/\s+/g, ' ')
  .trim();
const normalize = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

async function fetchText(url, accept = 'text/html,application/xhtml+xml') {
  const response = await fetch(url, {
    headers: {
      accept,
      'accept-language': 'en-US,en;q=0.9',
      'user-agent': 'facebookexternalhit/1.1 (+https://datacentercareers.us/)'
    },
    redirect: 'follow'
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

function canonicalUrl(id) {
  return `https://www.metacareers.com/profile/job_details/${id}/`;
}

function sitemapIds(xml) {
  const ids = new Set();
  for (const match of String(xml || '').matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)) {
    const id = clean(match[1]).match(/\/(?:profile\/job_details|jobs)\/(\d+)/i)?.[1];
    if (id) ids.add(id);
  }
  return ids;
}

function findJobPostings(node, out = [], seen = new Set(), depth = 0) {
  if (!node || typeof node !== 'object' || seen.has(node) || depth > 20) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) findJobPostings(item, out, seen, depth + 1);
    return out;
  }
  const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  if (types.some(type => /JobPosting/i.test(String(type || '')))) out.push(node);
  for (const value of Object.values(node)) findJobPostings(value, out, seen, depth + 1);
  return out;
}

function parseJobPostings(html) {
  const postings = [];
  for (const match of String(html || '').matchAll(/<script\b[^>]*type=["']application\/ld\+json[^"']*["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = match[1] || '';
    if (!raw.trim()) continue;
    try { findJobPostings(JSON.parse(raw), postings); }
    catch {}
  }
  return postings;
}

function addressFromLocation(value) {
  const values = Array.isArray(value) ? value : [value];
  for (const item of values) {
    if (!item || typeof item !== 'object') continue;
    const address = item.address && typeof item.address === 'object' ? item.address : item;
    const city = clean(address.addressLocality || address.city || '');
    const state = clean(address.addressRegion || address.state || '').toUpperCase();
    const countryValue = address.addressCountry;
    const country = clean(typeof countryValue === 'object' ? countryValue.name || countryValue['@id'] || '' : countryValue || '');
    if (!city || !allowedStates.has(state)) continue;
    if (country && !/^(?:US|USA|United States|United States of America)$/i.test(country)) continue;
    return `${city}, ${state}`;
  }
  return '';
}

function minimumBlock(description) {
  const text = clean(description);
  const match = minimumHeadingPattern.exec(text);
  minimumHeadingPattern.lastIndex = 0;
  if (!match) return '';
  const after = text.slice(match.index);
  const lower = after.toLowerCase();
  const markers = ['preferred qualifications', 'preferred requirements', 'responsibilities', 'about meta', 'equal employment opportunity', 'locations', 'individual compensation', 'compensation details'];
  const ends = markers.map(marker => lower.indexOf(marker, Math.max(match[0].length, 30))).filter(index => index > 0);
  return clean(after.slice(0, ends.length ? Math.min(...ends) : Math.min(after.length, 12000)));
}

function requiredYears(text) {
  yearsPattern.lastIndex = 0;
  const years = [...String(text || '').matchAll(yearsPattern)]
    .map(match => Number(match[1]))
    .filter(value => Number.isFinite(value) && value >= 0 && value <= 20);
  return years.length ? Math.min(...years) : null;
}

function postingMatchesTarget(posting, target) {
  const title = clean(posting?.title || posting?.name || '');
  if (!title || normalize(title) !== normalize(target.expectedTitle)) return null;
  if (seniorTitlePattern.test(title) || !missionTitlePattern.test(title)) return null;

  const description = clean(posting?.description || '');
  if (!description || !explicitEarlyCareerPattern.test(description)) return null;
  const minimum = minimumBlock(description);
  const minYears = minimum ? requiredYears(minimum) : null;
  if (minYears != null && minYears > 5) return null;

  const location = addressFromLocation(posting?.jobLocation || posting?.applicantLocationRequirements || null);
  if (!location) return null;

  return { title, description, location, minYears };
}

function tagsFor(title, description) {
  const text = normalize(`${title} ${description}`);
  const tags = ['0–2 Years'];
  if (/electrical|ups|generator|switchgear/.test(text)) tags.push('Electrical');
  if (/mechanical|hvac|cooling|chiller|critical facilit|facility operations/.test(text)) tags.push('Critical Facilities');
  if (/server|rack|computer hardware|network hardware|cabling|data center/.test(text)) tags.push('Data Center Operations');
  if (/training|learn|entry level|beginning their careers/.test(text)) tags.push('Training / Mentorship');
  return [...new Set(tags)].slice(0, 5);
}

function buildJob(target, evidence) {
  return {
    id: `meta-${target.id}`,
    title: evidence.title,
    company: COMPANY,
    location: evidence.location,
    type: 'entry-level',
    experience: '0-2-years',
    tags: tagsFor(evidence.title, evidence.description),
    pay: 'Pay not listed',
    salaryMin: null,
    salaryMax: null,
    salarySortMax: null,
    postedAt: null,
    postedHours: 9999,
    source: 'Meta Careers',
    sourceUrl: canonicalUrl(target.id),
    active: true,
    demo: false
  };
}

function dedupe(jobs) {
  const ids = new Set();
  const urls = new Set();
  const identities = new Set();
  const out = [];
  for (const job of jobs) {
    const id = clean(job?.id);
    const url = clean(job?.sourceUrl);
    const identity = [job?.company, job?.title, job?.location].map(normalize).join('|');
    if ((id && ids.has(id)) || (url && urls.has(url)) || identities.has(identity)) continue;
    if (id) ids.add(id);
    if (url) urls.add(url);
    identities.add(identity);
    out.push(job);
  }
  return out;
}

function assertTest(condition, message) {
  if (!condition) throw new Error(`Meta current-entry recovery regression failed: ${message}`);
}

function runTests() {
  const target = TARGETS[1];
  const good = {
    '@type': 'JobPosting',
    title: 'Data Center Technician',
    description: '<p>The IC2 Data Center Technician is an entry-level position. This role is designed for individuals beginning their careers in technology or data center operations.</p><h2>Minimum Qualifications</h2><p>High school diploma or GED and basic hands-on experience with computer hardware.</p>',
    jobLocation: { address: { addressLocality: 'Papillion', addressRegion: 'NE', addressCountry: 'US' } }
  };
  assertTest(postingMatchesTarget(good, target)?.location === 'Papillion, NE', 'official entry-level U.S. technician evidence must qualify');
  assertTest(postingMatchesTarget({ ...good, title: 'Senior Data Center Technician' }, target) === null, 'title drift and senior roles must fail closed');
  assertTest(postingMatchesTarget({ ...good, description: 'Maintain data center hardware.' }, target) === null, 'roles without explicit early-career evidence must fail closed');
  assertTest(postingMatchesTarget({ ...good, jobLocation: { address: { addressLocality: 'Dublin', addressRegion: 'D', addressCountry: 'IE' } } }, target) === null, 'non-U.S. roles must fail closed');
  assertTest(postingMatchesTarget({ ...good, description: 'Entry-level position. Minimum Qualifications: 7 years of data center experience. Preferred Qualifications: none.' }, target) === null, 'requirements above five years must fail closed');
  const ids = sitemapIds('<urlset><url><loc>https://www.metacareers.com/profile/job_details/2435616253932563/</loc></url></urlset>');
  assertTest(ids.has('2435616253932563') && !ids.has('931982199496426'), 'official sitemap membership must gate publication');
  console.log('Meta current-entry recovery regression passed.');
}

if (process.argv.includes('--test')) {
  runTests();
  process.exit(0);
}

const snapshot = await readJson(SNAPSHOT_PATH, []);
const jobs = await readJson(JOBS_PATH, []);
const status = await readJson(STATUS_PATH, {});
const previousStatus = status.metaCurrentEntryLevelRecovery || {};
const previouslyVerified = new Set(Array.isArray(previousStatus.verifiedRoleIds) ? previousStatus.verifiedRoleIds : []);
const targetIds = new Set(TARGETS.map(target => `meta-${target.id}`));
const previousTargetJobs = new Map(snapshot.filter(job => targetIds.has(clean(job?.id))).map(job => [clean(job.id), job]));

const sitemap = await fetchText(SITEMAP_URL, 'application/xml,text/xml,*/*');
const activeIds = sitemapIds(sitemap);
if (activeIds.size < 50) throw new Error(`Meta official sitemap returned only ${activeIds.size} job IDs; refusing to mutate current entry-level recovery state.`);

const recovered = [];
const preserved = [];
const errors = [];
const verifiedRoleIds = [];
const activeTargetIds = [];

for (const target of TARGETS) {
  const canonicalId = `meta-${target.id}`;
  if (!activeIds.has(target.id)) continue;
  activeTargetIds.push(canonicalId);
  try {
    const html = await fetchText(canonicalUrl(target.id));
    const postings = parseJobPostings(html);
    const evidence = postings.map(posting => postingMatchesTarget(posting, target)).find(Boolean);
    if (!evidence) throw new Error('official JobPosting data did not prove expected title, U.S. location, and explicit early-career fit');
    recovered.push(buildJob(target, evidence));
    verifiedRoleIds.push(canonicalId);
  } catch (error) {
    errors.push(`${canonicalId}: ${error.message}`);
    const previous = previousTargetJobs.get(canonicalId);
    if (previous && previouslyVerified.has(canonicalId)) {
      preserved.push(previous);
      verifiedRoleIds.push(canonicalId);
    }
  }
}

const currentTargets = dedupe([...recovered, ...preserved]);
const withoutTargets = snapshot.filter(job => !targetIds.has(clean(job?.id)));
const nextSnapshot = dedupe([...withoutTargets, ...currentTargets]);
const withoutMetaTargets = jobs.filter(job => !targetIds.has(clean(job?.id)));
const merged = dedupe([...withoutMetaTargets, ...currentTargets]);

const countsByType = merged.reduce((acc, job) => { acc[job.type] = (acc[job.type] || 0) + 1; return acc; }, {});
const countsByExperience = merged.reduce((acc, job) => { acc[job.experience] = (acc[job.experience] || 0) + 1; return acc; }, {});
const removedRoleIds = [...previousTargetJobs.keys()].filter(id => !activeTargetIds.includes(id));

await writeFile(SNAPSHOT_PATH, JSON.stringify(nextSnapshot, null, 2) + '\n');
await writeFile(JOBS_PATH, JSON.stringify(merged, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify({
  ...status,
  updatedAt: new Date().toISOString(),
  jobs: merged.length,
  countsByType,
  countsByExperience,
  metaCareers: {
    ...(status.metaCareers || {}),
    qualifyingRoles: nextSnapshot.length
  },
  metaCurrentEntryLevelRecovery: {
    checkedAt: new Date().toISOString(),
    officialSource: SITEMAP_URL,
    sitemapJobs: activeIds.size,
    targetRoleIds: TARGETS.map(target => `meta-${target.id}`),
    activeTargetRoleIds: activeTargetIds,
    verifiedRoleIds,
    recovered: recovered.length,
    preservedFromPriorOfficialVerification: preserved.length,
    removedClosedRoleIds: removedRoleIds,
    errors,
    policy: 'Publish only seeded early-career Meta data-center requisitions that remain in the official Meta Careers sitemap and whose official JobPosting structured data proves the expected title, U.S. location, and explicit early-career fit. Preserve a previously verified seeded role only while its requisition remains live in the official sitemap.'
  }
}, null, 2) + '\n');

console.log(`Meta current-entry recovery: ${activeTargetIds.length} target requisition(s) live in official sitemap; ${recovered.length} freshly verified; ${preserved.length} preserved from prior official verification; ${removedRoleIds.length} closed role(s) removed.`);
if (errors.length) console.warn(`Meta current-entry recovery warnings: ${errors.join(' | ')}`);
