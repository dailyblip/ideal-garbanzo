import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const workdayBoards = [
  { company: 'Vantage Data Centers', origin: 'https://vantagedc.wd1.myworkdayjobs.com', tenant: 'vantagedc', site: 'Vantage', locale: 'en-US' },
  { company: 'QTS Data Centers', origin: 'https://qtsdatacenters.wd5.myworkdayjobs.com', tenant: 'qtsdatacenters', site: 'QTS', locale: 'en-US' },
  { company: 'CyrusOne', origin: 'https://cyrusone.wd1.myworkdayjobs.com', tenant: 'cyrusone', site: 'CyrusOneCareerPortal', locale: 'en-US' },
  { company: 'STACK Infrastructure', origin: 'https://stackinfra.wd108.myworkdayjobs.com', tenant: 'stackinfra', site: 'STACK_AMER', locale: 'en-US' },
  { company: 'NTT Global Data Centers', origin: 'https://nttglobaldatacenters.wd501.myworkdayjobs.com', tenant: 'nttglobaldatacenters', site: 'External', locale: 'en-US' },
  { company: 'Aligned Data Centers', origin: 'https://aligneddc.wd12.myworkdayjobs.com', tenant: 'aligneddc', site: 'aligneddc', locale: 'en-US' }
];

const strongTitleTerms = [
  'data center', 'data centre', 'critical facilities', 'critical facility',
  'critical environments', 'critical environment', 'electrical apprentice',
  'low voltage', 'fiber technician', 'fiber splicer', 'data cabling', 'structured cabling'
];
const contextualTitleTerms = [
  'electrician', 'technician', 'apprentice', 'trainee', 'intern', 'operator',
  'commissioning', 'facilities', 'facility', 'controls', 'mechanical', 'electrical',
  'maintenance', 'operations'
];
const dataCenterContextTerms = [
  'data center', 'data centre', 'critical facilities', 'critical facility', 'critical environments',
  'colocation', 'colo facility', 'server rack', 'server racks', 'white space', 'ups system',
  'uninterruptible power', 'switchgear', 'pdu', 'power distribution unit', 'generator',
  'crac', 'crah', 'chiller', 'cooling plant', 'raised floor', 'fiber infrastructure',
  'mission critical', 'mission-critical', 'bms', 'epms', 'dcim'
];
const excludedTitleTerms = [
  'senior', 'sr.', 'sr ', 'lead ', 'principal', 'manager', 'director', 'vice president',
  'vp ', 'head of', 'staff engineer', 'supervisor', 'superintendent', 'foreman', 'counsel',
  'attorney', 'designer', 'architect', 'recruiter', 'sales', 'account executive',
  'future opportunity', 'future opportunities', 'talent pool', 'general application',
  'express your interest'
];
const excludedDescriptionTerms = [
  'this is an evergreen requisition', 'evergreen requisition', 'talent pool application',
  'general interest application'
];
const earlyTerms = [
  'intern', 'internship', 'apprentice', 'apprenticeship', 'trainee', 'entry level', 'entry-level',
  'tier 1', 'level 1', 'level i', 'technician i', 'operator i', 'operator 1', 'junior',
  'associate', 'no experience', '0-2 years', '0–2 years', '1-2 years', '1–2 years',
  'training provided'
];
const midTerms = [
  '2+ years', '2 years', '3 years', '4 years', '5 years', '2-3 years', '2–3 years',
  '3-5 years', '3–5 years', 'technician ii', 'technician iii', 'operator ii', 'operator iii',
  'level 2', 'level ii', 'level 3', 'level iii', 'tier 2', 'tier 3', 'journeyman'
];

const clean = value => String(value ?? '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&#39;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ')
  .trim();
const lower = value => clean(value).toLowerCase();
const hasAny = (text, terms) => terms.some(term => text.includes(term));
const hash = value => crypto.createHash('sha1').update(value).digest('hex').slice(0, 14);
const normalizeIdentity = value => lower(value).replace(/[^a-z0-9]+/g, ' ').trim();

function titleCandidate(title = '') {
  const t = lower(title);
  return Boolean(t) && !hasAny(t, excludedTitleTerms) && (hasAny(t, strongTitleTerms) || hasAny(t, contextualTitleTerms));
}

function relevant(title, description = '') {
  const t = lower(title);
  const d = lower(description);
  if (!t || hasAny(t, excludedTitleTerms) || hasAny(d, excludedDescriptionTerms)) return false;
  if (hasAny(t, strongTitleTerms)) return true;
  return hasAny(t, contextualTitleTerms) && hasAny(d, dataCenterContextTerms);
}

function statedExperienceYears(text = '') {
  const values = [];
  const patterns = [
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\+?\s*(?:-|–|to)\s*(\d{1,2})\s+years?(?:\s+of)?\s+(?:relevant\s+|related\s+)?experience/gi,
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\+?\s+years?(?:\s+of)?\s+(?:relevant\s+|related\s+)?experience/gi,
    /experience(?:\s+of)?\s+(?:at least\s+|minimum(?: of)?\s+)?(\d{1,2})\+?\s+years?/gi
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      values.push(Number(match[1]));
      if (match[2]) values.push(Number(match[2]));
    }
  }
  return values.filter(Number.isFinite);
}

function classify(title, description = '', employmentType = '') {
  const text = lower(`${title} ${description}`);
  const t = lower(title);
  if (!relevant(title, description)) return null;

  const years = statedExperienceYears(text);
  if (years.some(year => year >= 6)) return null;

  let type = 'entry-level';
  const employment = lower(employmentType);
  if (t.includes('intern') || employment.includes('intern')) type = 'internship';
  else if (t.includes('apprentice')) type = 'apprenticeship';
  else if (t.includes('trainee')) type = 'trainee';

  let experience = '0-2-years';
  if (hasAny(text, ['no experience', 'entry level', 'entry-level'])) experience = 'no-experience';
  else if (/\b(?:iii|3)\b/.test(t) || t.includes('journeyman') || years.some(year => year >= 3) || hasAny(text, midTerms)) experience = '2-5-years';
  else if (hasAny(text, earlyTerms) || years.some(year => year <= 2)) experience = '0-2-years';

  return { type, experience };
}

function payObject(label = 'Pay not listed', min = null, max = null, interval = '') {
  const isHourly = /hour|hourly|hr/i.test(interval);
  const salarySortMax = Number.isFinite(max) ? (isHourly ? Math.round(max * 2080) : max) : null;
  return { pay: label, salaryMin: min, salaryMax: max, salarySortMax };
}

function extractPay(text = '') {
  const s = clean(text);
  const range = s.match(/\$([\d,.]+)\s*(?:-|–|to)\s*\$?([\d,.]+)\s*(?:\/|per\s+)?(hour|hourly|hr|year|yearly|yr|annum|annual|annually)?/i);
  if (!range) return payObject();
  const min = Number(range[1].replace(/,/g, ''));
  const max = Number(range[2].replace(/,/g, ''));
  const explicit = lower(range[3] || '');
  const annual = /year|yr|annum|annual/.test(explicit) || (!explicit && max >= 1000);
  return payObject(`$${range[1]}–$${range[2]} / ${annual ? 'year' : 'hr'}`, min, max, annual ? 'year' : 'hour');
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
  if (hasAny(text, ['training provided', 'on-the-job training', 'on the job training', 'mentorship'])) tags.push('Training / Mentorship');
  if (hasAny(text, ['electrical', 'electrician', 'ups', 'switchgear', 'epms'])) tags.push('Electrical');
  if (hasAny(text, ['fiber', 'cabling', 'network'])) tags.push('Network / Cabling');
  if (hasAny(text, ['critical facilities', 'critical environments', 'hvac', 'generator', 'mechanical', 'chiller', 'crah', 'crac', 'bms'])) tags.push('Critical Facilities');
  return [...new Set(tags)].slice(0, 5);
}

function relativePostedAt(label = '') {
  const text = lower(label);
  const now = Date.now();
  if (!text) return null;
  if (text.includes('today')) return new Date(now).toISOString();
  if (text.includes('yesterday')) return new Date(now - 864e5).toISOString();
  const match = text.match(/(\d+)\+?\s+days?\s+ago/);
  if (match) return new Date(now - Number(match[1]) * 864e5).toISOString();
  return null;
}

async function fetchJson(url, options = {}) {
  const headers = {
    accept: 'application/json',
    'user-agent': 'DataCenterCareersBot/1.3 (+https://datacentercareers.us/)',
    ...(options.headers || {})
  };
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

async function listWorkday(board) {
  const endpoint = `${board.origin}/wday/cxs/${board.tenant}/${board.site}/jobs`;
  const postings = [];
  const seen = new Set();
  let offset = 0;
  let total = null;
  let pagesAttempted = 0;
  let pagesSucceeded = 0;
  let complete = false;
  let incompleteReason = '';

  for (let page = 0; page < 100; page += 1) {
    if (Number.isFinite(total) && offset >= total) {
      complete = true;
      break;
    }

    pagesAttempted += 1;
    const payload = await fetchJson(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        referer: `${board.origin}/${board.locale}/${board.site}`
      },
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: '' })
    });
    pagesSucceeded += 1;

    const rows = Array.isArray(payload.jobPostings) ? payload.jobPostings : [];
    if (page === 0) {
      const reported = Number(payload.total);
      if (!Number.isFinite(reported) || reported < 0) {
        incompleteReason = 'Workday did not return a valid total count';
        break;
      }
      total = reported;
      if (total === 0) {
        complete = true;
        break;
      }
    }

    let fresh = 0;
    for (const row of rows) {
      const key = row.externalPath || row.bulletFields?.[0] || `${row.title}|${row.locationsText}`;
      if (seen.has(key)) continue;
      seen.add(key);
      postings.push(row);
      fresh += 1;
    }

    offset += rows.length;
    if (offset >= total) {
      complete = true;
      break;
    }
    if (rows.length === 0) {
      incompleteReason = `listing ended at ${offset}/${total} rows`;
      break;
    }
    if (rows.length < 20) {
      incompleteReason = `short page returned ${rows.length} rows at ${offset}/${total}`;
      break;
    }
    if (fresh === 0) {
      incompleteReason = `duplicate page before reaching reported total (${offset}/${total})`;
      break;
    }
  }

  if (!complete && !incompleteReason) {
    incompleteReason = `pagination cap reached at ${offset}/${Number.isFinite(total) ? total : 'unknown'} rows`;
  }

  return {
    postings,
    total: Number.isFinite(total) ? total : null,
    pagesAttempted,
    pagesSucceeded,
    complete,
    incompleteReason
  };
}

async function collectWorkday(board, previousCompanyJobs = []) {
  const listing = await listWorkday(board);
  if (!listing.complete) {
    return {
      jobs: previousCompanyJobs,
      errors: [`incomplete Workday listing (${listing.incompleteReason}); kept previous employer snapshot`],
      listing,
      usedFallback: true
    };
  }

  const rows = listing.postings.filter(row => titleCandidate(row.title));
  const jobs = [];
  const errors = [];
  const previousByUrl = new Map(previousCompanyJobs.map(job => [clean(job.sourceUrl), job]));

  // Detail requests are intentionally limited to plausible hands-on titles.
  // A transient detail failure may preserve only a role that is still present
  // in the current complete Workday listing. Closed roles still disappear.
  for (let index = 0; index < rows.length; index += 5) {
    const batch = rows.slice(index, index + 5);
    const hydrated = await Promise.all(batch.map(async row => {
      const sourceUrl = `${board.origin}/${board.locale}/${board.site}${row.externalPath}`;
      try {
        const detailUrl = `${board.origin}/wday/cxs/${board.tenant}/${board.site}${row.externalPath}`;
        const detail = await fetchJson(detailUrl, { headers: { referer: sourceUrl } });
        const info = detail.jobInfo || detail;
        const description = clean(info.jobDescription || info.description || '');
        const cls = classify(row.title, description, info.timeType || '');
        if (!cls) return { job: null, error: null };
        const location = clean(row.locationsText || info.location || 'Location not listed');
        const externalId = clean(row.bulletFields?.[0] || row.externalPath?.split('_').pop() || hash(row.externalPath || row.title));
        return {
          job: {
            id: `workday-${board.tenant}-${externalId}`,
            title: clean(row.title),
            company: board.company,
            location,
            type: cls.type,
            experience: cls.experience,
            tags: tagsFor(row.title, description, cls.experience, cls.type),
            ...extractPay(description),
            postedAt: relativePostedAt(row.postedOn),
            source: 'Employer career site',
            sourceUrl,
            active: true,
            demo: false
          },
          error: null
        };
      } catch (error) {
        const previous = previousByUrl.get(clean(sourceUrl));
        return {
          job: previous || null,
          error: `${clean(row.title)}: ${error.message}${previous ? ' (kept previous verified record because role remains listed)' : ''}`
        };
      }
    }));

    for (const result of hydrated) {
      if (result.job) jobs.push(result.job);
      if (result.error) errors.push(result.error);
    }
  }

  return { jobs, errors, listing, usedFallback: false };
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

const baseJobs = await readJson('data/jobs.json', []);
const previousMajor = await readJson('data/major-jobs.json', []);
const priorStatus = await readJson('data/collector-status.json', {});
const majorJobs = [];
const errors = [];
const employerDiagnostics = {};
let succeeded = 0;
let detailFailures = 0;
let listingFallbacks = 0;

for (const board of workdayBoards) {
  const previousCompanyJobs = previousMajor.filter(job => job.company === board.company);
  try {
    const result = await collectWorkday(board, previousCompanyJobs);
    majorJobs.push(...result.jobs);
    detailFailures += result.errors.filter(error => !error.startsWith('incomplete Workday listing')).length;
    errors.push(...result.errors.map(error => `${board.company}: ${error}`));

    if (result.usedFallback) listingFallbacks += 1;
    else succeeded += 1;

    employerDiagnostics[board.company] = {
      sourceHealthy: !result.usedFallback,
      listingComplete: result.listing.complete,
      reportedRows: result.listing.total,
      uniqueRows: result.listing.postings.length,
      pagesAttempted: result.listing.pagesAttempted,
      pagesSucceeded: result.listing.pagesSucceeded,
      qualifyingRoles: result.jobs.length,
      usedPreviousSnapshot: result.usedFallback,
      ...(result.listing.incompleteReason ? { incompleteReason: result.listing.incompleteReason } : {})
    };
  } catch (error) {
    listingFallbacks += 1;
    errors.push(`${board.company}: ${error.message} (kept previous employer snapshot)`);
    majorJobs.push(...previousCompanyJobs);
    employerDiagnostics[board.company] = {
      sourceHealthy: false,
      listingComplete: false,
      qualifyingRoles: previousCompanyJobs.length,
      usedPreviousSnapshot: true,
      error: error.message
    };
  }
}

const majorSnapshot = dedupe(majorJobs);
if (!succeeded && !majorSnapshot.length) {
  throw new Error(`All major-employer collectors failed and no prior snapshot exists: ${errors.join(' | ')}`);
}

// Reconciliation runs immediately after this script and makes majorSnapshot
// authoritative for these six employers. Keeping baseJobs here preserves the
// existing pipeline contract while still allowing the next step to remove stale
// major-employer records safely.
const merged = dedupe([...baseJobs, ...majorSnapshot]);
const now = Date.now();
for (const job of merged) {
  job.postedHours = job.postedAt ? Math.max(0, Math.round((now - new Date(job.postedAt).getTime()) / 36e5)) : 9999;
}
merged.sort((a, b) => (a.postedHours ?? 9999) - (b.postedHours ?? 9999));

const countsByType = merged.reduce((acc, job) => {
  acc[job.type] = (acc[job.type] || 0) + 1;
  return acc;
}, {});
const countsByExperience = merged.reduce((acc, job) => {
  acc[job.experience] = (acc[job.experience] || 0) + 1;
  return acc;
}, {});

await writeFile('data/major-jobs.json', JSON.stringify(majorSnapshot, null, 2) + '\n');
await writeFile('data/jobs.json', JSON.stringify(merged, null, 2) + '\n');
await writeFile('data/collector-status.json', JSON.stringify({
  ...priorStatus,
  updatedAt: new Date().toISOString(),
  jobs: merged.length,
  sourcesAttempted: Number(priorStatus.sourcesAttempted || 0) + workdayBoards.length,
  providers: {
    ...(priorStatus.providers || {}),
    workday: workdayBoards.length
  },
  majorSources: {
    attempted: workdayBoards.length,
    succeeded,
    listingFallbacks,
    detailFailures,
    employers: workdayBoards.map(board => board.company),
    jobs: majorSnapshot.length,
    employerDiagnostics
  },
  countsByType,
  countsByExperience,
  errors: [...(priorStatus.errors || []), ...errors]
}, null, 2) + '\n');

console.log(`Merged ${majorSnapshot.length} qualifying jobs from ${succeeded}/${workdayBoards.length} complete major Workday scans; ${listingFallbacks} employer snapshot fallback(s), ${detailFailures} detail fetch failure(s); ${merged.length} total jobs.`);
