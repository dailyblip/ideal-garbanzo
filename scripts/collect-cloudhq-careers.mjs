import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const SNAPSHOT_PATH = 'data/cloudhq-jobs.json';
const COMPANY = 'CloudHQ';
const OFFICIAL_CAREERS = 'https://cloudhq.com/careers/';
const BOARD_GUID = 'd38e9867-3cd9-4254-b3ff-46e251ca1eee';
const BOARD_URL = `https://recruiting.paylocity.com/recruiting/jobs/All/${BOARD_GUID}/CloudHQ-LLC`;
const FEED_URL = `https://recruiting.paylocity.com/recruiting/v2/api/feed/jobs/${BOARD_GUID}`;
const MAX_FALLBACK_AGE_HOURS = 96;
const VERIFIED_DIRECT_CANDIDATES = [
  {
    jobId: 4007666,
    title: 'Mission Critical Coordinator',
    city: 'Ashburn',
    state: 'VA',
    sourceUrl: 'https://recruiting.paylocity.com/recruiting/jobs/Details/4007666/CloudHQ-LLC/Mission-Critical-Coordinator'
  }
];
const US_STATE_CODES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI',
  'MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT',
  'VT','VA','WA','WV','WI','WY','DC'
]);

const clean = value => String(value ?? '')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&quot;/gi, '"')
  .replace(/&#8211;|&ndash;/gi, '–')
  .replace(/&#8212;|&mdash;/gi, '—')
  .replace(/\s+/g, ' ')
  .trim();
const lower = value => clean(value).toLowerCase();

const missionTitlePattern = /\b(?:mission critical coordinator|building technician(?:\s+[i1])?|critical (?:facilities|facility|operations) technician(?:\s+[i1v]{1,3})?|data cent(?:er|re) (?:facilities |facility |operations )?technician(?:\s+[i1v]{1,3})?|facilities (?:assistant|technician)(?:\s+[i1v]{1,3})?|operations technician(?:\s+[i1v]{1,3})?|controls technician(?:\s+[i1v]{1,3})?|commissioning engineer(?:\s+[i1v]{1,3})?|project engineer(?:\s+[i1v]{1,3})?)\b/i;
const excludedTitlePattern = /\b(?:senior|sr\.?|lead|leader|principal|chief|manager|mgr\.?|director|vice president|vp|head of|staff|supervisor|superintendent|foreman|architect|sales|account executive)\b/i;
const missionContextPattern = /\bdata cent(?:er|re)s?\b/i;
const infrastructureContextPattern = /\b(?:critical infrastructure|critical systems?|electrical|mechanical|power|generator|ups|switchgear|hvac|chiller|bms|epms|dcim|facilit(?:y|ies)|operations?|commissioning|controls?|maintenance|troubleshooting)\b/i;
const explicitEntryPattern = /\b(?:entry[- ]level|early[- ]career|no (?:prior )?experience|required experience\s*:\s*none|great learning opportunity for an entry level candidate|high school diploma|ged)\b/i;

function fallbackState({ sourceHealthy, previousLastHealthyAt, nowMs = Date.now() }) {
  if (sourceHealthy) {
    return {
      lastHealthyAt: new Date(nowMs).toISOString(),
      fallbackAgeHours: 0,
      fallbackExpired: false
    };
  }

  const lastHealthyMs = Date.parse(String(previousLastHealthyAt || ''));
  if (!Number.isFinite(lastHealthyMs)) {
    return {
      lastHealthyAt: null,
      fallbackAgeHours: null,
      fallbackExpired: true
    };
  }

  const ageHours = Math.max(0, (nowMs - lastHealthyMs) / 3_600_000);
  return {
    lastHealthyAt: new Date(lastHealthyMs).toISOString(),
    fallbackAgeHours: Math.round(ageHours * 100) / 100,
    fallbackExpired: ageHours >= MAX_FALLBACK_AGE_HOURS
  };
}

function runFreshnessSelfTest() {
  const nowMs = Date.parse('2026-09-16T12:00:00.000Z');
  const healthy = fallbackState({ sourceHealthy: true, previousLastHealthyAt: null, nowMs });
  if (healthy.fallbackExpired || healthy.fallbackAgeHours !== 0 || healthy.lastHealthyAt !== '2026-09-16T12:00:00.000Z') {
    throw new Error('CloudHQ healthy-source freshness regression failed.');
  }

  const freshFallback = fallbackState({
    sourceHealthy: false,
    previousLastHealthyAt: new Date(nowMs - 95 * 3_600_000).toISOString(),
    nowMs
  });
  if (freshFallback.fallbackExpired || freshFallback.fallbackAgeHours !== 95) {
    throw new Error('CloudHQ verified fallback should remain publishable inside 96 hours.');
  }

  const boundaryFallback = fallbackState({
    sourceHealthy: false,
    previousLastHealthyAt: new Date(nowMs - MAX_FALLBACK_AGE_HOURS * 3_600_000).toISOString(),
    nowMs
  });
  if (!boundaryFallback.fallbackExpired) {
    throw new Error('CloudHQ fallback must fail closed at the 96-hour boundary.');
  }

  const missingAnchor = fallbackState({ sourceHealthy: false, previousLastHealthyAt: null, nowMs });
  if (!missingAnchor.fallbackExpired || missingAnchor.lastHealthyAt !== null) {
    throw new Error('CloudHQ fallback without a verification anchor must fail closed.');
  }

  console.log('CloudHQ fallback freshness regression tests passed.');
}

if (process.argv.includes('--test-freshness')) {
  runFreshnessSelfTest();
  process.exit(0);
}

function requiredExperienceYears(text = '') {
  const normalized = lower(text);
  const years = [];
  const patterns = [
    /(?:minimum(?: of)?|at least|requires?|required|must have|you have|you bring)\D{0,45}(\d{1,2})\+?\s*(?:-|–|to)?\s*(\d{1,2})?\s*years?/gi,
    /(\d{1,2})\+?\s*(?:-|–|to)\s*(\d{1,2})\s+years?\s+(?:of\s+)?(?:relevant\s+|related\s+|professional\s+|hands-on\s+|data cent(?:er|re)\s+|mission critical\s+)?experience/gi,
    /(\d{1,2})\+?\s+years?\s+(?:of\s+)?(?:relevant\s+|related\s+|professional\s+|hands-on\s+|data cent(?:er|re)\s+|mission critical\s+)?experience/gi
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const minimum = Number(match[1]);
      if (Number.isFinite(minimum)) years.push(minimum);
    }
  }
  return years;
}

function classify(title, description, requirements) {
  const titleText = clean(title);
  const evidence = clean(`${description} ${requirements}`);
  if (!missionTitlePattern.test(titleText) || excludedTitlePattern.test(titleText)) return null;
  if (!missionContextPattern.test(evidence) || !infrastructureContextPattern.test(evidence)) return null;
  const years = requiredExperienceYears(evidence);
  if (years.some(year => year >= 6)) return null;
  if (years.some(year => year >= 3)) return { type: 'entry-level', experience: '2-5-years' };
  if (years.some(year => year >= 1)) return { type: 'entry-level', experience: '0-2-years' };
  if (explicitEntryPattern.test(evidence)) return { type: 'entry-level', experience: 'no-experience' };
  return null;
}

function locationFor(raw = {}) {
  const location = raw?.jobLocation || {};
  const city = clean(location.city);
  const state = clean(location.state).toUpperCase();
  if (!city || !US_STATE_CODES.has(state)) return '';
  return `${city}, ${state}`;
}

function postedAtFor(raw = {}) {
  const parsed = Date.parse(String(raw?.publishedDate || raw?.createdUtc || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function postedHoursFor(postedAt) {
  if (!postedAt) return 9999;
  const diff = Math.floor((Date.now() - Date.parse(postedAt)) / 3_600_000);
  return Number.isFinite(diff) && diff >= 0 ? diff : 0;
}

function tagsFor(title, description, requirements, experience) {
  const text = lower(`${title} ${description} ${requirements}`);
  const tags = [experience === 'no-experience' ? 'No Experience Needed' : experience === '2-5-years' ? '2–5 Years' : '0–2 Years'];
  if (/\b(?:electrical|mechanical|power|generator|ups|switchgear|hvac|chiller|critical infrastructure|critical systems?)\b/.test(text)) tags.push('Critical Facilities');
  if (/\b(?:training|learn(?:ing)?|mentorship|entry[- ]level|career development)\b/.test(text)) tags.push('Training / Mentorship');
  if (/\b(?:controls?|bms|epms|dcim)\b/.test(text)) tags.push('Controls / DCIM');
  if (/\bcommissioning\b/.test(text)) tags.push('Commissioning');
  return [...new Set(tags)].slice(0, 5);
}

function officialDetailUrl(raw = {}) {
  const candidate = clean(raw?.displayUrl || raw?.applyUrl);
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'recruiting.paylocity.com') return '';
    if (!/^\/recruiting\/jobs\/(?:details|apply)\/\d+/i.test(parsed.pathname)) return '';
    return parsed.href;
  } catch {
    return '';
  }
}

async function fetchDirectCandidates() {
  const jobs = [];
  const inactive = [];
  const failures = [];
  for (const candidate of VERIFIED_DIRECT_CANDIDATES) {
    try {
      const response = await fetch(candidate.sourceUrl, {
        redirect: 'follow',
        headers: { 'user-agent': 'DataCenterCareersBot/1.5 (+https://datacentercareers.us/)' },
        signal: AbortSignal.timeout(20000)
      });
      const finalUrl = response.url || candidate.sourceUrl;
      if (!response.ok) {
        failures.push(`${candidate.jobId}: HTTP ${response.status}`);
        continue;
      }
      if (/\/jobnotfound(?:$|[/?#])/i.test(finalUrl)) {
        inactive.push(candidate.jobId);
        continue;
      }
      const html = await response.text();
      const text = clean(html);
      if (!text || !lower(text).includes(lower(candidate.title)) || !/\bcloudhq\b/i.test(text)) {
        failures.push(`${candidate.jobId}: direct role identity mismatch`);
        continue;
      }
      jobs.push({
        jobId: candidate.jobId,
        title: candidate.title,
        displayUrl: candidate.sourceUrl,
        applyUrl: candidate.sourceUrl.replace('/Details/', '/Apply/'),
        publishedDate: null,
        description: text,
        requirements: text,
        jobLocation: { city: candidate.city, state: candidate.state },
        salaryDescription: ''
      });
    } catch (error) {
      failures.push(`${candidate.jobId}: ${error?.message || error}`);
    }
  }
  if (failures.length) {
    throw new Error(`CloudHQ direct-role verification failed: ${failures.join('; ')}`);
  }
  return { jobs, inactive };
}

async function fetchSourceJobs() {
  const response = await fetch(FEED_URL, {
    redirect: 'follow',
    headers: {
      accept: 'application/json',
      'user-agent': 'DataCenterCareersBot/1.5 (+https://datacentercareers.us/)'
    },
    signal: AbortSignal.timeout(25000)
  });
  if (!response.ok) throw new Error(`CloudHQ Paylocity feed returned HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.jobs)) {
    throw new Error('CloudHQ Paylocity feed did not return a jobs array');
  }
  const displayName = clean(payload.displayName);
  if (displayName && displayName !== BOARD_GUID && !/cloudhq/i.test(displayName)) {
    throw new Error(`CloudHQ Paylocity feed identity mismatch: ${displayName}`);
  }
  if (payload.jobs.length) {
    return { jobs: payload.jobs, mode: 'paylocity-feed', feedListedJobs: payload.jobs.length, inactiveCandidateIds: [] };
  }
  const fallback = await fetchDirectCandidates();
  return {
    jobs: fallback.jobs,
    mode: 'verified-direct-role-fallback',
    feedListedJobs: 0,
    inactiveCandidateIds: fallback.inactive
  };
}

let jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
if (!Array.isArray(jobs)) throw new Error('jobs.json must contain an array');
let status = {};
try { status = JSON.parse(await readFile(STATUS_PATH, 'utf8')); } catch {}
const previousSourceStatus = status?.cloudHqCareers || {};
let previousSnapshot = [];
try {
  previousSnapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
  if (!Array.isArray(previousSnapshot)) previousSnapshot = [];
} catch {}

const checkedAt = new Date().toISOString();
let sourceResult = null;
let sourceError = '';
try {
  sourceResult = await fetchSourceJobs();
} catch (error) {
  sourceError = error?.message || String(error);
}
const sourceHealthy = Boolean(sourceResult);
const previousAnchor = previousSourceStatus?.lastHealthyAt
  || (previousSourceStatus?.sourceHealthy === true ? previousSourceStatus?.checkedAt : null);
const freshness = fallbackState({
  sourceHealthy,
  previousLastHealthyAt: previousAnchor,
  nowMs: Date.parse(checkedAt)
});
const rawJobs = sourceHealthy ? sourceResult.jobs : [];
const drops = { nonUs: 0, titleOrContext: 0, experience: 0, missingDirectUrl: 0 };
const qualifying = [];

for (const raw of rawJobs) {
  const title = clean(raw?.title);
  const description = clean(raw?.description);
  const requirements = clean(raw?.requirements);
  const location = locationFor(raw);
  if (!location) {
    drops.nonUs += 1;
    continue;
  }
  if (!missionTitlePattern.test(title) || excludedTitlePattern.test(title) || !missionContextPattern.test(`${description} ${requirements}`) || !infrastructureContextPattern.test(`${description} ${requirements}`)) {
    drops.titleOrContext += 1;
    continue;
  }
  const cls = classify(title, description, requirements);
  if (!cls) {
    drops.experience += 1;
    continue;
  }
  const sourceUrl = officialDetailUrl(raw);
  if (!sourceUrl) {
    drops.missingDirectUrl += 1;
    continue;
  }
  const postedAt = postedAtFor(raw);
  qualifying.push({
    id: `cloudhq-${String(raw?.jobId || '').trim() || new URL(sourceUrl).pathname.split('/').filter(Boolean)[3]}`,
    title,
    company: COMPANY,
    location,
    type: cls.type,
    experience: cls.experience,
    tags: tagsFor(title, description, requirements, cls.experience),
    pay: clean(raw?.salaryDescription),
    salaryMin: null,
    salaryMax: null,
    salarySortMax: null,
    postedAt,
    postedHours: postedHoursFor(postedAt),
    source: 'Official CloudHQ Paylocity careers',
    sourceUrl,
    active: true,
    demo: false
  });
}

const unique = [];
const seenUrls = new Set();
for (const job of qualifying) {
  if (seenUrls.has(job.sourceUrl)) continue;
  seenUrls.add(job.sourceUrl);
  unique.push(job);
}

const fallbackActive = !sourceHealthy && !freshness.fallbackExpired && previousSnapshot.length > 0;
const selected = sourceHealthy ? unique : fallbackActive ? previousSnapshot : [];
if (sourceHealthy || freshness.fallbackExpired) {
  await writeFile(SNAPSHOT_PATH, JSON.stringify(selected, null, 2) + '\n');
}

jobs = jobs.filter(job => String(job?.company || '').trim() !== COMPANY);
const existingUrls = new Set(jobs.map(job => String(job?.sourceUrl || '')).filter(Boolean));
for (const job of selected) {
  if (existingUrls.has(job.sourceUrl)) continue;
  jobs.push(job);
  existingUrls.add(job.sourceUrl);
}

status.cloudHqCareers = {
  checkedAt,
  lastHealthyAt: freshness.lastHealthyAt,
  officialCareers: OFFICIAL_CAREERS,
  boardUrl: BOARD_URL,
  feedUrl: FEED_URL,
  sourceHealthy,
  mode: sourceHealthy ? sourceResult.mode : fallbackActive ? 'verified-snapshot-fallback' : 'fail-closed',
  feedListedJobs: sourceHealthy ? sourceResult.feedListedJobs : 0,
  directCandidatesChecked: sourceHealthy ? VERIFIED_DIRECT_CANDIDATES.length : 0,
  inactiveCandidateIds: sourceHealthy ? sourceResult.inactiveCandidateIds : [],
  listedJobs: rawJobs.length,
  qualifyingRoles: sourceHealthy ? unique.length : 0,
  publishedRoles: selected.length,
  fallbackMaxAgeHours: MAX_FALLBACK_AGE_HOURS,
  fallbackAgeHours: freshness.fallbackAgeHours,
  fallbackExpired: !sourceHealthy && freshness.fallbackExpired,
  usedPreviousSnapshot: fallbackActive,
  preservedPrevious: fallbackActive ? previousSnapshot.length : 0,
  removedExpiredFallback: !sourceHealthy && freshness.fallbackExpired ? previousSnapshot.length : 0,
  fallbackPolicy: `Retain the last fully verified CloudHQ snapshot for at most ${MAX_FALLBACK_AGE_HOURS} hours after official-source failure; then remove CloudHQ roles until fresh verification succeeds.`,
  drops,
  errors: sourceError ? [sourceError] : []
};
status.jobs = jobs.length;

await writeFile(JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

if (sourceHealthy) {
  console.log(`CloudHQ careers: ${rawJobs.length} official role(s) checked via ${sourceResult.mode}; ${unique.length} qualifying U.S. 0–5 year infrastructure role(s).`);
} else if (fallbackActive) {
  console.warn(`CloudHQ source unavailable (${sourceError}); preserved ${selected.length} verified role(s) inside the ${MAX_FALLBACK_AGE_HOURS}-hour fallback window.`);
} else {
  console.warn(`CloudHQ source unavailable (${sourceError}); fallback expired or unavailable, publishing 0 CloudHQ roles.`);
}
