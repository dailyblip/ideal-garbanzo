import { readFile, writeFile } from 'node:fs/promises';

const COMPANY = 'Meta';
const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/meta-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const MAX_CANDIDATES = 40;

const clean = value => String(value ?? '')
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
const normalizeIdentity = value => lower(value).replace(/[^a-z0-9]+/g, ' ').trim();
const excludedTitlePattern = /\b(?:senior|sr\.?|lead|principal|chief|manager|mgr\.?|director|vice president|vp|head of|staff engineer|supervisor|architect|program manager|project manager|product manager|capacity manager|partnerships?|strategy|counsel|attorney|recruiter|sales)\b/i;
const missionTitlePattern = /(?:data cent(?:er|re)|critical facilit(?:y|ies)|critical environment|facility operations).*(?:technician|engineer|operations|building)|(?:technician|engineer|operations|building).*(?:data cent(?:er|re)|critical facilit(?:y|ies)|critical environment)/i;
const headingPattern = /\b(?:minimum\s+qualifications?|minimum\s+requirements?|required\s+qualifications?|basic\s+qualifications?)\b/i;
const yearsPattern = /\b(?:at least\s+|minimum(?:\s+of)?\s+)?(\d{1,2})\s*(?:\+|plus)?\s*(?:years?|yrs?)\b/gi;

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

async function fetchText(url) {
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

function canonicalUrl(value) {
  try {
    const parsed = new URL(String(value || ''), 'https://www.metacareers.com/');
    if (!/(^|\.)metacareers\.com$/i.test(parsed.hostname)) return '';
    const match = parsed.pathname.match(/\/(?:profile\/job_details|jobs)\/(\d+)/i);
    return match ? `https://www.metacareers.com/profile/job_details/${match[1]}/` : '';
  } catch { return ''; }
}

function jobId(value) {
  return canonicalUrl(value).match(/job_details\/(\d+)/)?.[1] || '';
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

function visibleText(html) {
  return clean(String(html || '')
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
    if (typeof value === 'string' && /(?:qualif|require|responsib|description|experience|location|compensation|salary|title)/i.test(key)) {
      const text = clean(decodeEscapes(value));
      if (text) out.push(text);
    }
    collectStrings(value, out, seen, depth + 1);
  }
}

function structuredText(html) {
  const strings = [];
  for (const match of String(html || '').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = match[1] || '';
    if (!raw.trim()) continue;
    try {
      collectStrings(JSON.parse(raw), strings);
    } catch {
      const decoded = clean(decodeEscapes(raw));
      if (headingPattern.test(decoded) || /\b\d{1,2}\s*(?:\+|plus)?\s*(?:years?|yrs?)\b/i.test(decoded)) {
        strings.push(decoded.slice(0, 120000));
      }
    }
  }
  const metaDescriptions = [...String(html || '').matchAll(/<meta\b[^>]*(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']*)["'][^>]*>/gi)]
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

function jobPostingMinimum(html) {
  const postings = [];
  for (const match of String(html || '').matchAll(/<script\b[^>]*type=["']application\/ld\+json[^"']*["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = match[1] || '';
    if (!raw.trim()) continue;
    try {
      findJobPostingObjects(JSON.parse(raw), postings);
    } catch {}
  }

  for (const posting of postings) {
    const description = clean(decodeEscapes(posting.description || ''));
    const scoped = minimumBlock(description);
    if (scoped) return { text: scoped, source: 'jobposting-jsonld' };

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
    if (directText && requiredYears(directText) != null) return { text: directText, source: 'jobposting-jsonld' };
  }

  return { text: '', source: '' };
}

function minimumBlock(text) {
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
    'locations',
    'individual compensation',
    'compensation details',
    'related jobs'
  ];
  const ends = markers
    .map(marker => afterLower.indexOf(marker, Math.max(heading[0].length, 30)))
    .filter(index => index > Math.max(heading[0].length, 30));
  const end = ends.length ? Math.min(...ends) : Math.min(after.length, 12000);
  return clean(after.slice(0, end));
}

function findMinimumQualifications(html) {
  const visible = visibleText(html);
  const visibleMinimum = minimumBlock(visible);
  if (visibleMinimum) return { text: visibleMinimum, source: 'visible-html' };

  const jobPosting = jobPostingMinimum(html);
  if (jobPosting.text) return jobPosting;

  const structured = structuredText(html);
  const structuredMinimum = minimumBlock(structured);
  if (structuredMinimum) return { text: structuredMinimum, source: 'structured-data' };

  return { text: '', source: '' };
}

function requiredYears(text) {
  yearsPattern.lastIndex = 0;
  const years = [...String(text || '').matchAll(yearsPattern)]
    .map(match => Number(match[1]))
    .filter(value => Number.isFinite(value) && value >= 0 && value <= 20);
  return years.length ? Math.min(...years) : null;
}

function classify(title, minimum) {
  const t = lower(title);
  let type = 'entry-level';
  if (/intern(?:ship)?\b/.test(t)) type = 'internship';
  else if (/apprentice/.test(t)) type = 'apprenticeship';
  else if (/trainee|developmental program|skillbridge/.test(t)) type = 'trainee';

  const years = requiredYears(minimum);
  if (type !== 'entry-level' && years == null) {
    return { type, experience: /apprentice|trainee|developmental program|skillbridge/.test(t) ? 'no-experience' : '0-2-years', minYears: null };
  }
  if (years == null || years > 5) return null;
  return { type, experience: years >= 3 ? '2-5-years' : '0-2-years', minYears: years };
}

function tagsFor(title, experience, type, minimum) {
  const text = lower(`${title} ${minimum}`);
  const tags = [];
  if (type === 'internship') tags.push('Internship');
  if (type === 'apprenticeship') tags.push('Apprenticeship');
  if (type === 'trainee') tags.push('Trainee');
  if (experience === 'no-experience') tags.push('No Experience Needed');
  else tags.push(experience === '2-5-years' ? '2–5 Years' : '0–2 Years');
  if (/electrical|ups|generator|switchgear/.test(text)) tags.push('Electrical');
  if (/mechanical|hvac|cooling|chiller|critical facilit|facility operations/.test(text)) tags.push('Critical Facilities');
  if (/server|rack|data center operations|production operations/.test(text)) tags.push('Data Center Operations');
  if (/training|trainee|apprentice|developmental|skillbridge/.test(text)) tags.push('Training / Mentorship');
  return [...new Set(tags)].slice(0, 5);
}

function dedupe(jobs) {
  const ids = new Set();
  const urls = new Set();
  const identities = new Set();
  const out = [];
  for (const job of jobs) {
    const id = String(job.id || '');
    const url = String(job.sourceUrl || '');
    const identity = [job.company, job.title, job.location].map(normalizeIdentity).join('|');
    if ((id && ids.has(id)) || (url && urls.has(url)) || identities.has(identity)) continue;
    if (id) ids.add(id);
    if (url) urls.add(url);
    identities.add(identity);
    out.push(job);
  }
  return out;
}

const status = await readJson(STATUS_PATH, {});
const jobs = await readJson(JOBS_PATH, []);
const snapshot = await readJson(SNAPSHOT_PATH, []);
const diagnostics = status.metaCareers?.diagnostics || {};
const samples = Array.isArray(diagnostics.experienceSamples) ? diagnostics.experienceSamples : [];
const existingUrls = new Set(snapshot.map(job => canonicalUrl(job.sourceUrl)).filter(Boolean));
const candidates = samples
  .filter(sample => sample?.url && sample?.title && sample?.location)
  .filter(sample => missionTitlePattern.test(sample.title) && !excludedTitlePattern.test(sample.title))
  .filter(sample => !existingUrls.has(canonicalUrl(sample.url)))
  .slice(0, MAX_CANDIDATES);

const recovered = [];
const recovery = {
  attempted: candidates.length,
  fetched: 0,
  recovered: 0,
  minimumFromVisibleHtml: 0,
  minimumFromJobPostingJsonLd: 0,
  minimumFromStructuredData: 0,
  noMinimumQualifications: 0,
  noSupportedExperience: 0,
  recoveredSamples: [],
  fetchErrors: []
};

for (const sample of candidates) {
  try {
    const url = canonicalUrl(sample.url);
    const id = jobId(url);
    if (!id || !url) continue;
    const html = await fetchText(url);
    recovery.fetched += 1;

    const minimum = findMinimumQualifications(html);
    if (!minimum.text) {
      recovery.noMinimumQualifications += 1;
      continue;
    }
    if (minimum.source === 'visible-html') recovery.minimumFromVisibleHtml += 1;
    if (minimum.source === 'jobposting-jsonld') recovery.minimumFromJobPostingJsonLd += 1;
    if (minimum.source === 'structured-data') recovery.minimumFromStructuredData += 1;

    const cls = classify(sample.title, minimum.text);
    if (!cls) {
      recovery.noSupportedExperience += 1;
      continue;
    }

    const job = {
      id: `meta-${id}`,
      title: clean(sample.title),
      company: COMPANY,
      location: clean(sample.location),
      type: cls.type,
      experience: cls.experience,
      tags: tagsFor(sample.title, cls.experience, cls.type, minimum.text),
      pay: 'Pay not listed',
      salaryMin: null,
      salaryMax: null,
      salarySortMax: null,
      postedAt: null,
      postedHours: 9999,
      source: 'Meta Careers',
      sourceUrl: url,
      active: true,
      demo: false
    };
    recovered.push(job);
    if (recovery.recoveredSamples.length < 20) {
      recovery.recoveredSamples.push({ id: job.id, title: job.title, location: job.location, minYears: cls.minYears, source: minimum.source, url });
    }
  } catch (error) {
    if (recovery.fetchErrors.length < 20) recovery.fetchErrors.push(String(error.message || error));
  }
}

recovery.recovered = recovered.length;
const nextSnapshot = dedupe([...snapshot, ...recovered]);
const withoutMeta = jobs.filter(job => job.company !== COMPANY && !/(^|\.)metacareers\.com\//i.test(String(job.sourceUrl || '')));
const merged = dedupe([...withoutMeta, ...nextSnapshot]);
const countsByType = merged.reduce((acc, job) => { acc[job.type] = (acc[job.type] || 0) + 1; return acc; }, {});
const countsByExperience = merged.reduce((acc, job) => { acc[job.experience] = (acc[job.experience] || 0) + 1; return acc; }, {});

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
    qualifyingRoles: nextSnapshot.length,
    diagnostics: {
      ...diagnostics,
      recoveredFromStructuredData: Number(diagnostics.recoveredFromStructuredData || 0) + recovered.length
    },
    structuredRecovery: recovery
  }
}, null, 2) + '\n');

console.log(`Meta recovery checked ${candidates.length} experience-dropped roles; recovered ${recovered.length} verified 0–5 year role(s).`);
if (recovery.fetchErrors.length) console.warn(`Meta recovery warnings: ${recovery.fetchErrors.join(' | ')}`);
