import { readFile, writeFile } from 'node:fs/promises';

const JOBS_PATH = 'data/jobs.json';
const STATUS_PATH = 'data/collector-status.json';
const COMPANY = 'Equinix';
const SOURCE = 'Equinix official current SkillBridge';
const LISTING_URL = 'https://careers.equinix.com/internships';

const verifiedRoles = [
  {
    requisition: 'JR-163301',
    title: "SkillBridge - Critical Facilities Engineer - Trainee (Cohort Q1' 2027)",
    url: 'https://careers.equinix.com/jobs/skillbridge-critical-facilities-engineer-trainee-cohort-q1-2027-dallas-texas-united-states-ashburn-virginia-atlanta-georgia-chicago-illinois-englewood-colorado-miami-florida-san-jose-californ',
    location: 'San Jose, CA; Englewood, CO; Miami, FL; Atlanta, GA; Chicago, IL; Secaucus, NJ; Dallas, TX; Ashburn, VA; Seattle, WA',
    experience: '0-2-years',
    allowNoYears: true
  },
  {
    requisition: 'JR-163300',
    title: "SkillBridge - Data Center Technician - Trainee - Cohort Q1' 2027",
    url: 'https://careers.equinix.com/jobs/skillbridge-data-center-technician-trainee-cohort-q1-2027-dallas-texas-united-states-ashburn-virginia-atlanta-georgia-chicago-illinois-san-jose-california',
    location: 'San Jose, CA; Atlanta, GA; Chicago, IL; Dallas, TX; Ashburn, VA',
    experience: '2-5-years'
  },
  {
    requisition: 'JR-158170',
    title: 'SkillBridge Critical Facilities Engineer - Trainee',
    url: 'https://careers.equinix.com/jobs/skillbridge-critical-facilities-engineer-trainee-dallas-texas-united-states',
    location: 'Dallas, TX',
    experience: '2-5-years'
  },
  {
    requisition: 'JR-811161',
    title: 'SkillBridge, Data Center Critical Facilities Engineer - Trainee',
    url: 'https://careers.equinix.com/jobs/skillbridge-data-center-critical-facilities-engineer-trainee-san-jose-california-united-states',
    location: 'San Jose, CA',
    experience: '2-5-years'
  }
];

const knownOverExperiencePaths = [
  '/jobs/skillbridge-data-center-customer-operations-technician-trainee-ashburn-virginia-united-states-f8fff2b9-fbf0-4ac3-b7f9-da6e86f74bf6',
  '/jobs/skillbridge-data-center-customer-operations-technician-trainee-san-jose-california-united-states'
];

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
const normalize = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const canonicalUrl = value => {
  try {
    const url = new URL(clean(value));
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return clean(value).replace(/\/$/, '');
  }
};

function isManaged(job) {
  return clean(job?.company) === COMPANY && (
    /^equinix-skillbridge-current-/i.test(clean(job?.id)) ||
    clean(job?.source) === SOURCE
  );
}

function isKnownOverExperience(job) {
  if (clean(job?.company) !== COMPANY) return false;
  try {
    const path = new URL(clean(job?.sourceUrl)).pathname.toLowerCase().replace(/\/$/, '');
    return knownOverExperiencePaths.some(expected => path.endsWith(expected));
  } catch {
    return false;
  }
}

function titleMatches(actual, expected) {
  const a = normalize(actual);
  const e = normalize(expected);
  if (!a || !e) return false;
  if (a === e || a.includes(e) || e.includes(a)) return true;
  if (!a.includes('skillbridge') || !e.includes('skillbridge')) return false;
  return ['critical facilities engineer', 'data center technician']
    .some(family => a.includes(family) && e.includes(family));
}

function extractHeading(html) {
  const headings = [];
  for (const match of String(html).matchAll(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/gi)) {
    const value = clean(match[1]);
    if (value && /skillbridge/i.test(value)) headings.push(value);
  }
  return headings.sort((a, b) => a.length - b.length)[0] || '';
}

function requiredExperienceText(html) {
  const text = clean(html);
  const preferred = text.search(/\b(?:preferred qualifications?|preferred experience|preferred skills?|nice to have|bonus qualifications?)\b/i);
  return preferred >= 0 ? text.slice(0, preferred) : text;
}

function experienceYears(text) {
  const values = [];
  const patterns = [
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+years?\b/gi,
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:\+|or more)\s+years?\b/gi,
    /(?:experience|relevant experience)[^.;]{0,45}?(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+years?\b/gi
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      values.push(Number(match[1]));
      if (match[2]) values.push(Number(match[2]));
    }
  }
  return values.filter(value => Number.isFinite(value) && value >= 0 && value <= 50);
}

function classifyExperience(role, html) {
  const text = requiredExperienceText(html);
  const years = experienceYears(text);
  if (years.some(year => year > 5)) return { ok: false, reason: 'over-5-years', years };
  if (years.length) {
    const max = Math.max(...years);
    const experience = max >= 3 ? '2-5-years' : '0-2-years';
    if (experience !== role.experience) return { ok: false, reason: 'experience-drift', years, experience };
    return { ok: true, experience, years };
  }

  const beginnerSignal = /desire to learn a new skill or trade|hands-on experience|kick-start the next chapter|training will be on/i.test(text);
  if (role.allowNoYears === true && beginnerSignal) return { ok: true, experience: role.experience, years: [] };
  return { ok: false, reason: 'unknown-experience', years: [] };
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': 'DataCenterCareersBot/2.3 (+https://datacentercareers.us/)'
      },
      redirect: 'follow',
      signal: controller.signal
    });
    const body = response.ok ? await response.text() : '';
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: '', error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

function listedOnInternshipPage(role, html) {
  const body = String(html).toLowerCase();
  try {
    const path = new URL(role.url).pathname.toLowerCase().replace(/\/$/, '');
    return body.includes(path) || body.includes(role.requisition.toLowerCase()) || body.includes(role.title.toLowerCase());
  } catch {
    return false;
  }
}

function dedupe(jobs) {
  const urls = new Set();
  const identities = new Set();
  const out = [];
  for (const job of jobs) {
    const url = canonicalUrl(job?.sourceUrl);
    const identity = [normalize(job?.company), normalize(job?.title), normalize(job?.location)].join('|');
    if ((url && urls.has(url)) || identities.has(identity)) continue;
    if (url) urls.add(url);
    identities.add(identity);
    out.push(job);
  }
  return out;
}

function countBy(jobs, key) {
  return jobs.reduce((counts, job) => {
    const value = clean(job?.[key]) || 'unknown';
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function runSelfTest() {
  const role = verifiedRoles.find(item => item.requisition === 'JR-163300');
  const good = classifyExperience(role, '<h2>Qualifications</h2><p>2–4 years of related technical or data center experience.</p>');
  if (!good.ok || good.experience !== '2-5-years') throw new Error('Equinix SkillBridge 2–4 year role regression failed.');
  const over = classifyExperience({ ...role, experience: '2-5-years' }, '<p>4–6 years of experience in data center operations.</p>');
  if (over.ok || over.reason !== 'over-5-years') throw new Error('Equinix SkillBridge >5-year fail-closed regression failed.');
  const beginner = classifyExperience(verifiedRoles[0], '<p>Do you desire to learn a new skill or trade? Training will be on the cutting edge.</p>');
  if (!beginner.ok || beginner.experience !== '0-2-years') throw new Error('Equinix SkillBridge beginner-signal regression failed.');
  if (!titleMatches('SkillBridge - Critical Facilities Engineer - Trainee', verifiedRoles[0].title)) throw new Error('Equinix SkillBridge title-family regression failed.');
  console.log('Equinix current SkillBridge regression tests passed.');
}

if (process.argv.includes('--test')) {
  runSelfTest();
  process.exit(0);
}

const jobs = JSON.parse(await readFile(JOBS_PATH, 'utf8'));
let status = {};
try { status = JSON.parse(await readFile(STATUS_PATH, 'utf8')); } catch {}
if (!Array.isArray(jobs)) throw new Error(`${JOBS_PATH} must contain an array.`);

const removedManaged = jobs.filter(isManaged).length;
const removedKnownOverExperience = jobs.filter(isKnownOverExperience).length;
const baseJobs = jobs.filter(job => !isManaged(job) && !isKnownOverExperience(job));
const existingUrls = new Set(baseJobs.map(job => canonicalUrl(job?.sourceUrl)).filter(Boolean));
const listing = await fetchPage(LISTING_URL);
const checks = [];
const additions = [];

if (listing.ok) {
  for (const role of verifiedRoles) {
    if (!listedOnInternshipPage(role, listing.body)) {
      checks.push({ requisition: role.requisition, listed: false, detailOk: false, published: false, reason: 'not-listed' });
      continue;
    }

    const detail = await fetchPage(role.url);
    if (!detail.ok) {
      checks.push({ requisition: role.requisition, listed: true, detailOk: false, detailStatus: detail.status, published: false, reason: detail.error || `detail-${detail.status}` });
      continue;
    }

    const heading = extractHeading(detail.body);
    const requisitionMatches = new RegExp(`\\b${role.requisition}\\b`, 'i').test(clean(detail.body));
    if (!requisitionMatches || !titleMatches(heading, role.title)) {
      checks.push({ requisition: role.requisition, listed: true, detailOk: true, detailStatus: detail.status, published: false, reason: 'identity-drift', heading });
      continue;
    }

    const classification = classifyExperience(role, detail.body);
    if (!classification.ok) {
      checks.push({ requisition: role.requisition, listed: true, detailOk: true, detailStatus: detail.status, published: false, reason: classification.reason, years: classification.years });
      continue;
    }

    const sourceUrl = canonicalUrl(role.url);
    if (!existingUrls.has(sourceUrl)) {
      const tags = ['Trainee', classification.experience === '0-2-years' ? '0–2 Years' : '2–5 Years', 'SkillBridge'];
      tags.push(/critical facilit/i.test(role.title) ? 'Critical Facilities' : 'Data Center Operations');
      additions.push({
        id: `equinix-skillbridge-current-${role.requisition.toLowerCase()}`,
        title: role.title,
        company: COMPANY,
        location: role.location,
        type: 'trainee',
        experience: classification.experience,
        tags,
        pay: 'Pay not listed',
        salaryMin: null,
        salaryMax: null,
        salarySortMax: null,
        postedAt: null,
        postedHours: 9999,
        source: SOURCE,
        sourceUrl,
        active: true,
        demo: false
      });
    }
    checks.push({ requisition: role.requisition, listed: true, detailOk: true, detailStatus: detail.status, published: true, years: classification.years, alreadyPublishedByOtherCollector: existingUrls.has(sourceUrl) });
  }
}

const merged = dedupe([...additions, ...baseJobs]);
const unsafe = merged.filter(isKnownOverExperience);
if (unsafe.length) throw new Error(`Equinix current SkillBridge guard failed: ${unsafe.length} known >5-year role(s) remain.`);

const checkedAt = new Date().toISOString();
status.updatedAt = checkedAt;
status.jobs = merged.length;
status.countsByType = countBy(merged, 'type');
status.countsByExperience = countBy(merged, 'experience');
status.equinixCurrentSkillbridge = {
  officialSource: LISTING_URL,
  checkedAt,
  listingHealthy: listing.ok,
  listingStatus: listing.status,
  rolesExpected: verifiedRoles.length,
  rolesListed: checks.filter(check => check.listed).length,
  detailChecksPassed: checks.filter(check => check.detailOk).length,
  qualifyingRoles: checks.filter(check => check.published).length,
  added: additions.length,
  removedManaged,
  removedKnownOverExperience,
  policy: 'Publish only source-verified U.S. Equinix SkillBridge data-center roles that remain on the live official internship listing and whose current official detail page confirms the exact requisition, job family, and a 0–5-year requirement. Missing, drifted, unreachable, or >5-year roles fail closed.',
  checks,
  errors: listing.ok ? [] : [listing.error || `listing-${listing.status}`]
};

await writeFile(JOBS_PATH, JSON.stringify(merged, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

if (!listing.ok) {
  console.warn(`Equinix current SkillBridge listing unavailable (${listing.status || listing.error || 'unknown'}); removed ${removedManaged} previously managed role(s) and published none.`);
} else {
  console.log(`Equinix current SkillBridge verified ${checks.filter(check => check.published).length}/${verifiedRoles.length} mission-fit role(s), added ${additions.length}, and removed ${removedKnownOverExperience} known >5-year role(s).`);
}
