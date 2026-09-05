import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

const COMPANY = 'Switch';
const BASE_URL = 'https://switchltd.hrmdirect.com';
const LIST_URL = `${BASE_URL}/employment/job-openings.php?jbsrc=1014&search=true&sort=pa`;
const RSS_URL = `${BASE_URL}/employment/rss.php?search=true&dept=-1&city=-1&state=-1`;
const OFFICIAL_CAREERS = 'https://www.switch.com/careers/';
const JOBS_PATH = 'data/jobs.json';
const SNAPSHOT_PATH = 'data/switch-jobs.json';
const STATUS_PATH = 'data/collector-status.json';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const decodeHtml = value => String(value ?? '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&ndash;|&#8211;/gi, '–')
  .replace(/&mdash;|&#8212;/gi, '—')
  .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));
const clean = value => decodeHtml(String(value ?? ''))
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]*>/g, ' ')
  .replace(/\uFFFD/g, '-')
  .replace(/\s+/g, ' ')
  .trim();
const lower = value => clean(value).toLowerCase();
const hash = value => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 14);
const normalizeIdentity = value => lower(value).replace(/[^a-z0-9]+/g, ' ').trim();
const normalizeTitle = value => normalizeIdentity(value).replace(/\b(?:night|day|swing|graveyard) shift\b/g, '').trim();

const missionTitlePattern = /\b(?:client support technician i|cross connect specialist|data center (?:network )?cabling technician(?: i)?|data center structured cabling technician|dco facilities technician (?:i|ii|iii)|mission control (?:power\/environmental )?technician(?: i)?|network infrastructure technician i|network operations center technician i|telecom network operations center technician i|rig electrical apprentice i|rig electrical journeyman)\b/i;
const seniorTitlePattern = /\b(?:senior|sr\.?|lead|principal|staff|manager|director|vice president|vp|chief|head of|supervisor|superintendent|foreman)\b/i;
const leadershipRequirementPattern = /\b(?:supervisory or team lead|supervisory experience|team lead experience|supervising technical staff|supervise technicians|leadership experience|people management experience)\b/i;
const dataCenterContextPattern = /\b(?:data cent(?:er|re)|mission-critical|critical infrastructure|critical facilities|supernap)\b/i;

function requiredQualificationsText(description = '') {
  const text = clean(description);
  const required = text.search(/\bRequired\b/);
  const start = required >= 0 ? required : 0;
  const preferred = text.slice(start).search(/\bPreferred\b/);
  return preferred >= 0 ? text.slice(start, start + preferred) : text.slice(start);
}

function normalizeExperienceNumbers(text = '') {
  const words = new Map([
    ['zero', '0'], ['one', '1'], ['two', '2'], ['three', '3'], ['four', '4'], ['five', '5'],
    ['six', '6'], ['seven', '7'], ['eight', '8'], ['nine', '9'], ['ten', '10']
  ]);
  return lower(text)
    .replace(/\uFFFD/g, '-')
    .replace(/\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/g, word => words.get(word) || word);
}

function statedExperienceYears(text = '') {
  const normalized = normalizeExperienceNumbers(text);
  const values = [];
  const patterns = [
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\s+years?['’]?(?:\s+(?:of|prior))?\s+(?:direct\s+|relevant\s+|related\s+|professional\s+|work\s+|hands-on\s+)?experience/gi,
    /(?:minimum(?: of)?\s+|at least\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?['’]?(?:\s+(?:of|prior))?\s+(?:direct\s+|relevant\s+|related\s+|professional\s+|work\s+|hands-on\s+)?experience/gi,
    /experience(?:\s+(?:of|in))?\s+(?:at least\s+|minimum(?: of)?\s+)?(\d{1,2})\s*(?:\+|or more)?\s+years?/gi,
    /(\d{1,2})\s*(?:\+|or more)?\s+years?['’]?\s+experience\b/gi
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      values.push(Number(match[1]));
      if (match[2]) values.push(Number(match[2]));
    }
  }
  return values.filter(value => Number.isFinite(value) && value >= 0 && value <= 50);
}

function extractTag(xml = '', tag = '') {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(xml).match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
  return match ? clean(match[1]) : '';
}

function extractRssListings(xml = '') {
  if (!/<rss\b/i.test(xml) || !/<channel\b/i.test(xml)) throw new Error('Switch RSS source did not return an RSS channel.');
  const listings = [];
  const seenReqs = new Set();
  for (const match of String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const item = match[1];
    const title = extractTag(item, 'title');
    const rawLink = extractTag(item, 'link');
    let parsed;
    try { parsed = new URL(rawLink, BASE_URL); } catch { continue; }
    const req = String(parsed.searchParams.get('req') || '').trim();
    if (!/^\d+$/.test(req) || seenReqs.has(req)) continue;
    seenReqs.add(req);
    const pubDate = extractTag(item, 'pubDate');
    const parsedDate = pubDate ? new Date(pubDate) : null;
    listings.push({
      req,
      title,
      url: `${BASE_URL}/employment/view.php?req=${encodeURIComponent(req)}`,
      postedAt: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null
    });
  }
  return listings;
}

function extractDetailTitle(html = '') {
  const reqResult = String(html).match(/<div\b[^>]*class=["'][^"']*\breqResult\b[^"']*["'][^>]*>[\s\S]*?<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
  if (reqResult) return clean(reqResult[1]);
  const h2 = String(html).match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
  if (h2) return clean(h2[1]);
  const title = String(html).match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return title ? clean(title[1]).replace(/\s+-\s+Careers At Switch.*$/i, '').trim() : '';
}

function extractRoleHeading(html = '') {
  const match = String(html).match(/<h[1-6]\b[^>]*>\s*(?:<[^>]+>\s*)*The Role:\s*([\s\S]*?)<\/h[1-6]>/i);
  return match ? clean(match[1]) : '';
}

function extractViewField(html = '', fieldName = '') {
  for (const row of String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => clean(match[1]));
    if (cells.length >= 2 && cells[0].replace(/:\s*$/, '').toLowerCase() === fieldName.toLowerCase()) return cells[1];
  }
  return '';
}

function classify(title, description = '', detailRole = '') {
  const t = clean(title);
  if (!missionTitlePattern.test(t)) return { classification: null, reason: 'out-of-scope-title' };
  if (seniorTitlePattern.test(t)) return { classification: null, reason: 'senior-title' };
  if (!dataCenterContextPattern.test(description)) return { classification: null, reason: 'missing-data-center-context' };

  if (detailRole) {
    const listed = normalizeTitle(t);
    const detailed = normalizeTitle(detailRole);
    const compatible = listed === detailed || listed.includes(detailed) || detailed.includes(listed);
    if (!compatible) return { classification: null, reason: 'detail-title-mismatch' };
  }

  const required = requiredQualificationsText(description);
  if (leadershipRequirementPattern.test(required)) return { classification: null, reason: 'leadership-requirement' };

  let type = 'entry-level';
  const titleLower = lower(t);
  if (titleLower.includes('intern')) type = 'internship';
  else if (titleLower.includes('apprentice')) type = 'apprenticeship';
  else if (titleLower.includes('trainee')) type = 'trainee';

  const years = statedExperienceYears(required);
  if (years.some(year => year > 5)) return { classification: null, reason: 'over-5-years' };

  const explicitNoExperience = /(?:no|zero) (?:prior )?experience(?: is)? (?:required|needed)|experience (?:is )?not required/i.test(required);
  const explicitEntryLevel = /\bentry[- ]level\b/i.test(description);
  const programRole = type !== 'entry-level';
  const levelOne = /\btechnician\s+i\b/i.test(t);
  const midTitle = /\btechnician\s+(?:ii|iii)\b/i.test(t) || /\bjourneyman\b/i.test(t);

  if (!years.length && !explicitNoExperience && !explicitEntryLevel && !programRole && !levelOne && !midTitle) {
    return { classification: null, reason: 'unknown-experience' };
  }

  let experience = '0-2-years';
  if (explicitNoExperience) experience = 'no-experience';
  else if (midTitle || years.some(year => year >= 3)) experience = '2-5-years';

  return { classification: { type, experience }, reason: null };
}

function locationFromDetail(html = '') {
  const field = extractViewField(html, 'Location');
  if (field) {
    const cityState = field.match(/([A-Za-z][A-Za-z .'-]*,\s*[A-Z]{2})\b/);
    if (cityState) return clean(cityState[1]);
  }
  const text = clean(html);
  const explicit = text.match(/\bLocation:\s*([A-Za-z][A-Za-z .'-]*,\s*[A-Z]{2})\b/);
  return explicit ? clean(explicit[1]) : null;
}

function payFor(description = '') {
  const text = clean(description);
  const match = text.match(/\$([\d,.]+)\s*(?:-|–|—|to)\s*\$?([\d,.]+)\s*(?:\/|per\s+)?\s*(hour|hourly|hr|year|yearly|yr|annum|annual|annually)?/i);
  if (!match) return { pay: 'Pay not listed', salaryMin: null, salaryMax: null, salarySortMax: null };
  const min = Number(match[1].replace(/,/g, ''));
  const max = Number(match[2].replace(/,/g, ''));
  const unit = lower(match[3] || '');
  const hourly = /hour|hr/.test(unit) || (!unit && max < 1000);
  return {
    pay: `$${match[1]}–$${match[2]} / ${hourly ? 'hr' : 'year'}`,
    salaryMin: min,
    salaryMax: max,
    salarySortMax: hourly ? Math.round(max * 2080) : max
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
  if (/training|apprentice|mentorship|development/.test(text)) tags.push('Training / Mentorship');
  if (/electrical|switchgear|ups|generator|power\/environmental/.test(text)) tags.push('Electrical');
  if (/facilities|mechanical|hvac|chiller|cooling|mission control/.test(text)) tags.push('Critical Facilities');
  if (/network|cabling|fiber|cross connect|telecom/.test(text)) tags.push('Network / Cabling');
  return [...new Set(tags)].slice(0, 5);
}

function dedupe(jobs) {
  const urls = new Set();
  const identities = new Set();
  const out = [];
  for (const job of jobs) {
    const urlKey = clean(job?.sourceUrl);
    const identity = [job?.company, job?.title, job?.location].map(normalizeIdentity).join('|');
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

async function fetchText(url, retries = 1) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'text/html,application/xhtml+xml,application/xml,text/xml',
          'user-agent': 'DataCenterCareersBot/1.1 (+https://datacentercareers.us/)'
        },
        signal: AbortSignal.timeout(20000)
      });
      if (response.ok) return response.text();
      lastError = new Error(`HTTP ${response.status} for ${url}`);
      if (![403, 429, 500, 502, 503, 504].includes(response.status) || attempt === retries) throw lastError;
    } catch (error) {
      lastError = error;
      if (attempt === retries) throw error;
    }
    await sleep(1500 * (attempt + 1));
  }
  throw lastError;
}

if (process.argv.includes('--test-classifier')) {
  const cases = [
    {
      name: 'electrical apprentice qualifies',
      title: 'RIG Electrical Apprentice I',
      detailRole: 'RIG Electrical Apprentice I',
      description: 'The Role: RIG Electrical Apprentice I. This is an entry-level role in a mission-critical data center. Required High school diploma. Preferred Prior electrical experience.',
      expectedType: 'apprenticeship', expectedExperience: '0-2-years'
    },
    {
      name: 'facilities technician range qualifies',
      title: 'DCO Facilities Technician I',
      detailRole: 'DCO Facilities Technician I',
      description: 'Data center facilities. Required 1-2 years of experience in a facilities, mechanical, electrical, or related technical environment. Preferred data center exposure.',
      expectedType: 'entry-level', expectedExperience: '0-2-years'
    },
    {
      name: 'level two is appropriate mid-level',
      title: 'DCO Facilities Technician II',
      detailRole: 'DCO Facilities Technician II',
      description: 'Critical facilities data center operations. Required 3+ years of related experience. Preferred certifications.',
      expectedType: 'entry-level', expectedExperience: '2-5-years'
    },
    {
      name: 'over-five requirement is rejected',
      title: 'DCO Facilities Technician III',
      detailRole: 'DCO Facilities Technician III',
      description: 'Critical facilities data center operations. Required 7+ years of experience. Preferred certifications.',
      expectedType: null, expectedExperience: null
    },
    {
      name: 'misposted supervisor detail is rejected',
      title: 'Data Center Cabling Technician I',
      detailRole: 'Network Infrastructure Supervisor',
      description: 'Data center operations. Required 2+ years of experience in a supervisory or team lead role.',
      expectedType: null, expectedExperience: null
    },
    {
      name: 'senior title is rejected',
      title: 'Senior DCO Facilities Technician',
      detailRole: 'Senior DCO Facilities Technician',
      description: 'Data center critical facilities. Required 2+ years of experience.',
      expectedType: null, expectedExperience: null
    }
  ];
  const failures = [];
  for (const testCase of cases) {
    const result = classify(testCase.title, testCase.description, testCase.detailRole).classification;
    const actualType = result?.type ?? null;
    const actualExperience = result?.experience ?? null;
    if (actualType !== testCase.expectedType || actualExperience !== testCase.expectedExperience) {
      failures.push(`${testCase.name}: expected ${testCase.expectedType}/${testCase.expectedExperience}, got ${actualType}/${actualExperience}`);
    }
  }
  if (failures.length) {
    for (const failure of failures) console.error(`Switch classifier regression: ${failure}`);
    process.exit(1);
  }
  console.log(`Switch classifier passed ${cases.length} regression cases.`);
  process.exit(0);
}

const previousJobs = await readJson(JOBS_PATH, []);
const priorStatus = await readJson(STATUS_PATH, {});
const rss = await fetchText(RSS_URL, 2);
const listings = extractRssListings(rss);
if (!listings.length) throw new Error('Switch official RSS source returned no valid current requisitions; preserving prior snapshot.');

const diagnostics = {
  listedJobs: listings.length,
  candidateRoles: 0,
  qualifyingRoles: 0,
  rejectedOutOfScopeTitle: 0,
  rejectedSeniorTitle: 0,
  rejectedMissingDataCenterContext: 0,
  rejectedDetailTitleMismatch: 0,
  rejectedLeadershipRequirement: 0,
  rejectedOver5Years: 0,
  rejectedUnknownExperience: 0,
  detailErrors: []
};
const collected = [];

for (const listing of listings) {
  if (!missionTitlePattern.test(listing.title)) {
    diagnostics.rejectedOutOfScopeTitle += 1;
    continue;
  }
  if (seniorTitlePattern.test(listing.title)) {
    diagnostics.rejectedSeniorTitle += 1;
    continue;
  }
  diagnostics.candidateRoles += 1;

  let html;
  try { html = await fetchText(listing.url, 1); }
  catch (error) {
    diagnostics.detailErrors.push({ req: listing.req, title: listing.title, url: listing.url, error: error.message });
    continue;
  }
  await sleep(450);

  const description = clean(html);
  const title = extractDetailTitle(html) || listing.title;
  const detailRole = extractRoleHeading(html);
  const location = locationFromDetail(html);
  if (!location) {
    diagnostics.detailErrors.push({ req: listing.req, title, url: listing.url, error: 'Location not found on official detail page' });
    continue;
  }

  const { classification, reason } = classify(title, description, detailRole);
  if (!classification) {
    if (reason === 'out-of-scope-title') diagnostics.rejectedOutOfScopeTitle += 1;
    else if (reason === 'senior-title') diagnostics.rejectedSeniorTitle += 1;
    else if (reason === 'missing-data-center-context') diagnostics.rejectedMissingDataCenterContext += 1;
    else if (reason === 'detail-title-mismatch') diagnostics.rejectedDetailTitleMismatch += 1;
    else if (reason === 'leadership-requirement') diagnostics.rejectedLeadershipRequirement += 1;
    else if (reason === 'over-5-years') diagnostics.rejectedOver5Years += 1;
    else if (reason === 'unknown-experience') diagnostics.rejectedUnknownExperience += 1;
    continue;
  }

  collected.push({
    id: `switch-${listing.req}`,
    title: clean(title),
    company: COMPANY,
    location,
    type: classification.type,
    experience: classification.experience,
    tags: tagsFor(title, description, classification.experience, classification.type),
    ...payFor(description),
    postedAt: listing.postedAt,
    source: 'Employer career site',
    sourceUrl: listing.url,
    active: true,
    demo: false
  });
}

if (diagnostics.detailErrors.length) {
  throw new Error(`Switch official source had ${diagnostics.detailErrors.length} candidate detail error(s); preserving prior snapshot. ${diagnostics.detailErrors.map(item => `${item.req}/${item.title}: ${item.error}`).join(' | ')}`);
}

const switchJobs = dedupe(collected);
diagnostics.qualifyingRoles = switchJobs.length;
if (diagnostics.candidateRoles > 0 && switchJobs.length === 0) {
  throw new Error(`Switch listed ${diagnostics.candidateRoles} mission-title candidate role(s) but none passed 0–5 year classification; preserving prior snapshot.`);
}

const merged = dedupe([
  ...previousJobs.filter(job => clean(job?.company) !== COMPANY),
  ...switchJobs
]);
const now = Date.now();
for (const job of merged) {
  job.postedHours = job.postedAt ? Math.max(0, Math.round((now - new Date(job.postedAt).getTime()) / 36e5)) : 9999;
}
merged.sort((a, b) => (a.postedHours ?? 9999) - (b.postedHours ?? 9999));

const status = {
  ...priorStatus,
  updatedAt: new Date().toISOString(),
  jobs: merged.length,
  switchCareers: {
    checkedAt: new Date().toISOString(),
    sourceHealthy: true,
    listingComplete: true,
    officialCareerPage: OFFICIAL_CAREERS,
    officialJobBoard: LIST_URL,
    officialRssFeed: RSS_URL,
    authoritativeSnapshot: true,
    ...diagnostics
  }
};

await writeFile(SNAPSHOT_PATH, JSON.stringify(switchJobs, null, 2) + '\n');
await writeFile(JOBS_PATH, JSON.stringify(merged, null, 2) + '\n');
await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');

console.log(`Switch: ${switchJobs.length} qualifying U.S. role(s) from ${listings.length} current official RSS requisitions; feed now ${merged.length} jobs.`);
