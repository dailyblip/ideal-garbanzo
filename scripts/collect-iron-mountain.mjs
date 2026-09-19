import { readFile, writeFile } from 'node:fs/promises';

const COMPANY = 'Iron Mountain';
const ORIGIN = 'https://ironmountain.wd5.myworkdayjobs.com';
const TENANT = 'ironmountain';
const SITE = 'iron-mountain-jobs';
const LOCALE = 'en-US';
const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/iron-mountain-jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const PAGE_SIZE = 20;
const MAX_PAGES = 100;
const DETAIL_BATCH = 6;
const MAX_FALLBACK_AGE_HOURS = 96;
const MAX_FALLBACK_AGE_MS = MAX_FALLBACK_AGE_HOURS * 60 * 60 * 1000;

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
const normalizeIdentity = value => lower(value).replace(/[^a-z0-9]+/g, ' ').trim();

const allowedTitle = /\b(?:critical facilit(?:y|ies) technician|data cent(?:er|re)(?: operations)? technician|data cent(?:er|re) operations engineer|data cent(?:er|re) facilities technician)\b/i;
const excludedTitle = /\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|architect)\b/i;
const dataCenterContext = /\b(?:data cent(?:er|re)|critical facilit(?:y|ies)|colocation|mission[- ]critical|ups|switchgear|chiller|cooling|bms|generator)\b/i;
const noExperiencePattern = /\b(?:no experience|experience (?:is )?not required|preferred,? but not required|preferred but not required)\b/i;

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: 'application/json',
      'user-agent': 'DataCenterCareersBot/1.5 (+https://datacentercareers.us/)',
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

function candidateTitle(title = '') {
  const value = clean(title);
  return Boolean(value) && allowedTitle.test(value) && !excludedTitle.test(value);
}

function sourceUrl(row = {}) {
  const path = String(row.externalPath || '').trim();
  if (!path.startsWith('/job/')) return '';
  return `${ORIGIN}/${LOCALE}/${SITE}${path}`;
}

function detailUrl(row = {}) {
  const path = String(row.externalPath || '').trim();
  if (!path.startsWith('/job/')) return '';
  return `${ORIGIN}/wday/cxs/${TENANT}/${SITE}${path}`;
}

function locationFrom(row = {}, info = {}) {
  const raw = clean(row.locationsText || info.location || info.locationText || '');
  if (!raw) return '';

  const parts = raw.split('|').map(part => clean(part)).filter(Boolean);
  if (parts.length >= 2 && /^US$/i.test(parts[0])) {
    const state = parts[1].toUpperCase();
    const city = clean(parts[2] || '');
    if (city && !/^remote$/i.test(city) && /^[A-Z]{2}$/.test(state)) return `${city}, ${state}`;
    if (/^remote$/i.test(city)) return 'Remote';
    if (/^[A-Z]{2}$/.test(state)) return `${state}, United States`;
  }

  if (/\bUnited States\b/i.test(raw)) return raw.replace(/,?\s*United States\s*$/i, '').trim() || 'United States';
  return '';
}

function statedExperience(description = '') {
  const text = clean(description);
  const values = [];
  const patterns = [
    /\b(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\s+years?['’]?\s*(?:of\s+)?(?:relevant\s+|related\s+|critical\s+operations\s+|data\s+cent(?:er|re)\s+)?experience\b/gi,
    /\b(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\+?\s+years?['’]?\s*(?:of\s+)?(?:relevant\s+|related\s+|critical\s+operations\s+|data\s+cent(?:er|re)\s+)?experience\b/gi,
    /\bexperience\s+(?:of\s+)?(?:at least\s+|minimum(?: of)?\s+)?(\d{1,2})\+?\s+years?\b/gi
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      values.push(Number(match[1]));
      if (match[2]) values.push(Number(match[2]));
    }
  }
  const years = values.filter(value => Number.isFinite(value) && value >= 0 && value <= 50);
  if (!years.length) return null;
  return { min: Math.min(...years), max: Math.max(...years) };
}

function classify(title, description) {
  const t = clean(title);
  const d = clean(description);
  if (!candidateTitle(t) || !dataCenterContext.test(`${t} ${d}`)) return { cls: null, reason: 'title-or-context' };

  const earlyProgram = /\b(?:skillbridge|intern(?:ship)?|apprentice(?:ship)?|trainee)\b/i.test(t);
  const explicitlyNoExperience = noExperiencePattern.test(d);
  const years = statedExperience(d);
  if (!years && !earlyProgram && !explicitlyNoExperience) return { cls: null, reason: 'experience-unknown' };
  if (years && (years.min > 5 || years.max > 5)) return { cls: null, reason: 'experience-over-5' };

  let type = 'entry-level';
  if (/intern(?:ship)?|skillbridge/i.test(t)) type = 'internship';
  else if (/apprentice/i.test(t)) type = 'apprenticeship';
  else if (/trainee/i.test(t)) type = 'trainee';

  let experience = '0-2-years';
  if (explicitlyNoExperience) experience = 'no-experience';
  else if (years && years.min >= 3) experience = '2-5-years';

  return { cls: { type, experience }, reason: '' };
}

function payFrom(description = '') {
  const text = clean(description);
  const range = text.match(/\$([\d,.]+)\s*(?:-|–|—|to)\s*\$?([\d,.]+)\s*(?:\/|per\s+)?(hour|hourly|hr|year|yearly|yr|annual|annually)?/i);
  if (!range) return { pay: 'Pay not listed', salaryMin: null, salaryMax: null, salarySortMax: null };
  const min = Number(range[1].replace(/,/g, ''));
  const max = Number(range[2].replace(/,/g, ''));
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { pay: 'Pay not listed', salaryMin: null, salaryMax: null, salarySortMax: null };
  const unit = lower(range[3] || '');
  const annual = /year|yr|annual/.test(unit) || (!unit && max >= 1000);
  return {
    pay: `$${min.toLocaleString('en-US')}–$${max.toLocaleString('en-US')} / ${annual ? 'year' : 'hr'}`,
    salaryMin: min,
    salaryMax: max,
    salarySortMax: annual ? max : Math.round(max * 2080)
  };
}

function canonicalIsoDay(value = '') {
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed)) return null;
  return `${new Date(parsed).toISOString().slice(0, 10)}T00:00:00.000Z`;
}

function relativePostedAt(label = '', nowMs = Date.now()) {
  const text = lower(label);
  if (!text) return null;
  let candidateMs = null;
  if (text.includes('today')) candidateMs = nowMs;
  else if (text.includes('yesterday')) candidateMs = nowMs - 864e5;
  else {
    const match = text.match(/(\d+)\+?\s+days?\s+ago/);
    if (match) candidateMs = nowMs - Number(match[1]) * 864e5;
  }
  return Number.isFinite(candidateMs) ? canonicalIsoDay(new Date(candidateMs).toISOString()) : null;
}

// Workday exposes relative posting labels. Recomputing them with the current
// crawl clock causes snapshot-only churn and can move old "30+ days ago" roles
// forward indefinitely. Keep the earliest date evidence already verified for
// the same requisition, matching the shared job-history stability policy.
function stablePostedAt(label = '', previousPostedAt = null, nowMs = Date.now()) {
  const current = relativePostedAt(label, nowMs);
  const previous = canonicalIsoDay(previousPostedAt);
  if (!current) return previous;
  if (!previous) return current;
  return Date.parse(previous) <= Date.parse(current) ? previous : current;
}

function tagsFor(title, description, cls) {
  const text = lower(`${title} ${description}`);
  const tags = [];
  if (cls.type === 'internship') tags.push(/skillbridge/i.test(title) ? 'SkillBridge' : 'Internship');
  if (cls.type === 'apprenticeship') tags.push('Apprenticeship');
  if (cls.type === 'trainee') tags.push('Trainee');
  if (cls.experience === 'no-experience') tags.push('No Experience Needed');
  else if (cls.experience === '0-2-years') tags.push('0–2 Years');
  else tags.push('2–5 Years');
  if (/electrical|ups|switchgear|power distribution/.test(text)) tags.push('Electrical');
  if (/mechanical|hvac|cooling|chiller|critical facilit/.test(text)) tags.push('Critical Facilities');
  if (/training|learn|mentorship|skillbridge/.test(text)) tags.push('Training / Mentorship');
  return [...new Set(tags)].slice(0, 5);
}

function requisitionId(row = {}, info = {}) {
  const bullet = Array.isArray(row.bulletFields) ? row.bulletFields.find(value => /^J\d+$/i.test(clean(value))) : '';
  const fromInfo = clean(info.jobReqId || info.jobRequisitionId || info.requisitionId || '');
  const fromPath = String(row.externalPath || '').match(/_(J\d+)\/?$/i)?.[1] || '';
  const value = clean(bullet || fromInfo || fromPath);
  return /^J\d+$/i.test(value) ? value.toUpperCase() : '';
}

function dedupe(jobs) {
  const ids = new Set();
  const urls = new Set();
  const identities = new Set();
  const out = [];
  for (const job of jobs) {
    if (!job || typeof job !== 'object') continue;
    const id = clean(job.id).toLowerCase();
    const url = clean(job.sourceUrl).toLowerCase();
    const identity = [job.company, job.title, job.location].map(normalizeIdentity).join('|');
    if ((id && ids.has(id)) || (url && urls.has(url)) || identities.has(identity)) continue;
    if (id) ids.add(id);
    if (url) urls.add(url);
    identities.add(identity);
    out.push(job);
  }
  return out;
}

function ironMountainJob(job = {}) {
  return clean(job.company) === COMPANY || /ironmountain\.wd5\.myworkdayjobs\.com/i.test(clean(job.sourceUrl));
}

function fallbackDecision(lastHealthyAt, nowMs, hasSnapshot) {
  if (!hasSnapshot) return { active: false, expired: false, ageHours: 0, expiresAt: null };
  const verifiedMs = Date.parse(String(lastHealthyAt || ''));
  if (!Number.isFinite(verifiedMs)) return { active: false, expired: true, ageHours: null, expiresAt: null };
  const expiresAt = verifiedMs + MAX_FALLBACK_AGE_MS;
  const ageHours = Math.max(0, (nowMs - verifiedMs) / 36e5);
  return { active: nowMs < expiresAt, expired: nowMs >= expiresAt, ageHours, expiresAt };
}

async function listJobs() {
  const endpoint = `${ORIGIN}/wday/cxs/${TENANT}/${SITE}/jobs`;
  const rows = [];
  const seen = new Set();
  let offset = 0;
  let total = null;
  let pagesAttempted = 0;
  let pagesSucceeded = 0;
  let complete = false;
  let incompleteReason = '';

  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (Number.isFinite(total) && offset >= total) { complete = true; break; }
    pagesAttempted += 1;
    const payload = await fetchJson(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', referer: `${ORIGIN}/${LOCALE}/${SITE}` },
      body: JSON.stringify({ appliedFacets: {}, limit: PAGE_SIZE, offset, searchText: '' })
    });
    pagesSucceeded += 1;

    if (page === 0) {
      const reported = Number(payload.total);
      if (!Number.isFinite(reported) || reported < 0) {
        incompleteReason = 'Workday did not return a valid total count';
        break;
      }
      total = reported;
      if (total === 0) { complete = true; break; }
    }

    const postings = Array.isArray(payload.jobPostings) ? payload.jobPostings : [];
    let fresh = 0;
    for (const row of postings) {
      const key = clean(row.externalPath || row.bulletFields?.[0] || `${row.title}|${row.locationsText}`);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
      fresh += 1;
    }

    offset += postings.length;
    if (offset >= total) { complete = true; break; }
    if (!postings.length) { incompleteReason = `listing ended at ${offset}/${total}`; break; }
    if (postings.length < PAGE_SIZE) { incompleteReason = `short page returned ${postings.length} rows at ${offset}/${total}`; break; }
    if (!fresh) { incompleteReason = `duplicate page before reported total (${offset}/${total})`; break; }
  }

  if (!complete && !incompleteReason) incompleteReason = `pagination cap reached at ${offset}/${total ?? 'unknown'}`;
  return { rows, total, pagesAttempted, pagesSucceeded, complete, incompleteReason };
}

if (process.argv.includes('--test')) {
  const now = Date.parse('2026-09-16T12:00:00Z');
  const fresh = fallbackDecision('2026-09-12T12:00:01Z', now, true);
  const boundary = fallbackDecision('2026-09-12T12:00:00Z', now, true);
  const missing = fallbackDecision(null, now, true);
  const empty = fallbackDecision(null, now, false);
  if (!fresh.active || fresh.expired) throw new Error('Iron Mountain fallback expired before 96 hours.');
  if (!boundary.expired) throw new Error('Iron Mountain fallback did not expire at 96 hours.');
  if (!missing.expired) throw new Error('Iron Mountain fallback without verification evidence did not fail closed.');
  if (empty.expired) throw new Error('Empty Iron Mountain snapshot incorrectly entered fallback expiry.');

  const newRelative = stablePostedAt('2 Days Ago', null, now);
  if (newRelative !== '2026-09-14T00:00:00.000Z') {
    throw new Error(`Iron Mountain relative posting-date normalization regressed: ${newRelative}`);
  }
  const sameDay = stablePostedAt('4 Days Ago', '2026-09-12T05:11:02.267Z', now);
  if (sameDay !== '2026-09-12T00:00:00.000Z') {
    throw new Error(`Iron Mountain posting-date clock stability regressed: ${sameDay}`);
  }
  const capped = stablePostedAt('30+ Days Ago', '2026-08-10T00:00:00.000Z', now);
  if (capped !== '2026-08-10T00:00:00.000Z') {
    throw new Error(`Iron Mountain 30+ day stability regressed: ${capped}`);
  }
  const missingLabel = stablePostedAt('', '2026-08-10T17:00:00.000Z', now);
  if (missingLabel !== '2026-08-10T00:00:00.000Z') {
    throw new Error(`Iron Mountain missing-label preservation regressed: ${missingLabel}`);
  }

  console.log('Iron Mountain collector fallback and posting-date regression tests passed.');
  process.exit(0);
}

const currentJobs = await readJson(JOBS_PATH, []);
const status = await readJson(STATUS_PATH, {});
const storedSnapshot = await readJson(SNAPSHOT_PATH, []);
const previousSnapshot = Array.isArray(storedSnapshot) ? storedSnapshot.filter(ironMountainJob) : [];
const previousPostedAtById = new Map();
for (const job of [...previousSnapshot, ...currentJobs.filter(ironMountainJob)]) {
  const id = clean(job?.id);
  const date = canonicalIsoDay(job?.postedAt);
  if (!id || !date) continue;
  const existing = previousPostedAtById.get(id);
  if (!existing || Date.parse(date) < Date.parse(existing)) previousPostedAtById.set(id, date);
}
const previousSource = status?.ironMountain && typeof status.ironMountain === 'object' ? status.ironMountain : {};
const previousLastHealthyAt = clean(previousSource.lastHealthyAt || previousSource.fallbackFreshness?.lastHealthyAt || '');
const checkedAt = new Date().toISOString();
const nowMs = Date.parse(checkedAt);
const diagnostics = {
  listingPagesAttempted: 0,
  listingPagesSucceeded: 0,
  listingComplete: false,
  listedTotal: null,
  candidateRows: 0,
  detailAttempted: 0,
  detailSucceeded: 0,
  qualifyingRoles: 0,
  snapshotRoles: 0,
  preservedPrevious: 0,
  removedExpiredFallback: 0,
  drops: { titleOrContext: 0, nonUs: 0, experienceUnknown: 0, experienceOver5: 0, invalidRequisition: 0, fetch: 0 }
};
const errors = [];
let transportHealthy = false;
let verified = [];

try {
  const listing = await listJobs();
  diagnostics.listingPagesAttempted = listing.pagesAttempted;
  diagnostics.listingPagesSucceeded = listing.pagesSucceeded;
  diagnostics.listingComplete = listing.complete;
  diagnostics.listedTotal = listing.total;
  transportHealthy = listing.pagesSucceeded > 0 && listing.rows.length > 0;
  if (!listing.complete) errors.push(`incomplete Workday listing: ${listing.incompleteReason}`);

  const candidates = listing.rows.filter(row => candidateTitle(row.title));
  diagnostics.candidateRows = candidates.length;

  for (let index = 0; index < candidates.length; index += DETAIL_BATCH) {
    const batch = candidates.slice(index, index + DETAIL_BATCH);
    const results = await Promise.all(batch.map(async row => {
      const publicUrl = sourceUrl(row);
      const apiUrl = detailUrl(row);
      diagnostics.detailAttempted += 1;
      if (!publicUrl || !apiUrl) {
        diagnostics.drops.invalidRequisition += 1;
        return null;
      }
      try {
        const detail = await fetchJson(apiUrl, { headers: { referer: publicUrl } });
        diagnostics.detailSucceeded += 1;
        const info = detail.jobPostingInfo || detail.jobInfo || detail;
        const description = clean(info.jobDescription || info.description || '');
        const location = locationFrom(row, info);
        if (!location) { diagnostics.drops.nonUs += 1; return null; }
        const { cls, reason } = classify(row.title, description);
        if (!cls) {
          if (reason === 'experience-unknown') diagnostics.drops.experienceUnknown += 1;
          else if (reason === 'experience-over-5') diagnostics.drops.experienceOver5 += 1;
          else diagnostics.drops.titleOrContext += 1;
          return null;
        }
        const reqId = requisitionId(row, info);
        if (!reqId || !publicUrl.toUpperCase().includes(`_${reqId}`)) {
          diagnostics.drops.invalidRequisition += 1;
          return null;
        }
        const jobId = `ironmountain-${reqId}`;
        return {
          id: jobId,
          title: clean(row.title),
          company: COMPANY,
          location,
          type: cls.type,
          experience: cls.experience,
          tags: tagsFor(row.title, description, cls),
          ...payFrom(description),
          postedAt: stablePostedAt(row.postedOn || row.posted || '', previousPostedAtById.get(jobId), nowMs),
          postedHours: 9999,
          source: 'Official Iron Mountain Careers',
          sourceUrl: publicUrl,
          active: true,
          demo: false
        };
      } catch (error) {
        diagnostics.drops.fetch += 1;
        if (errors.length < 25) errors.push(`detail ${clean(row.title)}: ${error.message}`);
        return null;
      }
    }));
    verified.push(...results.filter(Boolean));
  }
} catch (error) {
  errors.push(`listing: ${error.message}`);
}

verified = dedupe(verified);
diagnostics.qualifyingRoles = verified.length;
const authoritativeSnapshot = transportHealthy &&
  diagnostics.listingComplete === true &&
  diagnostics.detailAttempted === diagnostics.candidateRows &&
  diagnostics.detailSucceeded === diagnostics.detailAttempted &&
  diagnostics.drops.fetch === 0 &&
  diagnostics.drops.invalidRequisition === 0;

let nextSnapshot = [];
let lastHealthyAt = previousLastHealthyAt || null;
let fallbackFreshness;

if (authoritativeSnapshot) {
  nextSnapshot = verified;
  lastHealthyAt = checkedAt;
  fallbackFreshness = {
    active: false,
    expired: false,
    lastHealthyAt,
    checkedAt,
    expiresAt: new Date(nowMs + MAX_FALLBACK_AGE_MS).toISOString(),
    ageHours: 0,
    maxAgeHours: MAX_FALLBACK_AGE_HOURS,
    roles: nextSnapshot.length,
    policy: 'Retain only the last fully verified Iron Mountain snapshot for at most 96 hours after official-source verification fails.'
  };
} else {
  const fallback = fallbackDecision(lastHealthyAt, nowMs, previousSnapshot.length > 0);
  if (fallback.active) {
    nextSnapshot = previousSnapshot;
    diagnostics.preservedPrevious = previousSnapshot.length;
  } else {
    diagnostics.removedExpiredFallback = previousSnapshot.length;
  }
  fallbackFreshness = {
    active: fallback.active,
    expired: fallback.expired,
    lastHealthyAt: lastHealthyAt || null,
    checkedAt,
    expiresAt: fallback.expiresAt ? new Date(fallback.expiresAt).toISOString() : null,
    ageHours: fallback.ageHours === null ? null : Math.round(fallback.ageHours * 10) / 10,
    maxAgeHours: MAX_FALLBACK_AGE_HOURS,
    roles: nextSnapshot.length,
    policy: 'Retain only the last fully verified Iron Mountain snapshot for at most 96 hours after official-source verification fails.'
  };
}

diagnostics.snapshotRoles = nextSnapshot.length;
const withoutIronMountain = currentJobs.filter(job => !ironMountainJob(job));
const merged = dedupe([...withoutIronMountain, ...nextSnapshot]);
const countsByType = merged.reduce((acc, job) => { acc[job.type] = (acc[job.type] || 0) + 1; return acc; }, {});
const countsByExperience = merged.reduce((acc, job) => { acc[job.experience] = (acc[job.experience] || 0) + 1; return acc; }, {});

await writeFile(SNAPSHOT_PATH, JSON.stringify(nextSnapshot, null, 2) + '\n');
await writeFile(JOBS_PATH, JSON.stringify(merged, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify({
  ...status,
  jobs: merged.length,
  countsByType,
  countsByExperience,
  ironMountain: {
    officialSource: 'https://www.ironmountain.com/data-centers',
    boardUrl: `${ORIGIN}/${LOCALE}/${SITE}`,
    checkedAt,
    lastHealthyAt,
    transportHealthy,
    sourceHealthy: authoritativeSnapshot,
    authoritativeSnapshot,
    usedPreviousSnapshot: !authoritativeSnapshot && nextSnapshot.length > 0,
    ...diagnostics,
    fallbackFreshness,
    errors
  }
}, null, 2) + '\n');

console.log(
  `Iron Mountain collector: ${authoritativeSnapshot ? 'authoritative' : fallbackFreshness.active ? 'verified fallback' : 'fail-closed'}; ` +
  `${verified.length} qualifying this run, ${nextSnapshot.length} published snapshot roles, ${merged.length} total jobs.`
);
if (errors.length) console.warn(`Iron Mountain collector warnings: ${errors.slice(0, 5).join(' | ')}`);
