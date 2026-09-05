import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const VERIFIED_AT = '2026-09-05T00:00:00.000Z';
const EXPIRES_AT = '2026-09-13T00:00:00.000Z';
const COMPANY = 'Equinix';
const SOURCE = 'Equinix official careers (verified fallback)';
const BROAD_SOURCE = 'Equinix official careers';
const earlyProgramTitle = /skillbridge|trainee|fellowship|work.?based learning/i;

// The broad Equinix collector can receive a rendered page shell without the
// qualifications body. Early-program roles are therefore owned by the stricter
// early-career collector and this verified fallback instead of being trusted
// from the broad collector. Two current Customer Operations SkillBridge roles
// were also verified on Equinix as requiring 4–6 years, which exceeds this
// site's 0–5 year mission and must never survive a stale/failure carry-forward.
const knownOverExperiencePathSuffixes = [
  '/jobs/skillbridge-data-center-customer-operations-technician-trainee-ashburn-virginia-united-states-f8fff2b9-fbf0-4ac3-b7f9-da6e86f74bf6',
  '/jobs/skillbridge-data-center-customer-operations-technician-trainee-san-jose-california-united-states'
];

// Equinix's public job pages currently render full qualifications to browsers,
// while GitHub-hosted collection sometimes receives a shell without that body.
// These roles were verified directly against Equinix on 2026-09-05. The
// fallback expires quickly, and every role URL must still return HTTP 200.
const verifiedRoles = [
  {
    requisition: 'JR-161457',
    title: "SkillBridge - Data Center Technician - Hiring our Heroes Cohort Q3' 2026",
    url: 'https://careers.equinix.com/jobs/skillbridge-data-center-technician-hiring-our-heroes-cohort-q3-2026-dallas-texas-united-states-ashburn-virginia-boca-raton-florida-chicago-illinois-englewood-colorado-san-jose-california',
    location: 'San Jose, CA; Englewood, CO; Boca Raton, FL; Chicago, IL; Dallas, TX; Ashburn, VA',
    experience: '2-5-years'
  },
  {
    requisition: 'JR-161458',
    title: "SkillBridge Critical Facilities Engineer, Data Center - Hiring our Heroes Cohort Q3' 2026",
    url: 'https://careers.equinix.com/jobs/skillbridge-critical-facilities-engineer-data-center-hiring-our-heroes-cohort-q3-2026-dallas-texas-united-states-ashburn-virginia-chicago-illinois-denver-colorado-miami-florida-san-jose-calif',
    location: 'San Jose, CA; Denver, CO; Miami, FL; Chicago, IL; Dallas, TX; Ashburn, VA',
    experience: '2-5-years'
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

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalize = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const hash = value => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 14);

async function checkLive(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
        'user-agent': 'DataCenterCareersBot/2.2 (+https://datacentercareers.us/)'
      },
      redirect: 'follow',
      signal: controller.signal
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, status: 0, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

function canonicalTitle(job) {
  return normalize(job.title);
}

function isManagedFallback(job) {
  return clean(job?.company) === COMPANY && (
    /^equinix-verified-/i.test(clean(job?.id)) ||
    clean(job?.source) === SOURCE
  );
}

function isBroadEarlyProgram(job) {
  return clean(job?.company) === COMPANY &&
    clean(job?.source) === BROAD_SOURCE &&
    earlyProgramTitle.test(clean(job?.title));
}

function isKnownOverExperience(job) {
  if (clean(job?.company) !== COMPANY) return false;
  try {
    const pathname = new URL(clean(job?.sourceUrl)).pathname.toLowerCase().replace(/\/$/, '');
    return knownOverExperiencePathSuffixes.some(suffix => pathname.endsWith(suffix));
  } catch {
    return false;
  }
}

function dedupe(jobs) {
  const urls = new Set();
  const identities = new Set();
  const out = [];
  for (const job of jobs) {
    const url = clean(job.sourceUrl);
    const identity = [normalize(job.company), canonicalTitle(job), normalize(job.location)].join('|');
    if ((url && urls.has(url)) || identities.has(identity)) continue;
    if (url) urls.add(url);
    identities.add(identity);
    out.push(job);
  }
  return out;
}

const jobs = JSON.parse(await readFile('data/jobs.json', 'utf8'));
let status = {};
try { status = JSON.parse(await readFile('data/collector-status.json', 'utf8')); } catch {}

// Never carry an older managed fallback record forward blindly. Also strip
// early-program records emitted by the broad collector, which cannot safely
// infer experience when Equinix returns a page shell. The dedicated early pass
// or the short-lived verified fallback must earn those roles back into the feed.
const removedManaged = jobs.filter(isManagedFallback).length;
const removedBroadEarly = jobs.filter(isBroadEarlyProgram).length;
const removedKnownOverExperience = jobs.filter(isKnownOverExperience).length;
const baseJobs = jobs.filter(job =>
  !isManagedFallback(job) &&
  !isBroadEarlyProgram(job) &&
  !isKnownOverExperience(job)
);
const now = Date.now();
const expired = now >= Date.parse(EXPIRES_AT);
const existingUrls = new Set(baseJobs.map(job => clean(job.sourceUrl)));
const additions = [];
const checks = [];

if (!expired) {
  for (const role of verifiedRoles) {
    const live = await checkLive(role.url);
    checks.push({ requisition: role.requisition, status: live.status, ok: live.ok });
    if (!live.ok || existingUrls.has(role.url)) continue;
    additions.push({
      id: `equinix-verified-${hash(role.url)}`,
      title: role.title,
      company: COMPANY,
      location: role.location,
      type: 'trainee',
      experience: role.experience,
      tags: ['Trainee', '2–5 Years', 'SkillBridge', /critical facilit/i.test(role.title) ? 'Critical Facilities' : 'Data Center Operations'],
      pay: 'Pay not listed',
      salaryMin: null,
      salaryMax: null,
      salarySortMax: null,
      postedAt: null,
      postedHours: 9999,
      source: SOURCE,
      sourceUrl: role.url,
      active: true,
      demo: false
    });
  }
}

const merged = dedupe([...additions, ...baseJobs]);
const unsafe = merged.filter(job => isBroadEarlyProgram(job) || isKnownOverExperience(job));
if (unsafe.length) {
  throw new Error(`Equinix fallback mission-fit guard failed: ${unsafe.length} unverified or over-experience early-program role(s) remain.`);
}

const retainedManaged = merged.filter(job => isManagedFallback(job)).length;
const countsByType = merged.reduce((acc, job) => { acc[job.type] = (acc[job.type] || 0) + 1; return acc; }, {});
const countsByExperience = merged.reduce((acc, job) => { acc[job.experience] = (acc[job.experience] || 0) + 1; return acc; }, {});

await writeFile('data/jobs.json', JSON.stringify(merged, null, 2) + '\n');
await writeFile('data/collector-status.json', JSON.stringify({
  ...status,
  updatedAt: new Date().toISOString(),
  jobs: merged.length,
  countsByType,
  countsByExperience,
  equinixVerifiedFallback: {
    officialSource: 'https://careers.equinix.com/',
    verifiedAt: VERIFIED_AT,
    expiresAt: EXPIRES_AT,
    expired,
    rolesVerified: verifiedRoles.length,
    liveChecksPassed: checks.filter(check => check.ok).length,
    removedManaged,
    removedBroadEarly,
    removedKnownOverExperience,
    added: additions.length,
    retainedManaged,
    checks
  }
}, null, 2) + '\n');

console.log(expired
  ? `Equinix verified fallback expired at ${EXPIRES_AT}; removed ${removedManaged} managed role(s), ${removedBroadEarly} broad early-program role(s), and ${removedKnownOverExperience} known over-experience role(s); added 0.`
  : `Equinix verified fallback removed ${removedManaged} prior managed role(s), ${removedBroadEarly} broad early-program role(s), and ${removedKnownOverExperience} known over-experience role(s); checked ${checks.length} official URLs and retained ${retainedManaged} live fallback role(s) (${checks.filter(check => check.ok).length} live checks passed).`);