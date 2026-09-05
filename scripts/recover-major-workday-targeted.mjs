import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

// Some Workday boards do not surface every relevant role consistently in an
// unfiltered listing. This recovery pass uses official employer Workday search
// endpoints to find mission-fit roles that the authoritative daily scan may
// temporarily miss. It is additive only: it never keeps or removes a role on
// its own, and every recovered role is detail-verified on the employer board.
const boards = [
  { company: 'Vantage Data Centers', origin: 'https://vantagedc.wd1.myworkdayjobs.com', tenant: 'vantagedc', site: 'Vantage', locale: 'en-US' },
  { company: 'QTS Data Centers', origin: 'https://qtsdatacenters.wd5.myworkdayjobs.com', tenant: 'qtsdatacenters', site: 'QTS', locale: 'en-US' },
  { company: 'CyrusOne', origin: 'https://cyrusone.wd1.myworkdayjobs.com', tenant: 'cyrusone', site: 'CyrusOneCareerPortal', locale: 'en-US' },
  { company: 'STACK Infrastructure', origin: 'https://stackinfra.wd108.myworkdayjobs.com', tenant: 'stackinfra', site: 'STACK_AMER', locale: 'en-US' },
  { company: 'NTT Global Data Centers', origin: 'https://nttglobaldatacenters.wd501.myworkdayjobs.com', tenant: 'nttglobaldatacenters', site: 'External', locale: 'en-US' },
  { company: 'Aligned Data Centers', origin: 'https://aligneddc.wd12.myworkdayjobs.com', tenant: 'aligneddc', site: 'aligneddc', locale: 'en-US' }
];

const searchTerms = [
  'data center',
  'critical facilities',
  'critical environment',
  'mechanical engineer',
  'electrical engineer',
  'technician',
  'intern',
  'apprentice',
  'trainee'
];

const strongTitleTerms = [
  'data center', 'data centre', 'critical facilities', 'critical facility',
  'critical environment', 'critical environments', 'electrical apprentice',
  'fiber technician', 'data cabling', 'structured cabling'
];
const contextualTitleTerms = [
  'electrician', 'technician', 'apprentice', 'trainee', 'intern', 'operator',
  'commissioning', 'facilities', 'facility', 'controls', 'mechanical', 'electrical',
  'maintenance', 'operations'
];
const contextTerms = [
  'data center', 'data centre', 'critical facilities', 'critical facility',
  'critical environment', 'critical environments', 'colocation', 'mission critical',
  'mission-critical', 'ups', 'switchgear', 'generator', 'chiller', 'crah', 'crac',
  'bms', 'epms', 'dcim', 'power distribution', 'cooling plant', 'server rack'
];
const excludedTitleTerms = [
  'senior', 'sr.', 'sr ', 'lead ', 'principal', 'manager', 'director', 'vice president',
  'vp ', 'head of', 'staff engineer', 'supervisor', 'superintendent', 'foreman',
  'counsel', 'attorney', 'recruiter', 'sales', 'account executive', 'architect',
  'future opportunity', 'future opportunities', 'talent pool', 'general application',
  'express your interest'
];

const clean = value => String(value ?? '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&#39;/gi, "'")
  .replace(/&quot;/gi, '"')
  .replace(/\s+/g, ' ')
  .trim();
const lower = value => clean(value).toLowerCase();
const hasAny = (text, terms) => terms.some(term => text.includes(term));
const normalizeIdentity = value => lower(value).replace(/[^a-z0-9]+/g, ' ').trim();
const hash = value => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 14);

const experienceNumberWords = new Map([
  ['zero', '0'], ['one', '1'], ['two', '2'], ['three', '3'], ['four', '4'], ['five', '5'],
  ['six', '6'], ['seven', '7'], ['eight', '8'], ['nine', '9'], ['ten', '10']
]);

function requiredExperienceText(description = '') {
  const text = clean(description);
  const preferred = text.search(/\b(?:preferred qualifications?|preferred experience|preferred skills?|nice to have|bonus qualifications?)\b/i);
  return preferred >= 0 ? text.slice(0, preferred) : text;
}

function statedExperienceYears(text = '') {
  const normalized = lower(text).replace(
    /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/g,
    word => experienceNumberWords.get(word) || word
  );
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

function relevant(title = '', description = '') {
  const t = lower(title);
  const d = lower(description);
  if (!t || hasAny(t, excludedTitleTerms)) return false;
  if (hasAny(t, strongTitleTerms)) return true;
  return hasAny(t, contextualTitleTerms) && hasAny(d, contextTerms);
}

function classify(title = '', description = '', employmentType = '') {
  if (!relevant(title, description)) return null;
  const t = lower(title);
  const required = lower(`${title} ${requiredExperienceText(description)}`);
  const years = statedExperienceYears(required);
  if (years.some(year => year > 5)) return null;

  let type = 'entry-level';
  const employment = lower(employmentType);
  if (t.includes('intern') || employment.includes('intern')) type = 'internship';
  else if (t.includes('apprentice')) type = 'apprenticeship';
  else if (t.includes('trainee')) type = 'trainee';

  const explicitProgram = type !== 'entry-level';
  const earlySignal = explicitProgram
    || /\b(?:entry[- ]level|early career|no experience)\b/i.test(required)
    || /\b(?:l|level)\s*(?:1|i)\b/i.test(t)
    || /\b(?:technician|operator)\s+(?:1|i)\b/i.test(t)
    || years.some(year => year <= 2);
  const midSignal = /\b(?:l|level)\s*(?:2|3|ii|iii)\b/i.test(t)
    || /\b(?:technician|operator)\s+(?:2|3|ii|iii)\b/i.test(t)
    || t.includes('journeyman')
    || years.some(year => year >= 3 && year <= 5);

  // Fail closed when the official detail page gives us no reliable signal that
  // a regular position belongs in the site's 0-5 year audience.
  if (!years.length && !earlySignal && !midSignal) return null;

  let experience = '0-2-years';
  if (/\bno experience\b/i.test(required)) experience = 'no-experience';
  else if (midSignal) experience = '2-5-years';
  return { type, experience };
}

function confidentUsLocation(value = '') {
  const text = clean(value);
  if (!text) return false;
  if (/\b(?:united states(?: of america)?|usa|u\.s\.a\.|u\.s\.)\b/i.test(text)) return true;
  const states = [
    'Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut','Delaware','Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa','Kansas','Kentucky','Louisiana','Maine','Maryland','Massachusetts','Michigan','Minnesota','Mississippi','Missouri','Montana','Nebraska','Nevada','New Hampshire','New Jersey','New Mexico','New York','North Carolina','North Dakota','Ohio','Oklahoma','Oregon','Pennsylvania','Rhode Island','South Carolina','South Dakota','Tennessee','Texas','Utah','Vermont','Virginia','Washington','West Virginia','Wisconsin','Wyoming','District of Columbia'
  ];
  if (states.some(state => new RegExp(`\\b${state.replace(/ /g, '\\s+')}\\b`, 'i').test(text))) return true;
  const codes = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY']);
  const match = text.match(/,\s*([A-Z]{2})(?:\b|\s|$)/);
  return Boolean(match && codes.has(match[1]));
}

function extractPay(text = '') {
  const s = clean(text);
  const match = s.match(/\$([\d,.]+)\s*(?:-|–|to)\s*\$?([\d,.]+)\s*(?:\/|per\s+)?(hour|hourly|hr|year|yearly|yr|annum|annual|annually)?/i);
  if (!match) return { pay: 'Pay not listed', salaryMin: null, salaryMax: null, salarySortMax: null };
  const min = Number(match[1].replace(/,/g, ''));
  const max = Number(match[2].replace(/,/g, ''));
  const explicit = lower(match[3] || '');
  const annual = /year|yr|annum|annual/.test(explicit) || (!explicit && max >= 1000);
  return {
    pay: `$${match[1]}–$${match[2]} / ${annual ? 'year' : 'hr'}`,
    salaryMin: min,
    salaryMax: max,
    salarySortMax: annual ? max : Math.round(max * 2080)
  };
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
  if (hasAny(text, ['electrical', 'electrician', 'ups', 'switchgear', 'epms'])) tags.push('Electrical');
  if (hasAny(text, ['mechanical', 'hvac', 'generator', 'chiller', 'crah', 'crac', 'bms', 'critical facilities', 'critical environment'])) tags.push('Critical Facilities');
  if (hasAny(text, ['fiber', 'cabling', 'network'])) tags.push('Network / Cabling');
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
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: 'application/json',
      'user-agent': 'DataCenterCareersBot/1.4 (+https://datacentercareers.us/)',
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

async function searchBoard(board, searchText) {
  const endpoint = `${board.origin}/wday/cxs/${board.tenant}/${board.site}/jobs`;
  const rows = [];
  let offset = 0;
  let reportedTotal = null;
  for (let page = 0; page < 5; page += 1) {
    const payload = await fetchJson(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        referer: `${board.origin}/${board.locale}/${board.site}`
      },
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText })
    });
    const pageRows = Array.isArray(payload.jobPostings) ? payload.jobPostings : [];
    if (page === 0) reportedTotal = Number.isFinite(Number(payload.total)) ? Number(payload.total) : null;
    rows.push(...pageRows);
    offset += pageRows.length;
    if (!pageRows.length || (reportedTotal !== null && offset >= reportedTotal) || pageRows.length < 20) break;
  }
  return { rows, reportedTotal };
}

function titleCandidate(title = '') {
  const t = lower(title);
  return Boolean(t) && !hasAny(t, excludedTitleTerms) && (hasAny(t, strongTitleTerms) || hasAny(t, contextualTitleTerms));
}

async function recoverBoard(board) {
  const candidates = new Map();
  const queryStats = [];
  const errors = [];

  for (const searchText of searchTerms) {
    try {
      const result = await searchBoard(board, searchText);
      for (const row of result.rows) {
        if (!titleCandidate(row.title) || !row.externalPath) continue;
        candidates.set(row.externalPath, row);
      }
      queryStats.push({ searchText, healthy: true, rows: result.rows.length, reportedTotal: result.reportedTotal });
    } catch (error) {
      errors.push(`${searchText}: ${error.message}`);
      queryStats.push({ searchText, healthy: false, rows: 0, reportedTotal: null });
    }
  }

  const jobs = [];
  const rows = [...candidates.values()];
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
        if (!cls) return null;
        const location = clean(row.locationsText || info.location || '');
        if (!confidentUsLocation(location)) return null;
        const externalId = clean(row.bulletFields?.[0] || row.externalPath.split('_').pop() || hash(row.externalPath));
        return {
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
          demo: false,
          postedHours: 9999
        };
      } catch (error) {
        errors.push(`${clean(row.title)}: ${error.message}`);
        return null;
      }
    }));
    jobs.push(...hydrated.filter(Boolean));
  }

  return { jobs, queryStats, candidates: rows.length, errors };
}

function identity(job) {
  return [job?.company, job?.title, job?.location].map(normalizeIdentity).join('|');
}

function dedupe(jobs) {
  const urls = new Set();
  const identities = new Set();
  const out = [];
  for (const job of jobs) {
    if (!job || typeof job !== 'object') continue;
    const url = clean(job.sourceUrl);
    const key = identity(job);
    if ((url && urls.has(url)) || (key && identities.has(key))) continue;
    if (url) urls.add(url);
    if (key) identities.add(key);
    out.push(job);
  }
  return out;
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

if (process.argv.includes('--test')) {
  const cases = [
    {
      name: 'NTT entry-level mechanical engineer',
      title: '5277 - Mechanical Engineer L1',
      description: 'As an Entry-level Mechanical Engineer at NTT Global Data Centers Americas, support mechanical infrastructure in our data center facilities.',
      expected: '0-2-years'
    },
    {
      name: 'three-year critical facilities role',
      title: 'Critical Facilities Technician',
      description: 'Three years of relevant experience maintaining data center UPS and generator systems.',
      expected: '2-5-years'
    },
    {
      name: 'six-year role rejected',
      title: 'Data Center Technician',
      description: 'Minimum of six years of experience in data center operations.',
      expected: null
    },
    {
      name: 'unknown-experience engineer rejected',
      title: 'Mechanical Engineer',
      description: 'Support mechanical infrastructure in data center facilities.',
      expected: null
    },
    {
      name: 'senior role rejected',
      title: 'Senior Critical Facilities Engineer',
      description: 'Two years of experience in critical facilities.',
      expected: null
    }
  ];
  const failures = cases.filter(testCase => (classify(testCase.title, testCase.description)?.experience ?? null) !== testCase.expected);
  if (failures.length) {
    for (const failure of failures) console.error(`Targeted recovery regression failed: ${failure.name}`);
    process.exit(1);
  }
  console.log(`Targeted major Workday recovery passed ${cases.length} regression cases.`);
  process.exit(0);
}

const jobs = await readJson('data/jobs.json', []);
const major = await readJson('data/major-jobs.json', []);
const status = await readJson('data/collector-status.json', {});
if (!Array.isArray(jobs) || !Array.isArray(major)) throw new Error('Expected jobs and major-jobs snapshots to be arrays.');

const existingUrls = new Set([...jobs, ...major].map(job => clean(job?.sourceUrl)).filter(Boolean));
const existingIdentities = new Set([...jobs, ...major].map(identity).filter(Boolean));
const recovered = [];
const diagnostics = {};

for (const board of boards) {
  const result = await recoverBoard(board);
  const additions = result.jobs.filter(job => !existingUrls.has(clean(job.sourceUrl)) && !existingIdentities.has(identity(job)));
  for (const job of additions) {
    existingUrls.add(clean(job.sourceUrl));
    existingIdentities.add(identity(job));
    recovered.push(job);
  }
  diagnostics[board.company] = {
    queriesAttempted: searchTerms.length,
    queriesSucceeded: result.queryStats.filter(query => query.healthy).length,
    candidates: result.candidates,
    qualifyingRoles: result.jobs.length,
    additions: additions.length,
    queryStats: result.queryStats,
    errors: result.errors.slice(0, 12)
  };
}

if (!recovered.length) {
  console.log('Targeted major Workday recovery found no new verified U.S. 0-5 year roles.');
  process.exit(0);
}

const now = Date.now();
for (const job of recovered) {
  const posted = job.postedAt ? new Date(job.postedAt).getTime() : NaN;
  job.postedHours = Number.isFinite(posted) ? Math.max(0, Math.round((now - posted) / 36e5)) : 9999;
}

const nextMajor = dedupe([...major, ...recovered]);
const nextJobs = dedupe([...jobs, ...recovered]).sort((a, b) => (a.postedHours ?? 9999) - (b.postedHours ?? 9999));
status.majorTargetedRecovery = {
  checkedAt: new Date().toISOString(),
  officialOnly: true,
  additiveOnly: true,
  recovered: recovered.length,
  recoveredRoles: recovered.map(job => ({ company: job.company, title: job.title, location: job.location, sourceUrl: job.sourceUrl })),
  diagnostics
};

await writeFile('data/major-jobs.json', JSON.stringify(nextMajor, null, 2) + '\n');
await writeFile('data/jobs.json', JSON.stringify(nextJobs, null, 2) + '\n');
await writeFile('data/collector-status.json', JSON.stringify(status, null, 2) + '\n');
console.log(`Targeted major Workday recovery added ${recovered.length} verified role(s): ${recovered.map(job => `${job.company} — ${job.title} (${job.location})`).join('; ')}`);
